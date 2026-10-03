/**
 * The ONE contract between the composition roots and the tool layer.
 *
 * popclaw has three composition roots: `index.ts` (the OpenClaw gateway),
 * `main.ts` (the dev CLI / daemon) and `mcp.ts` (the stdio MCP bridge — how a
 * citizen on Claude Code / Codex / any other harness carries the same passport;
 * a first-class surface, peer of index.ts). The two that register tools —
 * index.ts and mcp.ts — each assemble a "runtime bag" and hand it to
 * `registerPopclawTools`; main.ts registers no tools and builds no bag.
 *
 * That bag used to be typed `() => Promise<unknown>`, while `register-tools.ts`
 * reads it through optional chaining (`rt?.x?.y?.()`) — so a key a root forgets
 * to supply throws nothing, logs nothing, and just silently turns a feature off.
 * That has already happened for real: the MCP root never had `knownFollowers`,
 * so "people who follow me" dropped out of person resolution entirely — the same
 * bug the 2026-07-30 field note in index.ts describes, resurfacing on a different
 * host.
 *
 * Hence: the bag IS this type. Both tool-registering roots annotate against it,
 * so a missing key is a compile error rather than a feature nobody notices is
 * gone.
 *
 * Discipline: types ONLY — no runtime code, and never a `node:*` import (eslint
 * allows those in the three roots + host/local-host-adapter only).
 *
 * Host-specific slots stay OUT of here (OpenClaw's ownerSession / ownerNotifier /
 * lastCommandAddress / followerSync, MCP's notifier): each root adds its own
 * via `extends` or an intersection. "Only one host has it" must not masquerade
 * as a shared contract.
 */
import type { CadenceLoader } from '../cadence/cadence-loader.js';
import type { BondsStore } from '../bonds/bonds-store.js';
import type { ProposalsStore } from '../bonds/proposals-store.js';
import type { MultiHouseEgress } from '../egress/multi-house-egress.js';
import type { uploadCanvas } from '../egress/canvas-egress.js';
import type { HostAdapter } from '../host/host-adapter.js';
import type { HouseRuntime } from './house-lifecycle/house-runtime.js';
import type { PopclawPaths } from '../host/popclaw-paths.js';
import type { NameChain } from '../identity/person-name.js';
import type { WorldFeedCatalog } from '../ingress/world-feed-catalog.js';
import type { InviteInitiator } from '../invite/invite-initiator.js';
import type { InviteWatchDeps, PendingInvitesStore } from '../invite/pending-invites.js';
import type { MarkService } from '../marks/mark-service.js';
import type { MarksStore } from '../marks/marks-store.js';
import type { InboxStore } from '../messaging/inbox-store.js';
import type { OwnerNotifyTargetStore } from '../notifier/owner-notify-target.js';
import type { Notifier } from '../notifier/notifier.js';
import type { MountedHouse, OnboardingOrchestrator } from '../onboarding/orchestrator.js';
import type { OnboardingStateRepository } from '../onboarding/state-repository.js';
import type { ReplyPingsStore } from '../pings/reply-pings.js';
import type { ScoreCache } from '../recommend/score-cache.js';
import type { bootstrapPlugin } from './plugin-bootstrap.js';
import type { SocialGraph } from '../social-graph/social-graph.js';
import type { KnownFollowersStore } from '../social-graph/followers-sync.js';
import type { PendingFollowStore } from '../social-graph/pending-follow-store.js';
import type { SocialLogRecorder } from '../social-log/social-log.js';
import type { TasteLoader } from '../taste/taste-loader.js';
import type { GuideClient } from '../world/guide-client.js';
import type { WorldSummaryClient } from '../world/world-summary-client.js';

export interface PluginRuntime {
  readonly publicFeedDisplay?: import('../ingress/public-feed-display.js').PublicFeedDisplay;
  readonly houseRuntime: HouseRuntime;
  readonly worldRuntime: import('./world-runtime.js').WorldRuntime;
  readonly host: HostAdapter;
  readonly boot: Awaited<ReturnType<typeof bootstrapPlugin>>;
  readonly egress: MultiHouseEgress;
  readonly initiator: InviteInitiator;
  /** Cross-house snapshot fetch (= the same catalog object). */
  readonly worldFeedClient: WorldFeedCatalog;
  /** Cross-house merged world-feed cache view (Spec B, slice ②). Each item carries its source house slug. */
  readonly worldFeedCache: WorldFeedCatalog;
  readonly tasteLoader: TasteLoader;
  readonly cadenceLoader: CadenceLoader;
  readonly socialGraph: SocialGraph;
  /**
   * People who follow the owner — the THIRD person-resolution source
   * register-tools reads. Omitting it raises no error; it just makes that whole
   * class of people unrecognizable (field-verified 2026-07-30).
   */
  readonly knownFollowers: KnownFollowersStore;
  /**
   * Follow doorbell (migration 023): the rows a reader's ➕ becomes.
   * `popclaw_show_dream_review` lists them, `popclaw_follow` graduates one to
   * `confirmed` so a followed name is never re-asked (`markConfirmed` is a
   * no-op on non-pending rows, so wiring it into every successful follow is
   * safe).
   *
   * **Required, and that is the point.** It was optional while "only the
   * gateway runs the doorbell legs" was true. Every resident root runs them
   * now (`runtime/resident-services.ts`), and optional turned out to be the
   * worse half of the same defect: a root that pulls the batch enqueues an L2
   * saying "N pending follow requests — say 'follow list'", and then
   * `stub-tools.ts` and `world-tools.ts` both read this slot through a local
   * `pendingFollows?:` cast and degrade in silence. The owner gets an empty
   * list and a follow that never graduates — a dead end they were explicitly
   * invited into.
   *
   * Required makes tsc the guard, which is this file's whole design
   * (tests/unit/runtime-contract.test.ts, gate ①): a root that pulls the batch
   * but cannot show it no longer compiles. Both bag-building roots supply it —
   * `index.ts` from `bootRuntime`, `mcp.ts` from `buildRuntime`. The dev
   * daemon builds no bag at all (it registers no tools), so there is nothing
   * there to supply; the rows its doorbell writes are read by whichever
   * tool-registering root shares the data root.
   */
  readonly pendingFollows: PendingFollowStore;
  readonly scoreCache: ScoreCache;
  readonly inboxStore: InboxStore;
  // Pings · replies-to-me: idempotency/first-reply ledger + unread cursor (spec 2026-07-25).
  readonly replyPings: ReplyPingsStore;
  // ADR-0040: ledger of invitation requests I initiated + lore-house query wiring (shared by polling/lazy-lookup).
  readonly pendingInvites: PendingInvitesStore;
  readonly inviteWatch: InviteWatchDeps;
  /** #236: retry the notification queue on any owner interaction, then report
   *  what is still stuck. Both are functions so the count is read AFTER the retry.
   *
   *  Optional because only a host with a PUSH leg can have a backlog that is
   *  stuck. On MCP nothing is ever pushed — the agent pulls with
   *  `popclaw_notifications` — so "not delivered yet" is the normal resting
   *  state there, and reporting it as trouble would be a false alarm. */
  readonly drainNotifications?: () => Promise<void>;
  /** Gateway-only durable DM retry, with per-item backoff. */
  readonly retryDmNotifications?: () => Promise<void>;
  readonly notifyBacklog?: () => { count: number; lastFailureAt?: number; lastFailureReason?: string };
  // Pinned proactive-notification channel (/popclaw notify-here), persisted.
  readonly ownerNotifyTargetStore: OwnerNotifyTargetStore;
  // Newspaper (L3): rendered in the AGENT's own turn (popclaw never calls an LLM —
  // spec 2026-06-18). The gather/publish tools need canvas upload + the data root.
  readonly uploadCanvas: typeof uploadCanvas;
  readonly paths: PopclawPaths;
  readonly orchestrator: OnboardingOrchestrator;
  // R1 spec §4: the house-gap closure used by the "settling-in" line and the one
  // the orchestrator recognizes are the same pair of closures.
  readonly houses: () => MountedHouse[];
  readonly houseStarted: (slug: string) => boolean;
  // Onboarding stage lookup for /popclaw status's settling-in list (is settling-in incomplete?).
  readonly onboardingState: OnboardingStateRepository;
  // S4.1-T3: world clients shared between orchestrator act2 and world tools.
  readonly guideClient: GuideClient;
  readonly summaryClient: WorldSummaryClient;
  // ADR-0019: mark snapshot store + execution service.
  readonly marksStore: MarksStore;
  readonly markService: MarkService;
  // Plan B bond-book: relationship-bond store (a bond record is opened the moment
  // there's any interaction + follow projection).
  readonly bondsStore: BondsStore;
  /**
   * The single name chain: alias > self-declared name (bond book ∪ server) >
   * world-feed handle > ''. Anywhere a popclaw_id needs to become a name the
   * owner recognizes, pull it from here — don't hand-roll another one.
   */
  readonly nameOf: NameChain;
  // Social log (the raw-material warehouse for the night digest, ADR-0023 Revision
  // 2026-07-26). Used by collection points to record entries; may be undefined
  // before the writer is wired up (very early in boot) = that entry just isn't recorded.
  readonly socialLog: SocialLogRecorder;
  /**
   * The notification queue. Shared, not host-specific: both roots build one,
   * and anything a tool can say on one root it must be able to say on the
   * other — a tool that enqueues under MCP and goes silent on the native host
   * is the worst kind of broken, because nothing reports it.
   */
  readonly notifier: Notifier;
  readonly proposalsStore: ProposalsStore;
  readonly llmComplete: (prompt: string) => Promise<string>;
}
