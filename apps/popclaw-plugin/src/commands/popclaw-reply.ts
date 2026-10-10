/**
 * /popclaw reply [<platform>:]<postId> "<body>"
 *
 * Public reply attached to a post. Builds a signed Reply envelope and
 * pushes it to the content’s house via egress.
 *
 * Body is taken as the rest of the args after the postId. Example:
 *   /popclaw reply 2074089762994831258 great point about RLHF — paper link?
 *   /popclaw reply x:2074089762994831258 "I'd love to talk about this"
 *
 * Quoting around the body is optional — anything after the postId is body.
 */

import { signReply, type PostRefArgs } from '../messaging/sign-message.js';
import { pushRejection, pushRouted } from '../egress/event-egress.js';
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
): Promise<{ text: string; isError?: true }> {
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
  const receipt = await pushRouted(deps.egress, item.houseSlug, signed.signedPayloadBytes);
  const rejection = pushRejection(receipt);
  if (rejection) {
    const lang = ownerLang();
    return { isError: true, text: renderCopy(lang, 'reply.cli.notAccepted', {
      status: String(rejection.status),
      why: rejection.detail ? renderCopy(lang, 'reply.cli.notAccepted.reason', { detail: rejection.detail }) : '',
    }) };
  }

  // Do not record a reply that the house refused.
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
