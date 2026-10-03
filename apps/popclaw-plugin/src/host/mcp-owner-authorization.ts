/**
 * Owner confirmation for MCP hosts: the one place a world action asks the human
 * directly, through the `elicitation/create` form the HOST renders itself.
 *
 * Peer of `openclaw-world-execution.ts` — both are host adapters that turn one
 * out-of-band decision (there a config policy, here a human answer) into a
 * short-lived grant the shared WorldRuntime can reserve against. The model
 * never sees or answers this form: it is a server→client request, and only
 * `action:'accept'` with `confirm === true` is consent (work order §3.6).
 *
 * This is HOST-ATTESTED consent, not a cryptographic proof: a host configured
 * to auto-answer elicitations has removed the boundary itself. Nothing here can
 * detect that, which is why `docs/known-limitations.md` says so out loud.
 *
 * What the owner cannot read, the owner cannot approve. The dialog is ONE
 * message carrying every fact whole — house, identity, action kind, capability
 * revision, every parameter verbatim, the duplicate state, the reference and
 * the deadline — and ONE real input, the confirmation. (It used to lay the
 * parameters out as text fields; those were real inputs the owner could type
 * into and nothing read, so they are gone.) A host may fold the message behind
 * an expand key; that is acceptable, a fake input is not. What cannot be shown
 * honestly as one line is refused as OWNER_CONFIRMATION_UNREADABLE, never
 * truncated, so the agent can fix the value and ask again and the bytes that
 * get signed are exactly the ones the human read.
 */
import { displayWidth, isZeroWidthCodePoint } from './approval-presentation.js';
export { displayWidth } from './approval-presentation.js';

import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ErrorCode, type ElicitRequestFormParams } from '@modelcontextprotocol/sdk/types.js';
import { captureWorldCommandInput } from '../commands/popclaw-world.js';
import type { WorldInvokeInput } from '../world/action-client.js';
import { canonicalActionJson } from '../world/action-receipt-journal.js';
import { worldPublicKey } from '../world/action-wire.js';
import { renderCopy } from '../lexicon/index.js';
import {
  OWNER_APPROVAL_WINDOW_MS, OWNER_CONFIRMATION_ANSWER_INVALID, OWNER_CONFIRMATION_CANCELLED,
  OWNER_CONFIRMATION_FAILED, OWNER_CONFIRMATION_INACTIVE,
} from './owner-approval.js';
import { ownerLang } from '../lexicon/owner-language.js';

/** One accepted confirmation: one job, therefore exactly one request slot. */
export interface OwnerGrant {
  readonly jobId: string;
  readonly expiresAt: number;
  assertCurrent(): void;
}
/** What the runtime's per-call command context asks. Structurally identical to
 *  `fixtureOwnerAuthorization`, so both lanes share one reservation sequence. */
export interface OwnerConfirmation {
  authorize(input: Readonly<WorldInvokeInput>): Promise<OwnerGrant>;
}
/** One tool call's ask, plus the reference the owner reads in the dialog. The
 *  caller puts the same reference in what the tool returns: it is the only way
 *  a person can tie the dialog they approved to the receipt they read
 *  afterwards, because no request id exists yet when the dialog is shown. */
export interface OwnerInvocation extends OwnerConfirmation {
  readonly reference: string;
}
/** What the duplicate check is asked, and nothing else. `input` is the CAPTURED
 *  invoke input — schema-validated, deep-frozen, exactly the four canonical
 *  keys — and `actorId` is the adapter's own rather than anything the call
 *  carried, so the model has no field with which to steer or skip the answer. */
export interface DuplicateActionQuery {
  readonly actorId: string;
  readonly input: Readonly<WorldInvokeInput>;
}
/** Injected at the wiring seam exactly like the `Server` box: this module owns
 *  no storage and must not learn any. Throwing is a permitted answer, reported
 *  to the owner as "could not check" rather than swallowed. */
export interface DuplicateActionLookup {
  /** Request ids of earlier requests with this exact canonical input, for this
   *  house and this actor, that have not reached a terminal result. */
  unresolved(query: DuplicateActionQuery): readonly string[] | Promise<readonly string[]>;
}
export interface McpOwnerAuthorization {
  /** Adapter-level presence only. A stopped adapter, or a client that cannot
   *  render a form, is not a lane — this is what the runtime's capability
   *  projection reads, and it grants nothing by itself. */
  assertActive(): void;
  stop(): void;
  withInvocation<T>(callId: string, input: Readonly<WorldInvokeInput>, signal: AbortSignal | undefined,
    callback: (ask: OwnerInvocation) => Promise<T>): Promise<T>;
}
/** Late-bound on purpose: the MCP `Server` is constructed AFTER the tool
 *  surface is registered, so the adapter can only hold a box. */
export interface McpServerBox {
  current?: Pick<Server, 'elicitInput' | 'getClientCapabilities' | 'getClientVersion'>;
}
export interface McpOwnerAuthorizationOptions {
  actorId: string;
  server: McpServerBox;
  /** Required, not optional: an unwired duplicate check would drop the warning
   *  silently, which is the one outcome this fact exists to prevent. */
  duplicates: DuplicateActionLookup;
  now?(): number;
  elicitTimeoutMs?: number;
  /** How long the duplicate lookup may take before the dialog goes up without
   *  it. `elicitTimeoutMs` covers only the dialog itself. */
  duplicateTimeoutMs?: number;
}

export const OWNER_CONFIRMATION_UNAVAILABLE = 'OWNER_CONFIRMATION_UNAVAILABLE';
export const OWNER_CONFIRMATION_DECLINED = 'OWNER_CONFIRMATION_DECLINED';
export const OWNER_CONFIRMATION_TIMEOUT = 'OWNER_CONFIRMATION_TIMEOUT';
export const OWNER_CONFIRMATION_BUSY = 'OWNER_CONFIRMATION_BUSY';
export const OWNER_CONFIRMATION_EXPIRED = 'OWNER_CONFIRMATION_EXPIRED';
export const OWNER_CONFIRMATION_INPUT_MISMATCH = 'OWNER_CONFIRMATION_INPUT_MISMATCH';
export const OWNER_CONFIRMATION_INVOCATION_INVALID = 'OWNER_CONFIRMATION_INVOCATION_INVALID';
export const OWNER_CONFIRMATION_ACTOR_INVALID = 'OWNER_CONFIRMATION_ACTOR_INVALID';
export const OWNER_CONFIRMATION_CLOCK_ROLLBACK = 'OWNER_CONFIRMATION_CLOCK_ROLLBACK';
/** The dialog would not have rendered whole, so it was never sent. */
export const OWNER_CONFIRMATION_UNREADABLE = 'OWNER_CONFIRMATION_UNREADABLE';
/* `OWNER_CONFIRMATION_CANCELLED`, `_FAILED`, `_ANSWER_INVALID` and `_INACTIVE` are defined
 * once in `owner-approval.ts` and re-exported here, so the send-approval seam
 * and this world dialog mean one thing by each name. */
export {
  OWNER_CONFIRMATION_ANSWER_INVALID, OWNER_CONFIRMATION_CANCELLED, OWNER_CONFIRMATION_FAILED,
  OWNER_CONFIRMATION_INACTIVE,
} from './owner-approval.js';
export const OWNER_CONFIRMATION_ANSWER_INVALID_HINT =
  'this host returned a form answer PopClaw could not read (an untouched optional field answered as null rather than omitted); the action was not taken — ask again, and report the host if it repeats';

/** The one actionable line the model may relay when the host cannot ask at all. */
export const OWNER_CONFIRMATION_UNAVAILABLE_HINT =
  'this host does not offer an owner confirmation dialog; world actions need Claude Code 2.1+ or Codex 0.155+ with MCP elicitation';

/** The one box the owner must answer. Its `true` is the only consent there is.
 *  Labelled through the lexicon in the owner's language, naming what it does —
 *  run this world action — and carrying the reference again beside the box.
 *  `default: false`, never `true`: the server never pre-ticks it, and an
 *  untouched box is a refusal. Without a default, Claude Code 2.1.283 blocked
 *  an untouched Accept and codex-cli 0.157.1 answered an untouched Enter with
 *  `confirm: true`; with `default: false` both render it unticked and an
 *  untouched submit comes back `confirm: false` (Claude Code 2.1.283 /
 *  codex-cli 0.157.1, 2026-09-27), which is OWNER_CONFIRMATION_DECLINED below.
 *  No second confirmation is added. */
function confirmField(reference: string): { type: 'boolean'; default: false; title: string; description: string } {
  const lang = ownerLang();
  return { type: 'boolean', default: false, title: renderCopy(lang, 'world.action.approval.confirm'),
    description: renderCopy(lang, 'world.action.approval.confirmDescription', { ref: reference }) };
}
/** The form, on every host: exactly one required boolean and nothing else —
 *  no text field an owner could type into and have ignored. */
export function ownerConfirmationSchema(reference: string): FormSchema {
  // Frozen, as W1's constant was: the form the owner is shown must not be
  // reachable for edit by anything downstream of the decision to show it.
  return freeze({ type: 'object', properties: { confirm: confirmField(reference) }, required: ['confirm'] }) as FormSchema;
}

/** The human answer is excluded from execution validity: the clock starts when
 *  the answer arrives, and 240 < the store's 300 s reservation cap. */
const GRANT_SECONDS = 240;
const CALL_ID = /^[A-Za-z0-9_.:-]{1,128}$/;

/* --------------------------------------------------------------------------
 * The measurement the old field layout was built on.
 *
 * NO LONGER A LAYOUT RULE FOR THIS DIALOG. The parameters used to ride one
 * text field each, sized to these numbers; they now ride the message, and
 * nothing here lays out or refuses by them. Kept and exported only because
 * the draft seam's restated copy (`MCP_APPROVAL_DIALOG_BUDGET` in
 * `mcp-owner-approval.ts`), which its registrant still composes rows to, is
 * pinned equal to this measured original so the two cannot drift by accident.
 * Measured on Claude Code 2.1.278 in an 80×24 terminal: a field description
 * rendered 64 columns whole (80 − 8 indent − 1 cut mark − 7 margin), a folded
 * message's first line 72 (80 − 4 − 1 − 3), and (24 − 7 chrome) / 3 = 5
 * fields fit one screen without scrolling.
 * ----------------------------------------------------------------------- */
export const MCP_DIALOG_BUDGET = Object.freeze({
  fieldDescriptionColumns: 64,
  summaryLineColumns: 72,
  maxFields: 5,
});
/** Enough of a 43-character account id or a 64-hex revision to recognise it
 *  on the first line; the trailing ellipsis is what tells the owner it is a
 *  prefix. Both appear in full further down the message. */
const SUMMARY_PREFIX_CHARS = 6;
/** The correlation reference: the first six hex characters of the very nonce
 *  that becomes this job's id, so the dialog and the receipt carry the same
 *  string and a person can match them by eye. Long enough that two dialogs in
 *  one session do not collide in practice. Publishing a prefix costs nothing:
 *  the job id never leaves this machine, and the grant is an in-process
 *  object, not a bearer token someone could guess their way to. */
const REFERENCE_CHARS = 6;
const REQUEST_ID = /^[0-9a-f]{64}$/;
/** The lookup reads one local ledger, so a second is already generous. What it
 *  must never do is outlive the ask: a lookup that hangs would mean no dialog
 *  at all — the loudest version of the failure this fact exists to prevent, and
 *  the one way of not knowing that cannot report itself. */
const DUPLICATE_TIMEOUT_MS = 1000;
/** Distinguishes "the deadline won" from anything a lookup could return. */
const UNANSWERED = Symbol('duplicate-lookup-unanswered');

/** Every character a terminal treats as ending the row. VT, FF and NEL are
 *  line breaks the JSON profile lets through as escapes. In a message, each of
 *  them would let a value end its own line and write the next one — a `House:`
 *  line, or a reassurance nobody wrote — in the owner's dialog. */
const LINE_BREAK = /\r\n|[\n\r\v\f\u0085\u2028\u2029]/;
/** C0 and C1 controls, DEL included. These are not measurable rather than
 *  merely wide: ESC paints nothing or repaints the row, NUL paints zero
 *  columns, TAB paints up to eight. A display-only line has no use for any of
 *  them, so they are refused instead of counted. (Tested by code point rather
 *  than by a character class, which would be a literal control regex.) */
function isControl(code: number): boolean {
  return code < 0x20 || (code >= 0x7f && code <= 0x9f);
}
/** Format characters and lone surrogates: spoofing characters with no
 *  legitimate place in a parameter. A bidi override (U+202A–202E, U+2066–2069)
 *  makes a value display reordered; a zero-width character (U+200B–200F,
 *  U+2060–2064, U+FEFF and the rest of `\p{Cf}`) makes two different values
 *  look identical. This is NOT a closed list of everything that renders
 *  blank: characters outside `\p{Cf}`, such as the Hangul fillers (U+115F,
 *  U+1160, U+3164, U+FFA0, which are letters) and the space characters
 *  accepted below, still pass.
 *
 *  ONE EXCEPTION: U+200D ZERO WIDTH JOINER between two emoji. Joining emoji
 *  into one glyph (👨‍👩‍👧, 👩‍💻, 🏳️‍🌈) is its one legitimate job and ordinary input
 *  in a check-in. Allowed only when the code point before it is
 *  `\p{Extended_Pictographic}` — skipping one U+FE0F or skin-tone modifier
 *  (U+1F3FB–1F3FF), which real sequences carry — and the one after it is too.
 *  Between letters, at either end, or beside only one emoji it is an invisible
 *  difference and stays refused. `\p{Extended_Pictographic}` also covers
 *  non-emoji pictographs such as © and ™, so a joiner between those two is
 *  accepted by this rule — recorded, not changed.
 *
 *  KNOWN LIMITATION, DECIDED: a subdivision flag (🏴 followed by TAG
 *  characters, U+E0020–E007F, e.g. England's flag) is refused, because tag
 *  characters are `\p{Cf}`. That is a false refusal of a real emoji.
 *
 *  KNOWN LIMITATION, DECIDED: U+200C ZERO WIDTH NON-JOINER is refused although
 *  Persian and several Indic scripts use it legitimately. Telling that use from
 *  spoofing needs script-aware rules, and allowing it generally reopens the
 *  invisible-difference spoof.
 *
 *  DELIBERATELY NARROWER THAN THE DRAFT SEAM'S `INVISIBLE` class
 *  (`owner-approval.ts`) in two ways: the ZWJ-in-emoji allowance above, and
 *  spaces — the seam also refuses U+3000 IDEOGRAPHIC SPACE, U+00A0 and other
 *  spaces. A Chinese owner typing a place name on an IME legitimately produces
 *  U+3000, and a world parameter is shown as-is rather than escaped to a
 *  visible form the way the draft seam's body lines are, so refusing those
 *  here would refuse ordinary input. Do not "fix" either difference in either
 *  direction without these reasons in view. Line and paragraph separators
 *  (U+2028/2029) are refused by LINE_BREAK above. */
const SPOOFING = /[\p{Cf}\p{Cs}]/u;
const PICTOGRAPH = /\p{Extended_Pictographic}/u;
const ZERO_WIDTH_JOINER = '\u200D';
const EMOJI_PRESENTATION = '\uFE0F';
function isSkinTone(character: string | undefined): boolean {
  const code = character?.codePointAt(0) ?? 0;
  return code >= 0x1f3fb && code <= 0x1f3ff;
}
/** A joiner with an emoji on both sides, in a line walked by code point. */
function joinsEmoji(characters: readonly string[], index: number): boolean {
  let before = index - 1;
  if (characters[before] === EMOJI_PRESENTATION || isSkinTone(characters[before])) before -= 1;
  const previous = characters[before], next = characters[index + 1];
  return previous !== undefined && next !== undefined && PICTOGRAPH.test(previous) && PICTOGRAPH.test(next);
}
/** How many characters of a line cannot be shown honestly. */
function unprintableCount(line: string): number {
  const characters = [...line];
  return characters.filter((character, index) => {
    if (isControl(character.codePointAt(0)!)) return true;
    if (!SPOOFING.test(character)) return false;
    return !(character === ZERO_WIDTH_JOINER && joinsEmoji(characters, index));
  }).length;
}

type FormSchema = ElicitRequestFormParams['requestedSchema'];
interface OwnerDialog { message: string; requestedSchema: FormSchema }
/** What the injected lookup answered, reduced to the three cases the dialog
 *  distinguishes. `failed` covers a throw, a rejected promise and an answer
 *  that is not a list of request ids — every way of not knowing. */
export type DuplicateCheck =
  | { readonly state: 'none' }
  | { readonly state: 'twin'; readonly requestId: string }
  | { readonly state: 'failed' };
/** The duplicate fact, as the owner reads it. A fresh confirmation mints a
 *  fresh nonce and a fresh job, so it authorises a NEW action; it cannot resend
 *  the earlier one — hence "second action", never "retry". A check that could
 *  not run is said out loud and called unknown: silence would read as "no
 *  duplicate", which is the one thing it does not mean. */
function duplicateLines(duplicate: DuplicateCheck): string[] {
  if (duplicate.state === 'twin') {
    return [`DUPLICATE: an earlier request with the same input is unresolved.`,
      `Original request: ${duplicate.requestId}`,
      'Confirming creates a SECOND action that may duplicate it.'];
  }
  if (duplicate.state === 'failed') {
    return ['DUPLICATE CHECK FAILED: PopClaw could not check whether an earlier',
      'request with the same input is still unresolved.',
      'Whether this duplicates an earlier action is UNKNOWN.'];
  }
  return [];
}

/** Never truncate what the owner is asked to approve. A value that cannot be
 *  shown honestly is refused before anything is sent, with the code, the
 *  offending key, the limit and what it measured, so the agent can fix the
 *  value and ask again — and what is then signed is exactly the text the owner
 *  read. */
function unreadable(reason: string, key: string, limit: number, measured: number, unit: 'lines' | 'controls'): never {
  throw new Error(`${OWNER_CONFIRMATION_UNREADABLE} reason=${reason} key=${key} limit=${limit} measured=${measured} unit=${unit}`
    + ': the owner confirms the whole value or nothing; shorten it and ask again');
}
/** The host part is what tells one house from another on the first line; the
 *  scheme and port follow in full on the `House:` line. */
function houseHost(house: string): string {
  try { return new URL(house).host || house; } catch { return house; }
}
/** Code units, not code points: safe only because both callers pass a value the
 *  invoke schema has already re-validated as base58 or lower-hex, which is
 *  ASCII throughout. Anything else must not be cut here. */
function shortened(value: string): string {
  return value.length > SUMMARY_PREFIX_CHARS ? `${value.slice(0, SUMMARY_PREFIX_CHARS)}…` : value;
}
/** What the first line may occupy: Claude Code folds the message to it, and
 *  about 72 columns of it render (80 − 4 indent − 1 cut mark − 3 margin). */
const SUMMARY_COLUMNS = 72;
/** Below this much room for the host, the identity and revision prefixes are
 *  dropped from the first line rather than squeezing the host further; both
 *  are in full further down. */
const SUMMARY_MIN_HOST_COLUMNS = 16;
/** The END of a host within `columns`, marked with a leading `…`. The
 *  registrable domain is at the end, so that is the part kept: cutting from
 *  the right turns `popclaw.me.x.example.evil` into `popclaw.me.x…`, which
 *  reads as a subdomain of popclaw.me. Safe on code units: the invoke schema
 *  admits only an ASCII origin (IDN is punycode, anything else is refused). */
function hostEnd(host: string, columns: number): string {
  return host.length <= columns ? host : `…${host.slice(host.length - (columns - 1))}`;
}
/** The four fixed facts in one line of at most 72 columns: action kind,
 *  house, identity, capability revision. When there is no duplicate alarm it
 *  is what a host that folds the message shows before the expand key. A host
 *  too long for the room left is shortened from its start; the full House
 *  line follows below. */
function summaryLine(input: Readonly<WorldInvokeInput>, actorId: string): string {
  const head = `${input.kind} at `;
  const tail = ` as ${shortened(actorId)} cap ${shortened(input.expected_capability_revision)}`;
  const host = houseHost(input.house);
  const room = SUMMARY_COLUMNS - displayWidth(head) - displayWidth(tail);
  if (host.length <= room) return `${head}${host}${tail}`;
  if (room >= SUMMARY_MIN_HOST_COLUMNS) return `${head}${hostEnd(host, room)}${tail}`;
  // Too little room even without the prefixes: an action kind near its 64
  // limit. The host keeps at least its last 16 columns, and the KIND gives
  // way instead, cut at its end and marked — it is in full on the Action line.
  const hostColumns = Math.max(SUMMARY_COLUMNS - displayWidth(head), SUMMARY_MIN_HOST_COLUMNS);
  const shownHost = hostEnd(host, hostColumns);
  const kindColumns = SUMMARY_COLUMNS - ' at '.length - shownHost.length;
  const kind = input.kind.length <= kindColumns ? input.kind : `${input.kind.slice(0, kindColumns - 1)}…`;
  return `${kind} at ${shownHost}`;
}
/** What the owner reads for one parameter — a string as they would read it,
 *  anything else in the canonical JSON the signature covers. 0.1.0 renders no
 *  parameter by meaning: the owner approves the bytes, not an interpretation
 *  of them. */
function parameterText(value: unknown): string {
  return typeof value === 'string' ? value : canonicalActionJson(value);
}
/** `key: value` verbatim. */
function parameterLine(key: string, value: unknown): string {
  return `${key}: ${parameterText(value)}`;
}
/** Written by this module in front of EVERY parameter line, and by nothing
 *  else: no frame line starts with it. In the field form a parameter's key was
 *  a field title and could not pose as the frame; in a message a parameter
 *  named `house` could print `house: …` right under the real `House:` line.
 *  With the prefix, whatever a key or value says, the line reads as a quoted
 *  parameter. It only holds because a value cannot start a line of its own —
 *  which is what the line-break refusal below guarantees. */
const PARAMETER_PREFIX = '> ';
/** In front of every CONTINUATION row of a wrapped parameter: still `> `, so a
 *  painted row never lacks the prefix, and indented, so a value whose wrap
 *  boundary happens to begin `amount: 1000` reads as the rest of its own
 *  parameter rather than as a separate `> amount: 1000`. */
const CONTINUATION_PREFIX = '>   ';
/** Where PopClaw breaks a parameter row itself. WHY THIS EXISTS: a terminal
 *  soft-wraps a long row with NO prefix on the part that carries over, so a
 *  value padded to the terminal's width could paint `Reference: 000000` as a
 *  row of its own, above the real one. The old per-field column refusal
 *  (`parameter_too_wide`) had been guaranteeing incidentally that no row was
 *  that long; removing it as "layout only" lost that. So: every row PopClaw
 *  writes is at most 4 + 64 = 68 columns, under the 76 a narrow terminal pane
 *  paints, and nothing is left for the terminal to wrap. */
const WRAP_COLUMNS = 64;
const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const ZERO_COLUMN = /[\p{M}\u200D]/u;
/** Columns one grapheme may paint, on the safe side: the larger of
 *  `displayWidth` and a count that treats every non-ASCII code point as wide
 *  (marks and joiners as nothing). A character the width table misses must
 *  make a row too short, never too long. */
function graphemeColumns(grapheme: string): number {
  let conservative = 0;
  for (const character of grapheme) {
    const code = character.codePointAt(0)!;
    if (ZERO_COLUMN.test(character) || isZeroWidthCodePoint(code)) continue;
    conservative += code < 0x7f ? 1 : 2;
  }
  return Math.max(conservative, displayWidth(grapheme));
}
/** One parameter as rows: complete and verbatim — the rows, prefixes removed,
 *  concatenate back to the line — broken only between graphemes, so an emoji
 *  sequence or a surrogate pair is never split across rows. Wrapping, never
 *  truncation. */
function parameterRows(line: string): string[] {
  const rows: string[] = [];
  let row = '', width = 0;
  for (const { segment } of GRAPHEMES.segment(line)) {
    const columns = graphemeColumns(segment);
    if (row !== '' && width + columns > WRAP_COLUMNS) { rows.push(row); row = ''; width = 0; }
    row += segment; width += columns;
  }
  rows.push(row);
  return rows.map((text, index) => `${index === 0 ? PARAMETER_PREFIX : CONTINUATION_PREFIX}${text}`);
}

/** Builds the dialog, or refuses to build one at all. Every host gets the
 *  same dialog: the explanation is the message, the form is one boolean.
 *
 *  WHAT BOUNDS IT. Not a screen budget any more: the invoke schema, which
 *  captured this input before any dialog was built — `params` at most
 *  `L_PARAMS_MAX_BYTES` (16384) of JSON, the house an origin of at most 253
 *  characters, the kind at most 64, the revision 64 hex, the identity a
 *  44-character key. Rendered, a parameter line costs at most two bytes more
 *  than the same pair in JSON, plus five bytes per 64-column wrap, so the
 *  message stays within about twice the parameter limit; pinned by a test.
 *  No frame line needs wrapping for safety: the lines long enough for a
 *  terminal to wrap (House, Capability revision, Original request) hold only
 *  a lowercase whitespace-free origin or hex, which cannot form `Label: `.
 *
 *  The acceptance rule's optional `Session:` line is omitted deliberately: the
 *  ask receives only the invoke input, never the runtime's selected session. */
function buildDialog(input: Readonly<WorldInvokeInput>, actorId: string, seconds: number,
  reference: string, duplicate: DuplicateCheck): OwnerDialog {
  const keys = Object.keys(input.params).sort();
  const parameters = keys.map(key => ({ key, line: parameterLine(key, input.params[key]) }));
  // Content, over the WHOLE of each `key: value` — the key included, since a
  // key is the same attack from the other side. A value carrying its own line
  // break would end its line and write the next one in PopClaw's voice; it is
  // refused, not escaped, so what the owner reads and what is signed are the
  // same characters.
  for (const { key, line } of parameters) {
    const rows = line.split(LINE_BREAK).length;
    if (rows > 1) unreadable('parameter_not_one_line', key, 1, rows, 'lines');
    // The remaining controls cannot be shown faithfully at all, and format
    // characters and lone surrogates can only mislead, so they are refused
    // rather than rendered.
    const controls = unprintableCount(line);
    if (controls > 0) unreadable('parameter_not_printable', key, 0, controls, 'controls');
  }
  return {
    message: [
      // The alarm FIRST: a host that folds the message after one line shows it
      // without a keystroke, and it is read before the facts it qualifies.
      ...duplicateLines(duplicate),
      summaryLine(input, actorId),
      'PopClaw: confirm world action',
      `House: ${input.house}`,
      `Identity: ${actorId}`,
      `Action: ${input.kind}`,
      `Capability revision: ${input.expected_capability_revision}`,
      parameters.length > 0 ? 'Parameters:' : 'Parameters: (none)',
      ...parameters.flatMap(({ line }) => parameterRows(line)),
      `Reference: ${reference}`,
      `Answer within ${seconds} s.`,
    ].join('\n'),
    requestedSchema: ownerConfirmationSchema(reference),
  };
}

function fail(code: string): never { throw new Error(code); }
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function nonce(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString('hex');
}
export function createMcpOwnerAuthorization(options: McpOwnerAuthorizationOptions): McpOwnerAuthorization {
  try { worldPublicKey(options.actorId); } catch { return fail(OWNER_CONFIRMATION_ACTOR_INVALID); }
  // The one window every owner-approval dialog shares (`owner-approval.ts`).
  const timeoutMs = options.elicitTimeoutMs ?? OWNER_APPROVAL_WINDOW_MS;
  const seconds = Math.round(timeoutMs / 1000);
  // The adapter's own abort: shutdown must cancel a dialog already on screen,
  // rather than letting stop() wait out the full elicitation timeout.
  const shutdown = new AbortController();
  let stopped = false, busy = false, highWater = 0;
  function clock(): number {
    if (stopped) return fail(OWNER_CONFIRMATION_UNAVAILABLE);
    const now = options.now?.() ?? Math.floor(Date.now() / 1000);
    if (!Number.isSafeInteger(now) || now < highWater) return fail(OWNER_CONFIRMATION_CLOCK_ROLLBACK);
    highWater = now; return now;
  }
  /** Read the capability at CALL time: the SDK normalizes `{}` to `{form:{}}`. */
  function live(): NonNullable<McpServerBox['current']> {
    if (stopped) return fail(`${OWNER_CONFIRMATION_UNAVAILABLE}: the PopClaw MCP session is shutting down`);
    const server = options.server.current;
    if (!server || !server.getClientCapabilities()?.elicitation?.form) {
      return fail(`${OWNER_CONFIRMATION_UNAVAILABLE}: ${OWNER_CONFIRMATION_UNAVAILABLE_HINT}`);
    }
    return server;
  }
  /** "Is an identical earlier request still unresolved?", asked of the injected
   *  lookup and of nothing else. Every way of not knowing — a throw, a rejected
   *  promise, an answer that is not a list of request ids, and a lookup that
   *  never answers at all — collapses to `failed`, which the dialog states out
   *  loud. Answering `none` on a broken lookup would be the silent drop this
   *  fact exists to prevent; waiting forever on a hung one would be worse
   *  still, because then there is no dialog at all. */
  async function checkDuplicate(input: Readonly<WorldInvokeInput>, reason: AbortSignal): Promise<DuplicateCheck> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // `Promise.race` subscribes to the lookup, so a late rejection is handled
      // even when the deadline or the abort wins.
      const found = await Promise.race([
        Promise.resolve(options.duplicates.unresolved({ actorId: options.actorId, input })),
        new Promise<typeof UNANSWERED>(resolve => {
          const give = () => resolve(UNANSWERED);
          timer = setTimeout(give, options.duplicateTimeoutMs ?? DUPLICATE_TIMEOUT_MS);
          // The ask is over anyway; stop waiting so the caller can say so.
          if (reason.aborted) give(); else reason.addEventListener('abort', give, { once: true });
        }),
      ]);
      if (found === UNANSWERED || !Array.isArray(found)) return { state: 'failed' };
      const ids = found.filter((id): id is string => typeof id === 'string' && REQUEST_ID.test(id));
      // Something came back that is not a request id: the lookup is broken, and
      // a broken lookup has not established that there is no twin.
      if (ids.length !== found.length) return { state: 'failed' };
      // The oldest first, which is the order the ledger returns them in.
      return ids.length === 0 ? { state: 'none' } : { state: 'twin', requestId: ids[0]! };
    } catch { return { state: 'failed' }; }
    finally { if (timer !== undefined) clearTimeout(timer); }
  }
  return Object.freeze({
    assertActive(): void { live(); clock(); },
    stop(): void { stopped = true; shutdown.abort(); },
    async withInvocation<T>(callId: string, input: Readonly<WorldInvokeInput>, signal: AbortSignal | undefined,
      callback: (ask: OwnerInvocation) => Promise<T>): Promise<T> {
      if (typeof callId !== 'string' || !CALL_ID.test(callId)) return fail(OWNER_CONFIRMATION_INVOCATION_INVALID);
      // Refuse an unusable host with its own code and hint, before the capability
      // projection can turn this into a generic WORLD_LOCAL_UNSUPPORTED.
      live();
      if (busy) return fail(OWNER_CONFIRMATION_BUSY);
      const capturedInput = freeze(captureWorldCommandInput('invoke', input));
      const captured = canonicalActionJson(capturedInput);
      // Either the host cancelling this tool call or the adapter stopping ends the ask.
      const reason = AbortSignal.any([signal, shutdown.signal].filter((one): one is AbortSignal => !!one));
      // One invocation is one job, so the nonce is minted once here rather than
      // inside `authorize`: the reference the caller reports is then the same
      // string the dialog showed, whatever happened to the confirmation.
      const token = nonce();
      // Set synchronously, before the first await, so a re-entrant second call sees it.
      busy = true;
      let active = true, asked = false;
      try {
        const ask: OwnerInvocation = {
          reference: token.slice(0, REFERENCE_CHARS),
          authorize: async candidate => {
            // One confirmation per invocation: one job, one request slot (R3/R6).
            // Set before any await so a re-entrant second ask cannot slip through.
            if (asked) return fail(OWNER_CONFIRMATION_BUSY);
            asked = true;
            if (!active || reason.aborted) return fail(OWNER_CONFIRMATION_INACTIVE);
            if (canonicalActionJson(captureWorldCommandInput('invoke', candidate)) !== captured) {
              return fail(OWNER_CONFIRMATION_INPUT_MISMATCH);
            }
            const server = live();
            clock();
            // Asked BEFORE the dialog is built, from the injected lookup alone:
            // the owner has to learn that an identical earlier request is still
            // unresolved while there is still something to decide.
            const duplicate = await checkDuplicate(capturedInput, reason);
            if (!active || reason.aborted) return fail(OWNER_CONFIRMATION_INACTIVE);
            // Refuses instead of sending a dialog a value could forge a line in.
            const dialog = buildDialog(candidate, options.actorId, seconds, ask.reference, duplicate);
            const result = await server.elicitInput(
              { mode: 'form', message: dialog.message, requestedSchema: dialog.requestedSchema },
              // The host's own cancellation of the tool call, and the adapter's own
              // shutdown, both cancel the dialog rather than leaving it open for the whole window.
              { timeout: timeoutMs, signal: reason },
            ).catch((error: unknown) => {
              const code = (error as { code?: unknown } | null)?.code;
              if (reason.aborted) return fail(OWNER_CONFIRMATION_INACTIVE);
              // The code, then the one sentence that prevents the silent drop:
              // Claude Code leaves the dialog open after our cancel, and an
              // approval given there now reaches nobody.
              if (code === ErrorCode.RequestTimeout) {
                return fail(`${OWNER_CONFIRMATION_TIMEOUT}: ${renderCopy(ownerLang(), 'world.action.approval.timedOut')}`);
              }
              // The SDK validates an accepted answer against the form we sent and
              // raises InvalidParams when it does not match. That is a host bug on
              // an answer the owner already gave, so it is not a generic failure.
              if (code === ErrorCode.InvalidParams) {
                return fail(`${OWNER_CONFIRMATION_ANSWER_INVALID}: ${OWNER_CONFIRMATION_ANSWER_INVALID_HINT}`);
              }
              return fail(OWNER_CONFIRMATION_FAILED);
            });
            if (result.action === 'cancel') return fail(OWNER_CONFIRMATION_CANCELLED);
            // An accepted form whose box is unchecked is a refusal, not consent.
            if (result.action !== 'accept' || result.content?.['confirm'] !== true) return fail(OWNER_CONFIRMATION_DECLINED);
            if (!active || reason.aborted) return fail(OWNER_CONFIRMATION_INACTIVE);
            const expiresAt = clock() + GRANT_SECONDS;
            return freeze({
              jobId: `mcp-owner:${token}`,
              expiresAt,
              assertCurrent: (): void => {
                if (!active || reason.aborted || stopped) return fail(OWNER_CONFIRMATION_INACTIVE);
                if (clock() >= expiresAt) return fail(OWNER_CONFIRMATION_EXPIRED);
              },
            });
          },
        };
        return await callback(ask);
      } finally {
        // A returned grant must die with its call, so a stale one fails assertCurrent.
        active = false; busy = false;
      }
    },
  });
}
