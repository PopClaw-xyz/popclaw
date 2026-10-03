/**
 * `popclaw status` — the owner's identity check-up report: who I am + my current
 * standing in the world + what I'm still missing.
 * (spec docs/superpowers/specs/2026-07-25-status-friendliness-redesign.md, slice P)
 *
 * Plain text, no borders, no padEnd alignment (phones will break lines): emoji
 * section headers + short lines. Two readers: the slash command shows this
 * directly to a human; the `popclaw_check_status` tool path hands it to the
 * host LLM to paraphrase, so every todo spells out the full command — the LLM's
 * paraphrase mustn't drop the action guidance.
 *
 * Verification status comes from lore-house GET /v1/profile/:id. **404 is not
 * "unreachable"** — it's the legitimate "no verified account yet"; a network
 * error / non-404 is what counts as unreachable, and in that case we'd rather
 * under-report than over-report: don't show the ✓ line, and don't list
 * "unverified" as a todo either (can't look it up ≠ doesn't exist). **200 with
 * an EMPTY body is the same "no verified account yet"**, not a parse failure
 * — the conformant answer (PR #613/#614, 2026-09-14) both the Rust LoreHouse
 * and the reference server give for an identity they have never seen,
 * deliberately in place of 404.
 *
 * `loreHouseReachable = false` still covers "can't trust what this fetch told
 * us" (network failure, 401/403, 5xx, a NON-empty unparseable body) and still
 * suppresses the ✓ line and the verify/namecard todos — that gating is
 * unchanged. What changed is what the owner is *told*: `identityCheckFailure`
 * names which of those it was, so only a genuine transport failure (fetch
 * itself throwing — refused/timeout/DNS/TLS) gets called "down"; a house that
 * answered, even with an error, is reported as having answered with an error
 * (its HTTP code included), not as being down.
 */

import type { Signer } from '../identity/signer.js';
import { LORE_HOUSE_TIMEOUT_MS } from '../world/http-timeout.js';
import type { HostAdapter } from '../host/host-adapter.js';
import type { SocialGraph } from '../social-graph/social-graph.js';
import type { BondsStore } from '../bonds/bonds-store.js';
import { isAtLeast } from '../bonds/bond-tier.js';
import { deriveSigil } from '../invite/sigil.js';
import { formatPerson, displayPerson } from '../identity/person-resolver.js';
import type { NameChain } from '../identity/person-name.js';
import { platformLabel, type VerifiedProfileInput } from '../identity/passport-renderer.js';
import { profileLinkText } from '../lshow/sources/web-fallback.js';
import { readNameSource, isPlaceholderNickname } from '../onboarding/identity-writer.js';
import type { DreamCronState } from '../dreamer/dream-cron.js';
import { listGaps, tasteSeededOf } from '../onboarding/settling-gaps.js';
import { timeContext } from '../time/time-context.js';
import { lexiconFor, renderCopy, type Lang } from '../lexicon/index.js';
import { ownerLang } from '../lexicon/owner-language.js';
import { routingStats, type RoutingStats } from '../routing/stats.js';
import { routingLine } from '../routing/status-line.js';
import { configReport, langSourceCopyKey, tzSourceCopyKey, type ConfigReport } from '../host/config-report.js';
import { shortBuildStamp } from '../runtime/install-notice.js';
import { houseReadStanding, readAuthRefusalMessage } from '../identity/read-authority.js';
import { listParticipation } from '../runtime/house-lifecycle/participation-store.js';
import { normalizeHouseOrigin } from '../runtime/house-lifecycle/control-client.js';
import type { HostDb } from '../host/host-db.js';
import { ActionInactiveError } from '../runtime/house-lifecycle/action-context.js';
import { isDreamStale, planStatusNextSteps, withOutdatedNewspaperRules, renderStatusNextSteps } from './status-next-steps.js';

// Preserve existing consumers of the status formatting and dream helpers.
export { routingLine } from '../routing/status-line.js';
export { splitAtOr, isDreamStale, dreamTodo } from './status-next-steps.js';

/**
 * Every house this machine is in: the configured ones first and in config
 * order, then the ones joined at runtime with `popclaw_house_login`.
 *
 * A login writes `house_participation` and never `config.lore_houses`, so
 * enumerating the config alone told the owner that a house they are logged in
 * to does not exist — and a restart could not fix it, because the config still
 * listed one house. `house-runtime.ts` already unions the same two sources
 * when it decides which houses to mount; this is the readout agreeing with it.
 *
 * `desired` is the intent, so a house that was LEFT drops off again — its row
 * stays behind for the outbox, and a leave must never read as a live login.
 * Dedupe is by canonical origin: the config may spell a house with a trailing
 * slash that the participation row has already normalized away.
 */
function statusHouses(db: HostDb, configured: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (origin: string): void => {
    let key: string;
    try {
      key = normalizeHouseOrigin(origin);
    } catch {
      // An unparseable configured origin is still the owner's own line to see:
      // the standing lookup below reports it, it just cannot be deduped.
      key = origin;
    }
    if (seen.has(key)) return;
    seen.add(key);
    out.push(origin);
  };
  for (const origin of configured) push(origin);
  try {
    for (const row of listParticipation(db)) {
      if (row.desired === 'enabled') push(row.house_origin);
    }
  } catch {
    // The lifecycle tables are created when the first house is mounted; a
    // machine that never joined one legitimately has none.
  }
  return out;
}

/**
 * Roster resolution = the single name chain + a not-found fallback: alias →
 * self-reported name → world-feed handle → `—`. If the chain isn't wired in
 * (some test setups), treat it uniformly as not found.
 */
export function followDisplayName(id: string, nameOf: NameChain | undefined): string {
  return nameOf?.(id) || '—';
}

export interface StatusCommandDeps {
  readonly signer: Signer;
  readonly host: HostAdapter;
  readonly loreHouseUrl: string;
  readonly fetch: typeof globalThis.fetch;
  readonly logger?: { info(msg: string): void };
  readonly socialGraph?: Pick<SocialGraph, 'following'> &
    Partial<Pick<SocialGraph, 'followingByHouse'>>;
  /** Bootstrap-derived nickname; used to render the canonical handle when
   *  no popclaw-platform verified row exists yet. */
  readonly nickname?: string;
  /** Pinned proactive-notification channel (auto-captured or /popclaw notify-here), or null. */
  readonly notifyTarget?: { deliveryContext?: { channel?: string } } | null;
  /** Channel this very invocation came from; undefined on the CLI / tool path. */
  readonly currentChannel?: string;
  /** The single name chain (alias > self-reported name > world-feed handle); if not injected, treat as uniformly not found. */
  readonly nameOf?: NameChain;
  /** popclaw.me base URL; defaults to the resolver (config → env → popclaw.me). */
  readonly webBaseUrl?: string;
  /** Build stamp, appended as the last line. Slash-command path only — the
   *  tool path omits it (the host LLM has no use for it). */
  readonly buildStamp?: string;
  /**
   * `PopclawPaths.cadenceDir()`. Present → the footer reports where the config
   * file is and what language/timezone it actually produced (`configLines`).
   * Absent (tests, the dev CLI) → those two lines are simply omitted.
   */
  readonly cadenceDir?: string;
  /**
   * Install credential (`runtime/last-build.ts`, the `previous` field in
   * `data/last-build.json`). Only has a value when a build change actually
   * happened — for an owner coming back after a gateway restart interrupted a
   * turn, this line is how they know "yes, the new version really did get
   * installed just now." The wording must name the popclaw plugin explicitly —
   * it must not be read as an openclaw (host) upgrade.
   */
  readonly lastBuildUpgrade?: { from: string; to: string; recordedAt: string } | null;
  /** Bond book counts. */
  readonly bondsStore?: Pick<BondsStore, 'list'>;
  /** Number of people who have DMed me = COUNT(DISTINCT from_popclaw_id) over the inbox table. */
  readonly dmSenderCount?: () => number;
  /** Onboarding stage. Kept on the interface (callers still pass it), but the
   *  "finish settling in" todo has been removed (onboarding plan C spec §4:
   *  funnel language doesn't belong in the todo list). */
  readonly onboardingStage?: (popclawId: string) => string | null;
  /**
   * The taste read port (shape of TasteLoader.enabledSources; structural
   * injection is enough). Used for the "no taste seed" todo (plan C spec §4 ②,
   * the attune-skip landing spot): empty core-layer body text = no seed — same
   * criterion as orchestrator.coreTasteText. Not injected, or the read fails,
   * → don't list the todo (can't look it up ≠ doesn't exist, same principle as
   * dreamCron).
   */
  readonly tasteLoader?: {
    enabledSources(): Promise<ReadonlyArray<{ path: string; content: string }>>;
  };
  /**
   * The two-reader split (spec Revision 2026-07-26). `'human'` (default, slash
   * command) is for a person to read: following shows only `name#sigil`, and
   * only one todo is given. `'agent'` (`popclaw_check_status`) is for the host
   * LLM to paraphrase: it gets the full popclaw_id so it can act directly, and
   * all 3 todos — an LLM doesn't get decision paralysis.
   */
  readonly audience?: 'human' | 'agent';
  /**
   * The social-log read port (`readSocialLog(dir, fromSec, toSec)` injected
   * with `dir` already bound). This is status's only source of "delta" — without
   * it, status is a static ID photo, and there's no point looking at it a
   * second time. Runs fine without it too: the whole "this week" block is
   * simply omitted.
   */
  readonly socialLog?: (fromSec: number, toSec: number) => readonly { kind: string; actor?: { id?: string } }[];
  /**
   * ADR-0040: an in-progress (unexpired) verification request. If present, we
   * report "verification in progress" and suppress the "unverified" todo —
   * someone already waiting shouldn't be nagged again.
   */
  readonly pendingInvites?: () => ReadonlyArray<{ platform: string; handle: string }>;
  /** ADR-0040 lazy-check compensation: after a process restart the polling loop is dead, so as soon as the owner speaks up we ask the lore-house on their behalf. */
  readonly checkPendingInvites?: () => Promise<void>;
  /**
   * #236 kill ②: retry the notification queue the moment the owner speaks,
   * instead of waiting for the next inbound event to drag the backlog along.
   * On a real machine one L1 sat queued for two days because nothing else
   * arrived. Same lazy-compensation shape as `checkPendingInvites` above.
   */
  readonly drainNotifications?: () => Promise<void>;
  /** #236 kill ①: how many notifications are still waiting, and why the last
   *  send failed. Read AFTER the drain above, so a backlog it just cleared is
   *  not reported as still stuck. */
  readonly notifyBacklog?: () => { count: number; lastFailureAt?: number; lastFailureReason?: string };
  /**
   * Timestamp (seconds) of the last effective dream write-back; null = no
   * recorded write-back. This is not a last-attempt timestamp; an empty
   * material window leaves this record unchanged.
   */
  readonly lastDreamAt?: number | null;
  /**
   * Whether the dream cron job is scheduled. `undefined`/`null` = can't tell →
   * fall back to neutral wording (can't look it up ≠ not scheduled, same
   * principle as "don't list the verification todo when the lore-house is
   * unreachable").
   */
  readonly dreamCron?: DreamCronState;
  /**
   * Files in the daily-paper rulebook that the owner has edited, but whose
   * language/template version has since moved on (`newspaperRulesOutdated`).
   * Seeding writes a hash stamp, and an edited file is **never overwritten**
   * (P-006) — so all we can do is mention it here. Not injected / empty array
   * = say nothing (the overwhelming common case).
   */
  readonly outdatedNewspaperRules?: () => readonly string[];
  readonly now?: () => number; // seconds, test seam
  /** Test seam — defaults to `ownerLang()` (S1 process-wide singleton). */
  readonly lang?: Lang;
  /**
   * The configured houses (`config.lore_houses`). Absent → the block is
   * omitted entirely (the dev CLI and every pre-existing test). Present → this
   * is the FIRST half of the house list; the houses joined at runtime with
   * `popclaw_house_login` are unioned in from `house_participation` (see
   * `statusHouses`), because nothing ever writes those back into the config.
   *
   * What each of them declared is no longer passed in: it is the verified
   * projection the read path itself consults, read from the same database
   * through the same resolver, so the two can never describe different houses.
   */
  readonly configuredHouses?: readonly string[];
  /** Test seam — defaults to the live process-wide routing counters (#374).
   *  Same-process as the hook, so no plumbing at the call sites. */
  readonly routingStats?: () => RoutingStats;
}

/**
 * The "this week" window: a fixed 7 days, not "since last checked."
 *
 * "Since last checked" has an unread-badge feel, but it would require storing
 * a last-seen timestamp (one more piece of state), and checking status
 * frequently would show an empty window a lot. A fixed window has stable
 * semantics and isn't awkward when it comes up empty — the longer sense of
 * time is left to the curve on the status graph.
 */
const WEEK_SECONDS = 7 * 24 * 60 * 60;

/** Only these five kinds feed the "pulse": two things others do for me + three
 *  things I do. The rest (mark/person_asked/follow_removed) are raw material
 *  for the dream mechanism, not an answer to "how was this week." */
interface WeeklyPulse {
  readonly repliers: number;
  readonly dms: number;
  readonly dmsSent: number;
  readonly posts: number;
  readonly follows: number;
}

export function summarizeWeek(
  records: readonly { kind: string; actor?: { id?: string } }[],
): WeeklyPulse {
  // Replies are counted by "how many people," not "how many messages": three replies from the same person is one conversation, not three separate acts of attention.
  const repliers = new Set<string>();
  let dms = 0;
  let dmsSent = 0;
  let posts = 0;
  let follows = 0;
  for (const r of records) {
    if (r.kind === 'reply_received') repliers.add(r.actor?.id ?? '');
    else if (r.kind === 'dm_received') dms += 1;
    else if (r.kind === 'dm_sent') dmsSent += 1;
    else if (r.kind === 'post_sent') posts += 1;
    else if (r.kind === 'follow_added') follows += 1;
  }
  return { repliers: repliers.size, dms, dmsSent, posts, follows };
}

/**
 * Section headers get their own line. On a phone, once a heading has to
 * compete with content on the same line, it both dilutes the heading's role
 * as a visual anchor and pushes that line to a length that's bound to wrap
 * (real-device screenshot: the Chinese heading 「你的江湖」("Your World") plus
 * four numbers crams 27 characters onto one line, but a phone only fits 16
 * per line).
 *
 * Indentation has been dropped entirely: a wrapped continuation line will
 * always end up flush-left regardless, so there's no point maintaining a left
 * margin we can't actually hold. Hierarchy is instead carried by blank lines
 * + bold sub-headings + monospace blocks. The ID explainer text has also been
 * removed — teaching copy belongs in onboarding, not permanently parked in
 * the header of a high-frequency command; it was the only long paragraph on
 * the page.
 */
/**
 * How many cells a character occupies. CJK characters and full-width
 * punctuation occupy 2; everything else occupies 1.
 *
 * Used by the line-width guard in the tests: a phone fits ~15 full-width
 * cells per line, and every line we emit has to fit without wrapping.
 * Counting characters would undercount by half on a Chinese line — 回你的话
 * is 4 characters but occupies 8 cells.
 */
export function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    const wide =
      (c >= 0x1100 && c <= 0x115f) || // Hangul Jamo
      (c >= 0x2e80 && c <= 0xa4cf) || // radicals / kana / bopomofo / CJK ideographs
      (c >= 0xac00 && c <= 0xd7a3) || // Hangul syllables
      (c >= 0xf900 && c <= 0xfaff) || // CJK compatibility ideographs
      (c >= 0xfe30 && c <= 0xfe6f) || // vertical punctuation / small-form variants
      (c >= 0xff00 && c <= 0xff60) || // fullwidth alphanumerics and punctuation (incl. （）)
      (c >= 0xffe0 && c <= 0xffe6);
    w += wide ? 2 : 1;
  }
  return w;
}

function shortenId(id: string): string {
  return id.length <= 17 ? id : `${id.slice(0, 8)}…${id.slice(-8)}`;
}

/**
 * `recordedAt` (ISO 8601 UTC) → the owner's wall clock, `YYYY-MM-DD HH:MM`
 * (ADR-0045). Truncating the ISO string instead printed UTC: a package
 * installed at 22:15 in +08 was reported as "upgraded at 14:15", on the wrong
 * day either side of midnight.
 *
 * A stamp we cannot parse is shown raw — a garbled timestamp beats `NaN-NaN-NaN`.
 */
function formatUpgradeTime(recordedAt: string): string {
  const ms = Date.parse(recordedAt);
  if (Number.isNaN(ms)) return recordedAt;
  const t = timeContext(Math.floor(ms / 1000));
  return `${t.ymd} ${t.hm}`;
}

/**
 * The notification-channel line. With zero-config auto-capture the target is
 * almost always set, so the useful information is "is it here or not," not
 * the raw channel name. `current` empty = CLI / tool path (no session
 * channel) → just report the channel name, don't guess.
 */
function notifyLine(pinned: string, current: string | undefined, lang: Lang): string {
  if (!pinned) return renderCopy(lang, 'status.notify.unset');
  const channel = channelLabel(pinned, lang);
  if (!current) return renderCopy(lang, 'status.notify.pinned', { channel });
  if (current === pinned) return renderCopy(lang, 'status.notify.pinnedHere');
  return renderCopy(lang, 'status.notify.pinnedElsewhere', { channel });
}

/**
 * Host channel id → what the owner calls the place. `openclaw-weixin` is a
 * plugin id, not a place — the owner reads it as something leaking out, not
 * as information. An id with no registered name goes out unchanged: a
 * confidently wrong name is worse than a raw one, and there's nothing to
 * guess from.
 */
function channelLabel(id: string, lang: Lang): string {
  return lexiconFor(lang).copy[`status.channel.${id.replace(/^openclaw-/, '').toLowerCase()}`] ?? id;
}

/**
 * The two config lines in the footer: **where the config file is** (absolute,
 * and whether it is even there) and **what language/timezone came out of it,
 * with the provenance of each**.
 *
 * Why it earns footer space on a report that is otherwise curated: on
 * 2026-07-31 the cadence file got written to `data/cadence/` while the loader
 * reads `config/cadence/` — on three machines, with no error and no log line.
 * Nothing on any surface could tell "en-US because you said so" apart from
 * "en-US because I never found your file", and one machine served an English
 * newspaper to a Chinese owner for weeks. Unlike the routing line this is
 * printed on the agent path too: MCP hosts have no slash commands at all, so
 * for a Claude Code / Codex owner the tool path is the only surface there is.
 */
export function configLines(r: ConfigReport, lang: Lang): string[] {
  return [
    renderCopy(lang, r.cadenceFound ? 'status.config.path' : 'status.config.pathMissing', {
      path: r.cadencePath,
    }),
    renderCopy(lang, 'status.config.effective', {
      lang: r.langTag,
      langFrom: renderCopy(lang, langSourceCopyKey(r.langSource)),
      tz: r.tz,
      tzFrom: renderCopy(lang, tzSourceCopyKey(r)),
    }),
  ];
}

export async function runStatusCommand(deps: StatusCommandDeps): Promise<{
  popclawId: string;
  sigil: string;
  verifiedProfiles: VerifiedProfileInput[];
  following: string[];
}> {
  const popclawId = await deps.signer.popclawId();
  const sigil = deriveSigil(popclawId);
  const info = deps.logger?.info.bind(deps.logger) ?? ((msg: string) => console.log(msg));
  const lang = deps.lang ?? ownerLang();
  const L = lexiconFor(lang).terms.status;

  // ADR-0040 lazy-check compensation: ask the lore-house once before reading
  // the ledger, so the "in progress" line is never actually a stale request
  // that already settled. If the lore-house is unreachable, keep showing "in
  // progress" as before (better to under-report than falsely claim it settled).
  await deps.checkPendingInvites?.().catch(() => undefined);
  // Retry the queue before reading it (#236). A failing channel must not make
  // the status command itself fail — the whole point here is to REPORT trouble.
  await deps.drainNotifications?.().catch(() => undefined);
  const pendingInvites = deps.pendingInvites?.() ?? [];

  const endpoint = `${deps.loreHouseUrl.replace(/\/$/, '')}/v1/profile/${encodeURIComponent(popclawId)}`;
  let profiles: VerifiedProfileInput[] = [];
  // `?? ` let an EMPTY nickname through ('' is not nullish), and an empty
  // handle renders as `popclaw.me//<sigil>` — a dead link. The bootstrap's own
  // fallback is the placeholder name, and the owner's own card falls back to
  // the same one (profile.ts ownCard), so the two surfaces agree in every case.
  let nickname = deps.nickname?.trim() || `ranger-${popclawId.slice(0, 6)}`;
  let handle = nickname;
  // Number of people following me on this lore-house (house_follower_count,
  // spec 2026-07-26) — this is this lore-house's own local follower count,
  // not a network-wide aggregate; null when it can't be looked up (lore-house
  // unreachable), never pretend it's 0.
  let houseFollowerCount: number | null = null;
  // Lore-house reachable = 200 (including 200 + empty body) or 404 — both
  // are "no verified account yet", a normal state, not "unreachable".
  let loreHouseReachable = true;
  // Which lantern-down sentence (if any) to show at the bottom of the
  // identity block. Three transport-distinct outcomes, all of which used to
  // be flattened into `loreHouseReachable = false` → one blanket "down" line
  // (a real defect: a house answering 401/403/5xx, or 200 with a body we
  // couldn't parse, is up — calling it "down" points a debugging owner at
  // the wrong fix). `null` covers both success and the 404 "no verified
  // account yet" case, neither of which is a failure worth naming here.
  let identityCheckFailure: 'unreachable' | 'notAsked' | 'serverError' | 'authError' | null = null;
  let identityCheckStatus: number | undefined;
  // Whether the home lore-house has my namecard (based on whether the `card`
  // field is present, not the HTTP status code — a 200 with no card also
  // counts as "no").
  let cardOnHouse = false;
  let resp: Awaited<ReturnType<typeof deps.fetch>> | undefined;
  try {
    resp = await deps.fetch(endpoint, { signal: AbortSignal.timeout(LORE_HOUSE_TIMEOUT_MS) });
  } catch (error) {
    // The fetch itself never landed: connection refused, timeout, DNS, TLS —
    // this is the only case that actually means "the house is down". A read
    // this host refused to send (the house action gate is not active here)
    // never reached the network, so it says nothing about the house (R17-D1).
    loreHouseReachable = false;
    identityCheckFailure = error instanceof ActionInactiveError ? 'notAsked' : 'unreachable';
  }
  if (resp) {
    if (resp.ok) {
      try {
        // Read as text first, not resp.json() directly: 200 + an EMPTY body
        // is the conformant "nobody by that id yet" answer (PR #613/#614,
        // 2026-09-14) — both the Rust LoreHouse and the reference server use
        // it deliberately instead of 404. JSON-parsing an empty string
        // throws, which used to get misfiled as "the body made no sense" and
        // rendered as "down"/"answered with an error" — false either way for
        // a perfectly healthy house that simply never saw this identity.
        const text = await resp.text();
        if (text.trim() !== '') {
          const body = JSON.parse(text) as {
            house_follower_count?: number;
            profiles?: Array<{
              platform?: string;
              handle?: string;
              verified_at?: string;
              profile_url?: string | null;
              proof_url?: string;
              follower_count?: number;
            }>;
            card?: { nickname?: string } | null;
          };
          houseFollowerCount = body.house_follower_count ?? null;
          profiles = (body.profiles ?? []).map((p) => ({
            platform: p.platform ?? '',
            handle: p.handle ?? '',
            verified_at: p.verified_at ?? '',
            ...(p.profile_url ? { profile_url: p.profile_url } : {}),
            ...(p.proof_url ? { proof_url: p.proof_url } : {}),
            follower_count: p.follower_count ?? 0,
          }));
          // This is the owner's own address, so the name they declared on
          // their namecard wins. The house's popclaw-native profile row is
          // written once at registration (usually under the auto name) and
          // nothing refreshes it — preferring it made status keep printing
          // `ranger-xxxxxx` after a rename whose confirmation printed the new
          // address. The native row stays the fallback when no card exists.
          const native = profiles.find((p) => p.platform === 'popclaw');
          handle = body.card?.nickname?.trim() || native?.handle || nickname;
          cardOnHouse = Boolean(body.card);
          nickname = body.card?.nickname?.trim() || handle;
        }
        // else: empty body — leave every default as-is, exactly like the 404
        // branch below (reachable, no verified account yet, no failure).
      } catch {
        // The house answered 2xx with a NON-empty body that made no sense —
        // it is up, just misbehaving. Not "down".
        loreHouseReachable = false;
        identityCheckFailure = 'serverError';
        identityCheckStatus = resp.status;
      }
    } else if (resp.status === 404) {
      // No verified account yet — a normal state, not a failure.
    } else if (resp.status === 401 || resp.status === 403) {
      // The house answered; it refused the check. A credential problem, not an outage.
      loreHouseReachable = false;
      identityCheckFailure = 'authError';
      identityCheckStatus = resp.status;
    } else {
      // Any other non-2xx/404 (5xx and anything else unexpected): the house
      // answered with an error. Still not "down".
      loreHouseReachable = false;
      identityCheckFailure = 'serverError';
      identityCheckStatus = resp.status;
    }
  }

  // The popclaw-native row is the identity anchor (already shown in the 🏮 line), not an external endorsement → it doesn't go into the ✓ verified list.
  const external = profiles.filter((p) => p.platform !== 'popclaw');
  const following = (deps.socialGraph?.following() ?? []).map((e) => e.popclawId);
  const bonds = deps.bondsStore?.list() ?? [];
  const friends = bonds.filter((b) => isAtLeast(b.tier, 'friend')).length;
  const dmSenders = deps.dmSenderCount?.() ?? 0;
  const notifyChannel = deps.notifyTarget?.deliveryContext?.channel ?? '';
  const nameSource = await readNameSource(deps.host).catch(() => null);
  // "No taste seed": empty core-layer body text. null = can't tell (read port not wired in / read failed) → don't list.
  const tasteSeeded = await tasteSeededOf(deps.tasteLoader);
  // The nickname in local config = the source of truth for namecard content
  // (same read pattern as my-namecard.ts). Both the namecard todo's criterion
  // and its suggested command must use it — deps.nickname is a boot-time
  // snapshot that stays stale after a rename until the next restart, and
  // using it to build /popclaw name would teach the owner to rename himself
  // back to the old name.
  let localNickname = '';
  try {
    const raw = await deps.host.config.loadJson('plugin');
    const p = (raw as { ranger_profile?: { nickname?: string } } | null)?.ranger_profile;
    localNickname = typeof p?.nickname === 'string' ? p.nickname.trim() : '';
  } catch {
    // Config couldn't be read (including test stubs that don't provide host.config) → treat as no nickname, don't list the namecard todo.
  }

  const forAgent = deps.audience === 'agent';
  const lines: string[] = [];

  // ── Identity block ───────────────────────────────────────────────────
  // All flush-left. On a phone, indentation only affects the first line — a
  // wrapped continuation line is always flush-left regardless, so keeping a
  // left margin we can't actually hold is messier than just going flush-left
  // everywhere. Hierarchy is instead carried by blank lines + bold sub-headings.
  lines.push(`🏮 **${nickname}** #${sigil}`);
  // One account per line. Two accounts side by side plus a verification date
  // is bound to wrap (`✓ X @elonmusk (2026-05-20), GitHub @octocat
  // (2026-06-01)` comes out to 28 fullwidth-equivalent cells, and a phone
  // only fits 16 per line). The date belongs on the profile, not on the
  // headline — it's been moved to the status graph.
  if (loreHouseReachable) {
    for (const p of external) lines.push(`✓ ${platformLabel(p.platform)} @${p.handle}`);
  }
  // If a request is pending, add a line right under the verified list — it's part of the identity headline just like ✓ verified (ADR-0040).
  for (const p of pendingInvites) {
    lines.push(`⏳ ${platformLabel(p.platform)} @${p.handle}${L.pendingVerifySuffix}`);
  }
  // The full popclaw_id is only shown to the agent — a human won't copy it by hand, and a copyable version is on the status graph.
  if (forAgent) lines.push(renderCopy(lang, 'status.agentIdLine', { id: shortenId(popclawId) }));

  // ── This week ────────────────────────────────────────────────────────
  // Placed before the "world" block: what other people give you is given by
  // the system, todos are what you owe the system — give first, then ask.
  // This is also the only thing that makes status worth checking a second time.
  if (deps.socialLog) {
    const toSec = Math.floor((deps.now?.() ?? Date.now()) / 1000);
    const pulse = summarizeWeek(deps.socialLog(toSec - WEEK_SECONDS, toSec));
    const rows: [string, string][] = [];
    if (pulse.repliers > 0) rows.push([L.weekReplies, `${pulse.repliers} ${L.peopleUnit}`]);
    if (pulse.dms > 0) rows.push([L.weekDms, `${pulse.dms} ${L.messageUnit}`]);
    if (pulse.dmsSent > 0) rows.push([L.weekDmsSent, `${pulse.dmsSent} ${L.messageUnit}`]);
    if (pulse.posts > 0) rows.push([L.weekPosts, `${pulse.posts} ${L.postUnit}`]);
    if (pulse.follows > 0) rows.push([L.weekFollows, `${pulse.follows} ${L.peopleUnit}`]);
    // A quiet week omits the whole block — zero isn't news, and a row of 0s just makes someone not want to check next time.
    if (rows.length > 0) {
      lines.push('');
      lines.push(L.headWeek);
      for (const row of rows) lines.push(`${row[0]} ${row[1]}`);
    }
  }

  // ── World block ──────────────────────────────────────────────────────
  const realm: [string, string][] = [];
  if (following.length > 0) realm.push([L.realmFollowing, `${following.length} ${L.peopleUnit}`]);
  // "Following" is the client-side truth (who I follow); "followed by" is the
  // lore-house's-eye local in-house count (house_follower_count, spec
  // 2026-07-26), not a network-wide aggregate. The two directions are placed
  // side by side. If it can't be looked up (lore-house unreachable / an older
  // lore-house without this field), it simply doesn't appear — the ⚠️
  // unreachable line already explains why, and adding "temporarily
  // unavailable" here would spend one of the owner's lines on internal state.
  if (houseFollowerCount !== null && houseFollowerCount > 0) realm.push([L.realmFollowedBy, `${houseFollowerCount} ${L.peopleUnit}`]);
  if (bonds.length > 0) {
    realm.push([L.realmBonds, renderCopy(lang, 'status.realmBondsValue', { bonds: String(bonds.length), friends: String(friends) })]);
  }
  if (dmSenders > 0) realm.push([L.realmDmSenders, `${dmSenders} ${L.peopleUnit}`]);

  if (realm.length > 0) {
    lines.push('');
    lines.push(L.headRealm);
    for (const row of realm) lines.push(`${row[0]} ${row[1]}`);
  }
  // "Recently followed" is agent-only. For a human it's a string of sigils
  // (pure noise when the roster can't resolve a name), and three names plus
  // sigils is bound to wrap, while "following N people" is already shown in
  // the block above and `/popclaw bond` is right on the next line; for the
  // agent it's actionable material carrying full popclaw_ids — removing it
  // would leave no way to DM/follow directly.
  if (forAgent && following.length > 0) {
    const recent = [...(deps.socialGraph?.following() ?? [])]
      .sort((a, b) => b.since - a.since)
      .slice(0, 3)
      .map((e) => {
        const name = followDisplayName(e.popclawId, deps.nameOf);
        const sig = deriveSigil(e.popclawId);
        // The agent needs the full popclaw_id to DM/follow directly (ADR-0028
        // revision 2026-07-25); a human just needs to recognize who it is —
        // a 44-character base58 string would stretch one line into five.
        if (forAgent) return formatPerson({ nickname: name, sigil: sig, popclawId: e.popclawId }, lang);
        // When the roster can't resolve a name, report just the sigil: a
        // sigil is a legitimate way to refer to someone on its own, and
        // `—#xxx (roster lookup failed)` would dump an internal failure on
        // the owner. This convention is now centralized in displayPerson for
        // the whole project.
        return displayPerson(e.popclawId, name === '—' ? '' : name, lang);
      });
    lines.push(`${L.recentFollowsLabel} ${recent.join(L.listSep)}${following.length > 3 ? L.moreSuffix : ''}`);
  }
  // ADR-0037: following is declared **per lore-house**. The people count is a
  // union (each person counted once); the per-house breakdown is each
  // house's own local truth — the two numbers not matching up is normal (the
  // same person can follow you once on each of two houses). This line only
  // appears when there really are multiple houses; it's short and won't
  // wrap, so both a human and the agent see it (unlike "recently followed,"
  // which is agent-only because a string of sigils is noise to a human —
  // this per-house line isn't).
  if (following.length > 0) {
    const byHouse = [...(deps.socialGraph?.followingByHouse?.() ?? new Map())]
      .filter(([slug, entries]) => slug && entries.length > 0);
    if (byHouse.length > 1) {
      lines.push(`${L.byHouseLabel} ` + byHouse.map(([slug, e]) => `${slug} ${e.length}`).join(' · '));
    }
  }
  if (bonds.length > 0 || dmSenders > 0) lines.push(renderCopy(lang, 'status.hint.bonds'));

  // ── Houses ───────────────────────────────────────────────────────────
  // The trust is established without the owner asking for it, so this is the
  // only place they would ever learn it exists — and the only place a house
  // that is trusted but unreadable can be told apart from one where nobody
  // follows them. The refusal wording is the resolver's own (`read.auth.*`),
  // so it cannot drift from the decision that produced it.
  if (deps.configuredHouses !== undefined) {
    const houseLines: string[] = [];
    for (const origin of statusHouses(deps.host.db, deps.configuredHouses)) {
      // The standing's own key, not the configured string: a pin is filed
      // under the canonical origin, so asking with `https://House.popclaw.me/`
      // would report a house the owner is demonstrably trusted at as untrusted.
      //
      // A BLOCKED pin is not a tick, and neither is a refused read decision
      // (declared nothing / declared a scheme this build does not speak): the
      // row is still there — it is kept on purpose, so there is something left
      // to compare against when someone comes to resolve the disagreement —
      // but "a binding was saved here" is not "currently trusted and
      // readable".
      //
      // Nor is one tick enough. A house that identifies readers only through a
      // login session refuses every identity read AND serves the inbox to that
      // session's token, so `⚠️ reads … are refused there` was still on screen
      // while the stream returned 200 to a request that said exactly who was
      // asking. `houseReadStanding` answers per KIND of read, from the same
      // two places the read path reads — the verified declaration and the
      // participation row — and never from the network.
      const standing = houseReadStanding(deps.host.db, origin);
      // Scheme and trailing slash dropped: a phone line is ~30 cells and the
      // sentence below already names the origin in full.
      houseLines.push(
        renderCopy(lang, standing.kind === 'refused' ? 'status.house.untrusted' : 'status.house.trusted', {
          origin: standing.origin.replace(/^https?:\/\//, '').replace(/\/+$/, ''),
        }),
      );
      if (standing.kind === 'refused') {
        // The resolver's own wording, so the reason cannot drift from the
        // decision that produced it.
        houseLines.push(
          readAuthRefusalMessage(standing.refusal, standing.origin, lang, standing.sessionLane),
        );
      } else if (standing.kind === 'session-inbox') {
        // Three things, separately. The session lane covers private messages
        // and nothing else: this house grants no credential for the follower
        // list or the relation history behind it. All three or none — a bare
        // ✅ would let an empty follower list be read as "nobody follows me",
        // and the single "reads … are refused there" was still on screen
        // while the inbox stream returned 200 to a request that said exactly
        // who was asking.
        houseLines.push(renderCopy(lang, 'status.house.loggedIn', { origin: standing.origin }));
        houseLines.push(renderCopy(lang, 'status.house.dmViaSession', { origin: standing.origin }));
        houseLines.push(renderCopy(lang, 'status.house.noRelationReads', { origin: standing.origin }));
      }
    }
    if (houseLines.length > 0) {
      lines.push('');
      lines.push(...houseLines);
    }
  }

  // ── Todo block ───────────────────────────────────────────────────────
  // Priority order = onboarding plan C spec §4 (2026-07-29): ① zero follows
  // ② no taste seed ③ unverified ④ dream stale ⑤ auto-assigned name. "Finish
  // settling in" (funnel language) and "set a notification channel" (already
  // auto-captured, dead noise) have both been removed. One todo at a time /
  // AGENT_MAX_TODOS is unchanged.
  //
  // R1 spec §4: the gap-detection conditions have moved into `listGaps` —
  // status's todos and the nudge feature share the exact same source, and
  // must never each maintain their own copy that drifts apart. Here we only
  // pass the results to the next-step module for policy and presentation;
  // resume_onboarding / house:*:first_move are exclusive to the nudge path
  // and status's todos don't consume them (bailedAt/houses aren't passed in,
  // so listGaps naturally never produces them here).
  const nowSec = deps.now?.() ?? Math.floor(Date.now() / 1000);
  const localNameReal = localNickname !== '' && !isPlaceholderNickname(localNickname);
  const gaps = listGaps({
    followingCount: following.length,
    tasteSeeded,
    loreHouseReachable,
    externalVerifiedCount: external.length,
    pendingInvitesCount: pendingInvites.length,
    dreamStale: isDreamStale(deps.lastDreamAt, nowSec),
    nameSource,
    cardOnHouse,
    localNameReal,
  });
  const gapTodos = planStatusNextSteps(gaps, {
    localNickname,
    localNameReal,
    lastDreamAt: deps.lastDreamAt,
    dreamCron: deps.dreamCron,
    nowSec,
  }, lang);
  // Read after gap/dream advice is built, before presentation and the footer.
  const staleRules = deps.outdatedNewspaperRules?.() ?? [];
  const todos = withOutdatedNewspaperRules(gapTodos, staleRules, lang);
  lines.push(...renderStatusNextSteps(todos, forAgent, lang));
  if (identityCheckFailure === 'unreachable') {
    lines.push(renderCopy(lang, 'status.lanternDown.identity'));
  } else if (identityCheckFailure === 'notAsked') {
    lines.push(renderCopy(lang, 'status.lanternDown.identityNotAsked'));
  } else if (identityCheckFailure === 'authError') {
    lines.push(renderCopy(lang, 'status.lanternDown.identityAuth', { code: String(identityCheckStatus) }));
  } else if (identityCheckFailure === 'serverError') {
    lines.push(renderCopy(lang, 'status.lanternDown.identityError', { code: String(identityCheckStatus) }));
  }

  // ── Profile footer ───────────────────────────────────────────────────
  // The notification channel and homepage almost never change: they're
  // profile info, not news, and shouldn't occupy the first screen. Sunk to
  // the bottom. The URL drops https:// to save 8 characters — Telegram still
  // recognizes it as a clickable link; it's bound to wrap, so giving it its
  // own line means it only drags itself down.
  lines.push('');
  lines.push(notifyLine(notifyChannel, deps.currentChannel, lang));
  // Human-only: the host LLM paraphrasing this line is useless and just costs tokens (same tradeoff as buildStamp).
  if (!forAgent) lines.push(routingLine((deps.routingStats ?? routingStats)(), lang));
  if (deps.cadenceDir !== undefined) lines.push(...configLines(configReport(deps.cadenceDir), lang));
  lines.push(profileLinkText(handle, sigil, deps.webBaseUrl));

  // #236: a backlog the owner cannot see is the failure mode, not the backlog
  // itself. Silent when there is nothing waiting — same omission rule as
  // 「这一周」, so a healthy machine costs zero lines.
  const backlog = deps.notifyBacklog?.();
  if (backlog && backlog.count > 0) {
    lines.push('');
    lines.push(renderCopy(lang, 'status.notifyBacklog', { n: String(backlog.count) }));
    if (backlog.lastFailureReason) {
      lines.push(
        renderCopy(lang, 'status.notifyBacklog.lastFailure', {
          when: backlog.lastFailureAt
            ? `${timeContext(backlog.lastFailureAt).ymd} ${timeContext(backlog.lastFailureAt).hm}`
            : '?',
          reason: backlog.lastFailureReason,
        }),
      );
    }
  }

  if (deps.buildStamp) {
    lines.push('');
    lines.push(`popclaw build ${deps.buildStamp}`);
  }

  // Install credential: for an owner coming back after a gateway restart cut a
  // turn short, the first thing they'll want to confirm is "did that restart
  // actually install the new version." The wording is pinned to the exact
  // phrase "popclaw plugin" — leaving it unclear would get misread as
  // openclaw (the host) upgrading itself, which is a different thing entirely.
  // Ledger #014's width half: the raw build strings (`0.1.0 2026-08-26
  // 12:21+08 c27aab30 (HEAD)`, ~38 cells each) once went in verbatim — 135
  // cells on one line. Here they take the same short stamp the install
  // notice uses; the full string stays on /popclaw version. An unrecognized
  // stamp is shown whole (shortBuildStamp's own fallback) — no truncation.
  if (deps.lastBuildUpgrade) {
    lines.push('');
    lines.push(
      renderCopy(lang, 'status.buildUpgrade', {
        time: formatUpgradeTime(deps.lastBuildUpgrade.recordedAt),
        from: shortBuildStamp(deps.lastBuildUpgrade.from),
        to: shortBuildStamp(deps.lastBuildUpgrade.to),
      }),
    );
  }

  for (const line of lines) info(line);

  return { popclawId, sigil, verifiedProfiles: profiles, following };
}
