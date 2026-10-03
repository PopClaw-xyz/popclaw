/**
 * What the owner is asked before `popclaw_send_draft` sends anything.
 *
 * The defect this closes (found in review, confirmed on real hardware
 * 2026-09-21): `popclaw_send_draft` took a `draft_id` and nothing else, so the
 * model that wrote a draft could confirm its own draft. On no host was there a
 * check that the owner had agreed. DMs, replies, posts and feedback letters
 * all go through that one door.
 *
 * Two rules shape everything below.
 *
 *  1. The approval binds to the draft's IMMUTABLE SNAPSHOT — recipient, house,
 *     complete body, attachment digests, and the digests of the two showings
 *     the draft tool made of it — never to a `confirmed: true` the model
 *     supplies and never to the id alone. `canonicalize` runs on the live
 *     table, so a draft whose content moved, or a different draft under a
 *     reused id, is a different subject and the seam refuses it by name.
 *  2. The prompt must be truthful about where the complete text IS, and must
 *     never claim the owner has read it. It carries the whole letter whenever
 *     that fits. When it does not, there has to be a complete copy the owner
 *     can reach — the preview pushed into their own chat, or the draft tool's
 *     own output in this host's transcript — and the prompt says which, and
 *     how to get to it. With neither, it refuses by name. It never summarises
 *     content nobody can read, and it never truncates in silence.
 */

import {
  FOLDED_ALTERNATIVE_UNPRESENTABLE,
  hasInvisibleCharacter,
  type ApprovalSubjectResult,
  type OwnerApprovalOutcome,
  type OwnerApprovalSubjectDescriptor,
} from '../host/owner-approval.js';
import { OWNER_APPROVAL_ROUTE_REFUSALS } from '../host/owner-approval-route.js';
import {
  APPROVAL_TITLE_BUDGET, COMPACT_DRAFT_REVIEW_POLICY, NATIVE_APPROVAL_PROFILE,
  approvalTextSize, displayWidth, type ApprovalDisplayBudget,
  type ApprovalDialogProfile, type ApprovalLayoutMetrics,
} from '../host/approval-presentation.js';
import { kb } from '../messaging/dm-media.js';
import { draftDigest, expiredDraftText, peekDraftSnapshot, verifyDraftReview, type DraftSnapshot } from './draft-store.js';
import { ownerLang } from '../lexicon/owner-language.js';
import { renderCopy, type Lang } from '../lexicon/index.js';
import { timeContext } from '../time/time-context.js';

/** The one tool name this subject is registered under. Exported so the tool
 *  body, the registration and the tests cannot drift to three spellings. */
export const SEND_DRAFT_TOOL = 'popclaw_send_draft';

/** The seam compares subjects as opaque strings; this is the version tag that
 *  lets the shape change later without a stale record matching a new one. */
const SUBJECT_VERSION = 'send-draft/v1';
/** Composite keys are NUL-joined project-wide, so a value containing the
 *  separator cannot forge a field boundary (the body's length rides along
 *  beside it for the same reason). */
const NUL = '\0';

/** Named refusals. Each one is a different thing to tell the owner's agent, so
 *  none of them collapses into a shared "cannot". */
const REFUSE_UNKNOWN_DRAFT = 'DRAFT_UNKNOWN_OR_EXPIRED';
const REFUSE_NOT_SHOWN_TOO_LONG = 'DRAFT_NOT_SHOWN_AND_TOO_LONG';
const REFUSE_PROMPT_TOO_LONG = 'DRAFT_DESCRIPTION_TOO_LONG';
/** A row carries a character that paints nothing. Refused rather than shown,
 *  and refused HERE so the reason names the draft rather than arriving from
 *  the seam as a length complaint that would not be true. */
const REFUSE_NOT_SHOWABLE = 'DRAFT_TEXT_NOT_SHOWABLE';
/*
 * Why a whole-text backend (the MCP dialog) could not be given the whole
 * letter. Never abbreviated instead; see `MCP_APPROVAL_DISPLAY_BUDGET`. Each
 * names one fact, so none is reported for another's reason.
 */
/** The rendered approval preview is over the backend's display budget (for
 *  MCP, UTF-8 bytes of the rendered rows; see `MCP_APPROVAL_DISPLAY_BUDGET`).
 *  Says nothing about whether the letter itself is valid or sendable. */
const REFUSE_PREVIEW_OVER_BUDGET = 'APPROVAL_PREVIEW_OVER_DISPLAY_BUDGET';
/** More rows than the backend's row limit. */
const REFUSE_TOO_MANY_ROWS = 'DRAFT_FULL_TEXT_TOO_MANY_ROWS';
/** A row wider than a row may be. Header rows wrap and body rows wrap, so
 *  this is a composition defect, named rather than blamed on the length. */
const REFUSE_ROW_TOO_WIDE = 'DRAFT_ROW_TOO_WIDE';
/** The review copy the approval is bound to is missing, or its bytes are not
 *  the ones written (`verifyDraftReview`). Nothing is sent; the owner is told
 *  to regenerate the review. Exported for the send body, which checks it. */
export const REFUSE_REVIEW_COPY = 'REVIEW_COPY_CHANGED_OR_MISSING';
/** The review-copy decision recorded at mint and the one re-made at approval
 *  (`needsReviewCopy`, same inputs) disagree. */
const REFUSE_REVIEW_DECISION_MISMATCH = 'REVIEW_DECISION_MISMATCH';
/** A needed review copy could not be written at mint: there never was
 *  anything for the owner to read. */
const REFUSE_REVIEW_NOT_WRITTEN = 'REVIEW_COPY_NOT_WRITTEN';
/** The review rows themselves carry a character that paints nothing.
 *  Defensive: `withDraftReview` never writes a copy under such a path, so a
 *  recorded file cannot have one today. */
const REFUSE_REVIEW_PATH = 'REVIEW_PATH_NOT_SHOWABLE';

/**
 * THE CEILINGS THIS MODULE COMPOSES TO.
 *
 * Rows and code points are the asking BACKEND'S budget, handed down by the
 * seam (`ApprovalDisplayBudget`). The native one allows 32 rows and 496 code
 * points; everything below about excerpts, both ends and pointers exists only
 * for the `preview-or-transcript` policy. The `whole-or-bound-review` policy
 * shows the whole letter or its already-bound review copy, or refuses by name.
 * How much of that message a host displays is measured separately: the budget is this preview's resource budget, not a claim about
 * any host's display and not the protocol's bound on a letter.
 *
 * HEADER ROWS WRAP. A header value (recipient, house, attachment name) wider
 * than a row continues on rows marked `HEADER_CONTINUATION`, on both
 * channels; the native total budget still applies to the result.
 *
 * WIDTH: every row is kept within `layout.rowColumns` (64) display
 * columns and the title within `layout.firstLineColumns` (72). These numbers were
 * the old folded dialog's; they are now this module's own composition limits.
 * A body line too wide is WRAPPED into more rows and nothing is lost; a header
 * row too wide is wrapped onto marked continuation rows (`wrapHeader`), never
 * cut and no longer refused.
 *
 * ROW COUNT follows the LETTER in every layout but one, under the seam's 32.
 * Composing the whole body to five rows was tried and regressed: a feedback
 * letter, which carries a `[feedback/v1]` header line of its own, stopped
 * being approvable anywhere.
 *
 * `inTranscript` composes to `layout.pointerMaxRows` (currently five) rows,
 * and refuses itself above that. Its rows are fixed — the header rows, one
 * pointer, the two ends of the letter — so nothing about it grows with the
 * body.
 */

/**
 * Characters the host's approval sanitizer treats as invisible — its own class
 * at `dist/exec-approval-text-sanitize-*.mjs:6`, which the seam re-states and
 * refuses on. Mirrored here (minus `\n`, which is a legal row break) so the
 * prompt this module composes is showable by construction instead of being
 * rejected downstream under a length reason that would not be the truth.
 */
/** Code points, counted the way the host counts them: by iterating the string,
 *  so an astral character is one and `.length` is never the measure. */
const codePoints = (text: string): number => [...text].length;

/**
 * Header rows are strict: a row that says WHERE this goes or WHAT rides along
 * cannot contain a character that paints nothing. A bidi override inside a
 * recipient label or an attachment name would make the owner read a different
 * destination from the one they are approving, and there is no honest way to
 * show that — so it is a named refusal.
 */
const hasInvisible = hasInvisibleCharacter;

/**
 * Body rows take the opposite treatment, and deliberately.
 *
 * Refusing the body on an invisible character would mean an ordinary DM
 * carrying a ZWJ emoji sequence or a variation selector could never be
 * approved — a real cost on the main path, in exchange for nothing: the
 * excerpt is supplementary, and what is actually approved is bound by
 * `canonicalize` over the full snapshot, which carries the real bytes either
 * way. So the character is ESCAPED into something the owner can see. A hidden
 * bidi control becomes visible rather than being passed through or refused,
 * which is strictly more information than either alternative.
 *
 * The token is built from guillemets and ASCII hex, so it can never itself
 * carry an invisible character, and it is counted toward the budget like any
 * other text.
 *
 * INJECTIVE, which is the whole point. A body that literally contains the
 * text `\u2039U+200D\u203a` must not render identically to a body containing a
 * real zero-width joiner — two different letters the owner cannot tell apart
 * is the same deception this lane just closed, wearing a different hat. So the
 * introducer escapes itself: a literal `\u2039` in the body becomes
 * `\u2039U+2039\u203a`. Every `\u2039` in the output is therefore the start of
 * a token this function wrote and nothing else, which makes the rendering
 * decodable and so one-to-one.
 */
const ESCAPE_INTRODUCER = '\u2039';

/** ATOMS, not characters. An escape token is one atom so the wrapping below
 *  can never cut `\u2039U+200D\u203a` in half across two rows — half a token
 *  would be unreadable and, worse, decodable as something else. */
function escapeInvisible(row: string): { readonly atoms: readonly string[]; readonly escaped: boolean } {
  let escaped = false;
  const atoms = [...row].map((ch) => {
    if (!hasInvisibleCharacter(ch) && ch !== ESCAPE_INTRODUCER) return ch;
    escaped = true;
    const cp = (ch.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0');
    return `${ESCAPE_INTRODUCER}U+${cp}\u203a`;
  });
  return { atoms, escaped };
}

/**
 * Pack atoms into rows no wider than `layout.rowColumns`.
 *
 * Wrapping is a DISPLAY act and is allowed to add rows; what it must never do
 * is lose an atom or split one. Splitting on display columns rather than code
 * points is what makes a row of CJK — two columns a character — wrap at the
 * same place the client would have cut it off.
 */
function wrapAtoms(atoms: readonly string[], columns: number): string[] {
  const rows: string[] = [];
  let current = '';
  let width = 0;
  for (const atom of atoms) {
    const w = displayWidth(atom);
    if (width + w > columns && current !== '') {
      rows.push(current);
      current = '';
      width = 0;
    }
    current += atom;
    width += w;
  }
  rows.push(current);
  return rows;
}

/**
 * Every character class that would start a new row somewhere: LF, CR, CRLF,
 * VT, FF, NEL, LINE SEPARATOR, PARAGRAPH SEPARATOR. The body is split on all
 * of them BEFORE anything is emitted, so a line break inside the text becomes
 * a row of ours — prefixed like every other body row — instead of arriving at
 * the prompt as an unmarked row of its own.
 */
const ROW_BREAK_CODE_POINTS: ReadonlySet<number> = new Set([
  0x000a, 0x000d, 0x000b, 0x000c, 0x0085, 0x2028, 0x2029,
]);
function splitRows(text: string): string[] {
  const rows: string[] = [];
  const chars = [...text];
  let current = '';
  for (let i = 0; i < chars.length; i++) {
    const cp = chars[i]!.codePointAt(0) ?? 0;
    if (!ROW_BREAK_CODE_POINTS.has(cp)) {
      current += chars[i];
      continue;
    }
    // CR LF is one break, not two — an empty row between them would be a row
    // the body did not write.
    if (cp === 0x000d && (chars[i + 1]?.codePointAt(0) ?? 0) === 0x000a) i++;
    rows.push(current);
    current = '';
  }
  rows.push(current);
  return rows;
}

/**
 * The marker every body row carries. It is what makes a body line reading
 * `To: someone-else` unable to pass for the header row directly above it: the
 * header rows this module emits never start with it, and every row after the
 * body label does.
 */
const BODY_ROW_PREFIX = '> ';
/** One escape token, or one ordinary character. Splitting a rendered row back
 *  into the atoms `escapeInvisible` produced, so a clip lands between them. */
const ESCAPE_TOKEN_OR_CHARACTER = /\u2039U\+[0-9A-F]{4,6}\u203a|[\s\S]/gu;
/** What joins two facts that share a row. Visible, and not a row break. */
const ROW_PART_SEPARATOR = ' \u00b7 ';
const quoted = (row: string): string => `${BODY_ROW_PREFIX}${row}`;

/**
 * The marker a header row's CONTINUATION carries, on both channels.
 *
 * A header value is not ours to shorten — an attachment named the way
 * WhatsApp names every photo (`WhatsApp Image 2026-09-27 at 10.15.32
 * (1).jpeg`) takes a row past the 64-column width on its own, and so does a
 * long nickname or house slug — so the row is WRAPPED instead, and every row
 * after its first begins with this marker. It is never `> ` (every row after
 * the body label is a body row and nothing else) and never a lexicon label,
 * so a continuation reads as "the row above, continued" and as nothing else.
 * A body line that imitates it is still a body row: it arrives quoted, as
 * `> ↪ …`.
 */
const HEADER_CONTINUATION = '\u21aa ';

/**
 * One header row as rows no wider than `layout.rowColumns`: itself when it
 * fits, else its first part and continuation rows. Breaks after a space when
 * the part has one, else between characters; nothing is dropped, so the parts
 * with their markers removed concatenate back to the row exactly.
 */
function wrapHeader(row: string, layout: ApprovalLayoutMetrics): string[] {
  if (displayWidth(row) <= layout.rowColumns) return [row];
  const rows: string[] = [];
  let rest = [...row];
  while (rest.length > 0) {
    const room = rows.length === 0 ? layout.rowColumns : layout.rowColumns - displayWidth(HEADER_CONTINUATION);
    let take = 0;
    let width = 0;
    while (take < rest.length && width + displayWidth(rest[take]!) <= room) width += displayWidth(rest[take++]!);
    // At a space when one falls in the part's second half; a break any
    // earlier (after `To: `, say) would leave a row that is only its label.
    if (take < rest.length) {
      const space = rest.lastIndexOf(' ', take - 1);
      if (space > take / 2) take = space + 1;
    }
    const part = rest.slice(0, Math.max(1, take)).join('');
    rows.push(rows.length === 0 ? part : `${HEADER_CONTINUATION}${part}`);
    rest = rest.slice(Math.max(1, take));
  }
  return rows;
}

function draftIdOf(params: unknown): string | null {
  if (typeof params !== 'object' || params === null) return null;
  const id = (params as { draft_id?: unknown }).draft_id;
  return typeof id === 'string' && id.trim().length > 0 ? id : null;
}

/**
 * The bytes this approval binds.
 *
 * Pure and TOTAL by contract: the seam runs it once when the prompt is built
 * and again when the tool body consumes the answer, and a throw on the second
 * call would turn a granted approval into a crash rather than a refusal. An
 * unknown, expired or snapshot-less draft therefore answers a stable sentinel
 * that still names the id — two different unknown ids stay two different
 * subjects, so one refusal can never stand in for another.
 *
 * Its one effect on the world is that the read underneath it collects drafts
 * the TTL has already killed. That cannot change an answer: a draft dead
 * enough to be collected already canonicalized to the sentinel.
 */
function canonicalize(params: unknown): string {
  const id = draftIdOf(params);
  if (id === null) return [SUBJECT_VERSION, 'no-draft-id'].join(NUL);
  const snapshot = peekDraftSnapshot(id);
  if (!snapshot) return [SUBJECT_VERSION, 'unknown-draft', id].join(NUL);
  return [
    SUBJECT_VERSION,
    'draft',
    id,
    snapshot.kind,
    snapshot.recipientId ?? '',
    snapshot.recipientLabel ?? '',
    snapshot.house ?? '',
    snapshot.target ?? '',
    String(codePoints(snapshot.body)),
    snapshot.body,
    String(snapshot.attachments.length),
    // The digest is RECOMPUTED from the stored bytes, not read off the
    // snapshot. A `Uint8Array` cannot be frozen, so a caller holding one —
    // anything that got a snapshot out of the table — could `.fill()` it in
    // place and neither the stored digest nor this subject would move, while
    // the mutated bytes went out. Hashing what is actually there makes that
    // impossible rather than merely unlikely: the bytes ARE the subject, so
    // touching them changes it and the send refuses with SUBJECT_CHANGED.
    // Costs one SHA-512 over at most `MAX_DM_MEDIA_BYTES` twice per approved
    // send — once when the prompt is built, once when the body consumes.
    ...snapshot.attachments.flatMap((a) => [a.name, draftDigest(a.bytes)]),
    snapshot.preview?.digest ?? '',
    snapshot.preview?.status ?? '',
    String(snapshot.preview?.at ?? 0),
    // The showing licenses the prompt, so it is part of what was approved: a
    // draft re-parked with no output record, or with a different one, is a
    // different subject and an approval taken against the old one refuses by
    // name rather than riding across.
    snapshot.output?.digest ?? '',
    String(snapshot.output?.at ?? 0),
    // The review copy the owner was pointed at: the decision, the language it
    // was made in, and the path and SHA-256 of the bytes written. An approval
    // is bound to that exact file; the send body re-hashes it before sending
    // (`verifyDraftReview`) and never reads it as content.
    snapshot.review ? String(snapshot.review.needed) : '',
    snapshot.review?.lang ?? '',
    snapshot.review?.file?.path ?? '',
    snapshot.review?.file?.sha256 ?? '',
    snapshot.review?.failed ?? '',
  ].join(NUL);
}

/** What `describeRows` found out that `labelled` needs: the kind, whether the
 *  whole letter is the first-screen line, whether the prompt carries the
 *  whole letter at all, and whether the draft tool's full output exists in
 *  the host transcript (the only thing Claude Code's ctrl+o can open). */
interface Seen {
  bodyOnFirstLine: boolean; wholeShown: boolean; hasOutput: boolean; kind: DraftSnapshot['kind'] | null;
  /** Set when the compact review layout was composed: the digest it named. */
  review?: { readonly digest8: string };
}

const confirmKey = {
  dm: 'sendDraft.approval.confirm.dm',
  reply: 'sendDraft.approval.confirm.reply',
  post: 'sendDraft.approval.confirm.post',
  feedback: 'sendDraft.approval.confirm.feedback',
} as const;

const kindKey = {
  dm: 'sendDraft.kind.dm',
  reply: 'sendDraft.kind.reply',
  post: 'sendDraft.kind.post',
  feedback: 'sendDraft.kind.feedback',
} as const;

/** `Alice#7q2k (a1b2c3d4)` — the form of address the preview used, plus enough
 *  of the id to tell two people with one name apart. The full id does not fit
 *  a prompt and is bound by `canonicalize` anyway. */
function whoLine(snapshot: DraftSnapshot, lang: Lang): string | null {
  if (!snapshot.recipientLabel && !snapshot.recipientId) return null;
  const short = snapshot.recipientId ? snapshot.recipientId.slice(0, 8) : '';
  const label = snapshot.recipientLabel ? cappedLabel(snapshot.recipientLabel) : '';
  const who = label ? (short ? `${label} (${short})` : label) : short;
  return renderCopy(lang, 'sendDraft.approval.to', { who });
}

/** At most this many code points of a recipient label are shown. A peer's
 *  nickname is unbounded remotely, and past this it only serves to push text
 *  that reads like a label (`house: …`) onto continuation rows. */
const MAX_LABEL_CODE_POINTS = 64;
/** A label split at its LAST `#`: the nickname, and the sigil that tells two
 *  people with one name apart (empty when there is none). */
function splitLabel(label: string): { nick: string; sigil: string } {
  const at = label.lastIndexOf('#');
  return at > 0 ? { nick: label.slice(0, at), sigil: label.slice(at) } : { nick: label, sigil: '' };
}
/** The label within `MAX_LABEL_CODE_POINTS`, cut in the nickname with a
 *  visible `…`; the sigil is always kept whole. Display only — the whole
 *  recipient is bound by `canonicalize`. */
function cappedLabel(label: string): string {
  if (codePoints(label) <= MAX_LABEL_CODE_POINTS) return label;
  const { nick, sigil } = splitLabel(label);
  const keep = Math.max(0, MAX_LABEL_CODE_POINTS - codePoints(sigil) - 1);
  return `${[...nick].slice(0, keep).join('')}\u2026${sigil}`;
}

/**
 * The recipient as a TITLE, for a DM whose recipient row cannot be one (it
 * wraps, or is over the title ceiling): the nickname's start, a visible `…`
 * where it is cut, then the sigil and the id's first eight characters, always
 * whole. A DM's first line is its recipient on every host; the full recipient
 * row stays below it. Null when there is no recipient.
 */
function shortWhoTitle(snapshot: DraftSnapshot, lang: Lang, layout: ApprovalLayoutMetrics): string | null {
  if (!snapshot.recipientLabel && !snapshot.recipientId) return null;
  const short = snapshot.recipientId ? snapshot.recipientId.slice(0, 8) : '';
  const { nick, sigil } = splitLabel(snapshot.recipientLabel ?? '');
  const tail = `\u2026${sigil}${short ? ` (${short})` : ''}`;
  let head = '';
  for (const ch of [...nick]) {
    const next = renderCopy(lang, 'sendDraft.approval.to', { who: `${head}${ch}${tail}` });
    if (titleRefusal(next, layout) !== null || displayWidth(next) > layout.rowColumns) break;
    head += ch;
  }
  const title = renderCopy(lang, 'sendDraft.approval.to', { who: `${head}${tail}` });
  return titleRefusal(title, layout) === null ? title : null;
}

/**
 * What a reply or quote target looks like to a person.
 *
 * The snapshot holds the machine-real value — a 64-hex event id, or
 * `reply:`/`quote:` in front of one — because that is what `canonicalize`
 * must bind. A 64-hex string is 64 display columns on its own, which is the
 * entire width a row has, so the prompt shows the same short form the draft
 * preview and the receipts already use. Nothing else is shortened: this one is
 * an opaque identifier whose tail tells the owner nothing.
 */
function targetDisplay(target: string): string {
  const [, verb, hex] = /^(reply|quote):([0-9a-f]{64})$/.exec(target) ?? [];
  if (verb && hex) return `${verb} #${hex.slice(0, 10)}`;
  return /^[0-9a-f]{64}$/.test(target) ? `#${target.slice(0, 10)}` : target;
}

/** Owner-local wall clock for the moment the preview attempt finished. Time of
 *  day only: a draft lives thirty minutes, so the date can only ever be today,
 *  and the row it shares has columns to spare for nothing. */
function when(at: number): string {
  return timeContext(Math.floor(at / 1000)).hm;
}

/** The tail of a row, in whole atoms, no wider than `columns`. Atom-wise like
 *  `wrapAtoms`, and for the same reason: half of `‹U+200D›` is both
 *  unreadable and decodable as something it is not. */
function tailAtoms(row: string, columns: number): string {
  const atoms = [...row.matchAll(ESCAPE_TOKEN_OR_CHARACTER)].map((m) => m[0]);
  let tail = '';
  let width = 0;
  for (let i = atoms.length - 1; i >= 0; i--) {
    const w = displayWidth(atoms[i]!);
    if (width + w > columns) break;
    tail = atoms[i]! + tail;
    width += w;
  }
  return tail;
}

/** Why a title cannot be shown, or null. Both ceilings: the seam's code-point
 *  budget and this module's `layout.firstLineColumns`. */
function titleRefusal(title: string, layout: ApprovalLayoutMetrics): string | null {
  if (hasInvisible(title)) return REFUSE_NOT_SHOWABLE;
  if (codePoints(title) > APPROVAL_TITLE_BUDGET || displayWidth(title) > layout.firstLineColumns) {
    return REFUSE_PROMPT_TOO_LONG;
  }
  return null;
}

/** What one prompt costs the backend, in its own unit: the rows plus the
 *  breaks the seam joins them with. */
const cost = (rows: readonly string[], budget: ApprovalDisplayBudget): number =>
  approvalTextSize(rows.join('\n'), budget);
/** Both ceilings at once: the backend's (rows, code points) and this module's
 *  row width (display columns — where a CJK character costs two). */
const fits = (rows: readonly string[], budget: ApprovalDisplayBudget, layout: ApprovalLayoutMetrics): boolean =>
  whyNotFits(rows, budget, layout) === null;
/** Which ceiling a prompt breaks, by name, or null — for a whole-text
 *  backend, whose refusals must each say what really happened. */
function whyNotFits(rows: readonly string[], budget: ApprovalDisplayBudget, layout: ApprovalLayoutMetrics): string | null {
  if (rows.length > budget.maxLines) return REFUSE_TOO_MANY_ROWS;
  if (!rows.every((row) => displayWidth(row) <= layout.rowColumns)) return REFUSE_ROW_TOO_WIDE;
  if (cost(rows, budget) > budget.descriptionMax) return REFUSE_PREVIEW_OVER_BUDGET;
  return null;
}

/**
 * THE FIRST SCREEN: what the MCP dialog's first line is, and what follows it.
 *
 * Claude Code 2.1.283 (probes v3–v3.2) shows only the FIRST LINE of an
 * elicitation message, then `… (+N more lines)`, and cannot expand it. The
 * MCP backend puts the prompt's title on that line, so this module offers it
 * a `firstScreen` spelling whose title is the one fact the owner most needs
 * there. It is for the MCP dialog only, on every MCP client alike; the native
 * backend keeps the composed title ("Send this post?") and rows unchanged.
 *
 *  - a letter with a RECIPIENT opens with the recipient row, so who it goes
 *    to is said first — unless that row is not showable as a title (over 64
 *    code points, e.g. a label heavy with combining marks), in which case no
 *    first-screen spelling is offered and the composed layout is shown, with
 *    the question first and the recipient as the first row under it;
 *  - a letter without one (a post, a reply) opens with its own text: the
 *    first body row, quoted like every body row. A one-row post is then whole
 *    on the first screen. The prefix stays because a post reading
 *    `To: Alice (…)` must not open the dialog looking like a DM to Alice;
 *  - with neither, nothing changes: the question stays the title.
 *
 * Below it: the question that used to be the title, the facts, then the
 * letter (its label row and body rows) LAST, as before. The letter does not
 * move up under the recipient, because the row discipline is positional as
 * well as prefixed: every row after the body label is a body row, and a
 * trusted fact row placed after the body would break that. So for a letter
 * with a recipient, the body is the first letter content after the facts.
 *
 * Nothing here decides whether a draft is approvable or which layout it gets:
 * every caller has already made those decisions on the rows it composed, so
 * this only moves the recipient row (or a copy of the opening row) up to the
 * first line and puts the question under it.
 *
 * The rearranged prompt is checked against the same ceilings. The question
 * row is the one addition; if the prompt does not fit with it, it is dropped
 * whole (the recipient row, the draft id and the confirm label still say what
 * this is). If it does not fit even then, or the first line is not showable
 * as a title, there is no first-screen spelling (null) and the rows the
 * caller composed are shown as they were.
 */
function presented(
  question: string,
  parts: {
    readonly who: string | null;
    readonly lead: string | null;
    readonly facts: readonly string[];
    readonly letter: readonly string[];
  },
  budget: ApprovalDisplayBudget,
  layout: ApprovalLayoutMetrics,
): { readonly title: string; readonly description: readonly string[] } | null {
  const first = parts.who ?? parts.lead;
  if (first === null || titleRefusal(first, layout) !== null) return null;
  for (const description of [
    [question, ...parts.facts, ...parts.letter],
    [...parts.facts, ...parts.letter],
  ]) {
    if (fits(description, budget, layout) && !description.some(hasInvisible)) return { title: first, description };
  }
  return null;
}

/** The first body row that shows anything, quoted: what a letter without a
 *  recipient opens the dialog with. */
function leadRow(bodyRows: readonly string[]): string | null {
  const row = bodyRows.find((r) => r.trim() !== '');
  return row === undefined ? null : quoted(row);
}

/**
 * The prompt for a letter whose complete text is in the HOST'S OWN OUTPUT —
 * the draft tool's result, which the host rendered in its transcript.
 *
 * What it has to do, and what it deliberately does not:
 *
 *  - it tells the owner WHERE the manuscript is, in words they can act on:
 *    the draft's own id, which the tool result prints as `draft_id:`, and the
 *    instruction to expand that output. Never "the full content is above",
 *    which is the model's line and means nothing;
 *  - it never says the owner has read it. The host may fold that output
 *    behind a keystroke, and it may cut a result past its own size cap;
 *  - so it pins BOTH ENDS of the letter. The opening says the owner found the
 *    right draft; the ending is the half a truncating host would silently
 *    lose, and it is the one the owner can check for themselves;
 *  - and it stays inside FIVE ROWS (`maxFields`), whatever the letter
 *    contains, refusing itself above that. What can want a sixth row is the
 *    escape legend, or a where-and-what header too wide to share one row, so
 *    when either is there the two ends share a row rather than anything above
 *    them being dropped: an emoji in the signature, or a long house slug, must
 *    not make a long letter unsendable.
 *
 * Refuses rather than showing a dialog that does not fit, like every other
 * path here: a clip the owner cannot see is the thing this module exists to
 * prevent.
 */
function inTranscript(args: {
  readonly draftId: string;
  readonly kindName: string;
  readonly chars: string;
  readonly escapedRows: readonly { readonly atoms: readonly string[] }[];
  readonly headerRows: readonly string[];
  /** Header rows before this index are never shared with the legend: the
   *  recipient row says who this goes to and nothing else. */
  readonly firstFoldable: number;
  /** The quoted opening row a letter without a recipient leads with. */
  readonly lead: string | null;
  readonly lang: Lang;
  readonly budget: ApprovalDisplayBudget;
  readonly layout: ApprovalLayoutMetrics;
}): ApprovalSubjectResult {
  const { draftId, kindName, chars, escapedRows, headerRows, firstFoldable, lead, lang, budget, layout } = args;
  // "Read it first" belongs in the TITLE: it is the first line of the native
  // prompt, and the instruction that has to reach an owner who is about to
  // answer on reflex. In the MCP first-screen spelling (`presented`) that
  // line goes to the recipient or the opening row, this becomes the row under
  // it, and the confirm field's line says where the full text is (`labelled`).
  const title = renderCopy(lang, 'sendDraft.approval.titleReadAbove', { kind: kindName });
  const titleBad = titleRefusal(title, layout);
  if (titleBad !== null) return { kind: 'refuse', reason: titleBad };

  // The letter's own lines, not the wrapped rows: a blank line is no use as
  // either end, and taking the last WRAPPED row would show the owner whatever
  // the wrap happened to leave over — `rithmetic.` where the letter ends with
  // `redo the arithmetic.`, which reads as a defect rather than as an ending.
  const lines = escapedRows.map((row) => row.atoms.join(''));
  const first = lines.findIndex((line) => line.trim() !== '');
  if (first < 0) return { kind: 'refuse', reason: REFUSE_PROMPT_TOO_LONG };
  let last = first;
  for (let i = lines.length - 1; i > first; i--) {
    if (lines[i]!.trim() !== '') { last = i; break; }
  }

  const skipped = renderCopy(lang, 'sendDraft.approval.bodySkipped');
  const room = layout.rowColumns - displayWidth(BODY_ROW_PREFIX);
  /** What stands between the two ends when text is missing between them. */
  const bridge = `${skipped} `;

  /**
   * Both ends of the letter, quoted, on two rows or squeezed onto one.
   *
   * The opening is the first row its line wraps to; the ending is clipped from
   * its LEFT so the row ends where the letter ends. When both come off the
   * SAME line the ending is taken from what the opening did not already show,
   * so the two cannot overlap and print one passage twice with a "text
   * missing" marker between them.
   */
  const endsOn = (oneRow: boolean): string[] => {
    const openingRoom = oneRow ? Math.floor((room - displayWidth(` ${bridge}`)) / 2) : room;
    const opening = wrapAtoms(escapedRows[first]!.atoms, openingRoom)[0]!;
    const rest = first === last ? lines[last]!.slice(opening.length) : lines[last]!;
    const ending = tailAtoms(rest, oneRow
      ? room - displayWidth(` ${bridge}`) - displayWidth(opening)
      : room - displayWidth(bridge));
    // The marker says text is missing, so it goes on only when text IS
    // missing: blank lines outside the two ends, whole lines between them, an
    // opening that is only the start of its line, or the part this clip
    // dropped.
    const omitted = first > 0 || last < lines.length - 1 || last > first + 1
      || opening !== lines[first] || ending !== rest;
    if (ending === '') return [quoted(opening)];
    // Collapsing two ends into one row is only honest with the marker between
    // them; with nothing omitted there is nothing to collapse, so it falls
    // through to two rows and the row ceiling below has the last word.
    if (oneRow && omitted) return [quoted(`${opening} ${bridge}${ending}`)];
    return [quoted(opening), quoted(omitted ? `${bridge}${ending}` : ending)];
  };

  // The legend is judged on the rows actually SHOWN, not on the whole letter:
  // a ZWJ in the middle of a body nobody is reading here would cost a row out
  // of five and say nothing true about what is on screen.
  const escaped = (rows: readonly string[]): boolean =>
    rows.some((row) => row.includes(ESCAPE_INTRODUCER));
  // AND ANY EXTRA ROW HAS TO BE PAID FOR. A rendered character inside either
  // end adds the legend row, which on its own takes this layout to six rows —
  // and this layout refuses itself above five (below), so an emoji would make
  // the letter unsendable. A header that needs two rows for where-and-what
  // does the same through a house slug. So whenever the rows above the ends
  // leave room for only one, the two ends move onto ONE row. Shorter ends,
  // both still shown, both still marked, nothing above them dropped.
  const tooTall = (ends: readonly string[]): boolean =>
    headerRows.length + (escaped(ends) ? 1 : 0) + 1 + ends.length > layout.pointerMaxRows;
  const wide = endsOn(false);
  const ends = tooTall(wide) ? endsOn(true) : wide;
  const above = [...headerRows];
  let pointer = [
    draftId,
    renderCopy(lang, 'sendDraft.approval.bodyLength', { chars }),
    renderCopy(lang, 'sendDraft.approval.bodyInToolOutput'),
  ].join(ROW_PART_SEPARATOR);
  let legendRows: string[] = [];
  if (escaped(ends)) {
    if (!tooTall(ends)) {
      legendRows = [renderCopy(lang, 'sendDraft.approval.escapedInvisible')];
    } else {
      // Even with both ends on one row there is no row left for the legend —
      // To, house, attachment, pointer, ends. So its short form SHARES a row
      // this module wrote: the pointer if it has the width, else one of the
      // where-and-what rows. Never the recipient row, which stays alone. With
      // no row wide enough, the ceiling below refuses by name.
      const short = renderCopy(lang, 'sendDraft.approval.escapedInvisibleShort');
      const withLegend = (row: string): string => `${row}${ROW_PART_SEPARATOR}${short}`;
      const roomy = (row: string): boolean => displayWidth(withLegend(row)) <= layout.rowColumns;
      const host = [...above.keys()].slice(firstFoldable).reverse().find((i) => roomy(above[i]!));
      if (roomy(pointer)) pointer = withLegend(pointer);
      else if (host !== undefined) above[host] = withLegend(above[host]!);
      else legendRows = [renderCopy(lang, 'sendDraft.approval.escapedInvisible')];
    }
  }
  const rows = [...above, ...legendRows, pointer, ...ends];
  // This layout's own ceiling. Everywhere else in this module the row count
  // follows the letter; this layout is fixed-size, so going over five rows is
  // a defect in the layout rather than a property of the letter, and it fails
  // closed.
  if (rows.length > layout.pointerMaxRows) {
    return { kind: 'refuse', reason: REFUSE_PROMPT_TOO_LONG };
  }
  if (!fits(rows, budget, layout) || rows.some(hasInvisible)) return { kind: 'refuse', reason: REFUSE_PROMPT_TOO_LONG };
  // Every decision above was made on the rows as composed; the first-screen
  // spelling only rearranges them. The recipient row is `above[0]` when there
  // is one, and the legend never shares it.
  const firstScreen = presented(title, {
    // A recipient wrapped onto more than one row cannot be a title: no
    // first-screen spelling then.
    who: firstFoldable === 1 ? above[0]! : null,
    lead: firstFoldable === 0 ? lead : null,
    facts: [...above.slice(firstFoldable), ...legendRows],
    letter: [pointer, ...ends],
  }, budget, layout);
  return { kind: 'ask', title, description: rows, ...(firstScreen ? { firstScreen } : {}) };
}

/**
 * The letter's own rows — recipient and facts (wrapped), the escape legend
 * when the body needs one, the draft row and the body rows — from the
 * snapshot, its id, a language and explicit layout: no preview state or live
 * backend state. Shared by `describeRows` and `needsReviewCopy`, so the draft-time
 * and approval-time decisions are made on the same rows by one function.
 */
function letterParts(snapshot: DraftSnapshot, id: string, lang: Lang, layout: ApprovalLayoutMetrics) {
  // Rows are scarce (the pointer layout has five), so facts that answer the
  // same question share a row: where this lands (house, and the reply target when there is
  // one) and what rides with it (the attachments). The recipient keeps a row
  // of its own — it is the fact an owner misreads most expensively.
  const whereParts = [
    // A feedback letter's house is the one whose guide.md DECLARES the
    // contact, which is not necessarily the one that carries the letter: the
    // relay house is a live `inboxStore.houseOf` read inside the send
    // (popclaw-feedback.ts says so, and deliberately). Saying "house: X" would
    // claim a route this subject does not bind; naming what it IS costs one
    // word and stays true.
    snapshot.house
      ? renderCopy(lang, snapshot.kind === 'feedback' ? 'sendDraft.approval.declaringHouse' : 'sendDraft.approval.house',
          { house: snapshot.house })
      : null,
    snapshot.target ? renderCopy(lang, 'sendDraft.approval.target', { target: targetDisplay(snapshot.target) }) : null,
    snapshot.attachments.length > 0
      ? renderCopy(lang, 'sendDraft.approval.attachments', {
          count: String(snapshot.attachments.length),
          // With the size: "photo.png" and "photo.png (2.9 KB)" are different
          // amounts of knowing what is about to leave the machine, and the
          // draft preview has always spelled it out. If a row overflows with
          // it, the refuse-never-truncate rule below applies as it does to
          // every other row.
          names: snapshot.attachments.map((a) => `${a.name} (${kb(a.bytes.length)})`).join(', '),
        })
      : null,
  ].filter((part): part is string => part !== null);
  // Sharing a row is a saving, never a condition. When the shared row is wider
  // than `layout.rowColumns` — measured 2026-09-24 on a real data root, where the
  // house is its origin's slug (`127-0-0-1-8112`) and a 211-byte attachment
  // beside it made 65 columns out of 64 — each fact takes a row of its own,
  // whole. Shortening a house name or a file name to fit would be a clip in
  // exactly the rows the owner reads to know what is leaving; a row too wide
  // even on its own is wrapped below (`wrapHeader`).
  const whereJoined = whereParts.join(ROW_PART_SEPARATOR);
  const whereRows = whereParts.length === 0
    ? []
    : displayWidth(whereJoined) <= layout.rowColumns ? [whereJoined] : whereParts;
  const who = whoLine(snapshot, lang);
  if ([who, ...whereRows].some((row) => row !== null && hasInvisible(row))) {
    return { refuse: REFUSE_NOT_SHOWABLE } as const;
  }
  // A row too wide for its own value is WRAPPED, never refused and never cut
  // (`wrapHeader`). The recipient's rows come first and stay together.
  const whoRows = who === null ? [] : wrapHeader(who, layout);
  const headerRows = [...whoRows, ...whereRows.flatMap(row => wrapHeader(row, layout))];
  const firstFoldable = whoRows.length;
  // A DM's first line is its recipient. When the recipient row can be a
  // title it is the title; when it wraps or is over the title ceiling, a
  // short spelling is (`shortWhoTitle`) and the full rows stay below it.
  const whoTitle = whoRows.length === 1 && titleRefusal(whoRows[0]!, layout) === null
    ? whoRows[0]! : shortWhoTitle(snapshot, lang, layout);
  const whoWhole = whoTitle !== null && whoRows.length === 1 && whoTitle === whoRows[0];

  const chars = String(codePoints(snapshot.body));
  // Row breaks first — a break must never be expressible by body text — then
  // every remaining invisible character is escaped into something visible.
  const escapedRows = splitRows(snapshot.body).map(escapeInvisible);
  // Wrapped to what a row may be once the prefix is on it. A source line that
  // is too wide becomes several rows of ours; it never becomes a row the body
  // authored, and it is never cut short.
  const bodyRows = escapedRows.flatMap((r) => wrapAtoms(r.atoms, layout.rowColumns - displayWidth(BODY_ROW_PREFIX)));
  // What a letter without a recipient opens the dialog with (`presented`).
  const lead = leadRow(bodyRows);
  // One trusted row, from this module's own lexicon, whenever anything was
  // escaped: the owner must know that what they are reading is a rendering.
  const header = escapedRows.some((r) => r.escaped)
    ? [...headerRows, renderCopy(lang, 'sendDraft.approval.escapedInvisible')]
    : headerRows;

  // WHICH DRAFT THIS IS, in every layout. The pointer layout names it inside
  // its own pointer row; every other layout gets this row, so the owner can
  // check the confirmation against the explicit draft number (09-21 ruling)
  // whether or not the letter is short enough to show whole. It is the id of
  // the snapshot being described, the one `canonicalize` binds.
  const draftRow = renderCopy(lang, 'sendDraft.approval.draftId', { id });
  return { who, whoRows, headerRows, firstFoldable, whoTitle, whoWhole, chars, escapedRows, bodyRows, lead, header, draftRow };
}

/**
 * THE ONE PREDICATE: does this draft get a review copy and the compact MCP
 * dialog? True when the letter, laid out whole with the fixed compact policy
 * (header, draft row, label, every body row), does not fit 496 code points and
 * 32 rows. The actual backend profile does not enter this decision. Evaluated once at mint
 * (`draft-review.ts`, which records it with the language it used) and again,
 * with the same inputs, at approval; the two must agree or the approval is
 * refused (`REVIEW_DECISION_MISMATCH`). A draft with no text never needs one.
 */
export function needsReviewCopy(snapshot: DraftSnapshot, id: string, lang: Lang): boolean {
  if (snapshot.body.trim().length === 0) return false;
  const { budget, layout } = COMPACT_DRAFT_REVIEW_POLICY;
  const parts = letterParts(snapshot, id, lang, layout);
  if ('refuse' in parts) return false;
  const rows = [...parts.header, parts.draftRow,
    renderCopy(lang, 'sendDraft.approval.bodyWhole', { chars: parts.chars }), ...parts.bodyRows.map(quoted)];
  return !fits(rows, budget, layout);
}

/**
 * What the owner reads, as rows, or a named refusal.
 *
 * Row discipline, because the body is text somebody else wrote:
 *
 *  - the HEADER rows come first and are built only from this module's own
 *    lexicon frames. Their content and their order do not depend on the body
 *    in any way, so a body cannot change what the header says;
 *  - the body follows, split on every row-breaking character there is and
 *    emitted one row at a time, each one carrying `BODY_ROW_PREFIX`. A body
 *    line reading `To: someone-else` therefore arrives as `> To: someone-else`
 *    and cannot be read as the header row it imitates;
 *  - a HEADER row carrying a character of the seam's invisible class is a
 *    named refusal: those rows say where the letter goes and what rides with
 *    it, and there is no honest way to render a lie about that;
 *  - a BODY row's invisible characters are ESCAPED into visible tokens, and
 *    one trusted header row says so. Refusing there would cost an ordinary
 *    emoji sequence the ability to be approved and buy nothing: the excerpt
 *    is supplementary, the real bytes are bound by `canonicalize`, and an
 *    escaped bidi control is more visible than a refused one.
 *
 * Side-effect free in the sense the seam needs: it reads the draft table and
 * the owner's language and timezone, and the only thing it can change is that
 * `peekDraftSnapshot` collects entries the TTL has already killed. It delivers
 * nothing, sends nothing, consumes nothing and touches no live draft. It runs
 * BEFORE the owner has decided, so anything more than that would also have
 * happened on a deny.
 */
function describeRows(params: unknown, seen: Seen, profile: ApprovalDialogProfile): ApprovalSubjectResult {
  const { budget, layout } = profile;
  const wholeOrBoundReview = profile.draftPresentation === 'whole-or-bound-review';
  const id = draftIdOf(params);
  const snapshot = id === null ? null : peekDraftSnapshot(id);
  if (!snapshot) return { kind: 'refuse', reason: REFUSE_UNKNOWN_DRAFT };
  const lang = ownerLang();
  seen.kind = snapshot.kind;
  seen.hasOutput = snapshot.output !== null;

  const kindName = renderCopy(lang, kindKey[snapshot.kind]);
  const title = renderCopy(lang, 'sendDraft.approval.title', { kind: kindName });
  const titleBad = titleRefusal(title, layout);
  if (titleBad !== null) return { kind: 'refuse', reason: titleBad };

  // `unknown` is the only preview status under which anything plausibly
  // reached the owner. `failed` may have followed a partial delivery and
  // `unavailable` means nothing was attempted — neither is something to claim.
  const previewed = snapshot.preview?.status === 'unknown';
  const parts = letterParts(snapshot, id!, lang, layout);
  if ('refuse' in parts) return { kind: 'refuse', reason: parts.refuse ?? REFUSE_NOT_SHOWABLE };
  const { who, headerRows, firstFoldable, whoTitle, whoWhole, chars, escapedRows, bodyRows, lead, header } = parts;

  // The preview statement and the body's length answer one question — "what am
  // I approving, and where have I already seen it?" — so they share the label
  // row that introduces the text.
  const previewNote = previewed
    ? renderCopy(lang, 'sendDraft.approval.previewedAt', { when: when(snapshot.preview!.at) })
    : renderCopy(lang, 'sendDraft.approval.notPreviewed');

  /**
   * THE SAME LETTER, SPELLED SHORTER, AS `folded`. NOTHING SHOWS IT TODAY.
   *
   * When a layout is taller than five rows and the draft tool's own output
   * exists, the pointer layout is attached as the optional `folded` spelling.
   * It was shown by the MCP backend to a host that folds the dialog; since
   * every MCP host now gets the primary rows as the message, no backend reads
   * it. The seam still screens it. Kept only because the seam's contract
   * still carries the field; removing both together is a named follow-up.
   */
  const alsoFolded = (result: ApprovalSubjectResult): ApprovalSubjectResult => {
    if (result.kind !== 'ask') return result;
    if (result.description.length <= layout.pointerMaxRows) return result;
    if (snapshot.output === null) return result;
    const pointer = inTranscript({ draftId: id!, kindName, chars, escapedRows, headerRows, firstFoldable, lead, lang, budget, layout });
    if (pointer.kind !== 'ask') return result;
    return { ...result, folded: { title: pointer.title, description: pointer.description } };
  };

  const draftRow = parts.draftRow;

  /** The rows as composed — every decision below is made on these — shown
   *  through `presented`. `letterFrom` is where the letter's own rows start;
   *  before it are the recipient row (if any) and the facts. */
  const ask = (rows: string[], letterFrom: number, fold: boolean): ApprovalSubjectResult => {
    const composed = { kind: 'ask' as const, title, description: rows };
    const firstScreen = presented(title, {
      who: whoTitle,
      lead: who === null ? lead : null,
      // A short title leaves the full recipient rows in the facts below it.
      facts: rows.slice(whoWhole ? firstFoldable : 0, letterFrom),
      letter: rows.slice(letterFrom),
    }, budget, layout);
    // A whole-text backend is never handed a shorter spelling, not even as an
    // unused alternative.
    const kept = fold && !wholeOrBoundReview ? alsoFolded(composed) : composed;
    return kept.kind === 'ask' && firstScreen ? { ...kept, firstScreen } : kept;
  };

  // A whole-text backend's rows carry no preview note: an MCP root never
  // pushes a preview, and with the whole letter in front of the owner a
  // "not sent to your preview" reads as if something were missing.
  const noted = (label: string): string => (wholeOrBoundReview ? label : `${label}${ROW_PART_SEPARATOR}${previewNote}`);

  /*
   * THE COMPACT DIALOG, for a draft whose full text is in a review copy.
   *
   * Only under whole-or-bound-review and only for a draft whose decision
   * was recorded at mint. The decision is re-made here by the same predicate
   * on the same inputs; a disagreement means "a file but no compact dialog"
   * or the reverse, and is refused by name rather than guessed at.
   *
   * The rows name the recipient, the facts, the review copy (its digest, its
   * file name and its full path, wrapped) and the draft, then the text's
   * opening row — never the full text and never an instruction to scroll.
   *
   * KNOWN LIMITATION: the path is a fallback for an agent that did not relay
   * the link, and a path wider than a row is wrapped onto `↪` rows, so it
   * cannot be copied in one piece from the dialog. The link line is the entry.
   *
   * The file itself is re-hashed right before the owner is asked
   * (`beforeAsk` below) and again before the send; this composition only
   * reads the snapshot.
   */
  const review = snapshot.review;
  if (wholeOrBoundReview && review) {
    // A defensive consistency check. With the language recorded at mint the
    // two evaluations are the same computation, so it does not fire today; it
    // is here so a future change to either side cannot split them silently.
    if (needsReviewCopy(snapshot, id!, review.lang) !== review.needed) {
      return { kind: 'refuse', reason: REFUSE_REVIEW_DECISION_MISMATCH };
    }
    if (review.needed) {
      if (!review.file) {
        return { kind: 'refuse', reason: REFUSE_REVIEW_NOT_WRITTEN };
      }
      const digest8 = draftDigest(snapshot.body).slice(0, 8);
      const reviewRows = [
        renderCopy(lang, 'sendDraft.approval.reviewDigest', { digest: digest8, name: review.file.name }),
        renderCopy(lang, 'sendDraft.approval.reviewPath', { path: review.file.path }),
      ];
      if (reviewRows.some(hasInvisible)) return { kind: 'refuse', reason: REFUSE_REVIEW_PATH };
      const opening = bodyRows.find((row) => row.trim() !== '') ?? '';
      const rows = [
        ...headerRows,
        // The legend only when the one body row shown carries an escape.
        ...(opening.includes(ESCAPE_INTRODUCER) ? [renderCopy(lang, 'sendDraft.approval.escapedInvisible')] : []),
        ...reviewRows.flatMap(row => wrapHeader(row, layout)),
        draftRow,
        renderCopy(lang, 'sendDraft.approval.bodyOpening', { chars }),
        quoted(opening),
      ];
      const why = whyNotFits(rows, budget, layout);
      if (why !== null) return { kind: 'refuse', reason: why };
      seen.review = { digest8 };
      return ask(rows, rows.length - 2, false);
    }
  }

  if (snapshot.body.trim().length === 0) {
    const rows = [...headerRows, draftRow, noted(renderCopy(lang, 'sendDraft.approval.noBody'))];
    const why = whyNotFits(rows, budget, layout);
    if (why !== null) return { kind: 'refuse', reason: wholeOrBoundReview ? why : REFUSE_PROMPT_TOO_LONG };
    seen.wholeShown = true;
    return ask(rows, rows.length - 1, false);
  }

  // The complete text always wins when it fits, previewed or not.
  const whole = [...header, draftRow, noted(renderCopy(lang, 'sendDraft.approval.bodyWhole', { chars })), ...bodyRows.map(quoted)];
  const wholeRefusal = whyNotFits(whole, budget, layout);
  if (wholeRefusal === null) {
    seen.wholeShown = true;
    const result = ask(whole, header.length + 1, true);
    // The whole letter is one row and it IS the first line, and nothing else
    // it depends on is below the fold: no reply or quote target, and no
    // escape token whose legend row would be out of sight.
    seen.bodyOnFirstLine = result.kind === 'ask' && who === null && bodyRows.length === 1
      && !snapshot.target && !escapedRows.some((r) => r.escaped)
      && result.firstScreen?.title === quoted(bodyRows[0]!);
    return result;
  }
  // Without a bound review, this policy requires a whole letter and gets none
  // of the preview/transcript layouts below. Refused by the name of the ceiling
  // it actually broke.
  if (wholeOrBoundReview) return { kind: 'refuse', reason: wholeRefusal };
  // It does not fit, so the complete text has to be somewhere else the owner
  // can actually reach. There are two such places and they are not the same
  // place, so they get two different prompts:
  //
  //   the PREVIEW the host pushed into the owner's own chat at draft time.
  //     It licenses the excerpt below, which is what this lane has always
  //     done, and it is the only one either MCP root ever has: those resolve
  //     a tool factory with `{}`, so no push is attempted there at all.
  //   the draft tool's own OUTPUT, which the host renders in its transcript
  //     to whoever is sitting at it. Without it a thousand-character reply
  //     was unapprovable from Claude Code while the same letter went out fine
  //     from OpenClaw — the dialog budget had become a letter-length limit.
  //
  // Neither is a receipt and neither prompt claims one.
  if (!previewed) {
    if (snapshot.output === null) return { kind: 'refuse', reason: REFUSE_NOT_SHOWN_TOO_LONG };
    return inTranscript({ draftId: id!, kindName, chars, escapedRows, headerRows, firstFoldable, lead, lang, budget, layout });
  }

  const opening = `${renderCopy(lang, 'sendDraft.approval.bodyOpening', { chars })}${ROW_PART_SEPARATOR}${previewNote}`;
  const more = quoted(renderCopy(lang, 'sendDraft.approval.bodyMore'));
  const base = [...header, draftRow, opening, more];
  if (!fits(base, budget, layout)) return { kind: 'refuse', reason: REFUSE_PROMPT_TOO_LONG };

  // Fill the room the frame leaves, row by row, clipping only the last one and
  // only by code point so an astral character is never split in half.
  // Native only (a whole-text backend returned above), so code points.
  let room = budget.descriptionMax - cost(base, budget);
  const excerpt: string[] = [];
  for (const row of bodyRows) {
    if (base.length + excerpt.length >= budget.maxLines) break;
    const candidate = quoted(row);
    const need = codePoints(candidate) + 1;
    if (need <= room) {
      excerpt.push(candidate);
      room -= need;
      continue;
    }
    // Atom-wise, exactly like `wrapAtoms`: clipping by code point here could
    // cut an escape token in half, and half of `\u2039U+200D\u203a` is both
    // unreadable and decodable as something it is not.
    const keep = room - codePoints(BODY_ROW_PREFIX) - 1;
    if (keep > 0) {
      let clip = '';
      for (const atom of [...row.matchAll(ESCAPE_TOKEN_OR_CHARACTER)].map((m) => m[0])) {
        if (codePoints(clip) + codePoints(atom) > keep) break;
        clip += atom;
      }
      if (clip !== '') excerpt.push(quoted(clip));
    }
    break;
  }
  const rows = [...header, draftRow, opening, ...excerpt, more];
  if (!fits(rows, budget, layout) || rows.some(hasInvisible)) return { kind: 'refuse', reason: REFUSE_PROMPT_TOO_LONG };
  return ask(rows, header.length + 1, true);
}

/** Exported for the tests that pin the row discipline; production reads it
 *  through the descriptor below, with the seam-resolved backend profile. */
export const describeSendDraft = (params: unknown,
  profile: ApprovalDialogProfile = NATIVE_APPROVAL_PROFILE): ApprovalSubjectResult => {
  const seen: Seen = { bodyOnFirstLine: false, wholeShown: false, hasOutput: false, kind: null };
  const result = describeRows(params, seen, profile);
  return labelled(result, draftIdOf(params), seen, profile.layout);
};

/** Every prompt this registrant asks carries its own confirmation label, so
 *  the MCP dialog's one input says what ticking it means (willing to publish
 *  this post, or send this DM — by kind, because on line 1 a quoted one-line
 *  post and a DM differ only by `> `) and what Accept does (submits that
 *  choice), instead of the seam's generic "Approve this action". Display
 *  only; binds nothing, and consent is still `accept` with `confirm === true`.
 *
 *  AND THE ONE LINE UNDER IT. Besides the message's first line, it is all a
 *  folding host (Claude Code 2.1.283, probes v3–v3.2) shows without a
 *  keystroke, and it is cut past about 80 display columns, so every candidate
 *  is a whole sentence within `layout.confirmDescriptionColumns` and the first one
 *  that fits is used — never a clipped one. Two things compete for it:
 *
 *   WHERE THE FULL TEXT IS. When the prompt carries the whole letter — every
 *     MCP dialog, and any native one short enough — the line says so, then
 *     gives Claude Code's keys in a clause labelled as Claude Code's, since
 *     that host shows only the message's start (`wholeHere`). An abbreviated
 *     native layout points at the draft tool's own output (`fullTextHint`).
 *     Either way it names the draft by the SAME id the approval is bound to.
 *   WHAT DECLINE DOES. Nothing is sent and the draft is kept; the agent is
 *     told to ask what to change and offer a new draft, which is shown and
 *     asked about afresh (write-tools.ts returns before `takeDraft`;
 *     `sendDraft.refused.denied`).
 *
 *  PRIORITY. When the whole letter is already the dialog's first line there
 *  is nothing to go and find, so the line is the change path alone. Otherwise
 *  reading comes first: Decline's meaning and the pointer in one line when
 *  the id leaves room, else the pointer alone. Both pointer spellings keep
 *  all three probe-verified keys, `ctrl+o back` included: it is the only
 *  instruction for returning to the form. The change path is dropped whole
 *  before the pointer is. (tests/unit/tools/send-draft-owner-gate.test.ts pins all of it.) */
function labelled(result: ApprovalSubjectResult, id: string | null, seen: Seen, layout: ApprovalLayoutMetrics): ApprovalSubjectResult {
  if (result.kind !== 'ask' || seen.kind === null) return result;
  const lang = ownerLang();
  const change = renderCopy(lang, 'sendDraft.approval.changeHint');
  // Where the full text is, said truthfully for the layout actually shown:
  // with the whole letter in this prompt, the line says so first. Then, only
  // when the draft tool's full output is in the transcript, Claude Code's own
  // way to read it (its dialog shows only the message's start; ctrl+o opens
  // the transcript, which holds that output). Decline's meaning follows when
  // the line still fits 80 columns, else it is dropped whole — and beside
  // Claude Code's clause it never fits (85+ columns), so that pair has no
  // combined spelling. Only an abbreviated layout — the native budget's —
  // points at the output instead.
  const candidates = seen.bodyOnFirstLine || id === null
    ? [change]
    // The full text is in the review copy the owner was given a link to:
    // host-neutral, and no host's keys (ctrl+o opened the transcript, which
    // misled on Codex).
    : seen.review
      ? [renderCopy(lang, 'sendDraft.approval.reviewHint', { id, digest: seen.review.digest8 })]
    : seen.wholeShown
      ? seen.hasOutput
        ? [renderCopy(lang, 'sendDraft.approval.wholeHere', { id })]
        : [
            renderCopy(lang, 'sendDraft.approval.wholeHereOnlyAndDecline', { id }),
            renderCopy(lang, 'sendDraft.approval.wholeHereOnly', { id }),
          ]
      : [
          renderCopy(lang, 'sendDraft.approval.declineAndFullText', { id }),
          renderCopy(lang, 'sendDraft.approval.fullTextHint', { id }),
        ];
  const line = candidates.find((c) => displayWidth(c) <= layout.confirmDescriptionColumns);
  return {
    ...result,
    // By kind: a quoted one-line post and a DM differ on line 1 only by the
    // `> ` prefix, so the box itself says publish-a-post or send-a-DM.
    confirmLabel: renderCopy(lang, confirmKey[seen.kind]),
    ...(line !== undefined ? { confirmDescription: line } : {}),
  };
}

/**
 * Registered next to `popclaw_send_draft` itself (write-tools.ts). Pure
 * declaration — it acquires nothing (ADR-0035).
 *
 * Rows go straight to the seam, which owns the join. This module never
 * produces the separator, which is the structural reason body text cannot
 * produce a row.
 */
export const sendDraftApprovalSubject: OwnerApprovalSubjectDescriptor = {
  canonicalize,
  describe: describeSendDraft,
  /**
   * RIGHT BEFORE THE OWNER IS ASKED: the review copy they were pointed at must
   * still be the bytes that were written. Otherwise the owner would see the
   * compact dialog, approve, and only then be refused — an approval spent on
   * a draft that could not be sent. A hash read, never a content read; the
   * send body checks again after approval. `none` (no copy) and `ok` pass;
   * a needed copy with no file is already refused by `describe` by its own
   * name.
   */
  beforeAsk: (params) => {
    const id = draftIdOf(params);
    if (id === null) return null;
    const review = peekDraftSnapshot(id)?.review;
    if (!review?.needed || !review.file) return null;
    return verifyDraftReview(id) === 'changed' ? REFUSE_REVIEW_COPY : null;
  },
};

/**
 * What the agent is told when the owner did not, or could not, approve.
 *
 * One sentence per reason family, from the lexicon in every locale: no
 * exception text, no class names, no stack positions. The agent's next move
 * differs per family — arrange an approval surface, get the owner to ask in
 * their own session, draft again — so a single shared "refused" would be the
 * very defect this lane spent a day removing one layer down.
 *
 * AND THE MACHINE REASON RIDES WITH IT, VERBATIM. On Ken, 2026-09-23 — a
 * WhatsApp self-chat with a pinned approval target configured — the owner read
 * "the draft could not be shown to the owner" and nobody could say which
 * refusal had fired: the sentence below was the same for a mis-addressed
 * approval target, a disabled forwarder and an unreadable filter. The seam had
 * already done its part (`consumeOwnerApproval` hands over the named reason the
 * origin guard left); this function was where the name was thrown away. So
 * every refusal now ends in the reason code it was given, unchanged, in one
 * machine-readable frame. The sentence is still what a person reads; the code
 * is what makes two identical-looking failures tellable apart.
 *
 * An owner's own `denied` or `timeout` carries no code, because there is no
 * machine reason for "they said no".
 */
export function sendDraftRefusalText(
  outcome: Exclude<OwnerApprovalOutcome, { decision: 'approved' }>,
  draftId: string,
  lang: Lang = ownerLang(),
): string {
  if (outcome.decision === 'denied') return renderCopy(lang, 'sendDraft.refused.denied');
  if (outcome.decision === 'timeout') return renderCopy(lang, 'sendDraft.refused.timeout');
  // The seam's reason, and the descriptor's own detail when there is one:
  // `SUBJECT_REFUSED` alone says which layer refused but not what it refused.
  const code = outcome.detail ? `${outcome.reason}/${outcome.detail}` : outcome.reason;
  return `${unavailableText(outcome, draftId, lang)} ${renderCopy(lang, 'sendDraft.refused.reasonCode', { reason: code })}`;
}

/** The sentence a person reads, for one `unavailable` outcome. */
function unavailableText(
  outcome: Extract<OwnerApprovalOutcome, { decision: 'unavailable' }>,
  draftId: string,
  lang: Lang,
): string {
  // Disabled forwarding says nothing about which chat a target would name.
  if (outcome.reason === 'OWNER_ROUTE_FORWARDING_DISABLED') {
    return renderCopy(lang, 'sendDraft.refused.forwardingDisabled');
  }
  // The remaining route refusals retain their existing presentation.
  // THE ROUTE FAMILY, ANSWERED AS A FAMILY. Every one of these means the same
  // thing to whoever has to act on it — the host would not have delivered this
  // approval to the chat the call came from — and they differ only in WHICH
  // part of the routing said so, which is what the reason code carries. Read
  // off the seam's own array rather than matched on a name prefix, so a refusal
  // added there cannot quietly fall back into the shared sentence again.
  if ((OWNER_APPROVAL_ROUTE_REFUSALS as readonly string[]).includes(outcome.reason)) {
    return renderCopy(lang, 'sendDraft.refused.notTheApprovalChat');
  }
  switch (outcome.reason) {
    case 'APPROVAL_SURFACE_ABSENT':
      return renderCopy(lang, 'sendDraft.refused.noApprovalSurface');
    case 'ORIGIN_NOT_OWNER_DIRECT':
      return renderCopy(lang, 'sendDraft.refused.notOwnerTurn');
    // Not "you are not the owner": nobody can be, on this channel, until a
    // list exists. A setup mistake, and it says so.
    case 'OWNER_ALLOWLIST_UNCONFIGURED':
      return renderCopy(lang, 'sendDraft.refused.noOwnerConfigured');
    case 'SUBJECT_NOT_REGISTERED':
      return renderCopy(lang, 'sendDraft.refused.notWired');
    case 'SUBJECT_CHANGED':
      // Two different things arrive here. If the draft is simply GONE — its
      // TTL ran out after the owner answered, or newer drafts evicted it —
      // then the subject moved to the unknown-draft sentinel and telling the
      // agent "its recipient or its text changed" names a cause that is not
      // the one. Only a draft still in the table changed its content.
      return peekDraftSnapshot(draftId) === null
        ? renderCopy(lang, 'sendDraft.refused.noLongerThere')
        : renderCopy(lang, 'sendDraft.refused.changed');
    case 'ALREADY_CONSUMED':
      return renderCopy(lang, 'sendDraft.refused.alreadyUsed');
    case 'CALL_IDENTITY_ABSENT':
      return renderCopy(lang, 'sendDraft.refused.noCallIdentity');
    case 'CALL_MISMATCH':
      return renderCopy(lang, 'sendDraft.refused.otherCall');
    // How an MCP dialog ended when OUR window did not close. Each gets its own
    // sentence: "the window closed" is true only of a timeout, and telling the
    // owner that about a cancel or a crash is the flattening this lane removes.
    case 'OWNER_CONFIRMATION_CANCELLED':
      return renderCopy(lang, 'sendDraft.refused.dialogCancelled');
    case 'OWNER_CONFIRMATION_ANSWER_INVALID':
      return renderCopy(lang, 'sendDraft.refused.answerUnreadable');
    case 'OWNER_CONFIRMATION_FAILED':
      return renderCopy(lang, 'sendDraft.refused.dialogFailed');
    case 'OWNER_CONFIRMATION_INACTIVE':
      return renderCopy(lang, 'sendDraft.refused.callEnded');
    default:
      // The descriptor refused, and it named itself. An unknown draft is the
      // ordinary "make a new one" answer it always was.
      if (outcome.detail === REFUSE_UNKNOWN_DRAFT) return expiredDraftText(draftId);
      if (outcome.detail === REFUSE_NOT_SHOWN_TOO_LONG) return renderCopy(lang, 'sendDraft.refused.tooLongUnseen');
      if (outcome.detail === REFUSE_NOT_SHOWABLE) return renderCopy(lang, 'sendDraft.refused.notShowable');
      if (outcome.detail === REFUSE_REVIEW_COPY || outcome.detail === REFUSE_REVIEW_DECISION_MISMATCH) {
        return renderCopy(lang, 'sendDraft.refused.reviewCopyChanged');
      }
      if (outcome.detail === REFUSE_REVIEW_NOT_WRITTEN) return renderCopy(lang, 'sendDraft.refused.reviewNotWritten');
      // The seam screens the rows again after this module does, and names its
      // own refusals. They mean the same things to the owner, so they map onto
      // the same two sentences rather than inventing a second vocabulary.
      // The shorter rendering this module offered was itself unshowable, so
      // there was nothing to fall back to. To the owner that is the same fact
      // as any other "it does not fit this dialog"; what differs is the reason
      // code the frame carries, which is the whole point of naming it.
      // The preview, not the letter: never worded as an invalid or oversized
      // message, and never a request to shorten it on that ground.
      if (outcome.detail === REFUSE_PREVIEW_OVER_BUDGET) return renderCopy(lang, 'sendDraft.refused.previewOverBudget');
      // A layout defect, not a length: the owner is not told to shorten it.
      if (outcome.detail === REFUSE_ROW_TOO_WIDE) return renderCopy(lang, 'sendDraft.refused.cannotShow');
      if (outcome.detail === REFUSE_PROMPT_TOO_LONG
        || outcome.detail === REFUSE_TOO_MANY_ROWS
        || outcome.detail === FOLDED_ALTERNATIVE_UNPRESENTABLE
        || outcome.detail === 'APPROVAL_PROMPT_TOO_LONG'
        || outcome.detail === 'APPROVAL_PROMPT_TOO_MANY_LINES'
        || outcome.detail === 'APPROVAL_PROMPT_EMPTY'
        || outcome.detail === 'APPROVAL_PROMPT_UNREADABLE_ON_HOST') {
        return renderCopy(lang, 'sendDraft.refused.tooLongToShow');
      }
      if (outcome.detail === 'APPROVAL_PROMPT_UNPRINTABLE') return renderCopy(lang, 'sendDraft.refused.notShowable');
      return renderCopy(lang, 'sendDraft.refused.cannotShow');
  }
}
