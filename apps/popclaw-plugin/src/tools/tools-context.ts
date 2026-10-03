/**
 * The shared foundation every popclaw tool-registration module sits on: the
 * dependency bag the composition roots hand in, and the small helpers more
 * than one domain needs (the social log, the observed owner language). The
 * result tail every tool goes through is `withTail` in tool-tail.ts; person
 * resolution is person-sources.ts.
 *
 * Split out of register-tools.ts (2026-08-25) so the domain modules can share
 * these without importing back from register-tools.ts, which would make the
 * import graph circular.
 */

import { reportOwnerLang } from '../lexicon/owner-language.js';
import type { OnboardingOrchestrator } from '../onboarding/orchestrator.js';
import type { WorldSummaryResult, WorldSummaryResponse } from '../world/world-summary-client.js';
import type { SocialLogRecorder } from '../social-log/social-log.js';
import type { ResolveCandidate } from '../identity/follow-resolution.js';
import type { PluginRuntime } from '../runtime/plugin-runtime.js';
import type { SubagentSurface } from '../newspaper/dedicated-session.js';
import type { DraftReviewFiles } from './draft-store.js';

// --- S4.1-T3: world tools collaboration surface (fake-friendly minimal shapes) ---

/**
 * Minimal projection of a WorldFeedClient.fetchSnapshot item (pbjs
 * IWorldFeedItem compatible). For popclaw-native rows `platformPostId` IS the
 * event_id (lore-house http/world_feed.rs maps platform_post_id =
 * env.event_id), so `/post/<first 10 chars of platformPostId>` is the canonical web link.
 */
export interface WorldSnapshotItemLike {
  readonly authorPopclawId?: string | null;
  readonly actorNickname?: string | null;
  readonly platform?: string | null;
  readonly textPreview?: string | null;
  readonly platformPostId?: string | null;
  /** Mirror posts carry the source-platform URL (the "view original" rule). */
  readonly originalUrl?: string | null;
  /** proto int64 — could be number/Long/string; normalized via numberOrZero (epoch seconds). */
  readonly platformPostCreatedAt?: unknown;
  /** ADR-0029 full signed event body; falls back to textPreview when missing (legacy / over 256KB). */
  readonly envelope?: Uint8Array | null;
}

/**
 * Dependencies for the four world tools. Same client instances as the
 * onboarding orchestrator's act2 wiring (same source, same criteria — no second aggregation
 * pipeline); resolved lazily via getWorldDeps, mirroring getOrchestrator.
 */
export interface WorldToolsDeps {
  guideClient: { fetchGuideText(): Promise<string | null> };
  summaryClient: {
    fetchSummary(windowHours?: number): Promise<WorldSummaryResponse | null>;
    fetchSummaryResult?(windowHours?: number): Promise<WorldSummaryResult>;
  };
  snapshotClient: {
    fetchSnapshot(q: {
      limit?: number;
      author?: string;
    }): Promise<WorldSnapshotItemLike[]>;
  };
  /** Resolving a person (ADR-0028): resolve a sigil / name / handle to followable candidates. */
  resolveClient: {
    resolve(q: { sigil?: string; name?: string }): Promise<ResolveCandidate[] | null>;
  };
  webBaseUrl: string;
  /**
   * ADR-0041 "mount a lore-house and you're playing": the guide text for each mounted
   * **non-primary** lore-house (fetched at handshake time, the copy cached under data/).
   * Read from disk synchronously, so a mounted house still has a guide to talk about.
   * Missing this field = only the primary house's guide is discussed
   * (partial test wiring / single-house deployment).
   */
  mountedGuides?: () => ReadonlyArray<{ slug: string; houseName: string; guide: string }>;
}

export interface RegisterToolsDeps {
  api: {
    registerTool: (tool: unknown, opts?: unknown) => void;
    logger?: { info: (m: string) => void };
  };
  runtime: () => Promise<PluginRuntime>;
  /** Installed roots capture business-command participation and drain its work. */
  runCommand?: (work: () => Promise<unknown>) => Promise<unknown>;
  /**
   * Where "attachments the owner handed over" live — **injected by each host's own
   * assembly root; the tool itself knows no host conventions at all**.
   *
   * This field is host knowledge, not popclaw knowledge: OpenClaw's entry point
   * (index.ts) gives `<stateDir>/media/inbound` per its own convention; the MCP
   * bridge (mcp.ts) gives its own if it knows one, or nothing if it doesn't.
   * The tool only has to "list the most recent files in these directories" —
   * switching hosts needs zero lines changed here.
   *
   * Empty / not provided = this host doesn't tell us where the owner's files are.
   * The tool still registers (#585) and says exactly that, so the agent asks the
   * owner for the path instead of making one up and hitting a wall. It used to
   * not register at all, which read as honest degradation but left
   * `popclaw_draft_message`'s description pointing at a tool that wasn't there —
   * on MCP, where nothing ever named a directory, that was every session.
   *
   * Note this is a **separate axis** from "whether the file gets saved to disk at all":
   * whether it's saved is decided by the **channel adapter** (real-hardware testing shows
   * Telegram/Feishu do save to disk, while WeChat converts voice to text and
   * **never saves to disk**); where it's saved is decided by the **host**.
   */
  inboundMediaDirs?: readonly string[];
  /**
   * Where long drafts' read-only review copies are written
   * (`draft-review.ts`). Host knowledge like the field above, injected by the
   * one root whose host is proven to open such a file from a chat link: the
   * MCP root. Absent (the native root) = no review copies, no link and no
   * compact dialog, exactly as before. A thunk is resolved at the first draft
   * mint, not at registration (ADR-0035): making the directory touches disk.
   */
  draftReviewFiles?: DraftReviewFiles | (() => DraftReviewFiles | null);
  /**
   * Fetches one picture, for baking the faces into a published issue
   * (`newspaper/avatar-inline.ts`). Injected at the assembly root rather than
   * reached for here, so a unit test that never wires it **cannot** touch the
   * network — the faces simply stay remote urls, which is what they were before.
   */
  fetchImage?: (url: string) => Promise<{ bytes: Uint8Array; type: string } | null>;
  /**
   * S3-T5: lazy getter that resolves the shared orchestrator instance.
   * Using a getter instead of the instance directly lets register() remain
   * synchronous (OpenClaw constraint) while still sharing the singleton that
   * was created inside runtimePromise. Providing this enables the three
   * onboarding tools; if absent the tools are not registered.
   */
  getOrchestrator?: () => Promise<OnboardingOrchestrator>;
  /**
   * S4.1-T3: lazy getter for the world clients (guide/summary/snapshot +
   * webBaseUrl), same lazy pattern as getOrchestrator. Providing this enables
   * the four world tools (guide/summary/author_latest/follow) and name
   * resolution in popclaw_show_feed; if absent they are not registered /
   * feed falls back to raw popclaw_id filtering.
   */
  getWorldDeps?: () => Promise<WorldToolsDeps>;
  /**
   * The host's plugin-runtime subagent surface (api.runtime.subagent), when the
   * composition root has one — the OpenClaw gateway does, the MCP bridge does
   * not. Providing this is what lets popclaw_newspaper dispatch the paper into a
   * dedicated child session (2026-09-03 cut 1); without it the tool honestly
   * keeps producing the paper in the current session, the budgetKnown()
   * precedent. LAZY on purpose: the surface is request-scoped and may only be
   * touched inside a tool execute, never at registration time.
   */
  getSubagent?: () => SubagentSurface | undefined;
  /**
   * The gateway's owner-notifier push (the newspaper dispatch's belt-and-braces
   * channel delivery — 2026-09-03 cut 1). Lazy like getSubagent: the notifier
   * only exists once the runtime has booted. Not provided (the MCP bridge, test
   * rigs) = the dispatch simply skips the channel push; the tool receipt still
   * carries everything. Deliberately NOT read off the shared runtime bag —
   * ownerNotifier is a gateway-only slot, and the PluginRuntime contract keeps
   * those out (see tests/unit/runtime-contract.test.ts).
   */
  getOwnerPush?: () => Promise<{ deliverNow(text: string): Promise<boolean> } | undefined>;
  /**
   * The newspaper workshop's model profile — plugin config `newspaper.model`
   * (2026-09-03 cut 2). Lazy like getOwnerPush: the parsed config only exists
   * once the runtime has booted. Resolves to undefined when unset or empty,
   * which means "follow the host's default model" (the dispatch then omits
   * the model key entirely — no host-side authorization needed). Not provided
   * (the MCP bridge, which has no subagent surface anyway, test rigs) = same
   * as unset.
   */
  getNewspaperModel?: () => Promise<string | undefined>;
  /**
   * ADR-0051 S3: lazy resolver for the house-lifecycle command context (the
   * resident coordinator binding + language lane). Lazy like the other
   * request-scoped slots: the resident only exists once the runtime has
   * booted; not provided (test rigs, hosts without the resident) = the
   * login/logout tools are not registered (honest degradation).
   */
  getHouseCommandContext?: () => Promise<
    import('../commands/popclaw-house.js').HouseCommandContext
  >;
  /** Frozen world tools use the same lazy, trusted command context in every host. */
  getWorldCommandContext?: () => Promise<import('../commands/popclaw-world.js').WorldCommandContext>;
  /**
   * The house's own declaration of one action kind's parameters — what the
   * owner-approval dialog is allowed to draw a row for.
   *
   * Each root supplies the cheapest honest source it has: the native root a
   * non-igniting read of an already-started runtime, the MCP root an awaited
   * one, because asking is already asynchronous there. ABSENT MEANS "cannot
   * tell", which refuses: a root that cannot say what the house declared must
   * not render a dialog built out of whatever the model sent.
   */
  declaredWorldActionParameters?: (house: string, kind: string) => unknown | Promise<unknown>;
  /** Only the native root binds actual host factory context; absent in MCP/CLI
   *  roots. It leaves `ownerConfirmationRef` unset: there is no owner dialog on
   *  that path, so there is nothing for the caller to correlate against.
   *
   *  IT ALSO DECIDES WHETHER THE WORLD OWNER-APPROVAL SUBJECT IS DECLARED.
   *  `registerWorldInteractionTools` registers that subject only when this
   *  slot is present, because only the native host suspends the tool call
   *  around its own approval prompt; the MCP root wraps every tool in a
   *  dispatch-time prompt of its own, and the world tool already asks inside
   *  its body. A new root that sets this slot is saying "my host asks the way
   *  OpenClaw does" — the reasoning is at the registration. */
  bindNativeWorldInvoke?: (hostContext: unknown) => <T>(callId: string,
    input: Readonly<import('../world/action-client.js').WorldInvokeInput>, signal: AbortSignal | undefined,
    work: (context: import('../commands/popclaw-world.js').WorldCommandContext,
      ownerConfirmationRef?: string) => Promise<T>) => Promise<T>;
  /** The MCP root's per-call owner confirmation. No host factory context exists
   *  under MCP (the collector resolves factory-form tools with `{}`), so this
   *  binder takes none; absent in the native/CLI roots. It passes the reference
   *  the owner just read in the dialog, so the tool result can repeat it. */
  bindMcpWorldInvoke?: () => <T>(callId: string,
    input: Readonly<import('../world/action-client.js').WorldInvokeInput>, signal: AbortSignal | undefined,
    work: (context: import('../commands/popclaw-world.js').WorldCommandContext,
      ownerConfirmationRef?: string) => Promise<T>) => Promise<T>;
}

/**
 * What every `register<Domain>Tools` receives: the `withTail`-wrapped api, the
 * runtime getter, the original dependency bag, and the tool count for this
 * process (`popclaw_feedback`'s doctor report needs it, and it is a pure
 * function of which lazy deps were provided, so it is computed up front).
 */
export interface ToolsCtx {
  readonly api: RegisterToolsDeps['api'];
  readonly runtime: RegisterToolsDeps['runtime'];
  readonly deps: RegisterToolsDeps;
  readonly total: number;
}

/**
 * S1 observation lane: the agent's read of what the owner has actually been
 * speaking (`owner_language` on the onboarding and dream tools). Loses to an
 * explicitly configured `primaryLanguage`, and any later observation replaces
 * it — it is a live reading, not a setting.
 *
 * Persisted to `data/owner-language.json`, deliberately **not** to cadence.json:
 * a value there returns as `explicitDelivery` next boot, i.e. an observation
 * would promote itself into an instruction and lock the owner out of switching.
 * Never throws — noticing a language must not fail the owner's turn.
 */
export function noteOwnerLanguage(tag: unknown): void {
  if (typeof tag === 'string') reportOwnerLang(tag, 'agent');
}

/**
 * Fetch the social-log recording hook from runtime. If runtime isn't ready /
 * was never injected at all (test stubs are often just `vi.fn()`, returning
 * undefined instead of a Promise) → undefined = don't record this entry.
 * Fetching the log must never break the tool itself.
 */
export async function socialLogOf(
  runtime: RegisterToolsDeps['runtime'],
): Promise<SocialLogRecorder | undefined> {
  try {
    const rt = (await runtime()) as { socialLog?: SocialLogRecorder } | null | undefined;
    return rt?.socialLog;
  } catch {
    return undefined;
  }
}
