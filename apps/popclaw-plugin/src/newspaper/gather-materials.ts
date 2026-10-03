/**
 * gatherNewspaperMaterials — the read half of the newspaper. Builds the three
 * circles from the LOCAL world-feed cache + inbox over the window, stores the whole
 * issue under a publishToken, and returns the agent-facing brief. The AGENT writes
 * the copy in its own turn and submits it via popclaw_publish_newspaper, which lays
 * the page out from the stored issue (v0.2 — the layout is code).
 * popclaw itself never calls an LLM. See spec 2026-06-18.
 */
import { buildCandidatePage, candidateOrder } from './build-candidate-page.js';
import { pageBudgetDecision, pageBudgetLogLine, pageBudgetNow } from './host-budget.js';
import type { IssueData, PulseItem } from './issue.js';
import { putIssue } from './issue-store.js';
import type { NewspaperStyle } from './newspaper-style.js';
import { ownerLangTag } from '../lexicon/owner-language.js';
import { collectNewspaperMaterials, type MaterialSources } from './collect-materials.js';

export type { NewspaperBond } from './collect-materials.js';

/**
 * How big an issue is, and the most any one person may hold in it.
 *
 * There is no target count any more. The owner struck it (2026-08-28): "how many you pick
 * is yours to decide, it does not have to be ninety, maybe it depends on the model you are
 * on — nobody is asking you to hard-code it." The reason is the sentence before it: **an
 * item summed up in one or two lines gives him no reason to follow anyone**, so writing
 * fewer items properly beats writing many thinly. Depth is the product; count is its cost.
 *
 * So the writer picks as much as it can write well, and only the two ends are held:
 * a floor, because "too few, or empty, is no good either" — and a runaway guard, because a
 * writer that hands back everything has not chosen at all (real hardware, 254 items).
 */
/** Under this an issue reads as empty; topped up by what was liveliest, and said out loud. */
export const PICK_FLOOR = 15;
/** Where a topped-up issue lands, and the low end of what the brief suggests. */
export const PICK_SUGGESTED_MIN = 20;
/** The high end of what the brief suggests. Not enforced — the writer knows its own budget. */
export const PICK_SUGGESTED_MAX = 40;
/** Not a target: past this the candidate set came back whole rather than chosen from. */
export const PICK_RUNAWAY = 120;
export const PER_AUTHOR_MAX = 6;
/**
 * The host's tool-result budget unit, ported from OpenClaw's `estimateStringChars`
 * (`dist/cjk-chars-*.js`): one unit per UTF-16 code unit **plus three more for every
 * common CJK character** — a Chinese character costs 4. OpenClaw charges more still
 * for rare and supplementary ideographs (×11 / ×14); those aren't modelled here, the
 * margin left under `PAYLOAD_BUDGET` covers them.
 */
const COMMON_CJK_RE = /[\u00B7\u3000-\u319F\u4E00-\u9FA5\uAC00-\uD7AF\uFF01-\uFF60]/gu;
export function weightedChars(text: string): number {
  return text.length + (text.match(COMMON_CJK_RE)?.length ?? 0) * 3;
}
/**
 * Ceiling for one `popclaw_newspaper` return, in those units. OpenClaw caps a single live
 * tool result at `min(context_tokens x 0.3 x 4, tier)` with tier 16,000 / 32,000 / 64,000 at
 * <100k / >=100k / >=200k context tokens, and over the cap it keeps the head and the tail and
 * drops the MIDDLE without telling the tool. The cap is the host's and cannot be raised: 8.1
 * removed the `contextLimits.toolResultMaxChars` override, and the tool execution context
 * carries no model information.
 *
 * **This is a per-message ceiling, not the issue's budget.** The per-turn aggregate is
 * `max(perResultMax x 4, context_tokens x 4 x 0.5)` — two million units on a 1M-context model —
 * so the way to hand over more material is more messages, never a bigger one. Sizing the issue
 * down to fit one message is what the owner rejected outright (2026-08-26): a machine whose
 * model reads a million tokens was being served twelve items because another machine's model
 * reads thirty-two thousand.
 *
 * This constant is therefore only the ceiling for ONE page. The number of items an issue
 * carries is decided by the selection ladder (taste, then the bond book, then heat), not by
 * arithmetic against a cap.
 */
/** Never trim below this: a paper with a handful of items is still a paper, an empty one isn't. */
const MIN_PULSE = 12;

/** The local collection sources plus candidate-page and storage dependencies. */
export interface GatherDeps extends MaterialSources {
  // Retained for assembly compatibility; gathering reads neither writing-stage input.
  readContentRules: () => string;
  readStyle?: () => NewspaperStyle;
  /** The owner's taste as prose, used by the writer to choose candidates. */
  tasteText?: string;
  /** One rendered bond-book line per person, for candidate selection. */
  bondLines?: readonly string[];
  /** Production assemblies persist the ledger here for cross-process publishing. */
  manifestDir?: string;
  /** The candidate page's session-specific host budget bucket. */
  sessionKey?: string;
  /** One info-level page-build diagnostic, emitted before persistence. */
  log?: (m: string) => void;
}

export type GatherResult =
  | { kind: 'empty'; message: string }
  /** The day's candidates, for the writer to choose from; `candidateToken` carries its picks back. */
  | { kind: 'candidates'; payload: string; candidateToken: string };

/** Collect materials, size and number the candidate page, then persist its exact order. */
export function gatherNewspaperMaterials(deps: GatherDeps, opts: { hours?: number } = {}): GatherResult {
  const collected = collectNewspaperMaterials(deps, opts);
  if (collected.kind === 'empty') return collected;
  const { candidateToken, lang, draft } = collected;
  const { pulse, byHouse } = draft;

  /** Same lore-house keys — E4's zero-item stacks must survive a trim — counts re-taken over `items`. */
  const laidOutBy = (items: readonly PulseItem[]): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const slug of Object.keys(byHouse)) out[slug] = 0;
    for (const p of items) if (p.houseSlug) out[p.houseSlug] = (out[p.houseSlug] ?? 0) + 1;
    return out;
  };

  const issueOf = (items: readonly PulseItem[]): IssueData => ({
    // Read at each build, including persistence: logging can change the registry.
    language: deps.language ?? ownerLangTag(),
    ...draft,
    pulse: items,
    byHouse: laidOutBy(items),
  });

  // Keep the whole return inside the host's single-tool-result cap (see PAYLOAD_BUDGET):
  // over it the host drops the MIDDLE of the materials without telling the tool, and the
  // agent is left holding materials it can't trust. Drop items until it fits — the brief
  // already states both numbers ("N items gathered today" from the window, "N items" on
  // the materials heading), so a trimmed issue reads honestly with no extra copy.
  // buildNewspaperPrompt is a pure string join; a few extra passes cost nothing next to
  // one agent turn.
  // What to leave out, in order. An unattributed item is the least valuable thing in a
  // person-first paper, so those go before anything that carries someone; oldest first
  // within each group. Trimming by recency alone was measured against a real feed
  // (2026-08-25) to throw away Tesla / WIRED / The Economist / natgeo / verge /
  // QuantaMagazine while keeping forty-odd unattributed scrapes. Page order never
  // changes — this only picks what does not make the issue.
  //
  // ⚠️ The trim runs on the SAME array the issue is stored from, so the item numbers the
  // agent is given and the ones the renderer lays out are the same numbers. Trimming the
  // brief but storing the untrimmed issue would silently shift every key in `edit.items`.
  // ——— The candidate page. Everything the day carried goes over, grouped by author, with
  // the owner's taste and bond book at the top; the writer answers with the numbers it
  // wants and `buildIssueFromPicks` turns that into the issue.
  //
  // The one thing still trimmed here is the page itself: a host hands over at most one
  // message's worth (>=200k-context models: 64,000 weighted units) and drops the MIDDLE of
  // anything larger without telling the tool. So the oldest candidates come off until the
  // page fits, and the page says how many of the day it is actually showing — a number the
  // owner can see, rather than a silent cut.
  // What comes off first when the page has to be trimmed: an item with nobody on it is the
  // least valuable thing in a person-first paper, so those go before anything that carries
  // someone; oldest first within each group.
  const dropOrder = candidateOrder(pulse, lang)
    .map((p, i) => ({ i, carriesPerson: p.author ? 1 : 0 }))
    .sort((a, b) => a.carriesPerson - b.carriesPerson || b.i - a.i)
    .map((x) => x.i);
  // Page order first, storage second: the numbers on the page are indices into what gets
  // stored, so the two must be the same list in the same order or the page comes out with
  // holes in its numbering (see `candidateOrder`).
  const ordered = candidateOrder(pulse, lang);
  let shown: readonly PulseItem[] = ordered;
  const page = (list: readonly PulseItem[]): string =>
    buildCandidatePage(issueOf(list), {
      tasteText: deps.tasteText ?? '',
      bondLines: deps.bondLines ?? [],
      publishToken: candidateToken,
      suggestMin: PICK_SUGGESTED_MIN,
      suggestMax: PICK_SUGGESTED_MAX,
      floor: PICK_FLOOR,
      perAuthorMax: PER_AUTHOR_MAX,
      budget: pageBudgetNow(deps.sessionKey),
      dayTotal: draft.totalCount,
      overBudget: over,
      sessionKey: deps.sessionKey,
    });
  const budget = pageBudgetNow(deps.sessionKey);
  // Rebuilt below once the trim settles; `over` decides which completeness line the page carries.
  let over = false;
  let payload = page(shown);
  while (weightedChars(payload) > budget && shown.length > MIN_PULSE) {
    const cut = new Set(dropOrder.slice(0, ordered.length - Math.max(MIN_PULSE, Math.floor(shown.length * 0.8))));
    shown = ordered.filter((_, i) => !cut.has(i));
    payload = page(shown);
  }

  // Group once more, *after* the trim, and only then hand out the numbers.
  //
  // The order is decided by group sizes — bonded first, then strangers fewest-first, then
  // the one-or-two-post authors pooled at the end. Trimming changes those sizes, so an
  // author cut from four posts to two crosses into the pooled group and moves to the foot of
  // the page. The numbers, meanwhile, came from the pre-trim order. Reproduced: a page
  // showing [1][2][3][6][7][8][9][10][4][5] under a line promising the numbers "run 1 to N
  // in the order they appear".
  //
  // Numbering that contradicts the page is what sent two machines to the feed to fill in
  // items they thought had been cut (2026-08-27). Re-ordering here is idempotent — the
  // groups keep the sizes they were just sorted by — so page order, stored order and the
  // numbers are one thing again.
  // The trim stops at MIN_PULSE rather than gut the page, so it can exit still over budget —
  // and that is precisely when the host silently drops the middle. The page has to say so
  // instead of promising it is whole.
  over = weightedChars(payload) > budget;
  shown = candidateOrder(shown, lang);
  payload = page(shown);

  // What this page was sized against, and what it came out weighing. Session keys, numbers
  // and counts only — never a word of the material. Without it, a page that arrives cut on a
  // real host (2026-09-13) leaves nothing behind to say whether the budget was this
  // session's own, borrowed from the default bucket, or the constant.
  deps.log?.(
    pageBudgetLogLine(
      'candidate',
      pageBudgetDecision(deps.sessionKey),
      weightedChars(payload),
      ordered.length - shown.length,
      ordered.length,
    ),
  );

  // The candidate set is stored in exactly that order, so the numbers the writer answers
  // with still mean what they meant when it read them. The session stamp rides along as a
  // diagnostic of WHO was served the page (2026-09-06 content-mismatch P1) — since r25 a
  // picks call resolves only by an explicit candidate_token/basis naming the page, never
  // by session-newest, so the stamp no longer gates any binding.
  putIssue(candidateToken, issueOf(shown), deps.manifestDir, deps.sessionKey);
  return { kind: 'candidates', payload, candidateToken };
}
