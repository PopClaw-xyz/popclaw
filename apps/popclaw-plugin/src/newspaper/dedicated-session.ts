/**
 * The newspaper's dedicated session (cut 1 of the 2026-09-03 proposal).
 *
 * Producing a paper is the heaviest job popclaw ever hands a model: a large
 * candidate page, a large material page, and a large written issue. It used to
 * run inside the owner's chat session, on whatever model the owner picked for
 * chatting — and on 2026-09-02 two machines died of exactly that (one with
 * 151k tokens of input, one whose reasoning ate 93% of the output budget).
 * The fix is
 * structural: the main session DISPATCHES the whole job into a throwaway child
 * session with a light context, waits for it, and hands back whatever the
 * child published.
 *
 * The waiting is split in two (#575, 2026-09-11). A paper takes minutes; a host
 * gives a tool call about a minute. On a claude-cli-backed host the parent call blocked
 * for the full twelve, the host abandoned it at sixty seconds with "The operation
 * timed out", the assistant read that as failure and asked again — twice — and
 * three workshops each published a paper. So the tool call waits only as long as
 * a host will hold it (DISPATCH_INLINE_WAIT_MS) and then hands the rest to a
 * background wait, answering "the workshop is writing, it will be delivered here".
 *
 * Three rules this module exists to keep:
 *   1. Delivery is never silent. A dispatch that times out, errors, or ends
 *      without a published receipt produces a failure receipt and a notifier
 *      push — on 2026-09-03 07:00 a cron run "succeeded" for 167 seconds with
 *      zero output and nobody knew. When the wait goes to the background the
 *      notifier IS the delivery, so a root with no notifier keeps waiting
 *      inline: there would be nowhere else for the paper to come out.
 *   2. The child session is always torn down (deleteSession), success or
 *      failure alike — and never before the run it belongs to has settled,
 *      which is why teardown follows the BACKGROUND wait when there is one.
 *   3. Degradation is honest. If the subagent surface is missing or refuses
 *      the dispatch (e.g. OPENCLAW_SUBAGENT_RUNTIME_REQUEST_SCOPE outside a
 *      request scope), the error propagates and the CALLER falls back to the
 *      current in-session flow — the budgetKnown() precedent: never guess.
 *   4. One request, one paper. While a workshop is in flight for a parent
 *      session, a second bare request is ANSWERED (the in-flight receipt),
 *      never dispatched — three papers for one request is the failure this
 *      guard exists to end.
 *
 * This module is host-agnostic: the subagent surface, the notifier and the
 * clock are all injected. No node:* — wiring lives in the composition roots.
 */
import { getOrCreatePerProcess } from '../runtime/once.js';
import { pageBudgetDecision, type PageBudgetSource } from './host-budget.js';
import { renderCopy } from '../lexicon/index.js';
import { ownerLang } from '../lexicon/owner-language.js';

/**
 * The marker that names a newspaper workshop session. Matched as a SUBSTRING
 * anywhere in a sessionKey, not as a prefix: the host may namespace the child
 * key however it likes, and the detection has to survive that.
 */
export const DEDICATED_SESSION_MARKER = 'popclaw-newspaper:';

/** Is this sessionKey one of our newspaper workshop sessions? */
export function isDedicatedSession(sessionKey: string | undefined): boolean {
  return typeof sessionKey === 'string' && sessionKey.includes(DEDICATED_SESSION_MARKER);
}

/**
 * The agent a session belongs to, read off its key (`agent:<id>:…`), defaulting
 * to `main`.
 *
 * Not cosmetic: openclaw 2026.8.2 refuses to run a session key it cannot
 * attribute — `AgentSelectionRequiredError: Multiple agents are configured, but
 * session key "popclaw-newspaper:…" has no explicit owner` — so on any
 * multi-agent host an unscoped child key means the dispatch NEVER happens. It
 * degraded to the in-session flow five times in one night on the owner's
 * gateway (2026-09-11/12), which is also why `newspaper.model` appeared to do
 * nothing there: the workshop it configures was never reached.
 */
export function agentIdOf(sessionKey: string | undefined): string {
  return /^agent:([^:]+):/.exec(sessionKey ?? '')?.[1] || DEFAULT_AGENT_ID;
}

/** Whose sessions we run under when the parent key names nobody. */
export const DEFAULT_AGENT_ID = 'main';

/**
 * The sessionKey a fresh workshop run lives under, owned by the dispatching
 * parent's agent. The marker stays inside the key, so `isDedicatedSession`
 * (a substring test) keeps matching whatever scope is prefixed.
 */
export function childSessionKey(issueHint: string, agentId?: string): string {
  return `agent:${agentId?.trim() || DEFAULT_AGENT_ID}:${DEDICATED_SESSION_MARKER}${issueHint}`;
}

/**
 * A short, low-entropy id for one dispatch. Date-shaped so two issues on the
 * same day stay readable in a session list, with a random tail so a same-minute
 * retry never collides with the session it retried.
 */
export function defaultIssueHint(): string {
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12); // YYYYMMDDHHmm (UTC)
  return `${stamp}-${Math.random().toString(36).slice(2, 6)}`;
}

// ---------------------------------------------------------------------------
// The outcome store — how the child hands its receipt to the waiting parent
// ---------------------------------------------------------------------------

/**
 * One line of the durable dispatch ledger (`<newspaperDir>/dispatches.jsonl`).
 *
 * Declared here, where the dispatch is, so this module stays host-agnostic — the writing is
 * injected (`recordDispatch`) and the filesystem half lives in `host/local-newspaper-artifacts.ts`, with
 * the rest of the newspaper's on-disk writes and their retention policy.
 * Nothing on it can carry the owner's content: timestamps, ids, session keys, an outcome
 * word, the reason string the receipt already says out loud, and numbers.
 */
export interface NewspaperDispatchRecord {
  /** ISO-8601, when the dispatch settled. */
  at: string;
  /** The host's run id, absent only if the run never produced one. */
  runId?: string;
  /** The child session the workshop actually ran under (the canonical key, post-run()). */
  sessionKey: string;
  /**
   * `published` — a receipt came back. `refused` — the child reported it could not publish
   * and said why. `error` — the host failed the run. `no-receipt` — it ended with nothing,
   * which covers timeout, still-queued, and finished-but-silent.
   */
  outcome: 'published' | 'no-receipt' | 'refused' | 'error';
  /** Exactly the reason the owner's failure receipt names. Absent on success. */
  reason?: string;
  /**
   * What the page budget would have resolved to FOR THE CHILD KEY at the moment the dispatch
   * settled — the dispatcher's view of it. `source: 'constant'` or `'default-bucket'` here is
   * itself the measurement: it means the workshop never reported a context-token budget of
   * its own under the key the tool calls carry.
   */
  budget?: { source: PageBudgetSource; units: number; tokens?: number };
  /**
   * How far the run got, **from the plugin's own knowledge only**. Absent when nothing
   * was observed (an older assembly, or a run that never reached a popclaw tool).
   */
  stage?: NewspaperDispatchStage;
}

/**
 * The four facts the plugin can state about a workshop run without reading anything the
 * child said.
 *
 * `reason` says what the owner's receipt says; this says where the run stopped. They are
 * deliberately separate. The 2026-09-13 run reported that the host had truncated its pages
 * — measurement afterwards said nothing had been — and promoting a model's own account of
 * its failure into a system diagnosis is how that sentence would have become a recorded
 * fact. So nothing here is taken from the child's words: each flag is set by the tool entry
 * point that performed the thing, at the moment it performed it.
 *
 * Content-free: stage booleans and one bounded collection outcome.
 */
export interface NewspaperDispatchStage {
  collection?: 'empty' | 'partial-no-material' | 'source-refused';
  /** A candidate page was built and returned to the child. */
  candidatePage: boolean;
  /** The child came back with picks and a material page was built and returned. */
  materialPage: boolean;
  /** popclaw_publish_newspaper was entered at least once. */
  publishCalled: boolean;
  /**
   * At least one hand-in was accepted — the issue published, or a batch kept with more
   * still to write. A refused hand-in (no provenance, no copy, every anchor rejected)
   * is NOT acceptance.
   */
  publishAccepted: boolean;
}

/** Nothing observed yet. */
const noStage = (): NewspaperDispatchStage => ({
  candidatePage: false,
  materialPage: false,
  publishCalled: false,
  publishAccepted: false,
});

/**
 * Which stages each workshop run reached, keyed by the session that ran it.
 *
 * Process-level for the same reason the outcome store is: the tool calls that observe the
 * stages and the dispatcher that records them are different plugin registrations of one
 * process, and a module-level table would give them one map each.
 *
 * Only workshop sessions are tracked. In the owner's own session there is no ledger line
 * to attach a stage to, and a table that grew one entry per chat session would be a slow
 * leak for a diagnostic nobody reads.
 */
const stages = (): Map<string, NewspaperDispatchStage> =>
  getOrCreatePerProcess('newspaper-stages', () => new Map<string, NewspaperDispatchStage>());

export const NewspaperStageStore = {
  /** Record that this session reached `step`. A no-op outside a workshop session. */
  note(sessionKey: string | undefined, step: Exclude<keyof NewspaperDispatchStage, 'collection'>): void {
    if (!isDedicatedSession(sessionKey)) return;
    const key = sessionKey!;
    const next = { ...(stages().get(key) ?? noStage()), [step]: true };
    if (step === 'candidatePage') delete next.collection;
    stages().set(key, next);
  },
  collection(sessionKey: string | undefined, outcome: NonNullable<NewspaperDispatchStage['collection']>): void {
    if (!isDedicatedSession(sessionKey)) return;
    stages().set(sessionKey!, { ...(stages().get(sessionKey!) ?? noStage()), collection: outcome });
  },
  peek(sessionKey: string): NewspaperDispatchStage | undefined { return stages().get(sessionKey); },
  /** Read and consume this run's stages — one dispatch, one ledger line. */
  take(sessionKey: string): NewspaperDispatchStage | undefined {
    const found = stages().get(sessionKey);
    stages().delete(sessionKey);
    return found;
  },
  /** Clear one entry, or the whole table (tests). */
  clear(sessionKey?: string): void {
    if (sessionKey === undefined) stages().clear();
    else stages().delete(sessionKey);
  },
};

/** What the child session left behind: the published receipt, or why there is none. */
export type NewspaperOutcome =
  | { ok: true; receiptText: string }
  | { ok: false; reason: string };

/**
 * Process-level (NOT module-level) on purpose: the host re-registers the
 * plugin dozens of times a day and each registration is a fresh module
 * instance, while the dispatching session and the publishing child must agree
 * on ONE table — the exact lesson the draft store learned on real hardware
 * (2026-07-27, src/tools/draft-store.ts). Same mechanism: globalThis.
 *
 * ⚠️ The hand-off matches the sessionKey EXACTLY. As of openclaw 2026.8.2 the
 * dispatcher keys it by the CANONICAL sessionKey run() hands back (which is,
 * by definition, the key the child's own tool context carries); on 7.1-2 it is
 * the key we constructed, because that is verbatim what the host ran the child
 * under. The workshop DETECTION (substring marker) survives any host-side key
 * rewriting either way; what an unexpected rewrite would break is this
 * hand-off — it would degrade to a noReceipt failure, silent non-delivery
 * again, the exact enemy this cut exists to kill. Re-verify the key agreement
 * (run()'s returned key === the child's tool-ctx sessionKey) on every openclaw
 * upgrade.
 */
const outcomes = (): Map<string, NewspaperOutcome> =>
  getOrCreatePerProcess('newspaper-outcomes', () => new Map<string, NewspaperOutcome>());

/** The tiny hand-off table between the two sessions of one dispatch. */
export const NewspaperOutcomeStore = {
  set(sessionKey: string, outcome: NewspaperOutcome): void {
    outcomes().set(sessionKey, outcome);
  },
  get(sessionKey: string): NewspaperOutcome | undefined {
    return outcomes().get(sessionKey);
  },
  /** Clear one entry (a consumed dispatch) or the whole table (tests). */
  clear(sessionKey?: string): void {
    if (sessionKey === undefined) outcomes().clear();
    else outcomes().delete(sessionKey);
  },
};

// ---------------------------------------------------------------------------
// The in-flight registry — one request, one paper
// ---------------------------------------------------------------------------

/** One workshop currently writing for a given parent session. */
export interface InFlightDispatch {
  runId: string;
  startedAt: number;
  /** After this long an entry is treated as debris, never as a live run. */
  ttlMs: number;
  /**
   * Which dispatch owns this entry. `settle` clears the entry only for its own
   * owner: a dispatch whose entry has already been replaced (its own expired,
   * and a later request registered) must not free the registration of the run
   * that is writing now.
   */
  dispatchId?: string;
}

const dispatches = (): Map<string, InFlightDispatch> =>
  getOrCreatePerProcess('newspaper-dispatches', () => new Map<string, InFlightDispatch>());

/**
 * Which parent sessions have a workshop in flight (process-level, same reason as
 * the outcome store: one table across every plugin registration).
 *
 * The guard this backs is the answer to one host's three papers: once the tool call
 * stops blocking, nothing else stops an assistant from asking again while the
 * first workshop is still writing. An entry is created when a run starts and
 * cleared when its wait settles; a stale one (older than the dispatch budget)
 * is ignored rather than trusted, so a crashed background wait can never lock
 * the owner out of their paper.
 */
export const NewspaperDispatchRegistry = {
  start(parentSessionKey: string, entry: InFlightDispatch): void {
    dispatches().set(parentSessionKey, entry);
  },
  /** The live dispatch for this parent, or undefined (expired entries are swept here). */
  inFlight(parentSessionKey: string, now = Date.now()): InFlightDispatch | undefined {
    const entry = dispatches().get(parentSessionKey);
    if (!entry) return undefined;
    if (now - entry.startedAt >= entry.ttlMs) {
      dispatches().delete(parentSessionKey);
      return undefined;
    }
    return entry;
  },
  /**
   * This dispatch is done with the slot. With a `dispatchId`, the entry is
   * cleared only if it is still that dispatch's own — otherwise the run whose
   * registration is live keeps it.
   */
  settle(parentSessionKey: string, dispatchId?: string): void {
    const entry = dispatches().get(parentSessionKey);
    if (!entry) return;
    if (dispatchId !== undefined && entry.dispatchId !== undefined && entry.dispatchId !== dispatchId) return;
    dispatches().delete(parentSessionKey);
  },
  /** Clear one entry or the whole table (tests). */
  clear(parentSessionKey?: string): void {
    if (parentSessionKey === undefined) dispatches().clear();
    else dispatches().delete(parentSessionKey);
  },
};

// ---------------------------------------------------------------------------
// The dispatch itself
// ---------------------------------------------------------------------------

/**
 * The host's plugin-runtime subagent surface (api.runtime.subagent), as the
 * minimal shape this module needs. Deliberately NOT the SDK type — declared
 * here on purpose, for TWO reasons: this module stays host-agnostic, and the
 * union below has to span BOTH host generations popclaw runs on. openclaw
 * 2026.7.1-2 (what this repo's node_modules pins) returns only
 * ok/error/timeout and no sessionKey from run(); 2026.8.2 adds `pending`
 * (queued, not started, consumes no timeout budget) and hands back the
 * CANONICAL sessionKey. Importing the host's type would flip which half of
 * that span fails to compile; declaring our own keeps both legs load-bearing.
 */
export interface SubagentSurface {
  run: (params: {
    sessionKey: string;
    message: string;
    /**
     * The workshop's model profile (cut 2). Deliberately omitted — not empty —
     * when unset: the host's 7.1-2/8.2 authorization gate
     * (plugins.entries.<id>.subagent.allowModelOverride) only trips when a
     * provider/model IS present, so an unset profile must not send a key at
     * all. The result carries only runId/sessionKey, never the model the host
     * actually resolved — hence the receipts print the configured value or the
     * default wording, which are both true by construction.
     */
    model?: string;
    extraSystemPrompt?: string;
    lightContext?: boolean;
    deliver?: boolean;
  }) => Promise<{ runId: string; sessionKey?: string }>;
  waitForRun: (params: { runId: string; timeoutMs?: number }) => Promise<{
    status: 'ok' | 'error' | 'timeout' | 'pending';
    error?: string;
  }>;
  deleteSession: (params: { sessionKey: string }) => Promise<void>;
}

/**
 * The host's model-override refusal strings, matched as SUBSTRINGS against
 * whatever run() throws. TWO families, extracted verbatim from both host
 * generations popclaw runs on (openclaw 2026.7.1-2, this repo's pinned dist,
 * and 2026.8.2 on the real machines — same set in both, re-verified from the
 * dists 2026-09-03):
 *
 *  1. the request-scope family — the gateway-side authorization check:
 *     "override is not authorized for this plugin subagent run.";
 *  2-4. the FALLBACK family — what the host throws when no request-scoped
 *     client exists to authorize against, i.e. cron / background wakeups,
 *     which is exactly the newspaper's main scheduled path. Different words
 *     entirely, which is why matching family 1 alone let the cron path's
 *     refusal degrade silently:
 *     "is not trusted for fallback provider/model override requests",
 *     "is not allowlisted for plugin ", and
 *     "requires plugin identity in fallback subagent runs.".
 *
 * ⚠️ Re-verify this table against the dist on every openclaw upgrade: a
 * renamed refusal string silently reverts the loud degrade (the modelIgnored
 * receipt note) to the generic one — the exact silence this cut exists to kill.
 */
export const MODEL_OVERRIDE_REFUSALS: readonly string[] = [
  'override is not authorized',
  'is not trusted for fallback provider/model override requests',
  'is not allowlisted for plugin ',
  'requires plugin identity in fallback subagent runs.',
];

/** Did the host refuse our model override? Matches BOTH refusal families (see MODEL_OVERRIDE_REFUSALS). */
export function isModelOverrideRefusal(err: unknown): boolean {
  const text = String(err);
  return MODEL_OVERRIDE_REFUSALS.some((fragment) => text.includes(fragment));
}

/**
 * The workshop run's system prompt. English on purpose (system prompts are an
 * English single source in this codebase; the child's own tool receipts carry
 * the owner's language). Minimal: name the job, name the two tools, and close
 * the one door the dispatch design depends on — the child delivers nothing
 * itself (its session has no channel; deliver: false).
 *
 * Plus one rule about how to act when a page looks short (2026-09-13). It lives here, not on
 * the pages, for two reasons: it is identical on every page, and it is a rule about behaviour
 * rather than a fact about the page in front of the writer. A system prompt is sent once per
 * session; a page is charged against the host's per-tool-result cap, where on a small host
 * these ~2.5k weighted units of fixed overhead were the difference between a three-item paper
 * fitting and not. Each page keeps only the one-line pointer (`*.cutShort.suspected`).
 *
 * Two red lines in the wording, from the review of the 2026-09-13 run — do not "strengthen"
 * them back: it says what THIS SESSION cannot do, never that no limit exists (a budget env var
 * does), and it never implies that stopping means there is no paper today. Pressure of that
 * kind pushes the writer to hand in shells, and an item counts as written on its headline
 * alone — which is why the headline-without-summary sentence is in here too.
 *
 * Exported for the tests that pin those red lines.
 */
export const CHILD_SYSTEM_PROMPT =
  'You are the newspaper workshop session. Your whole job this run: call popclaw_newspaper, ' +
  'choose the items that belong in the paper, write the copy from the material page, and publish ' +
  'with popclaw_publish_newspaper. The publish receipt (teaser + link) is your final answer — ' +
  'hand it back verbatim and deliver nothing to any channel yourself.\n' +
  'Read every page_cursor continuation until the complete-document end marker before final selection or finishing copy. ' +
  'A long source can span pages; join its complete parts before quoting it. Continue the same saved issue, never regather to fill a page. ' +
  'After reading the selected materials, prepare ONLY the next small batch: at most 12 items, fewer when their copy is long. ' +
  'As soon as that batch has complete q, h and s values, CALL popclaw_publish_newspaper. ' +
  'Do not draft or plan the entire issue in one output before the first call. A written promise, JSON in chat, ' +
  'or a mention of the tool is not a hand-in; the actual tool call saves the copy. ' +
  'Every hand-in carries the material page\'s basis verbatim. Include masthead and teaser in the first hand-in; ' +
  'later hand-ins need only the same basis and the remaining items (each with its own q, h and s). ' +
  'If a receipt says items are still unwritten, read its page_cursor continuations when present, then write and call ' +
  'with the next small batch in this same run. Do not repeat accepted items, regather, or stop on an unfinished receipt. ' +
  'These batches do not limit the total issue. Only the completed publish receipt is your final answer. ' +
  'If a page looks short to you but carries no truncation notice and no marker saying the middle ' +
  'was omitted: work with what you have, do not request that page again, and do not stop. ' +
  'A partial hand-in is the way through — `q` is checked per item, against that item\'s own body ' +
  'and never against the page as a whole, so any item whose body you can read is anchorable ' +
  'whatever became of the rest. Hand in the items you can verify and leave out the ones you ' +
  'cannot. Never hand in a headline with no summary: an item counts as written on its headline ' +
  'alone, and it then drops off the list of what is still owed. If there is genuinely nothing ' +
  'usable, say which step you reached and stop there. Two things this session cannot do: it ' +
  'cannot change host settings, and it cannot wait for the owner to answer here — and your ' +
  'explanation does not reach him either, because the dispatcher is what delivers the result.';

/** How long the main session waits for one workshop run before calling it failed. */
export const DEFAULT_DISPATCH_TIMEOUT_MS = 12 * 60 * 1000;

/**
 * How long the TOOL CALL itself may wait before answering.
 *
 * Bounded by what a host will hold a tool call open for, not by how long a paper
 * takes: claude-cli abandons one at about sixty seconds ("The operation timed
 * out"), and an abandoned call is read as a failed one and retried (#575). Forty
 * seconds leaves room for the answer to travel and still catches the runs that
 * finish quickly, which on a fast model is most of them.
 */
export const DEFAULT_DISPATCH_INLINE_WAIT_MS = 40 * 1000;

/**
 * The slowest we re-poll a still-queued run (2026.8.2 `pending`). Purely a
 * hot-spin guard: waitForRun is expected to block for the budget it is given,
 * and this only paces the loop if a host returns pending without blocking.
 */
const QUEUED_POLL_FLOOR_MS = 1_000;

/** What one wait attempt can come back with (both host generations). */
type WaitResult = { status: 'ok' | 'error' | 'timeout' | 'pending'; error?: string };

export interface DedicatedDispatchDeps {
  subagent: SubagentSurface;
  /**
   * Push one message to the owner's channel right now (the OwnerNotifier).
   * Optional — a root with no notifier (MCP, test rigs) simply skips the
   * belt-and-braces delivery; the tool receipt still carries everything.
   */
  deliverNow?: (text: string) => Promise<boolean>;
  /** Mints the issue hint for this dispatch (injected so tests are deterministic). */
  makeIssueHint: () => string;
  /** The wait budget. Default 12 minutes. */
  timeoutMs?: number;
  /**
   * How long the tool call waits before handing the rest to a background wait.
   * Default 40s (see DEFAULT_DISPATCH_INLINE_WAIT_MS). Only meaningful when a
   * notifier exists — without one there is nowhere for a background receipt to
   * go, so the call waits the full budget as it always did.
   */
  inlineWaitMs?: number;
  /**
   * The session that asked for the paper. Two jobs: it names the agent the child
   * session must belong to (multi-agent hosts refuse an unowned key), and it is
   * the key the one-request-one-paper guard is kept under. Absent = no guard and
   * the default agent — old assemblies and test rigs.
   */
  parentSessionKey?: string;
  /**
   * The model the workshop writes on (plugin config `newspaper.model`, cut 2).
   * Empty, whitespace, or absent = the host's default model: run() is then
   * called WITHOUT a model key — the 7.1-2/8.2 authorization gate only trips
   * when a model is present. Whatever this ends up being, the receipts say it
   * (boss ruling 2026-09-03: print the model actually used — honesty over
   * silence, so a profile the host quietly ignores cannot go unnoticed).
   */
  model?: string;
  /**
   * A rolling lookback the caller asked for ("the last 48 hours"). The child is
   * then DIRECTED to call popclaw_newspaper with `hours={hours}` itself — the
   * directive and the window must not contradict each other (review round
   * 2026-09-03: "produce today's paper, call with no arguments" followed by
   * "window: the last N hours" taught the child two different jobs). Undefined
   * = today, the tool's own default.
   */
  hours?: number;
  /**
   * Dispatch-time stale sweep (2026-09-03 night ruling): called once, just
   * before the child runs, to delete every issue-ledger entry stamped another
   * day — each new workshop starts on a clean slate, never hijacked by a
   * previous day's leftovers (the boss's ruling: a fresh paper must never be
   * held hostage by leftover stock). Injected (the
   * composition root wires `issueStore.sweepStaleIssues`) because this module
   * is host-agnostic and touches no filesystem of its own. Best-effort by
   * contract: a sweep that throws is logged and never blocks the dispatch.
   * Absent = nothing to sweep (older assemblies, test rigs).
   */
  sweepStaleIssues?: () => void;
  /**
   * Append one line to the durable dispatch ledger — every outcome, the published ones
   * included, or there is no denominator to measure the failures against. Injected because
   * this module touches no filesystem of its own (the composition root wires
   * `local-newspaper-artifacts.recordNewspaperDispatch`). Best-effort by contract and wrapped at the call
   * site as well: a ledger that cannot be written must never cost the owner a paper.
   * Absent = no ledger (old assemblies, test rigs).
   */
  recordDispatch?: (record: NewspaperDispatchRecord) => void;
  /** Where the one-line trail goes. Absent = silent. */
  log?: (m: string) => void;
}

/** Best-effort push: a channel that refuses must never take the receipt down with it. */
async function push(
  deliverNow: ((text: string) => Promise<boolean>) | undefined,
  text: string,
  log: (m: string) => void,
): Promise<void> {
  if (!deliverNow) return;
  try {
    const went = await deliverNow(text);
    if (!went) log('newspaper dispatch: notifier could not deliver (no routable target) — receipt stays in the tool result');
  } catch (err) {
    log(`newspaper dispatch: notifier delivery failed (non-fatal) — ${String(err)}`);
  }
}

/**
 * Dispatch one newspaper run into a dedicated child session, wait for it, and
 * return the receipt the owner should see (the published receipt on success,
 * an honest failure receipt otherwise).
 *
 * Throws ONLY when the dispatch itself could not start (the subagent surface
 * refusing the run — e.g. outside a gateway request scope). That is the one
 * case where the caller should fall back to the in-session flow; every other
 * failure belongs to the owner as a receipt, not as a silent retry.
 */
export async function runDedicatedNewspaper(deps: DedicatedDispatchDeps): Promise<string> {
  const lang = ownerLang();
  const log = deps.log ?? (() => {});
  const timeoutMs = deps.timeoutMs ?? DEFAULT_DISPATCH_TIMEOUT_MS;
  const minutes = String(Math.max(1, Math.round(timeoutMs / 60_000)));
  // The model profile, normalized here so every caller's idea of "unset"
  // (undefined, '', whitespace) collapses to ONE thing before it reaches the
  // params and the receipts.
  const model = deps.model?.trim() || undefined;
  // The one-line honesty clause, computed once: which model writes this
  // edition. With no profile the dispatch follows the host default and SAYS
  // so — the wording is true by construction because the model key is only
  // sent when a profile exists.
  const modelNote = model
    ? renderCopy(lang, 'newspaper.dispatch.modelUsed.model', { model })
    : renderCopy(lang, 'newspaper.dispatch.modelUsed.default');
  const parentKey = deps.parentSessionKey;
  const inFlightReceipt = (runId: string): string =>
    renderCopy(lang, 'newspaper.dispatch.inFlight', { minutes, run: runId });

  // One request, one paper (#575). A workshop already writing for this parent is
  // ANSWERED, never answered with a second workshop: the tool call no longer
  // blocks, so nothing else stands between an impatient retry and two editions.
  if (parentKey) {
    const live = NewspaperDispatchRegistry.inFlight(parentKey);
    if (live) {
      log(
        `popclaw: newspaper workshop already in flight for ${parentKey} (run ${live.runId}) — ` +
          'answering with the in-flight receipt instead of dispatching again',
      );
      return inFlightReceipt(live.runId);
    }
  }

  // The child must belong to an agent: a multi-agent host refuses an unowned
  // session key outright (AgentSelectionRequiredError), which silently cost the
  // owner's gateway every single dispatch.
  const issueHint = deps.makeIssueHint();
  const requestedKey = childSessionKey(issueHint, agentIdOf(parentKey));
  // This dispatch's own name for its claim on the parent's slot — minted before
  // anything can yield, so `settle` below can tell "my registration" from "the
  // registration of whoever holds the slot now".
  const dispatchId = requestedKey;

  let runId: string | undefined;
  // 2026.8.2 hands back the CANONICAL sessionKey it actually ran the child
  // under (it may normalize the key we asked for); 7.1-2 has no such field and
  // runs under exactly what we passed. Either way, from the moment run()
  // answers, this is the one key every subsequent step uses — outcome hand-off,
  // teardown — because it is the key the child's own tool context carries.
  let childKey = requestedKey;
  // Set when the wait moves to the background: teardown and the guard then belong
  // to THAT wait, not to the tool call that is about to return.
  let handedOff = false;

  const teardown = async (): Promise<void> => {
    try {
      await deps.subagent.deleteSession({ sessionKey: childKey });
    } catch (err) {
      log(`popclaw: newspaper child session cleanup failed (non-fatal) — ${String(err)}`);
    }
    // Already consumed by `record()` on every path that has a ledger to write to; this is
    // for the ones that do not (old assemblies, test rigs), so an untaken entry cannot
    // outlive the session it describes.
    NewspaperStageStore.clear(childKey);
    if (parentKey) NewspaperDispatchRegistry.settle(parentKey, dispatchId);
  };

  /**
   * Wait for the run until `deadlineAt`.
   *
   * 2026.8.2 can answer `pending`: the run is QUEUED and has not started, and a
   * queued run consumes no timeout budget on the host's side — so a wait that
   * runs out while still queued comes back pending, NOT timeout. Left unhandled,
   * that reads as "finished with no receipt": a failure receipt for a job that
   * never got its turn, plus a deleteSession aimed at a live queued run. So this
   * loops: pending → keep waiting with the REMAINING budget (the deadline never
   * moves), and only a run still queued at the deadline comes back pending.
   *
   * A `timeout` answer means the budget we gave ran out with the run still
   * going — a fact about the wait, not about the paper. Who reads it decides
   * what it means: the inline caller hands over to the background, the
   * background caller (whose deadline is the real one) calls it a failure.
   */
  const waitUntil = async (id: string, deadlineAt: number): Promise<WaitResult> => {
    let notedQueued = false;
    for (;;) {
      const remaining = deadlineAt - Date.now();
      if (remaining <= 0) return { status: 'pending' };
      const callStartedAt = Date.now();
      let wait: WaitResult;
      try {
        wait = await deps.subagent.waitForRun({ runId: id, timeoutMs: remaining });
      } catch (err) {
        return { status: 'error', error: String(err) };
      }
      if (wait.status !== 'pending') return wait;
      if (!notedQueued) {
        notedQueued = true;
        log('popclaw: newspaper workshop run is still queued — holding the deadline');
      }
      // A host that returns pending without blocking would otherwise hot-spin
      // this loop for the whole budget; a queued run needs no tighter polling
      // than about once a second.
      const spent = Date.now() - callStartedAt;
      if (spent < QUEUED_POLL_FLOOR_MS) {
        await new Promise((resolve) => setTimeout(resolve, QUEUED_POLL_FLOOR_MS - spent));
      }
    }
  };

  /**
   * One line in the durable ledger, per dispatch outcome.
   *
   * Wrapped here as well as inside the writer: a failed newspaper run used to leave nothing
   * behind but a line in a volatile container log (2026-09-13), and the cure for that must
   * not become a new way to lose the paper.
   */
  const record = (outcome: NewspaperDispatchRecord['outcome'], reason?: string): void => {
    const stage = NewspaperStageStore.take(childKey);
    if (!deps.recordDispatch) return;
    try {
      const b = pageBudgetDecision(childKey);
      // Consumed here, with the line it belongs to: one dispatch leaves one record, and
      // whatever the child did after that record is another run's business.
      deps.recordDispatch({
        at: new Date().toISOString(),
        ...(runId ? { runId } : {}),
        sessionKey: childKey,
        outcome,
        ...(reason ? { reason } : {}),
        budget: { source: b.source, units: b.budget, ...(b.tokens === undefined ? {} : { tokens: b.tokens }) },
        ...(stage ? { stage } : {}),
      });
    } catch (err) {
      log(`popclaw: newspaper dispatch record failed (non-fatal) — ${String(err)}`);
    }
  };

  /** The dispatch is over: compose the owner's receipt, push it, hand it back. */
  const receiptFor = async (wait: WaitResult): Promise<string> => {
    const outcome = NewspaperOutcomeStore.get(childKey);
    NewspaperOutcomeStore.clear(childKey); // consumed either way — one dispatch, one outcome

    if (outcome && outcome.ok) {
      record('published');
      // The paper is out. The model clause is appended DISPATCHER-side (the
      // child cannot know which model its session was profiled to) and rides
      // on both the channel push and the tool receipt, so whichever one the
      // owner actually sees names the machine that wrote the edition.
      const withModel = `${outcome.receiptText}\n${modelNote}`;
      await push(deps.deliverNow, withModel, log);
      return withModel;
    }

    // No paper. Name the reason honestly — never "ok" with nothing to show.
    let reason: string;
    if (outcome && !outcome.ok) {
      reason = outcome.reason;
    } else if (wait.status === 'error') {
      reason = wait.error || 'the workshop run errored';
    } else if (wait.status === 'timeout') {
      reason = renderCopy(lang, 'newspaper.dispatch.reason.timeout', { minutes });
    } else if (wait.status === 'pending') {
      reason = renderCopy(lang, 'newspaper.dispatch.reason.queued');
    } else if (NewspaperStageStore.peek(childKey)?.collection) {
      const collection = NewspaperStageStore.peek(childKey)!.collection!;
      reason = renderCopy(lang, `newspaper.dispatch.reason.${collection}`);
    } else {
      reason = renderCopy(lang, 'newspaper.dispatch.reason.noReceipt');
    }
    record(
      outcome ? 'refused' : wait.status === 'error' ? 'error' : 'no-receipt',
      reason,
    );
    const failed = renderCopy(lang, 'newspaper.dispatch.failed', { reason });
    log(`popclaw: newspaper dispatch failed (${wait.status}) — ${reason}`);
    await push(deps.deliverNow, failed, log);
    return failed;
  };

  try {
    // Clean slate first (2026-09-03 night ruling): yesterday's leftover issue
    // files are exactly what a fresh paper must never be hijacked by, and the
    // sweep belongs BEFORE the child runs, not after — the child's very first
    // tool calls consult this ledger. Best-effort: a sweep that fails is named
    // in the log and the dispatch proceeds regardless.
    if (deps.sweepStaleIssues) {
      try {
        deps.sweepStaleIssues();
      } catch (err) {
        log(`popclaw: newspaper stale-issue sweep failed (non-fatal) — ${String(err)}`);
      }
    }
    // The slot is claimed BEFORE the first await that can yield, and `run()` is
    // that await. The guard above used to read an empty table for two calls that
    // arrived together, because the registration was written only after run()
    // answered — so both started a workshop and the owner got two editions from
    // one request. Until run() names the host's run, the claim carries this
    // dispatch's own issue hint, which is what a concurrent caller is told.
    // A start that throws releases the claim through `teardown` in the `finally`
    // below, so a failed dispatch never locks the owner out of their paper.
    if (parentKey) {
      NewspaperDispatchRegistry.start(parentKey, {
        runId: issueHint,
        startedAt: Date.now(),
        ttlMs: timeoutMs,
        dispatchId,
      });
    }
    const started = await deps.subagent.run({
      sessionKey: requestedKey,
      // One directive, self-consistent: a rolling window teaches the child to
      // pass `hours` on its own first call; the default teaches "no arguments".
      message:
        deps.hours !== undefined
          ? renderCopy(lang, 'newspaper.dispatch.childDirectiveWindow', { hours: String(deps.hours) })
          : renderCopy(lang, 'newspaper.dispatch.childDirective'),
      // The profile is sent as a key ONLY when set — an empty profile must not
      // trip the host's override-authorization gate (see SubagentSurface.run).
      ...(model ? { model } : {}),
      extraSystemPrompt: CHILD_SYSTEM_PROMPT,
      lightContext: true,
      deliver: false,
    });
    if (!started || typeof started.runId !== 'string') {
      throw new Error('subagent.run returned no runId');
    }
    runId = started.runId;
    if (typeof started.sessionKey === 'string' && started.sessionKey) {
      childKey = started.sessionKey;
    }
    // The claim is now named by the host's own run id, which is what the in-flight
    // receipt quotes; it closes when the wait settles (teardown).
    if (parentKey) {
      NewspaperDispatchRegistry.start(parentKey, { runId, startedAt: Date.now(), ttlMs: timeoutMs, dispatchId });
    }
    log(
      `popclaw: newspaper dispatched to ${childKey} (run ${runId}, waiting up to ${minutes}m` +
        `${model ? `, model ${model}` : ', host default model'})`,
    );

    // The owner hears the job started before we go quiet for up to twelve
    // minutes. In the cron-wake case the main session's own reply may go
    // nowhere, and in the interactive case the agent's turn is blocked on
    // this very call — either way this line is the only thing that moves.
    // The model clause rides along from the start: which machine the workshop
    // will write on is part of "it started" (cut 2's honesty ruling).
    await push(
      deps.deliverNow,
      `${renderCopy(lang, 'newspaper.dispatch.started', { minutes })}\n${modelNote}`,
      log,
    );

    // ── The wait, in two halves (#575) ──
    const deadline = Date.now() + timeoutMs;
    const inlineMs = Math.min(
      Math.max(0, deps.inlineWaitMs ?? DEFAULT_DISPATCH_INLINE_WAIT_MS),
      timeoutMs,
    );
    const inlineIsWholeBudget = inlineMs >= timeoutMs;
    const inline = await waitUntil(runId, Date.now() + inlineMs);

    // Settled inside the inline budget (or the inline budget WAS the whole
    // budget, in which case this answer is final): behave exactly as before.
    if (inline.status === 'ok' || inline.status === 'error' || inlineIsWholeBudget) {
      return await receiptFor(inline);
    }

    // Still writing. Without a notifier there is nowhere for a later receipt to
    // go, so the call keeps waiting — the honest degradation, said out loud
    // rather than discovered as a stuck tool call.
    if (!deps.deliverNow) {
      log(
        'popclaw: newspaper workshop outran the inline budget and there is no notifier to deliver to — ' +
          'holding the tool call for the rest of the budget',
      );
      return await receiptFor(await waitUntil(runId, deadline));
    }

    // The tool call answers now; the wait, the delivery and the teardown go on
    // without it. Detached ON PURPOSE — awaiting it here is the twelve-minute
    // block this whole split exists to end.
    handedOff = true;
    const backgroundRunId = runId;
    void (async () => {
      try {
        await receiptFor(await waitUntil(backgroundRunId, deadline));
      } catch (err) {
        log(`popclaw: newspaper background wait failed (non-fatal) — ${String(err)}`);
      } finally {
        await teardown();
      }
    })();
    log(
      `popclaw: newspaper workshop ${childKey} outran the ${Math.round(inlineMs / 1000)}s inline budget — ` +
        'answering now, delivering through the notifier when it lands',
    );
    return inFlightReceipt(runId);
  } finally {
    // Teardown belongs to whoever is still waiting. When the wait moved to the
    // background, deleting the session here would kill the run that is writing.
    if (!handedOff) await teardown();
  }
}
