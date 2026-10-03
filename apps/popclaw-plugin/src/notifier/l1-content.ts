/** L1 owner-facing content: text, drill-down invitations and ordered media references. */
import { readableUrl } from '../lshow/sources/web-fallback.js';
import type { NotificationItem } from './types.js';
import { displayPerson } from '../identity/person-resolver.js';
import { attachmentKind } from '../messaging/dm-media.js';
import { imageUrlsIn, splitHomeletterHeader } from '../messaging/letter-text.js';
import { renderCopy, type Lang } from '../lexicon/index.js';
import { ownerLang } from '../lexicon/owner-language.js';

/**
 * The two lines for ADR-0040 act two (passed) / act three (rejected).
 *
 * Act two reports the exact figure privately — saying "30,000 people follow
 * you right now" in a DM carries no social risk, whereas the public namecard
 * uses the rounded "origin narrative" figure instead (ADR-0040's three
 * conversions, executed by the web thread). 0 followers means the sentence
 * omits the number entirely.
 * Act three gives the reason plus an immediately actionable next step: a
 * rejection doesn't enter rate-limiting — bring evidence and try again
 * (ADR-0034).
 */
function renderVerifyOutcome(item: NotificationItem, lang: Lang): string {
  const p = item.payload as {
    platform?: string;
    handle?: string;
    followerCount?: number;
    profileUrl?: string;
    reason?: string;
  };
  const who = `${p.platform || renderCopy(lang, 'notify.verifyOutcome.platformFallback')}:${p.handle || ''}`;
  if (item.kind === 'ranger_verify_fail') {
    const why = p.reason ? renderCopy(lang, 'notify.verifyFail.reason', { reason: p.reason }) : '';
    return renderCopy(lang, 'notify.verifyFail.body', { who, why });
  }
  const followers = Number(p.followerCount ?? 0);
  const snapshot =
    followers > 0
      ? renderCopy(lang, 'notify.verifyDone.snapshotWithFollowers', { followers: String(followers) })
      : renderCopy(lang, 'notify.verifyDone.snapshotBare');
  // Shown to the owner to read and share, so it is decoded (#282).
  const share = p.profileUrl ? renderCopy(lang, 'notify.verifyDone.share', { profileUrl: readableUrl(p.profileUrl) }) : '';
  return renderCopy(lang, 'notify.verifyDone.main', { who, snapshot, share });
}

/**
 * The bond-context trailer line (`payload.bondLine`, see bonds/bond-context.ts).
 *
 * Like `fromName`, this is baked into the payload **at enqueue time**: looking
 * up the bond book needs a db handle, while `renderL1` is a pure function
 * (the DROPPED log for a failed delivery in `notifyOwnerNow` also calls it);
 * baking it into the payload also incidentally preserves it across requeues —
 * a requeue is `{...item.payload, attempts}`.
 * Empty string / absent = this person has nothing worth saying, so **the
 * whole line is omitted** (interruption budget — don't manufacture filler for
 * a stranger).
 */
function bondTail(p: { bondLine?: unknown }): string {
  return typeof p.bondLine === 'string' && p.bondLine ? `\n${p.bondLine}` : '';
}

/** The quoted "original words" being replied to are only a locating hint;
 *  pointing back to the inbox is pointless here, so just truncate with an
 *  ellipsis. */
const TARGET_PREVIEW_CHARS = 40;

/** Only add a tail when it overflows — an unclipped body must stay byte-for-byte
 *  the same (the look of the old notifications). */
function preview(text: string, max: number, tail: string): string {
  return text.length <= max ? text : `${text.slice(0, max)}${tail}`;
}

/**
 * The body as the owner sees it — strips the house's machine-readable header
 * line (`[homeletter/v1] kind=… place=… view=…`).
 *
 * Real-machine incident, 2026-07-31: a postcard arrived, and the notification's
 * first line was that header string — the owner saw machine-speak; worse, it
 * ate up nearly a hundred characters of the preview budget, pushing the
 * postcard's image link past the truncation line. guide §3 has the agent
 * strip it, but the L1 direct-write channel **has no agent in the turn** (see
 * `dmInvite`), so this has to strip it itself.
 */
function ownerVisibleBody(raw: unknown): string {
  return splitHomeletterHeader(typeof raw === 'string' ? raw : '').rest;
}

/**
 * Render one L1 item into a single owner-facing line.
 *
 * `lang` defaults to the process-wide owner-language register
 * (`ownerLang()`) — this is the one surface (S6) that writes straight to the
 * owner's phone with no agent in the loop, so it has to pre-render in the
 * right language itself rather than relying on the agent to translate.
 */
export function renderL1(item: NotificationItem, lang: Lang = ownerLang()): string {
  const p = item.payload as {
    fromPopclawId?: string;
    fromName?: string;
    body?: string;
    targetPreview?: string;
    mediaPath?: string;
    bondLine?: string;
    messageId?: number | string;
  };
  // The owner-facing name always goes through displayPerson: `nickname#sigil`,
  // or just `#sigil` when the roster has no match. A real-machine screenshot
  // showing `📨 @Demo1234 sent you a DM` was this code's previous raw id
  // prefix — those 8 characters are pure noise to the owner. The name is
  // resolved from local sources at **enqueue time** and stuffed into
  // payload.fromName (see the inbound loop in index.ts); this render step
  // never touches the network.
  const who = displayPerson(p.fromPopclawId ?? '', p.fromName);
  const body = preview(ownerVisibleBody(p.body), BODY_MAX, renderCopy(lang, 'notify.bodyTruncated'));
  // The first reply (ADR-0012 amendment 2026-07-25): one line of fact. The
  // drill-down invitation is appended uniformly at the end by
  // renderL1Batch; the unread cursor is not cleared here (reply_pings.read_at
  // only advances via popclaw_show_pings).
  if (item.kind === 'reply') {
    const target = preview(p.targetPreview ?? '', TARGET_PREVIEW_CHARS, '…');
    const line = target
      ? renderCopy(lang, 'notify.reply.withTarget', { who, target, body })
      : renderCopy(lang, 'notify.reply.noTarget', { who, body });
    return `${line}${bondTail(p)}`;
  }
  // ADR-0040 act two/act three: the two outcomes of verification, each
  // announced once. Without these two branches, a passed verification would
  // get rendered as "sent you a DM" — that's exactly how mute it was on a
  // real machine.
  if (item.kind === 'ranger_verify_done' || item.kind === 'ranger_verify_fail') {
    return renderVerifyOutcome(item, lang);
  }
  // The image itself gets pushed to the owner's IM along with mediaUrls (see
  // notifyOwnerNow); this text line only flags its presence, so the owner
  // isn't left completely unaware the message had an image when the upload
  // fails.
  // The `@` was removed: the name already carries the `#sigil` identity
  // marker, so `@nickname#sigil` would be stacking two marker systems.
  // Image-only, no text (2026-07-29): the whole sentence is swapped out
  // rather than leaving a "sent you a DM:" line with nothing after the colon.
  // This line is always non-empty — `notifyOwnerNow` uses it as the host
  // payload's text, and nobody guarantees the host accepts an empty text.
  // The noun follows the attachment kind — once voice/text were opened up,
  // saying "sent you an image" for a voice clip would be a plain wrong statement.
  const kind = p.mediaPath ? attachmentKind(p.mediaPath) : 'image';
  // The inbox row id (real host 2026-09-25): the owner read the notice, then
  // asked for "the message EngA sent at 22:57" and the agent asked back for an
  // id the owner had never been shown. It is the same `message_id`
  // popclaw_show_inbox returns. Items queued by an older build carry no id and
  // render exactly as they did.
  const idTag = typeof p.messageId === 'number' || (typeof p.messageId === 'string' && p.messageId !== '')
    ? renderCopy(lang, 'notify.dm.idTag', { id: String(p.messageId) })
    : '';
  if (!body && p.mediaPath) {
    const what = renderCopy(lang, `media.noun.${kind}`);
    return `${renderCopy(lang, 'notify.dm.mediaOnly', { who, what, idTag })}${bondTail(p)}`;
  }
  const mediaTail = p.mediaPath
    ? renderCopy(lang, 'notify.dm.mediaTail', { what: renderCopy(lang, `media.tail.${kind}`) })
    : '';
  return `${renderCopy(lang, 'notify.dm.withBody', { who, body, idTag })}${mediaTail}${bondTail(p)}`;
}

/**
 * The max number of images a single message can carry onto the wire. One
 * postcard = one image, one group photo = one image; the cap only exists to
 * stop a message stuffed with 30 image links from flooding the owner's phone.
 */
const MAX_BODY_IMAGES_PER_ITEM = 2;

/**
 * All images carried along with this batch of L1 items (deduplicated,
 * order preserved). An empty array if there are none.
 *
 * Two sources:
 * - `mediaPath` — a local image decrypted from an encrypted attachment and
 *   saved to disk (#231).
 * - **An image link in the body** — this is how a house-sent postcard works:
 *   the image is a `https://…/x.jpg` line inside the message, with no
 *   attachment. Real-machine incident 2026-07-31 (host-c): the body got
 *   truncated, and that line — along with the image — got cut off with it;
 *   the owner's first glance saw only half a sentence and had to ask "full
 *   text" again before seeing the image. The image is the postcard's
 *   **entire** content, and shouldn't be left past the truncation line to
 *   chance.
 */
export function mediaUrlsOf(items: readonly NotificationItem[]): string[] {
  const seen = new Set<string>();
  for (const it of items) {
    const p = it.payload as { mediaPath?: string; body?: string };
    if (p.mediaPath) seen.add(p.mediaPath);
    for (const u of imageUrlsIn(ownerVisibleBody(p.body)).slice(0, MAX_BODY_IMAGES_PER_ITEM)) {
      seen.add(u);
    }
  }
  return [...seen];
}

/** The drill-down invitation: after a one-line fact, give the owner a way to
 *  go deeper — no numbering, no option cards. */
function pingsInvite(lang: Lang = ownerLang()): string {
  return renderCopy(lang, 'notify.pingsInvite');
}

/**
 * The DM drill-down invitation.
 *
 * Why DMs need one too (real-machine incident 2026-07-31): L1 notifications
 * go out through `sendDurableMessageBatch` as a **direct channel write** —
 * `no heartbeat, no agent turn`, so that `📨 …sent you a DM` line has never
 * once entered the agent's turn. When the owner asks "what did this DM say",
 * the agent can only answer "not sure what you mean" — not because it failed
 * to understand, but because the message was never in front of it at all.
 * And the body itself gets truncated to `BODY_MAX`, so even what's on screen
 * isn't complete. The full text has been sitting safely in the local `inbox`
 * table the whole time (`popclaw_show_inbox` can fetch it), but nobody ever
 * told the owner "you can ask for it" or told the agent "you should go get
 * it." This line reconnects that broken link.
 *
 * **Only appears when the body was actually truncated**: no truncation = the
 * full text is already visible, and inviting again would just be noise
 * (interruption budget).
 */
function dmInvite(lang: Lang = ownerLang()): string {
  return renderCopy(lang, 'notify.dmInvite');
}

/**
 * The display cap for the body in a notification — this line is a
 * **preview**, not the full text. The cap itself doesn't change (L1 lands on
 * the owner's IM, and a whole long letter there is noise); what changes is
 * "say so when you cut it": going over adds `notify.bodyTruncated` pointing
 * back to the inbox.
 *
 * Real-machine incident, 2026-07-31: an official reply of 424 characters was
 * silently cut to 140, cutting off exactly the three actionable things —
 * task name / timezone / turning off result delivery; both the owner and the
 * agent thought they were seeing the whole letter, so the agent mailed back a
 * question about something the letter had already answered clearly. The full
 * text was sitting fine in the local inbox the whole time.
 *
 * 140 → 256 (owner's call, 2026-07-31, second incident the same day): a
 * house-sent postcard's body runs ~200 characters, and the 140 cutoff landed
 * right before the image link. The image reliably goes out separately via
 * `mediaUrls` (see `mediaUrlsOf`); relaxing the character count to 256 lets a
 * whole short message get said in one go — it fits on one screen, but it's
 * still not a substitute for the full text.
 */
const BODY_MAX = 256;

/**
 * Assemble one complete L1 interruption before transport-specific media staging.
 * Language defaults are read by each renderer at its original call site; a batch
 * does not capture a language snapshot or retain content for a later retry.
 */
export function renderL1Batch(items: readonly NotificationItem[]): { text: string; mediaUrls: string[] } {
  const lines = items.map((item) => renderL1(item));
  if (items.some((item) => item.kind === 'reply')) lines.push(pingsInvite());
  // Only a DM whose body was clipped earns an invitation to retrieve the rest.
  const truncatedDm = (item: NotificationItem): boolean =>
    item.kind === 'dm' && ownerVisibleBody((item.payload as { body?: unknown }).body).length > BODY_MAX;
  if (items.some(truncatedDm)) lines.push(dmInvite());
  const mediaUrls = mediaUrlsOf(items);
  return { text: lines.join('\n'), mediaUrls };
}
