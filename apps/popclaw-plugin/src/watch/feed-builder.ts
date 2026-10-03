/**
 * ADR-0025 (Task 4.2): buildMirrorPost builds a Post+Origin envelope body
 * for the ranger watch path. The ranger scrapes external platforms and wraps
 * each scraped post as a Post carrying an Origin (provenance).
 *
 * Respects Plan 5 Invariant #1 (elide proto3-default scalars / enum-zero /
 * empty-repeated so prost and pbjs agree on canonical bytes).
 *
 * block_type=0 (TEXT) and MediaAttachment.kind=0 (IMAGE) are proto3
 * defaults; do NOT emit them explicitly.
 *
 * CRITICAL: origin.platform must NOT be "popclaw" and origin.post_id /
 * origin.url must be non-empty — lore-house's write-side guard (ADR-0025 I-1)
 * rejects envelopes that violate this invariant.
 */

import type { ScrapedMedia } from '../scraper/platform-scraper.js';

export interface MediaInput {
  /** kind enum: 0=IMAGE, 1=VIDEO, 2=GIF */
  kind: 0 | 1 | 2;
  url: string;
  width?: number;
  height?: number;
}

/** ScrapedMedia kind string → MediaAttachment kind enum (0=IMAGE, 1=VIDEO, 2=GIF).
 *  Shared by every scraped-post → PostPayload path (quest scrape-content handler,
 *  ranger watch loop) so the mapping can never drift between them. */
export function scrapedMediaToInput(m: ScrapedMedia): MediaInput {
  const kind = m.kind === 'video' ? 1 : m.kind === 'gif' ? 2 : 0;
  return {
    kind,
    url: m.url,
    ...(m.width !== undefined ? { width: m.width } : {}),
    ...(m.height !== undefined ? { height: m.height } : {}),
  };
}

// ---------------------------------------------------------------------------
// ADR-0025: Post+Origin builder for the ranger watch path (Task 4.2)
// ---------------------------------------------------------------------------

export interface MirrorPostInput {
  /** Source platform ("x", "instagram", "tiktok", "youtube"). MUST NOT be "popclaw". */
  platform: string;
  /** Platform-native stable post id (dedup anchor). MUST be non-empty. */
  platformPostId: string;
  /** Source post's publish time in unix seconds. 0 = elided on wire (Invariant #1). */
  platformPostCreatedAt: number;
  /** Canonical source URL. MUST be non-empty. */
  originalUrl: string;
  /** Post body text. "" = no text block emitted (Invariant #1). */
  text: string;
  /** Media attachments. */
  media: MediaInput[];
  /** Optional block type override. Defaults to TEXT(0), which is elided. */
  blockType?: number;
  /**
   * Platform-native parent post id when this scraped post is a reply;
   * "" or undefined = not a reply → origin.reply_to_id omitted on wire.
   */
  inReplyToId?: string;
}

/** The envelope body returned by buildMirrorPost — use as `post` in the EventEnvelope. */
export interface MirrorPostResult {
  /** The `Post` message body for the EventEnvelope `body.post` oneof field. */
  post: Record<string, unknown>;
}

/**
 * Build a `Post` envelope body carrying an `Origin` (ADR-0025).
 *
 * Invariant #1 compliance:
 *   - blocks omitted when text is empty
 *   - media omitted when array is empty
 *   - MediaAttachment.kind=IMAGE (0) elided
 *   - ContentBlock.blockType=TEXT (0) elided
 *   - Origin.created_at=0 elided
 *   - Origin.reply_to_id="" elided
 *
 * Returns the `post` field value to embed directly in the EventEnvelope.
 *
 * IMPORTANT: callers MUST validate that platform !== "popclaw" and that
 * platformPostId and originalUrl are non-empty before calling this function.
 * If validation fails, skip/log and do NOT call this function — emitting a
 * malformed Origin would be rejected by lore-house's write-side guard.
 */
export function buildMirrorPost(input: MirrorPostInput): MirrorPostResult {
  // Build content blocks.
  const blocks: Array<Record<string, unknown>> = [];
  if (input.text !== '') {
    const block: Record<string, unknown> = { content: input.text };
    if (input.blockType !== undefined && input.blockType !== 0) {
      block.blockType = input.blockType;
    }
    blocks.push(block);
  }

  // Build media attachments.
  const media: Array<Record<string, unknown>> = input.media.map((m) => {
    const entry: Record<string, unknown> = { url: m.url };
    if (m.kind !== 0) entry.kind = m.kind;
    if (m.width !== undefined) entry.width = m.width;
    if (m.height !== undefined) entry.height = m.height;
    return entry;
  });

  // Build Origin (Invariant #1: elide proto3 defaults).
  const origin: Record<string, unknown> = {
    platform: input.platform,
    postId: input.platformPostId,
    url: input.originalUrl,
  };
  // created_at=0 is proto3 default for int64 — elide it.
  if (input.platformPostCreatedAt !== 0) {
    origin.createdAt = input.platformPostCreatedAt;
  }
  // reply_to_id="" is proto3 default — elide it.
  if (input.inReplyToId) {
    origin.replyToId = input.inReplyToId;
  }

  // Build Post body (elide empty blocks/media per Invariant #1).
  const post: Record<string, unknown> = { origin };
  if (blocks.length > 0) post.blocks = blocks;
  if (media.length > 0) post.media = media;

  return { post };
}
