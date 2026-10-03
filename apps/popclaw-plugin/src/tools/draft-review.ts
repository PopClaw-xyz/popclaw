/**
 * A long draft's READ-ONLY REVIEW COPY: the owner's way to read the whole
 * letter before a short approval dialog asks about it.
 *
 * Why it exists: a 975-character letter put whole into the MCP approval
 * dialog reached the Codex desktop app starting at its third paragraph, with
 * no way to scroll back to the recipient or the opening (2026-09-28, D2-1
 * R2). A plain Markdown link to an absolute path, posted in the chat, opens a
 * file in that app's side panel, where the owner can read top, middle and
 * bottom and return (probe 1, 2026-09-28). So a draft too long for a compact
 * dialog gets a file, a link in the draft tool's result for the agent to
 * post, and a compact dialog that names the file.
 *
 * WHERE: only on a root that injects `DraftReviewFiles` — today the MCP root.
 * The native OpenClaw root injects nothing, so it never writes a copy, never
 * shows a link and never gets the compact dialog; its prompts are unchanged.
 * The decision is the root's, never a tool parameter's.
 *
 * WHAT: generated here, from the frozen snapshot, by the plugin. The model
 * never writes it. It is never read back as content: the send always uses the
 * snapshot, and the file is only re-hashed before an approval is honoured
 * (`verifyDraftReview`). It is never attached to the outgoing message.
 *
 * NOTHING UNTRUSTED RENDERS. Every value from outside (recipient label, house,
 * attachment names, the body) sits inside a fenced code block whose backtick
 * fence is longer than any backtick run in what it encloses, so no Markdown,
 * link, image or HTML can form from it. Header values additionally have any
 * character that paints nothing (line breaks included) escaped to a visible
 * `‹U+XXXX›`, so a value cannot add a header line of its own.
 */
import nacl from 'tweetnacl';
import { hasInvisibleCharacter } from '../host/owner-approval.js';
import { kb } from '../messaging/dm-media.js';
import { renderCopy, type Lang } from '../lexicon/index.js';
import { ownerLang } from '../lexicon/owner-language.js';
import {
  draftDigest, noteDraftReview, peekDraftSnapshot, setDraftReviewFiles,
  type DraftReviewFiles, type DraftSnapshot,
} from './draft-store.js';
import { needsReviewCopy } from './send-draft-subject.js';

/** Why a root's review directory is not used, for the log only. */
export const REVIEW_PATH_NOT_SHOWABLE = 'REVIEW_PATH_NOT_SHOWABLE';

/** A header value with every invisible character (and the escape introducer
 *  itself) shown as a visible token, so it stays on its own line. */
function escapeValue(value: string): string {
  return [...value].map((ch) => (hasInvisibleCharacter(ch) || ch === '‹'
    ? `‹U+${(ch.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}›`
    : ch)).join('');
}

/** A backtick fence longer than any backtick run in `text` (at least three). */
export function fenceFor(text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  return '`'.repeat(Math.max(3, longest + 1));
}

const fenced = (text: string): string => {
  const fence = fenceFor(text);
  return `${fence}text\n${text}\n${fence}`;
};

/** The file's text. Pure: the same snapshot, id and language give the same
 *  bytes. */
export function renderReviewCopy(snapshot: DraftSnapshot, id: string, lang: Lang): string {
  const none = renderCopy(lang, 'draft.review.file.none');
  const short = snapshot.recipientId ? snapshot.recipientId.slice(0, 8) : '';
  const to = snapshot.recipientLabel
    ? `${snapshot.recipientLabel}${short ? ` (${short})` : ''}`
    : short || none;
  const attachments = snapshot.attachments.length === 0
    ? none
    : snapshot.attachments.map((a) => `\n  - ${escapeValue(a.name)} (${kb(a.bytes.length)}, digest ${draftDigest(a.bytes)})`).join('');
  const header = renderCopy(lang, 'draft.review.file.header', {
    id,
    to: escapeValue(to),
    house: escapeValue(snapshot.house ?? none),
    attachments,
    chars: String([...snapshot.body].length),
    digest: draftDigest(snapshot.body),
  });
  return [
    renderCopy(lang, 'draft.review.file.heading'),
    '',
    fenced(header),
    '',
    renderCopy(lang, 'draft.review.file.bodyLabel'),
    '',
    fenced(snapshot.body),
    '',
    renderCopy(lang, 'draft.review.file.end', { id }),
    '',
  ].join('\n');
}

/** The link line the agent posts. Angle brackets around a path with spaces
 *  or parentheses (CommonMark's form for such destinations; not yet verified
 *  on the desktop app, where the proven path had neither). A path containing
 *  `<` or `>` cannot use that form and never reaches here: `withDraftReview`
 *  leaves such a root without review copies. */
export function reviewLink(id: string, path: string, lang: Lang): string {
  const target = /[\s()<>]/.test(path) ? `<${path}>` : path;
  return `[${renderCopy(lang, 'draft.review.linkText', { id })}](${target})`;
}

/** A root's review directory, or a thunk that makes it on first use (the MCP
 *  root: making it creates and sweeps a directory). */
export type DraftReviewFilesSource = DraftReviewFiles | (() => DraftReviewFiles | null) | null | undefined;

/**
 * At mint, right after the draft tool composed its result: decide, once, with
 * `needsReviewCopy`; on a root with review files, record the decision and,
 * when a copy is needed, write it and append the entry to the result. On a
 * root without review files, the result comes back unchanged and nothing is
 * recorded.
 *
 * `source` is the root's `deps.draftReviewFiles`, resolved HERE, at the first
 * mint, and published to the per-process holder that sent/evicted/expired
 * drafts clean up through (a copy exists only after a mint set it). Never at
 * registration: ADR-0035, registering tools touches no process singleton and
 * no filesystem. Null (the native root) clears it, so a native root never
 * inherits another root's directory.
 */
export function withDraftReview(token: string, text: string, source: DraftReviewFilesSource): string {
  const files = (typeof source === 'function' ? source() : source) ?? null;
  setDraftReviewFiles(files);
  if (!files) return text;
  // A review directory whose path cannot be shown honestly (a character that
  // paints nothing: an ideographic or no-break space, a zero-width joiner in
  // an emoji folder name) or that breaks the link's angle-bracket form (`<`,
  // `>`) is treated exactly like one that could not be created: no copy, no
  // decision recorded, and the draft keeps the whole-text dialog. The reason
  // goes to the log, never to the owner as a refusal.
  if (hasInvisibleCharacter(files.dir) || /[<>]/.test(files.dir)) {
    files.note?.(REVIEW_PATH_NOT_SHOWABLE);
    return text;
  }
  const snapshot = peekDraftSnapshot(token);
  if (!snapshot) return text;
  const lang = ownerLang();
  const needed = needsReviewCopy(snapshot, token, lang);
  if (!needed) {
    noteDraftReview(token, { needed: false, lang, file: null });
    return text;
  }
  const nonce = [...nacl.randomBytes(4)].map((b) => b.toString(16).padStart(2, '0')).join('');
  const name = `${token}-${nonce}.md`;
  let file: { path: string; name: string; sha256: string } | null = null;
  try {
    const written = files.write(name, renderReviewCopy(snapshot, token, lang));
    file = { path: written.path, name, sha256: written.sha256 };
  } catch { file = null; }
  noteDraftReview(token, file ? { needed: true, lang, file } : { needed: true, lang, file: null, failed: 'write' });
  if (!file) return `${text}\n\n${renderCopy(lang, 'draft.review.writeFailed')}`;
  return `${text}\n\n${renderCopy(lang, 'draft.review.entry', { link: reviewLink(token, file.path, lang) })}`;
}
