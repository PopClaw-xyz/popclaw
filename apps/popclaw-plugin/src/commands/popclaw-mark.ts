/**
 * /popclaw mark <id>     — mark an item from the world feed (ADR-0019)
 * /popclaw unmark <id>   — revoke a previous mark
 * /popclaw marks         — list locally-stored marks
 *
 * <id> can be:
 *   - A hex prefix (≥6 chars) matching a cached item's event_id
 *   - <platform>:<postId>  (e.g. x:1234567890 or youtube:abc)
 *   - A raw postId with no colon → defaults to platform=x
 */

import type { CachedFeedItem } from '../ingress/world-feed-cache.js';
import type { MarkResult, MarkableItem } from '../marks/mark-service.js';
import type { MarksStore } from '../marks/marks-store.js';
import { verifiedThenOf } from '../pings/reply-pings.js';
import { safeRecord, type SocialLogRecorder } from '../social-log/social-log.js';
import { displayPerson } from '../identity/person-resolver.js';
import type { NameChain } from '../identity/person-name.js';
import { renderCopy } from '../lexicon/index.js';
import { ownerLang } from '../lexicon/owner-language.js';

/**
 * A mirrored post's `@handle` (an account on X/IG/TikTok) vs. the name the
 * owner has given this person — **the owner wins**: once an alias / a
 * self-reported name exists, use `name#sigil` (the unique name chain). Keep
 * `@handle` only when neither exists (or the chain resolves to the handle
 * itself) — at that point it's the most informative field this person has.
 */
function markWho(
  who: { authorPopclawId: string; handle: string },
  nameOf?: NameChain,
): string {
  const chained = nameOf?.(who.authorPopclawId, who.handle) ?? '';
  if (chained && chained !== who.handle) return displayPerson(who.authorPopclawId, chained);
  return who.handle ? `@${who.handle}` : displayPerson(who.authorPopclawId, chained);
}

/** Structural interface so tests can inject a fake without importing MarkService directly. */
interface MarkServiceLike {
  mark(item: MarkableItem): Promise<MarkResult>;
  unmark(eventId: string, houseSlug?: string): Promise<MarkResult & { wasMarked: boolean }>;
}

const HEX_PREFIX = /^[0-9a-f]{6,64}$/;
const DEFAULT_PLATFORM = 'x';

interface CacheLike {
  lookup(platform: string, postId: string): CachedFeedItem | null;
  findByEventIdPrefix(prefix: string): { item: CachedFeedItem | null; ambiguous: string[] };
}

/** Exported for use in agent tools (Task 9). */
export function resolveMarkTarget(
  idArg: string,
  cache: CacheLike,
): { item: CachedFeedItem } | { error: string } {
  if (idArg.includes(':')) {
    // <platform>:<postId>
    const colon = idArg.indexOf(':');
    const platform = idArg.slice(0, colon);
    const postId = idArg.slice(colon + 1);
    const item = cache.lookup(platform, postId);
    if (!item) {
      return {
        error:
          `⚠️ not found in cache: ${platform}:${postId}\n` +
          `(tip: the item must have been seen via /popclaw feed at least once)`,
      };
    }
    if (!item.eventId) {
      return {
        error:
          `⚠️ item found but event_id is missing for ${platform}:${postId}\n` +
          `(tip: run /popclaw feed to refresh — items need a server-assigned event_id before they can be marked)`,
      };
    }
    return { item };
  }

  if (HEX_PREFIX.test(idArg)) {
    // Hex prefix — search by event_id
    const { item, ambiguous } = cache.findByEventIdPrefix(idArg);
    if (item) {
      if (!item.eventId) {
        return {
          error:
            `⚠️ item found but event_id is missing for prefix "${idArg}"\n` +
            `(tip: run /popclaw feed to refresh — items need a server-assigned event_id before they can be marked)`,
        };
      }
      return { item };
    }
    if (ambiguous.length > 0) {
      const preview = ambiguous
        .slice(0, 3)
        .map((id) => `  ${id.slice(0, 10)}…`)
        .join('\n');
      return {
        error:
          `⚠️ ambiguous prefix "${idArg}" — ${ambiguous.length}+ matches:\n${preview}\n` +
          `(add more hex chars to narrow it down)`,
      };
    }
    // Zero ambiguous matches: fall through to default-platform lookup below
    const fallbackItem = cache.lookup(DEFAULT_PLATFORM, idArg);
    if (!fallbackItem) {
      return {
        error:
          `⚠️ not found in cache: ${idArg}\n` +
          `(tip: the item must have been seen via /popclaw feed at least once)`,
      };
    }
    if (!fallbackItem.eventId) {
      return {
        error:
          `⚠️ item found but event_id is missing for x:${idArg}\n` +
          `(tip: run /popclaw feed to refresh — items need a server-assigned event_id before they can be marked)`,
      };
    }
    return { item: fallbackItem };
  }

  // Fallback: treat as platform=x postId
  const item = cache.lookup(DEFAULT_PLATFORM, idArg);
  if (!item) {
    return {
      error:
        `⚠️ not found in cache: x:${idArg}\n` +
        `(tip: the item must have been seen via /popclaw feed at least once)`,
    };
  }
  if (!item.eventId) {
    return {
      error:
        `⚠️ item found but event_id is missing for x:${idArg}\n` +
        `(tip: run /popclaw feed to refresh — items need a server-assigned event_id before they can be marked)`,
    };
  }
  return { item };
}

export interface PopclawMarkArgs {
  positional: string[];
}

export interface PopclawMarkDeps {
  cache: CacheLike;
  markService: MarkServiceLike;
  /** Social-log collection point `mark_added` (spec 2026-07-26 §4). Not injected = not recorded. */
  socialLog?: SocialLogRecorder;
  /** Unique name chain (alias > self-reported name > handle); not injected = keeps the old `@handle` behavior. */
  nameOf?: NameChain;
}

export interface PopclawUnmarkDeps {
  cache: CacheLike;
  markService: MarkServiceLike;
  store: MarksStore;
  /** Social-log collection point `mark_removed` (P-004: revoking approval is also a signal of the owner's choice). Not injected = not recorded. */
  socialLog?: SocialLogRecorder;
  /** Unique name chain (alias > self-reported name > handle); not injected = keeps the old `@handle` behavior. */
  nameOf?: NameChain;
}

export interface PopclawMarksDeps {
  store: MarksStore;
  /** Unique name chain (alias > self-reported name > handle); not injected = keeps the old `@handle` behavior. */
  nameOf?: NameChain;
}

export async function runPopclawMarkCommand(
  args: PopclawMarkArgs,
  deps: PopclawMarkDeps,
): Promise<{ text: string }> {
  const idArg = args.positional[0];
  if (!idArg) {
    return {
      text:
        'usage: /popclaw mark <id>\n' +
        'examples:\n' +
        '  /popclaw mark abc123          (hex event_id prefix)\n' +
        '  /popclaw mark x:1234567890    (platform:postId)\n' +
        '  /popclaw mark 1234567890      (postId, defaults to x)',
    };
  }

  const resolved = resolveMarkTarget(idArg, deps.cache);
  if ('error' in resolved) {
    return { text: resolved.error };
  }

  const item = resolved.item;
  const result = await deps.markService.mark(item);

  // Social log: recorded even when `result.pushed` is false — that only
  // means the lore-house hop failed; the local snapshot has already landed,
  // and the owner really did make this explicit endorsement. What's
  // recorded is the owner's action, not whether the network succeeded.
  safeRecord(deps.socialLog, {
    kind: 'mark_added',
    // Which house the marked item surfaced in (ADR-0037: taste signals are facts and must carry a house).
    ...(item.houseSlug ? { house_slug: item.houseSlug } : {}),
    actor: {
      ...(item.authorPopclawId ? { id: item.authorPopclawId } : {}),
      ...(item.handle ? { name: item.handle } : {}),
      // Known gap: the CachedFeedItem returned by `cache.lookup` doesn't
      // currently bake in actor_verified (only recentForReading's
      // ReadableFeedItem has it) → in practice this field is always
      // omitted. An honest gap, not a bug; the day lookup carries it too,
      // this will automatically start getting a value.
      verified_then: verifiedThenOf(
        (item as { actorVerified?: Parameters<typeof verifiedThenOf>[0] }).actorVerified,
      ),
    },
    text: item.textPreview,
    event_id: item.eventId,
    ...(item.originalUrl ? { url: item.originalUrl } : {}),
  });

  // Alias / self-reported name overrides a mirrored post's @handle; if neither exists, report only the sigil (ADR-0032).
  const target = markWho(item, deps.nameOf);

  const lang = ownerLang();
  if (result.pushed) {
    return { text: renderCopy(lang, 'mark.cli.pushed', { target }) };
  }
  return {
    text: renderCopy(lang, 'mark.cli.pushFailed', {
      target,
      error: result.error ?? renderCopy(lang, 'mark.cli.unknownError'),
    }),
  };
}

export async function runPopclawUnmarkCommand(
  args: PopclawMarkArgs,
  deps: PopclawUnmarkDeps,
): Promise<{ text: string }> {
  const idArg = args.positional[0];
  if (!idArg) {
    return {
      text:
        'usage: /popclaw unmark <id>\n' +
        'examples:\n' +
        '  /popclaw unmark abc123          (hex event_id prefix)\n' +
        '  /popclaw unmark x:1234567890    (platform:postId)',
    };
  }

  // First, try local marks store (resolving by prefix on the stored eventIds)
  let eventId: string | null = null;
  // Keep the local row as a fallback for the log's original text: the cache
  // has a one-year prune, so by the time of an unmark it may already be
  // gone, while the snapshot in the marks table was saved at mark time
  // (a hard self-sufficiency requirement).
  let localRow: { authorPopclawId: string; handle: string; bodySnapshot: string; sourceUrl: string } | null = null;
  if (HEX_PREFIX.test(idArg)) {
    // TODO(ADR-0019): prefix scan caps at 1000 active marks; revisit if anyone actually exceeds that.
    const allMarks = deps.store.listActive(1000);
    const localMatches = allMarks.filter((r) => r.eventId.startsWith(idArg));
    if (localMatches.length === 1) {
      eventId = localMatches[0]!.eventId;
      localRow = localMatches[0]!;
    } else if (localMatches.length > 1) {
      const preview = localMatches
        .slice(0, 3)
        .map(
          (r) =>
            `  ${r.eventId.slice(0, 10)}… ${markWho(r, deps.nameOf)}`,
        )
        .join('\n');
      return {
        text:
          `⚠️ ambiguous prefix "${idArg}" — ${localMatches.length}+ local marks match:\n${preview}\n` +
          `(add more hex chars to narrow it down)`,
      };
    }
  }
  if (eventId === null) {
    // Fall back to cache lookup
    const resolved = resolveMarkTarget(idArg, deps.cache);
    if ('error' in resolved) {
      return { text: resolved.error };
    }
    eventId = resolved.item.eventId;
  }

  // Spec B slice 3: unmarking must land back on whichever house the mark
  // originally went to. The local marks table doesn't record a house, so
  // ask the cache once uniformly (both resolution paths share this line);
  // if not found → the primary house.
  const cached = deps.cache.findByEventIdPrefix(eventId).item;
  const houseSlug = cached?.houseSlug;
  const result = await deps.markService.unmark(eventId, houseSlug);

  // Social log `mark_removed` (P-004 catch-up: unmark previously recorded
  // nothing at all). **Recorded unconditionally**, including when
  // `wasMarked` is false — that path still pushes a signed revoke to the
  // lore-house (see "revoke sent anyway" below); a public event has already
  // gone out, so the local log can't be out of sync with it.
  // This is also where it diverges from follow_removed: unfollow returns
  // early with nothing pushed when "wasn't following in the first place",
  // so there's nothing to record; unmark still pushes (an idempotent
  // recovery path).
  // Recorded even when the push fails: the local state has already been
  // revoked, the owner really did change their mind — what's recorded is
  // the action, not whether the network succeeded.
  const authorId = cached?.authorPopclawId || localRow?.authorPopclawId || '';
  const handle = cached?.handle || localRow?.handle || '';
  const text = cached?.textPreview || localRow?.bodySnapshot || '';
  const url = cached?.originalUrl || localRow?.sourceUrl || '';
  safeRecord(deps.socialLog, {
    kind: 'mark_removed',
    ...(houseSlug ? { house_slug: houseSlug } : {}),
    actor: { ...(authorId ? { id: authorId } : {}), ...(handle ? { name: handle } : {}) },
    ...(text ? { text } : {}),
    event_id: eventId,
    ...(url ? { url } : {}),
  });

  const suffix = result.pushed
    ? ''
    : `\n◐ lore-house push failed: ${result.error ?? 'unknown error'}\n` +
      `(rerun the same command to retry — server side is idempotent)`;

  if (!result.wasMarked) {
    return { text: `· was not marked locally; revoke sent anyway (idempotent)${suffix}` };
  }

  return { text: `✓ unmarked ${eventId.slice(0, 10)}…${suffix}` };
}

export async function runPopclawMarksCommand(
  args: { flags: Record<string, string> },
  deps: PopclawMarksDeps,
): Promise<{ text: string }> {
  const rawLimit = args.flags['limit'];
  let limit = 20;
  if (rawLimit !== undefined) {
    const parsed = parseInt(rawLimit, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      limit = 20;
    } else {
      limit = parsed;
    }
  }

  const rows = deps.store.listActive(limit);
  if (rows.length === 0) {
    return {
      text: 'no marks yet — `/popclaw mark <id>` on anything in your feed worth a hook.',
    };
  }

  const lines = rows.map((r) => {
    const eid = r.eventId.slice(0, 10);
    const who = markWho(r, deps.nameOf);
    const summary = r.summaryLine;
    const url = r.sourceUrl ? `  ${r.sourceUrl}` : '';
    return `${eid}  ${who}: ${summary}${url}`;
  });

  return { text: `marks (${rows.length}):\n` + lines.join('\n') };
}
