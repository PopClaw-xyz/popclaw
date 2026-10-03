/**
 * How much the host will actually hand the writer in one tool result.
 *
 * The host caps a single live tool result at `min(context_tokens × 0.3 × 4, tier)` with the
 * tier chosen from the model's context window (16,000 / 32,000 / 64,000 at <100k / ≥100k /
 * ≥200k tokens), and over the cap it keeps the head and the tail and **drops the middle
 * without telling the tool**. Guessing a constant is what the owner threw out on 2026-08-26:
 * a machine reading a million tokens was being served twelve items to spare a machine
 * reading thirty-two thousand.
 *
 * The number does not have to be guessed. The host computes that cap from
 * `contextTokenBudget`, and hands the very same value to plugins on every model call
 * (`model_call_started` → `event.contextTokenBudget`, documented as "resolved effective
 * context-token budget after model/config/agent caps"). One variable, two outlets. So the
 * plugin reads it, applies the host's own formula, and sizes what it hands over to what this
 * machine's model, on this turn, will actually receive.
 *
 * Measured 2026-08-27, the day this was missing: a 254-item candidate page came to 27,926
 * weighted units and was cut on a machine whose model sits on the 16,000 tier. The writer
 * lost the tail — where the instructions are — invented a token from memory, and the whole
 * day ended up on the page.
 *
 * Not heard from yet (the hook has not fired, or a host that never fires it) → `undefined`,
 * and the caller keeps its own default. Degrading to the old behaviour beats guessing low.
 *
 * One bucket per sessionKey (dedicated-session cut 1, 2026-09-03): the paper is now produced
 * in a child session, and the chat session and the workshop can sit on different models with
 * different windows. A single process-wide number meant whichever session had a model call
 * last silently re-tuned the page trimming of the other. The old single value lives on as
 * the DEFAULT bucket — callers that cannot name their session (old wiring, tests) read
 * exactly what they always read, and a session that has not reported yet falls back to it
 * rather than to a guess.
 */

/** The host's own constants, copied from `openclaw/dist/tool-result-limits-*.js` (8.1). */
const CONTEXT_SHARE = 0.3;
const TIER_DEFAULT = 16_000;
const TIER_LARGE = 32_000;
const TIER_XL = 64_000;
const LARGE_TOKENS = 100_000;
const XL_TOKENS = 200_000;
/**
 * What we aim at inside that cap. The host measures the JSON-wrapped tool result — every
 * newline escaped, plus the envelope — which came out 1.3% larger on a real payload, and the
 * weighting here does not model the rare-ideograph classes the host charges more for. 0.88
 * covers both with room to spare; the cost of overshooting is a silently gutted page.
 */
const AIM = 0.88;

/** The bucket for events that carry no sessionKey (and for readers that cannot name one). */
const DEFAULT_BUCKET = '';

/** Module-level on purpose (same lifetime the old single number had): a fresh plugin load
 * starts honest ("not heard from yet") and the next model_call_started re-syncs it. */
let buckets: Map<string, number> | undefined;

const table = (): Map<string, number> => (buckets ??= new Map());

const bucketKey = (sessionKey: string | undefined): string =>
  typeof sessionKey === 'string' && sessionKey.trim() ? sessionKey : DEFAULT_BUCKET;

/**
 * Record the context-token budget the host resolved for this call, under the
 * session it belongs to. No sessionKey → the default bucket.
 */
export function noteContextTokenBudget(sessionKey: string | undefined, tokens: number | undefined): void {
  if (typeof tokens === 'number' && Number.isFinite(tokens) && tokens > 0) {
    table().set(bucketKey(sessionKey), Math.floor(tokens));
  }
}

/**
 * This session's budget, or the default bucket's when it has not reported yet.
 * `undefined` only when nothing has been heard at all.
 */
function budgetOf(sessionKey: string | undefined): number | undefined {
  const t = table();
  const k = bucketKey(sessionKey);
  if (k !== DEFAULT_BUCKET && t.has(k)) return t.get(k);
  return t.get(DEFAULT_BUCKET);
}

/**
 * Does this machine's real cap actually reach us?
 *
 * It does on the gateway root, where `model_call_started` is wired. It does not on the MCP
 * root, which receives no host events at all, nor before the first model call after a
 * restart, nor for the beat in which the host silently swaps the model. The pages built for
 * the writer promise that nothing has been cut; that promise is only ours to make when the
 * answer here is true (owner's ruling, 2026-08-30). Guessing high stays — being wrong
 * silently does not.
 */
export function budgetKnown(sessionKey?: string): boolean {
  return budgetOf(sessionKey) !== undefined;
}

// Exported for test teardown only. DO NOT use from production code.
export function _resetBudgetForTest(): void {
  buckets = undefined;
}

/** The last budget the host reported for this session, for diagnostics. */
export function lastContextTokens(sessionKey?: string): number | undefined {
  return budgetOf(sessionKey);
}

/** The host's cap for one tool result, in weighted units, given a context window in tokens. */
export function hostToolResultCap(tokens: number): number {
  const tier = tokens >= XL_TOKENS ? TIER_XL : tokens >= LARGE_TOKENS ? TIER_LARGE : TIER_DEFAULT;
  return Math.min(Math.floor(tokens * CONTEXT_SHARE) * 4, tier);
}

/**
 * What one page may weigh on this machine right now, or `undefined` if the host has not said.
 * Callers keep their own default in that case rather than assuming the worst.
 */
export function pageBudget(sessionKey?: string): number | undefined {
  const tokens = budgetOf(sessionKey);
  return tokens === undefined ? undefined : Math.floor(hostToolResultCap(tokens) * AIM);
}

const PAGE_BUDGET_DEFAULT = Number(process.env.POPCLAW_NEWSPAPER_BUDGET) || 60_000;

/**
 * Where the number a page was sized against actually came from.
 *
 *  - `own`            — this sessionKey reported its own budget.
 *  - `default-bucket` — the DEFAULT bucket supplied it: either the caller named no session,
 *                       or the session it named has never reported.
 *  - `constant`       — nothing has been heard at all, so `PAGE_BUDGET_DEFAULT` applied.
 */
export type PageBudgetSource = 'own' | 'default-bucket' | 'constant';

/** What `pageBudgetNow` decided, and why. Diagnostics only — nothing reads this to size a page. */
export interface PageBudgetDecision {
  /**
   * The bucket key the lookup used — the caller's sessionKey verbatim, `''` for the default
   * bucket. Printed as-is so a human can compare it character by character against the key
   * the sync line reported.
   */
  bucketKey: string;
  source: PageBudgetSource;
  /** What one page may weigh, in weighted units. Identical to `pageBudgetNow(sessionKey)`. */
  budget: number;
  /** The context-token budget behind it; absent when the constant applied. */
  tokens?: number;
}

/**
 * The same decision `pageBudgetNow` makes, with its reasoning attached.
 *
 * It exists because a live run on 2026-09-13 could not be diagnosed from the log: the
 * workshop's pages came back cut, and nothing recorded whether the workshop had ever
 * reported a budget of its own, silently borrowed the chat session's, or fell through to the
 * constant. **It changes no sizing** — `pageBudgetNow` is this function's `budget` field.
 */
export function pageBudgetDecision(sessionKey?: string): PageBudgetDecision {
  const t = table();
  const k = bucketKey(sessionKey);
  const own = k !== DEFAULT_BUCKET && t.has(k) ? t.get(k) : undefined;
  const tokens = own ?? t.get(DEFAULT_BUCKET);
  if (tokens === undefined) return { bucketKey: k, source: 'constant', budget: PAGE_BUDGET_DEFAULT };
  return {
    bucketKey: k,
    source: own === undefined ? 'default-bucket' : 'own',
    budget: Math.floor(hostToolResultCap(tokens) * AIM),
    tokens,
  };
}

/**
 * The one-line trail a page build leaves behind, worded once so the candidate page and the
 * material page cannot drift apart in the log.
 *
 * Session keys, numbers and counts only — never a word of what the page carries. The key is
 * quoted so a human can line it up character by character against the `budget synced` line
 * (a key that differs only in form is one of the two readings of the 2026-09-13 failure).
 */
export function pageBudgetLogLine(
  page: 'candidate' | 'material',
  d: PageBudgetDecision,
  weightedUnits: number,
  trimmed: number,
  total: number,
): string {
  const tokens = d.tokens === undefined ? '' : `, ${d.tokens} context tokens`;
  return (
    `popclaw: newspaper ${page} page built — session "${d.bucketKey}" — ` +
    `budget ${d.budget} units (${d.source}${tokens}) — ` +
    `page ${weightedUnits} units, ${trimmed} of ${total} items trimmed`
  );
}

/**
 * What one page may weigh. **Measured, not guessed**: the host tells plugins the very
 * context-token budget it computes its own tool-result cap from, so `pageBudget()` applies
 * the host's formula to this machine's actual model. Only when nothing has been heard does
 * the constant below apply — and that constant aims at the top tier on purpose, because
 * under-serving the majority to spare the minority is what the owner rejected outright.
 */
export function pageBudgetNow(sessionKey?: string): number {
  return pageBudget(sessionKey) ?? PAGE_BUDGET_DEFAULT;
}
