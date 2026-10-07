/**
 * The write-class draft table: mint a draft_id, park the send closure behind
 * it, and hand it back out exactly once when the owner confirms.
 *
 * Short independent protocols still use this volatile table. Installed local
 * ordinary social manuscripts use durable-social-drafts.ts; their closures
 * exist here only while drafting or executing a current send invocation.
 */

import nacl from 'tweetnacl';
import { getOrCreatePerProcess, resetSingletonForTest } from '../runtime/once.js';
import { captureActionContext } from '../runtime/house-lifecycle/action-context.js';
import type { PreviewDeliveryStatus } from './draft-preview-delivery.js';
import { ownerLang } from '../lexicon/owner-language.js';
import { renderCopy, type Lang } from '../lexicon/index.js';

// In-memory draft store (write-class confirmation pattern).
//
// **Process-level, not module-level** — the host reloads the plugin repeatedly
// (`popclaw: register mode=full` / `mode=tool-discovery`, 33 times a day on
// real hardware), and each reload is a brand-new module instance. If the table
// lived in module scope, a reload would wipe it out, and a draft_token the
// agent just received would become orphaned seconds later (on real hardware,
// 2026-07-27: draft succeeded → send reported unknown → the DM never actually
// went out). Hanging it off globalThis lets it survive reloads, the same
// mechanism as runOncePerProcess / getOrCreatePerProcess (P-006 §3, resource
// singletons).
//
// Storing a closure here is safe: the `runtime` the closure captures is itself
// the process-level singleton from `getOrCreatePerProcess('runtime')`
// (index.ts) — the old instance's closure still resolves to the same
// sqlite/egress.
type DraftEntry = { fn: () => Promise<{ text: string }>; at: number; snapshot: DraftSnapshot | null; contentDigest?: string };
const draftStore = (): Map<string, DraftEntry> =>
  getOrCreatePerProcess('drafts', () => new Map<string, DraftEntry>());

/**
 * Short, stable content digest. Not a secret and not a capability — it exists
 * so that "the bytes the owner was shown" can be compared without carrying
 * those bytes through a prompt that has no room for them.
 *
 * tweetnacl's SHA-512 rather than `node:crypto`: this is a business module and
 * only the composition roots may reach for node APIs (the grandfather list in
 * eslint.config.js only shrinks). tweetnacl is already the plugin's signing
 * primitive, so this adds nothing to the dependency surface.
 */
export function draftDigest(value: string | Uint8Array): string {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  return [...nacl.hash(bytes).slice(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * One file riding along with a draft, as it was read at draft time.
 *
 * THE BYTES, not the path. A path is not content: a draft that carried one
 * had its file re-read at send time, so the file the owner approved and the
 * file that went out were the same only by luck — swapping it in between
 * changed nothing in the recorded manuscript. Holding
 * the bytes makes "what is sent is what was approved" true by construction
 * rather than by a comparison that can be skipped.
 *
 * Affordable because the format allowlist already caps one attachment at
 * `MAX_DM_MEDIA_BYTES` (1 MiB, dm-crypto.ts) and rejects anything larger at
 * DRAFT time. Local ordinary manuscripts move these bytes to HostDb instead
 * of retaining an unbounded closure cache.
 */
export interface DraftAttachmentSnapshot {
  readonly name: string;
  /** Digest of exactly these bytes, so an attachment that differs is a
   *  different subject even under the same name. */
  readonly digest: string;
  readonly mime: string;
  /** Deliberately not frozen — a Uint8Array cannot be — but the draft holds
   *  the only reference to this buffer: it was read here and handed nowhere
   *  else. */
  readonly bytes: Uint8Array;
}

/** The one preview delivery a draft tool attempted, and what came of it. */
export interface DraftPreviewSnapshot {
  /** Digest of the exact preview string that attempt was given. */
  readonly digest: string;
  /** `unknown` is the only status under which anything plausibly reached the
   *  owner; `unavailable` means nothing was attempted and `failed` means the
   *  attempt threw (draft-preview-delivery.ts states why none of the three is
   *  a receipt). The agent must not claim more than this. */
  readonly status: PreviewDeliveryStatus;
  /** Epoch ms at which that attempt finished. */
  readonly at: number;
}

/**
 * The tool RESULT that carried this draft's complete text to the host.
 *
 * A second, different source from the one above, and the difference is the
 * point. `DraftPreviewSnapshot` describes a push the plugin asked the host to
 * make into the owner's own chat; this describes the draft tool's own output,
 * which the host renders in its transcript to whoever is sitting at it. On an
 * MCP host (Claude Code, Codex) the tool factory resolves with `{}`, so the
 * push is never even attempted and this is the ONLY place the complete letter
 * ever appears.
 *
 * Not a read receipt, and the agent must not describe it as
 * one: the host may fold the output behind a keystroke, and it may cut a
 * result that exceeds its own size cap (real hardware: a newspaper payload was
 * truncated mid-way at 64k weighted characters). It says the plugin emitted
 * the whole letter, and nothing beyond that.
 */
export interface DraftToolOutputSnapshot {
  /** Digest of the exact text that was emitted. */
  readonly digest: string;
  /** Epoch ms at which the draft tool returned it. */
  readonly at: number;
}

/**
 * What a confirmed draft will send, frozen at draft time.
 *
 * The owner approves CONTENT, not a token. A draft id is a handle: it says
 * nothing about the recipient or the words, and on its own it let the model
 * mint a draft and confirm its own draft (real hardware, 2026-09-21). So the
 * table carries the content beside the closure. The closure sends this frozen
 * content; a digest also checks mutable attachment buffers before consumption.
 * Conversation review and confirmation remain the agent's responsibility.
 */
export interface DraftSnapshot {
  /** Serializable operation data, never a parked invocation callback. */
  readonly sendPlan?: import('./draft-send-plan.js').DraftSendPlan;
  /** Stable root/session identity; never a drafting-turn invocation capability. */
  readonly binding?: import('../host/social-send-context.js').SocialDraftBinding | null;
  readonly kind: DraftContentKind;
  /** The recipient's popclaw_id, for the kinds addressed to a person. */
  readonly recipientId?: string;
  /** `name#sigil`, exactly as the draft preview spelled it. */
  readonly recipientLabel?: string;
  /** The house this draft is addressed to, or posted in. */
  readonly house?: string;
  /** What a reply or quote points at, in the short form the preview showed. */
  readonly target?: string;
  /** The complete text that will be sent. Never a summary, never clipped. */
  readonly body: string;
  readonly attachments: readonly DraftAttachmentSnapshot[];
  /** Null until the draft tool has attempted its one preview delivery. */
  readonly preview: DraftPreviewSnapshot | null;
  /** Null until a draft tool has emitted this draft's complete text as its own
   *  tool result (`noteDraftToolOutput`). */
  readonly output: DraftToolOutputSnapshot | null;
  /** The review-copy decision, recorded once at mint on a root that can write
   *  review copies (`noteDraftReview`); absent everywhere else. */
  readonly review?: DraftReviewSnapshot;
}

/**
 * The owner's read-only review copy of a long draft (`draft-review.ts`).
 *
 * `needed` is the one decision — made at mint by `needsReviewCopy` on this
 * snapshot. `file` records the optional copy's absolute path and SHA-256.
 * The file is never read back as send content; it is only re-hashed before
 * sending to detect a changed copy.
 */
export interface DraftReviewSnapshot {
  readonly needed: boolean;
  readonly lang: Lang;
  readonly file: { readonly path: string; readonly name: string; readonly sha256: string } | null;
  /** Why a needed copy has no file: it could not be written. Absent when
   *  there is a file or none is needed. */
  readonly failed?: 'write';
}

/**
 * Where review copies live, injected by a composition root that has one (the
 * MCP root). Business code never touches the filesystem itself.
 */
export interface DraftReviewFiles {
  /** Absolute directory, private to the current user. */
  readonly dir: string;
  /** Write `text` as a new file `name` (0600) and report its path and the
   *  SHA-256 of the bytes written. Throws when it cannot. */
  write(name: string, text: string): { readonly path: string; readonly sha256: string };
  /** SHA-256 of the file's current bytes, or null when it is gone. */
  sha256(path: string): string | null;
  /** Remove the file if it is there. Never throws. */
  remove(path: string): void;
  /** Log why this root is not using its review directory. Never throws. */
  note?(reason: string): void;
}
const reviewHolder = (): { files: DraftReviewFiles | null } =>
  getOrCreatePerProcess('draft-review-files', () => ({ files: null as DraftReviewFiles | null }));
/** Set by the tool registration from its root's deps; null on a root without
 *  a review directory (the native root), which then writes no copies. */
export function setDraftReviewFiles(files: DraftReviewFiles | null): void { reviewHolder().files = files; }
export function draftReviewFiles(): DraftReviewFiles | null { return reviewHolder().files; }
/** A draft leaving the table takes its review copy with it: sent, evicted
 *  or expired. */
function dropReviewCopy(entry: DraftEntry | undefined): void {
  const path = entry?.snapshot?.review?.file?.path;
  if (path) reviewHolder().files?.remove(path);
}

function contentDigest(snapshot: DraftSnapshot): string {
  return draftDigest(JSON.stringify({kind: snapshot.kind, recipientId: snapshot.recipientId,
    recipientLabel: snapshot.recipientLabel, house: snapshot.house, target: snapshot.target,
    body: snapshot.body, binding: snapshot.binding, sendPlan: snapshot.sendPlan,
    attachments: snapshot.attachments.map(a => ({name: a.name, mime: a.mime, bytes: draftDigest(a.bytes)}))}));
}
/** Read-only integrity check on the frozen material, including actual bytes. */
export function draftContentIsCurrent(token: string): boolean {
  const entry = draftStore().get(token);
  return !!entry?.snapshot && entry.contentDigest === contentDigest(entry.snapshot);
}

/** Deep-frozen so neither the tool that built it nor anything downstream can
 *  edit what the owner approved. */
function freezeSnapshot(snapshot: DraftSnapshot): DraftSnapshot {
  const freezePlan = (value: unknown): void => {
    if (!value || typeof value !== 'object' || value instanceof Uint8Array) return;
    for (const child of Object.values(value)) freezePlan(child);
    Object.freeze(value);
  };
  freezePlan(snapshot.sendPlan);
  for (const a of snapshot.attachments) Object.freeze(a);
  Object.freeze(snapshot.attachments);
  if (snapshot.preview) Object.freeze(snapshot.preview);
  if (snapshot.output) Object.freeze(snapshot.output);
  if (snapshot.review) { if (snapshot.review.file) Object.freeze(snapshot.review.file); Object.freeze(snapshot.review); }
  return Object.freeze({ ...snapshot });
}

/** The draft's shelf life. Expires past this point, which also keeps this append-only table from growing into a leak. */
export const DRAFT_TTL_MS = 30 * 60 * 1000;

// Exported for test teardown only. DO NOT use from production code.
export const _draftsForTest = {
  clear: (): void => resetSingletonForTest('drafts'),
};

// The sequence counter is also hung off process-level global state: it lives
// and dies with the draft table. If it reset to zero on a module reload while
// the table didn't, a new draft could collide with and overwrite an old draft
// of the same name — the owner would confirm draft A but B would be what got
// sent, and the confirmation gate would be breached.
const draftSeq = (): { n: number } => getOrCreatePerProcess('draft-seq', () => ({ n: 0 }));

/**
 * Which tool minted a draft — the first segment of every draft id.
 *
 * It is not decoration: one process-level table backs every confirm gate, so a
 * token from one tool is physically reachable through another tool's confirm
 * parameter. `takeDraft` therefore demands the kinds the CALLER is allowed to
 * execute, and the check lives HERE rather than at each call site so the two
 * doors cannot drift apart — `popclaw_send_draft` sends reply/DM/post, and
 * `popclaw_invite`'s confirm_token submits a verification request and nothing
 * else. The failure is the ordinary "unknown or expired" answer: a tool must
 * never explain, let alone run, another tool's parked work.
 *
 * `house-entry` is the newest door and the narrowest: confirming one mints a
 * seven-day login key for a website, so it must not be reachable through the
 * send or verification doors, and theirs must not be reachable through it.
 */
export type DraftKind = 'reply' | 'message' | 'post' | 'invite' | 'house-entry';

/**
 * What a draft IS, as the owner would name it — which is not the same thing as
 * the token prefix above. A feedback letter is parked under the `message`
 * prefix because it is an outbound DM and must go through the DM door, but
 * "a letter to this lore-house's contact" is what the owner is approving, and
 * a preview that called it only a DM would be telling them less than it
 * knows. Every kind that can reach `popclaw_send_draft` is listed here.
 */
export type DraftContentKind = 'dm' | 'reply' | 'post' | 'feedback';

/**
 * The draft id must be **low-entropy, short, and must not contain the word "token"**.
 *
 * Real-hardware incident (morning of 2026-07-29): the original
 * `message_<ms>_<8-char random>` format looked too much like a secret key, so
 * the host's redaction/context-compression layer rewrote it as sensitive
 * information (`messag…8yda`, sometimes the whole thing replaced with `***`).
 * The agent then tried to send using the rewritten id and always got "unknown
 * or expired". The heuristic that triggers this is inconsistent — the plain-text
 * DM the previous night happened not to trigger it, but four straight
 * image-attached DMs the next morning all did.
 *
 * This id is not a secret: only local agents belonging to the owner can call
 * these tools on this machine, and its sole job is to match "the draft the
 * owner confirmed" against "the one that actually gets sent". The one-time-use
 * + 30-minute TTL gate isn't loosened one bit by this change. `message-7` is
 * plenty, and no redaction layer will ever touch it.
 */
/**
 * How many drafts may be alive at once.
 *
 * A draft now holds its attachment's BYTES, so an unbounded table is an
 * unbounded amount of retained memory: forty draft calls carrying a 1 MiB
 * attachment held forty idle megabytes, because nothing dropped an expired
 * draft until the NEXT one was minted. Sixteen is chosen against the two
 * numbers already here — `MAX_DM_MEDIA_BYTES` (1 MiB) bounds one attachment,
 * so this bounds the DM drafts at roughly sixteen megabytes — and against how
 * the feature is used: drafts are confirmed one at a time by a person, and
 * sixteen unconfirmed ones inside a single thirty-minute window is already
 * far past any real flow. It is counted PER KIND (see `evictOverflow`).
 *
 * An evicted draft is indistinguishable from an expired one, which is the
 * point: the agent is told the same "unknown or expired" thing and makes a
 * fresh draft.
 */
const MAX_LIVE_DRAFTS = 16;

/** Drop what the TTL has already killed. Called everywhere the table is
 *  touched — minting used to be the only one, so a draft nobody confirmed
 *  stayed in memory until somebody happened to make another. */
function sweepExpired(drafts: Map<string, DraftEntry>, now: number): void {
  for (const [k, v] of drafts) if (now - v.at > DRAFT_TTL_MS) { dropReviewCopy(v); drafts.delete(k); }
}

/** Every kind, longest-first so `house-entry` is not read as a kind called
 *  `house`. One list, because a token's kind is decided in exactly one place. */
const DRAFT_KINDS: readonly DraftKind[] = ['house-entry', 'message', 'invite', 'reply', 'post'];
const kindOf = (token: string): DraftKind | null =>
  DRAFT_KINDS.find((kind) => token.startsWith(`${kind}-`)) ?? null;

/**
 * PER KIND, and that is the whole point.
 *
 * A global cap made ordinary drafting destroy other doors' parked work:
 * mint an `invite-43`, make sixteen `popclaw_draft_message` calls, and the
 * verification you were waiting to confirm has been evicted — "unknown or
 * expired confirm_token", with nothing to say why. A house-entry token mints
 * a seven-day website login key and would vanish the same way. Those doors
 * carry no attachment and cost nothing to keep, so they must not be paying
 * for the memory bound that DM drafts need.
 *
 * Counting per kind keeps the bound that matters exactly where it was: only
 * `message` drafts hold bytes, so the table is still capped at roughly
 * sixteen megabytes.
 *
 * Oldest first, which is insertion order: ids are sequential and `at` only
 * ever moves forward.
 */
function evictOverflow(drafts: Map<string, DraftEntry>, kind: DraftKind | null): void {
  if (kind === null) return;
  const mine = [...drafts.keys()].filter((token) => kindOf(token) === kind);
  for (const token of mine.slice(0, Math.max(0, mine.length - MAX_LIVE_DRAFTS))) {
    dropReviewCopy(drafts.get(token));
    drafts.delete(token);
  }
}

export function makeDraftToken(kind: DraftKind): string {
  const drafts = draftStore();
  sweepExpired(drafts, Date.now());
  return `${kind}-${++draftSeq().n}`;
}
/** Drop a disposable closure, retaining its persisted review copy. */
export function forgetDraft(token: string): void { draftStore().delete(token); }

/**
 * Park a draft. `snapshot` is what the owner will be asked to approve, and it
 * is optional only because the two narrow doors that do NOT go through
 * `popclaw_send_draft` (`popclaw_invite`, `popclaw_house_entry`) have their own
 * confirm tools and nothing to show. A send-kind draft parked without one is
 * unavailable — `peekDraftSnapshot` returns null and nothing is sent.
 */
export function putDraft(
  token: string,
  fn: () => Promise<{ text: string }>,
  snapshot?: DraftSnapshot,
): void {
  const drafts = draftStore();
  const now = Date.now();
  drafts.set(token, {
    fn: captureActionContext(fn),
    at: now,
    snapshot: snapshot ? freezeSnapshot(snapshot) : null,
    contentDigest: snapshot ? contentDigest(snapshot) : undefined,
  });
  sweepExpired(drafts, now);
  evictOverflow(drafts, kindOf(token));
}

/**
 * Record the one preview delivery this draft attempted, and what is known
 * about it. Called right after `deliverDraftPreview` resolves, because the
 * outcome does not exist until then; the rest of the snapshot was sealed at
 * `putDraft`. A no-op for a draft that is already gone.
 */
export function noteDraftPreview(
  token: string,
  preview: string,
  status: PreviewDeliveryStatus,
): void {
  const entry = draftStore().get(token);
  if (!entry?.snapshot) return;
  entry.snapshot = freezeSnapshot({
    ...entry.snapshot,
    preview: { digest: draftDigest(preview), status, at: Date.now() },
  });
}

/**
 * Record that the draft tool handed the host this draft's COMPLETE text as its
 * own tool result. Called where that text is emitted and nowhere else.
 *
 * NEVER FROM A PARAMETER. A model that could pass `previewed: true` alongside
 * a draft_id would be back to confirming its own draft, which is the defect
 * this whole lane closed; the record exists only because the plugin itself
 * produced the bytes.
 *
 * AND THE TEXT IS CHECKED, NOT TAKEN ON TRUST. A result that talks about the
 * draft rather than carrying it records nothing, so a tool that summarised its
 * own letter cannot register a showing it did not make. A no-op for a draft
 * that is already gone, or one parked without a snapshot.
 *
 * A DRAFT WITH NO WORDS IN IT RECORDS NOTHING, because `includes('')` is true
 * of every string and would hand an attachment-only draft a showing for free —
 * a check that cannot fail is not a check. It costs that draft nothing: with
 * no text there is none to be too long for, and its prompt says "no text,
 * attachment only" and fits.
 */
export function noteDraftToolOutput(token: string, output: string): void {
  const entry = draftStore().get(token);
  if (!entry?.snapshot) return;
  if (entry.snapshot.body.trim() === '') return;
  if (!output.includes(entry.snapshot.body)) return;
  entry.snapshot = freezeSnapshot({
    ...entry.snapshot,
    output: { digest: draftDigest(output), at: Date.now() },
  });
}

/**
 * Record the review-copy decision made at mint (`draft-review.ts`). Once per
 * draft: a second call is ignored, so nothing later can flip the decision the
 * tool result was written under. A no-op for a draft that is already gone.
 */
export function noteDraftReview(token: string, review: DraftReviewSnapshot): void {
  const entry = draftStore().get(token);
  if (!entry?.snapshot || entry.snapshot.review) return;
  entry.snapshot = freezeSnapshot({ ...entry.snapshot, review });
}

/**
 * Whether the review copy the owner was pointed at is still exactly the bytes
 * that were written: `ok` when it is, `none` for a draft that has no copy,
 * `changed` when it was edited or is gone. Reads the file's hash, never its
 * content: what is sent always comes from the snapshot.
 */
export function verifyDraftReview(token: string): 'ok' | 'none' | 'changed' {
  const review = peekDraftSnapshot(token)?.review;
  if (!review?.needed) return 'none';
  const files = reviewHolder().files;
  // An optional copy that could not be written leaves the complete tool-result
  // review available. A copy that existed and is now unverifiable must refuse.
  if (!review.file) return 'none';
  if (!files) return 'changed';
  return files.sha256(review.file.path) === review.file.sha256 ? 'ok' : 'changed';
}

/**
 * Read a live draft's snapshot without spending it.
 *
 * Inspection never consumes a draft. Expired entries are swept; missing or
 * parked-without-snapshot entries answer null.
 */
export function peekDraftSnapshot(token: string): DraftSnapshot | null {
  const drafts = draftStore();
  sweepExpired(drafts, Date.now());
  return drafts.get(token)?.snapshot ?? null;
}

/**
 * Take and consume (confirmation gate: token is single-use). Missing, expired,
 * or minted by a tool the caller may not execute for → null. A token of the
 * wrong kind is left where it is: refusing it must not spend someone else's.
 */
export function takeDraft(
  token: string,
  kinds: readonly DraftKind[],
): (() => Promise<{ text: string }>) | null {
  const drafts = draftStore();
  if (!kinds.some((kind) => token.startsWith(`${kind}-`))) return null;
  sweepExpired(drafts, Date.now());
  const entry = drafts.get(token);
  if (!entry) return null;
  dropReviewCopy(entry);
  drafts.delete(token);
  return entry.fn;
}

/** The error must let the agent find its own way out, instead of it having to
 *  guess a superstition like "must call in quick succession". Through the
 *  lexicon since 2026-09-22, in the owner's language like every other sentence
 *  a tool returns — `invite.tool.expiredToken` is the same shape one door
 *  over. The English wording is byte-identical to the hard-coded version it
 *  replaced. */
export function expiredDraftText(token: string, lang: Lang = ownerLang()): string {
  return renderCopy(lang, 'draft.expiredToken', { token });
}
