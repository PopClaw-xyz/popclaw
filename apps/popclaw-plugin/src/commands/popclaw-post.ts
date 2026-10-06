import { rethrowActionCancellation } from '../runtime/house-lifecycle/action-context.js';
/**
 * /popclaw post [<body>] [--reply <event_id> | --quote <event_id>] <body>
 *
 * popclaw-native voicing command. Three modes:
 *   - root:  /popclaw post <body>
 *   - reply: /popclaw post --reply <event_id> <body>   (pure reply, default hidden from feed)
 *   - quote: /popclaw post --quote <event_id> <body>   (quoted, shown in feed with original card)
 *
 * Signs a PostPayload envelope via signPost and pushes to lore-house. Returns
 * a multi-line reply summary including event_id + popclaw.me URL.
 */
import { signPost } from '../messaging/sign-post.js';
import type { Signer } from '../identity/signer.js';
import { pushRouted, type EventEgress } from '../egress/event-egress.js';
import type { WorldFeedReader } from '../ingress/world-feed-cache.js';
import { safeRecord, type SocialLogRecorder } from '../social-log/social-log.js';
import { renderCopy } from '../lexicon/index.js';
import { ownerLang, failureText } from '../lexicon/owner-language.js';

export interface PopclawPostArgs {
  readonly positional: string[];
  readonly flags: Record<string, string>;
}

export interface PopclawPostDeps {
  signer: Signer;
  egress: EventEgress;
  nickname: string;
  cache: WorldFeedReader;
  /** Base URL of the popclaw.me web app for clickable post links. MVP local
   *  default http://localhost:3000; production https://popclaw.me. Resolved at
   *  bootstrap (env POPCLAW_WEB_BASE_URL → fallback). */
  webBaseUrl: string;
  /** Social-log capture point for `post_sent` / `reply_sent` (spec 2026-07-26 §4). Not recorded if not injected. */
  socialLog?: SocialLogRecorder;
}

/**
 * Resolve a --reply / --quote flag value: full 64-hex passes through;
 * short prefix (≥6 hex) gets looked up in the local worldFeedCache and
 * expanded to its unique full event_id; errors out on too-short / non-hex /
 * no-match / ambiguous-match cases.
 */
function resolveEventIdPrefix(
  flagName: '--reply' | '--quote',
  rawValue: string,
  cache: WorldFeedReader,
): { ok: true; eventId: string } | { ok: false; text: string } {
  // Full 64-hex: pass through unchanged
  if (/^[0-9a-f]{64}$/.test(rawValue)) {
    return { ok: true, eventId: rawValue };
  }
  // Must be all hex
  if (!/^[0-9a-f]+$/.test(rawValue)) {
    return {
      ok: false,
      text: renderCopy(ownerLang(), 'post.cli.notHex', { flag: flagName, got: rawValue.slice(0, 24) }),
    };
  }
  if (rawValue.length < 6) {
    return {
      ok: false,
      text: renderCopy(ownerLang(), 'post.cli.prefixTooShort', { flag: flagName, got: rawValue }),
    };
  }
  if (rawValue.length > 64) {
    return {
      ok: false,
      text: renderCopy(ownerLang(), 'post.cli.tooLong', { flag: flagName, length: String(rawValue.length) }),
    };
  }
  // 6-63 hex chars: prefix lookup
  const { full, ambiguous } = cache.findFullEventId(rawValue);
  if (full) return { ok: true, eventId: full };
  if (ambiguous.length > 0) {
    const shortList = ambiguous.map((id) => `${id.slice(0, 10)}...`).join(', ');
    return {
      ok: false,
      text: renderCopy(ownerLang(), 'post.cli.prefixAmbiguous', { flag: flagName, candidates: shortList }),
    };
  }
  return {
    ok: false,
    text: renderCopy(ownerLang(), 'post.cli.prefixNoMatch', { flag: flagName }),
  };
}

/**
 * The social log's `in_reply_to` — a self-sufficiency hard requirement: the
 * **original text** of the replied-to/quoted post must be persisted alongside it.
 * If found in the cache, include the original text; if not, keep only the
 * event_id (better to leave it missing than to fake having it).
 */
function inReplyToOf(
  deps: PopclawPostDeps,
  eventId: string,
): { event_id: string; text?: string; url?: string } {
  const found = deps.cache.findByEventIdPrefix(eventId).item;
  if (!found) return { event_id: eventId };
  return {
    event_id: eventId,
    ...(found.textPreview ? { text: found.textPreview } : {}),
    ...(found.originalUrl ? { url: found.originalUrl } : {}),
  };
}

export async function runPopclawPostCommand(
  args: PopclawPostArgs,
  deps: PopclawPostDeps,
): Promise<{ text: string }> {
  // Spec §6.3: body is sent VERBATIM to signPost (signed canonical bytes
  // preserve the user's exact input). trim() is only used to decide whether
  // the body is empty for the USAGE check.
  const body = args.positional.join(' ');

  if (!body.trim()) return { text: renderCopy(ownerLang(), 'post.cli.usage') };

  let replyTo: string | undefined;
  let quoteOf: string | undefined;

  if (args.flags['reply']) {
    const r = resolveEventIdPrefix('--reply', args.flags['reply'], deps.cache);
    if (!r.ok) return { text: r.text };
    replyTo = r.eventId;
  }
  if (args.flags['quote']) {
    const r = resolveEventIdPrefix('--quote', args.flags['quote'], deps.cache);
    if (!r.ok) return { text: r.text };
    quoteOf = r.eventId;
  }

  if (replyTo && quoteOf) {
    return { text: renderCopy(ownerLang(), 'post.cli.replyQuoteExclusive') };
  }

  let signed;
  try {
    signed = await signPost(deps.signer, {
      body,
      replyTo,
      quoteOf,
      nickname: deps.nickname,
    });
  } catch (err) {
    rethrowActionCancellation(err);
    return { text: failureText('/popclaw post', err) };
  }

  // Spec B slice 3: original posts go to the primary house; --reply/--quote
  // land on the source house of the replied-to/quoted post
  // (untraceable tag -> primary house).
  const targetId = replyTo ?? quoteOf;
  const targetHouse = targetId
    ? deps.cache.findByEventIdPrefix(targetId).item?.houseSlug
    : undefined;

  let pushResult;
  try {
    pushResult = await pushRouted(deps.egress, targetHouse, signed.signedPayloadBytes);
  } catch (err) {
    rethrowActionCancellation(err);
    return { text: failureText('/popclaw post', err) };
  }

  if (pushResult.status >= 500) {
    return { text: renderCopy(ownerLang(), 'post.cli.serverError', { status: String(pushResult.status) }) };
  }
  if (pushResult.status < 200 || pushResult.status >= 300) {
    return { text: renderCopy(ownerLang(), 'post.cli.rejected', { status: String(pushResult.status) }) };
  }

  // Social log: the only success exit — only once the lore-house has
  // accepted with a 2xx does "I said this" count. All failure branches
  // return early above — a draft, a signing failure, or a rejected push are
  // none of them actions.
  // A quote-repost counts as `post_sent`: in the feed it's my own utterance,
  // whereas --reply is joining someone else's thread.
  safeRecord(deps.socialLog, {
    kind: replyTo ? 'reply_sent' : 'post_sent',
    // Record whichever house it was pushed to (the same value pushRouted used
    // above); the primary house is omitted.
    ...(targetHouse ? { house_slug: targetHouse } : {}),
    text: body,
    event_id: signed.eventId,
    url: `${deps.webBaseUrl}/post/${signed.eventId.slice(0, 10)}`,
    ...(replyTo || quoteOf ? { in_reply_to: inReplyToOf(deps, replyTo ?? quoteOf!) } : {}),
  });

  return { text: formatSuccess(signed.eventId, body, deps.webBaseUrl, replyTo, quoteOf) };
}

function formatSuccess(
  eventId: string,
  body: string,
  webBaseUrl: string,
  replyTo?: string,
  quoteOf?: string,
): string {
  const preview = body.replace(/\s+/g, ' ').slice(0, 80);
  // 10-hex short id in both headline and URL: addresses ~1T namespace
  // (collision negligible at MVP scale), and lore-house resolves >=6-hex
  // prefixes (GET /v1/thread/<6+hex> -> 200). The popclaw.me web thread viewer
  // also passes the id straight through to lore-house, so the short form is the
  // canonical clickable link. Host is configurable (webBaseUrl): localhost:3000
  // for MVP, https://popclaw.me at deploy. See memory
  // popclaw-web-base-url-localhost-mvp.
  const short = eventId.slice(0, 10);
  const url = `${webBaseUrl}/post/${short}`;

  if (quoteOf) {
    return [
      renderCopy(ownerLang(), 'post.cli.quoted', { short, target: quoteOf.slice(0, 10) }),
      `   "${preview}"`,
      `   ${url}`,
      // Spec §8.1 also shows a "↳ <quoted preview>" line. Omitted here because
      // runPopclawPostCommand has no cache lookup; the quoted preview is
      // populated by lore-house projection (Task 4) and surfaced in feed
      // rendering (Task 11). See popclaw-feed.ts for that path.
    ].join('\n');
  }
  if (replyTo) {
    return [
      renderCopy(ownerLang(), 'post.cli.replied', { short, target: replyTo.slice(0, 10) }),
      `   "${preview}"`,
      `   ${url}`,
      `   ${renderCopy(ownerLang(), 'post.replyNotInFeed')}`,
    ].join('\n');
  }
  return [
    renderCopy(ownerLang(), 'post.cli.posted', { short }),
    `   "${preview}"`,
    `   ${url}`,
  ].join('\n');
}
