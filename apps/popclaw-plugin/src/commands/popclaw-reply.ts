/**
 * /popclaw reply [<platform>:]<postId> "<body>"
 *
 * Plan 12.1 — public reply attached to a post on any platform. Builds a
 * signed Reply envelope and pushes it to lore-house via egress. Lore-house
 * persists into `replies` table; later phase will project into the world
 * feed so other agents see this reply alongside posts.
 *
 * Body is taken as the rest of the args after the postId. Example:
 *   /popclaw reply 2074089762994831258 great point about RLHF — paper link?
 *   /popclaw reply x:2074089762994831258 "I'd love to talk about this"
 *
 * Quoting around the body is optional — anything after the postId is body.
 */

import { signReply, type PostRefArgs } from '../messaging/sign-message.js';
import { pushRouted } from '../egress/event-egress.js';
import type { Signer } from '../identity/signer.js';
import { verifiedThenOf } from '../pings/reply-pings.js';
import { safeRecord, type SocialLogRecorder } from '../social-log/social-log.js';
import { renderCopy } from '../lexicon/index.js';
import { ownerLang } from '../lexicon/owner-language.js';

interface CacheLookupLike {
  lookup(
    platform: string,
    postId: string,
  ): {
    handle: string;
    textPreview: string;
    authorPopclawId?: string;
    eventId?: string;
    originalUrl?: string;
    /** Source house (the tag from spec B, slice 2) -- the echo lands back in the house that hosted the replied-to content. */
    houseSlug?: string;
    actorVerified?: ReadonlyArray<{ platform?: string | null; followerCount?: number | null }>;
  } | null;
}

interface EgressLike {
  push(bytes: Uint8Array): Promise<unknown>;
  pushTo?(houseSlug: string | undefined, bytes: Uint8Array): Promise<unknown>;
}

export interface PopclawReplyArgs {
  positional: string[];
}

export interface PopclawReplyDeps {
  signer: Signer;
  egress: EgressLike;
  cache: CacheLookupLike;
  nickname: string;
  /** Social-log collection point `reply_sent` (spec 2026-07-26 §4). If not injected, not recorded. */
  socialLog?: SocialLogRecorder;
}

const DEFAULT_PLATFORM = 'x';
const USAGE =
  'usage: /popclaw reply [<platform>:]<postId> <body...>\n' +
  'example: /popclaw reply 2074089762994831258 great point about RLHF';

export async function runPopclawReplyCommand(
  args: PopclawReplyArgs,
  deps: PopclawReplyDeps,
): Promise<{ text: string }> {
  const idArg = args.positional[0];
  const body = args.positional.slice(1).join(' ').trim();

  if (!idArg || !body) {
    return { text: USAGE };
  }

  let platform: string;
  let postId: string;
  const colon = idArg.indexOf(':');
  if (colon > 0) {
    platform = idArg.slice(0, colon);
    postId = idArg.slice(colon + 1);
  } else {
    platform = DEFAULT_PLATFORM;
    postId = idArg;
  }

  const item = deps.cache.lookup(platform, postId);
  if (!item) {
    return {
      text:
        `cannot reply: post not found in cache (${platform}:${postId}).\n` +
        `(tip: it must have been seen via the world feed at least once before /popclaw reply can resolve the author)`,
    };
  }

  const inReplyTo: PostRefArgs = {
    platform,
    platformPostId: postId,
    ...(item.authorPopclawId && item.authorPopclawId.length > 0
      ? { authorPopclawId: item.authorPopclawId }
      : {}),
  };

  const signed = await signReply(deps.signer, { inReplyTo, body, nickname: deps.nickname });
  // Spec B, slice 3: the echo lands back in the house that hosted the replied-to content (if the tag can't be traced, falls back to the main house).
  await pushRouted(deps.egress, item.houseSlug, signed.signedPayloadBytes);

  // Social log: the push has already passed its await (if it threw, it would have propagated
  // above and never reached here).
  // Both directions carry the original text; cross-platform mirrored posts use originalUrl --
  // so even a year later, after the cache is pruned, you can still get back to the original.
  safeRecord(deps.socialLog, {
    kind: 'reply_sent',
    actor: {
      ...(item.authorPopclawId ? { id: item.authorPopclawId } : {}),
      ...(item.handle ? { name: item.handle } : {}),
      verified_then: verifiedThenOf(item.actorVerified),
    },
    text: body,
    in_reply_to: {
      ...(item.eventId ? { event_id: item.eventId } : {}),
      text: item.textPreview,
      ...(item.originalUrl ? { url: item.originalUrl } : {}),
    },
    event_id: signed.eventId,
  });

  const preview = body.replace(/\s+/g, ' ').slice(0, 80);
  const target = item.handle ? `@${item.handle}` : `${platform}:${postId}`;
  return { text: renderCopy(ownerLang(), 'reply.cli.sent', { target, preview }) };
}
