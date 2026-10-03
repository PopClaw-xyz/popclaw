/** Side-effect-free presentation contract and text metrics. No backend imports. */

/* --------------------------------------------------------------------------
 * The budget a prompt has to fit, and the measurement behind it.
 *
 * MEASURED in the installed host bundle, not estimated: `description` is
 * refused above 512 and `title` above 80 by `buildPluginApprovalPresentation`
 * (`dist/exec-approval-manager-D9SuY45T.mjs:63`), which is the plugin-kind path
 * a `requireApproval` takes, and measured AFTER the host sanitizes the text.
 *
 * THE UNIT IS UNICODE CODE POINTS, and that was checked rather than assumed —
 * bytes, UTF-16 code units and code points differ by a factor of three on the
 * content this carries, and a limit measured in one unit against a count made
 * in another is the shape of error no care in the code catches.
 * `exceedsApprovalTextLimit` (`dist/exec-approval-text-sanitize-Di2YnUSG.mjs:113-119`)
 * counts with `for (const _ of value)` — the string iterator, which yields
 * CODE POINTS, not UTF-16 units. Its two fast paths are exact bounds on that
 * same count (cp ≤ utf16 ≤ 2·cp), so `value.length <= max` is only reachable
 * when cp ≤ max and `value.length > max * 2` only when cp > max: the function
 * is exactly "code-point count > maxLength", with no unit mismatch hiding in
 * the shortcuts. So an emoji costs 1 and a Chinese character costs 1. No
 * byte-level guard sits in front of it on this path (checked in
 * exec-approval-manager, approval-shared and operator-approval-store).
 *
 * An over-cap description is not truncated there — the function returns `null`
 * and the whole prompt becomes unbuildable — so an over-budget subject is
 * refused HERE, by name, rather than silently losing its prompt.
 *
 * MEASURED for the launch subject (`rangermap.check_in`, four fields) against
 * the Ranger Map house guide — revision `rangermap-guide-1`, sha256 1d9a3fe8…,
 * `GET http://127.0.0.1:8113/v1/guide.md`, 3958 characters. Every bound it
 * declares is in CODE POINTS, the same unit as the host's cap, so the two
 * compose with no conversion:
 *
 *   `place`                 1–60 code points after trimming
 *   `latitude`/`longitude`  decimal strings, ≤4 fractional digits, ±90 / ±180
 *                           → at most `-90.0000` (8) and `-180.0000` (9)
 *   `status`                one line, 1–160 code points after trimming (L48)
 *
 *   frame with every value empty ............................... 139
 *   the four values as really sent, loopback house ............. 264
 *   the same with a 31-character public origin ................. 273
 *   place/latitude/longitude at their maxima, public origin .... 271
 *   + `status` at its declared maximum of 160 .................. 431
 *
 * So the WORST LEGAL check-in is 431 against a 512 cap, and 431 against the
 * 496 this module actually allows itself — 65 code points of headroom. There
 * is a test pinned to exactly that case.
 *
 * KEEP THE PER-CALL MEASUREMENT ANYWAY. 160 is what THIS house declares, not a
 * property of the protocol: another house may declare a longer status, more
 * fields, or a longer kind, and the refusal has to stay honest for houses
 * nobody here has seen. The arithmetic above says the launch action fits; it
 * does not say every action does, and removing the check as "already proved"
 * would turn a named refusal back into a silently unbuildable prompt.
 * ----------------------------------------------------------------------- */
export const APPROVAL_DESCRIPTION_CODE_POINTS = 512;
export const APPROVAL_TITLE_CODE_POINTS = 80;
/** Margin against the host measuring the SANITIZED text rather than ours. The
 *  one path that can LENGTHEN it — escaping an invisible character to `\u{XX}`
 *  — is closed by refusing those characters outright; what is left is secret
 *  redaction, which replaces a match with `***` or a shorter mask and has not
 *  been measured end to end. Kept next to that gap rather than at the edge of
 *  a bound nobody exercised. */
const SANITIZER_MARGIN_CODE_POINTS = 16;
export const APPROVAL_DESCRIPTION_BUDGET = APPROVAL_DESCRIPTION_CODE_POINTS - SANITIZER_MARGIN_CODE_POINTS;
export const APPROVAL_TITLE_BUDGET = APPROVAL_TITLE_CODE_POINTS - SANITIZER_MARGIN_CODE_POINTS;
/** A prompt with more rows than this is refused rather than shown. The budget
 *  alone does not bound rows usefully — a two-character row costs ~4 code
 *  points, so 496 code points would admit over a hundred of them — and a
 *  dialog nobody can take in on one screen is not something a person can be
 *  said to have read. The worst legal check-in measured above is SEVEN rows,
 *  so this leaves room for houses with far more fields than Ranger Map has
 *  while still naming a limit. */
export const APPROVAL_DESCRIPTION_MAX_LINES = 32;

/**
 * How much one backend's dialog may carry. Chosen by the BACKEND that shows
 * the prompt and handed down by the seam; no tool parameter reaches it, so a
 * model can neither pick a budget nor skip one.
 *
 * `descriptionMax` is measured in `unit`, which is the unit of the source the
 * bound comes from: the native cap counts code points; the MCP backend's
 * display budget counts the UTF-8 bytes of the rendered rows.
 * Measure through `approvalTextSize`, never by hand.
 *
 * A descriptor may pin its OWN budget (`displayBudget`), which then wins over
 * the backend's — see `OwnerApprovalSubjectDescriptor`.
 */
export interface ApprovalDisplayBudget {
  readonly descriptionMax: number;
  readonly unit: 'codePoints' | 'utf8Bytes';
  readonly maxLines: number;
}
/** The OpenClaw native `requireApproval` budget measured above. Unchanged, and
 *  the budget in the default native profile. */
export const NATIVE_APPROVAL_DISPLAY_BUDGET: ApprovalDisplayBudget = Object.freeze({
  descriptionMax: APPROVAL_DESCRIPTION_BUDGET,
  unit: 'codePoints',
  maxLines: APPROVAL_DESCRIPTION_MAX_LINES,
});
/** The size of prompt text in the budget's own unit. */
export function approvalTextSize(text: string, budget: ApprovalDisplayBudget): number {
  return budget.unit === 'utf8Bytes' ? new TextEncoder().encode(text).length : [...text].length;
}

/** The two existing draft content policies, selected only by trusted host code.
 * A bound review refers to a decision and file already recorded at mint;
 * composing a prompt never creates or discovers a review copy. */
export type DraftPresentation = 'preview-or-transcript' | 'whole-or-bound-review';

export interface ApprovalLayoutMetrics {
  readonly rowColumns: number;
  readonly firstLineColumns: number;
  readonly confirmDescriptionColumns: number;
  readonly pointerMaxRows: number;
}

export interface ApprovalDialogProfile {
  readonly budget: ApprovalDisplayBudget;
  readonly draftPresentation: DraftPresentation;
  readonly layout: ApprovalLayoutMetrics;
}

/** Existing shared dimensions, including native prompts. Originally measured
 * on the folded MCP form: 64 columns per row, 72 on its first line, 80 under
 * confirm, and five pointer rows. These are composition limits, not claims
 * that a host shows the complete message without expansion. */
export const APPROVAL_LAYOUT: ApprovalLayoutMetrics = Object.freeze({
  rowColumns: 64,
  firstLineColumns: 72,
  confirmDescriptionColumns: 80,
  pointerMaxRows: 5,
});

export const NATIVE_APPROVAL_PROFILE: ApprovalDialogProfile = Object.freeze({
  budget: NATIVE_APPROVAL_DISPLAY_BUDGET,
  draftPresentation: 'preview-or-transcript',
  layout: APPROVAL_LAYOUT,
});

/** Fixed compact policy for BOTH mint and ask, using the language recorded
 * at mint. It is independent of the actual backend profile and any subject
 * budget override. Changing it is a review-decision behavior change. */
export const COMPACT_DRAFT_REVIEW_POLICY = Object.freeze({
  budget: NATIVE_APPROVAL_DISPLAY_BUDGET,
  layout: APPROVAL_LAYOUT,
});

/** East-asian wide and fullwidth blocks plus the emoji planes: one character,
 *  two terminal columns. Inclusive code-point ranges (Unicode TR#11 W and F). */
const WIDE_RANGES: readonly (readonly [number, number])[] = Object.freeze([
  [0x1100, 0x115f],   // Hangul Jamo
  [0x2e80, 0x303e],   // CJK radicals, Kangxi, CJK symbols and punctuation
  [0x3041, 0x33ff],   // kana, Bopomofo, Hangul compatibility jamo, CJK compatibility
  [0x3400, 0x4dbf],   // CJK unified ideographs extension A
  [0x4e00, 0x9fff],   // CJK unified ideographs
  [0xa000, 0xa4cf],   // Yi syllables and radicals
  [0xa960, 0xa97f],   // Hangul Jamo extended-A
  [0xac00, 0xd7a3],   // Hangul syllables
  [0xf900, 0xfaff],   // CJK compatibility ideographs
  [0xfe10, 0xfe19],   // vertical forms
  [0xfe30, 0xfe6f],   // CJK compatibility forms, small form variants
  [0xff00, 0xff60],   // fullwidth forms
  [0xffe0, 0xffe6],   // fullwidth signs
  [0x1f300, 0x1f9ff], // the common emoji blocks
  [0x1fa70, 0x1faff], // symbols and pictographs extended-A
  [0x20000, 0x3fffd], // CJK unified ideographs extension B and later
  // The wide code points scattered through otherwise narrow symbol blocks
  // (wcwidth's Wide list): ✅ ⚡ ⌚ ⭐ 🈚 and their neighbours paint two columns
  // even though the blocks around them paint one. Left out, eight of them in a
  // near-full value walk past the real cut.
  [0x231a, 0x231b], [0x23e9, 0x23ec], [0x23f0, 0x23f0], [0x23f3, 0x23f3],
  [0x25fd, 0x25fe], [0x2614, 0x2615], [0x2648, 0x2653], [0x267f, 0x267f],
  [0x2693, 0x2693], [0x26a1, 0x26a1], [0x26aa, 0x26ab], [0x26bd, 0x26be],
  [0x26c4, 0x26c5], [0x26ce, 0x26ce], [0x26d4, 0x26d4], [0x26ea, 0x26ea],
  [0x26f2, 0x26f3], [0x26f5, 0x26f5], [0x26fa, 0x26fa], [0x26fd, 0x26fd],
  [0x2705, 0x2705], [0x270a, 0x270b], [0x2728, 0x2728], [0x274c, 0x274c],
  [0x274e, 0x274e], [0x2753, 0x2755], [0x2757, 0x2757], [0x2795, 0x2797],
  [0x27b0, 0x27b0], [0x27bf, 0x27bf], [0x2b1b, 0x2b1c], [0x2b50, 0x2b50],
  [0x2b55, 0x2b55], [0x1f004, 0x1f004], [0x1f0cf, 0x1f0cf], [0x1f18e, 0x1f18e],
  [0x1f191, 0x1f19a], [0x1f200, 0x1f2ff],
]);
/** Marks and joiners that occupy no column of their own. */
const ZERO_WIDTH_RANGES: readonly (readonly [number, number])[] = Object.freeze([
  [0x0300, 0x036f], // combining diacritical marks
  [0x200b, 0x200f], // zero-width space … right-to-left mark
  [0xfe00, 0xfe0f], // variation selectors
]);
function inRanges(code: number, ranges: readonly (readonly [number, number])[]): boolean {
  return ranges.some(([low, high]) => code >= low && code <= high);
}
/** Terminal columns, shared by approval presenters and draft composition. */
export function displayWidth(text: string): number {
  let columns = 0;
  for (const character of text) {
    const code = character.codePointAt(0)!;
    if (isZeroWidthCodePoint(code)) continue;
    columns += inRanges(code, WIDE_RANGES) ? 2 : 1;
  }
  return columns;
}

/** Combining marks and joiners that occupy no terminal column. */
export function isZeroWidthCodePoint(code: number): boolean { return inRanges(code, ZERO_WIDTH_RANGES); }
