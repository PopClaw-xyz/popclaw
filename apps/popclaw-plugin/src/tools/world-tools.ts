/**
 * The world tools (guide / summary / author history / follow + unfollow, plus
 * the newspaper reader-pass pairing). Registered only when the composition
 * root supplied `getWorldDeps`.
 *
 * Split out of register-tools.ts (2026-08-25).
 */

import { formatHouseReadFailure, houseReadFailure } from '../runtime/house-lifecycle/read-failure.js';
import type { WorldSummaryResult } from '../world/world-summary-client.js';
import {
  WorldGuideSchema,
  WorldSummaryToolSchema,
  AuthorLatestSchema,
  PopclawFollowSchema,
  PopclawUnfollowSchema,
  PopclawPairBrowserSchema,
} from './tool-schemas.js';
import { pairBrowser } from '../canvas/pair-claim.js';
import type { Signer } from '../identity/signer.js';
import { ownerLang, failureText } from '../lexicon/owner-language.js';
import { renderCopy } from '../lexicon/index.js';
import { parseGuideFrontmatter } from '../world/guide.js';
import { houseDisplayName } from '../world/house-handshake.js';
import { WorldSummaryClient } from '../world/world-summary-client.js';
import { aggregateNotableAuthors } from '../world/notable-authors.js';
import { resolveAuthor } from '../world/author-resolver.js';
import { rememberObservedPostIds } from '../world/post-ref.js';
import {
  formatHotPostLine,
  formatNotableAuthorLine,
  formatNotablePersonLine,
  formatWorldStateLine,
  hotPostsFallbackHeading,
  mirrorAuthorsHeading,
  NOTABLE_PEOPLE_CAP,
  notablePeopleHeading,
} from '../world/summary-format.js';
import { houseSilenceOf, houseSilenceText } from '../ingress/house-silence.js';
import { followReceivedText, followResolved } from '../commands/follow.js';
import { runPopclawUnfollowCommand } from '../commands/popclaw-unfollow.js';
import { safeRecord } from '../social-log/social-log.js';
import {
  resolveFollowTarget,
  formatCandidateList,
  type FollowResolution,
} from '../identity/follow-resolution.js';
import { localFirst, unresolvedText } from '../identity/person-resolver.js';
import type { NameChain } from '../identity/person-name.js';
import { renderAuthorHistory } from './author-history-view.js';
import {
  AUTHOR_LATEST_MAX_COUNT,
  WORLD_NOTABLE_CAP,
  WORLD_SNAPSHOT_LIMIT,
  WORLD_SUMMARY_LIST_CAP,
  WORLD_SUMMARY_WINDOW_HOURS,
  buildAuthorSources,
  disambiguationText,
  fetchAuthorSources,
} from './author-sources.js';
import { socialLogOf, type RegisterToolsDeps, type ToolsCtx, type WorldSnapshotItemLike } from './tools-context.js';
import { buildPersonSources, ownerPopclawId, resolvePersonRef } from './person-sources.js';

/**
 * Honest lore-house-unreachable fallback (world_summary/world_guide/
 * author_latest/follow/unfollow — every call site as of rollout slice 1;
 * the pilot's hardcoded `LANTERN_DOWN_TEXT` constant is gone).
 */
function lanternDownText(lang = ownerLang()): string {
  return renderCopy(lang, 'world.lanternDown');
}

/**
 * The single name chain (`rt.nameOf`). Returns undefined if runtime isn't up /
 * doesn't have this field — a read-only tool must never fail just because it
 * couldn't resolve how to address someone (falling back to the server-supplied
 * self-reported name is the pre-change behavior).
 */
async function nameChainOf(deps: RegisterToolsDeps): Promise<NameChain | undefined> {
  try {
    return ((await deps.runtime()) as { nameOf?: NameChain } | undefined)?.nameOf;
  } catch {
    return undefined;
  }
}

/** The owner's current name when `popclawId` is the owner, else ''. `boot.nickname` is live across renames. */
async function ownDeclaredName(deps: RegisterToolsDeps, popclawId: string): Promise<string> {
  try {
    const boot = ((await deps.runtime()) as { boot?: { popclawId?: string; nickname?: string } } | undefined)?.boot;
    return boot?.popclawId && boot.popclawId === popclawId ? (boot.nickname ?? '').trim() : '';
  } catch {
    return '';
  }
}

/** The runtime bag, or undefined when it isn't up — same tolerance as `nameChainOf`. */
async function runtimeBag(deps: RegisterToolsDeps): Promise<unknown> {
  try {
    return await deps.runtime();
  } catch {
    return undefined;
  }
}

/** World-tool registrations, in their original order. */

/**
 * Take the owner out of a relation resolution.
 *
 * Self is a local resolution candidate so that READ tools can answer "show my
 * namecard". Following or unfollowing yourself is a different thing entirely:
 * it signs a relation event and pushes it to a house, asserting a relationship
 * that cannot exist. Applied to BOTH outcomes — the precise hit, and a
 * candidate list that offers nobody but the owner, so the agent is never
 * invited to pick a target it would then be refused.
 *
 * An empty `me` (a runtime that cannot say who the owner is) changes nothing.
 */
function withoutOwner(resolution: FollowResolution, me: string): FollowResolution | 'self' {
  if (!me) return resolution;
  if (resolution.kind === 'follow') return resolution.popclawId === me ? 'self' : resolution;
  if (resolution.kind === 'choose') {
    const others = resolution.candidates.filter((c) => c.popclawId !== me);
    if (others.length === 0) return 'self';
    return { ...resolution, candidates: others };
  }
  return resolution;
}

export function registerWorldTools(ctx: ToolsCtx): void {
  const { api, runtime, deps } = ctx;

  // === WORLD TOOLS (S4.1-T3: act2 world capabilities on the NL path) ===
  // Owner principle: onboarding is a checklist, not a rail — a newcomer can go however they
  // like in open conversation, and the agent naturally guides them to fill any gap it
  // notices in their journey. This guidance script is encoded right in the description
  // (the OpenClaw agent routes by description). Rendering/aggregation all reuse act2's
  // summary-format / notable-authors / author-resolver — same source, same criteria.

  const { getWorldDeps } = deps;
  if (getWorldDeps !== undefined) {
    api.registerTool({
      name: 'popclaw_world_guide',
      description:
        'Call when the owner asks "what is this world / how do I play popclaw / what should I do next", ' +
        'or when he asks an open-ended question while onboarding is unfinished. ' +
        "Returns the world's own description plus a summary of its name/voice/stream list. " +
        'First explain how it works to the owner (using this tool\'s content), then call popclaw_world_summary ' +
        'for "who and what is interesting right now", and finish by offering the owner 2-4 things he could do. ' +
        'If popclaw_onboarding_status shows the owner has not finished onboarding, ' +
        'open with this tool and explain how it works, unprompted. ' +
        'Also call this tool when the owner gets a letter/postcard from some lore-house and does not know how to respond, ' +
        'or mentions how some mounted lore-house works — every lore-house guide is here. ' +
        "The owner's name is never fixed — never tell him it is. Once onboarding is finished he can change it with popclaw_set_name; " +
        'while onboarding is in progress a naming answer goes to popclaw_onboarding_continue instead.',
      parameters: WorldGuideSchema,
      execute: async () => {
        const lang = ownerLang();
        const wd = await getWorldDeps();
        const md = await wd.guideClient.fetchGuideText();
        const parts: string[] = [];
        if (md === null) {
          parts.push(renderCopy(lang, 'world.guide.unreachable', { lantern: lanternDownText(lang) }));
        } else {
          const { frontmatter, body } = parseGuideFrontmatter(md);
          if (frontmatter !== null) {
            const worldName = frontmatter.world ?? 'popclaw.me';
            const voice = frontmatter.voice ?? frontmatter.kind ?? renderCopy(lang, 'world.guide.defaultVoice');
            parts.push(`🏮 ${worldName} — ${voice}`);
            if (frontmatter.streams.length > 0) {
              parts.push(
                renderCopy(lang, 'world.guide.streamsLine', {
                  names: frontmatter.streams.map((s) => s.name).join(' / '),
                  count: String(frontmatter.streams.length),
                }),
              );
            }
          }
          const trimmedBody = body.trim();
          if (trimmedBody.length > 0) parts.push(trimmedBody);
        }
        // ADR-0041: after the primary house, each additional mounted house has its own
        // guide-text section appended. The source-attribution line is marking a trust
        // boundary — the content is trustworthy (mounting a house = explicit owner
        // consent, on the same level as relaying that house's official DM), but it's only
        // valid for interactions with that specific house, and must never be treated as a
        // global rule.
        for (const h of wd.mountedGuides?.() ?? []) {
          parts.push(
            `${renderCopy(lang, 'world.guide.mountedHeader', { houseName: h.houseName, slug: h.slug })}\n` +
              `${renderCopy(lang, 'world.guide.mountedNote')}\n` +
              h.guide,
          );
        }
        return { type: 'text' as const, text: parts.join('\n\n') };
      },
    });

    api.registerTool({
      name: 'popclaw_world_summary',
      description:
        'Call when the owner asks "what is trending / what is going on / any interesting people lately". ' +
        'Returns an overview of the world: the world-state line + the well-known (verified names, weighted by followers) + ' +
        'the best posts + active mirror accounts (aggregated on-device, unverified). ' +
        'After presenting it, suggest what the owner could do next (dig into someone with popclaw_author_latest, ' +
        'follow someone with popclaw_follow, reply/post with the draft tools).',
      parameters: WorldSummaryToolSchema,
      execute: async (_callId: string, params: unknown) => {
        const p = params as { window_hours?: number };
        const windowHours =
          typeof p.window_hours === 'number' && Number.isFinite(p.window_hours) && p.window_hours > 0
            ? p.window_hours
            : WORLD_SUMMARY_WINDOW_HOURS;
        const wd = await getWorldDeps();
        const [summaryResult, snapshot] = await Promise.all([
          (wd.summaryClient.fetchSummaryResult ? wd.summaryClient.fetchSummaryResult(windowHours)
            : wd.summaryClient.fetchSummary(windowHours).then((summary): WorldSummaryResult => summary
              ? {ok:true,summary} : {ok:false,failure:{code:'HOUSE_REMOTE_UNKNOWN'}}))
            .catch((error): WorldSummaryResult => ({ok:false,failure:houseReadFailure(error)})),
          wd.snapshotClient
            .fetchSnapshot({ limit: WORLD_SNAPSHOT_LIMIT })
            .catch(() => [] as WorldSnapshotItemLike[]),
        ]);
        const lang = ownerLang();
        if (!summaryResult.ok) {
          return { type: 'text' as const, text: formatHouseReadFailure(lang,summaryResult.failure) };
        }
        const summary = summaryResult.summary;
        // The owner's alias overrides the lore-house-supplied self-reported name (the single name chain).
        const nameOf = await nameChainOf(deps);
        const lines = summary.hot_posts.slice(0, WORLD_SUMMARY_LIST_CAP).map((post, i) =>
          formatHotPostLine(
            i + 1,
            {
              nickname: WorldSummaryClient.nicknameFor(summary, post.author, nameOf),
              bodyPreview: post.body_preview,
              platform: post.platform,
              replyCount: post.reply_count,
            },
            lang,
          ),
        );
        const notable = aggregateNotableAuthors(
          buildAuthorSources(summary, snapshot, nameOf),
          WORLD_NOTABLE_CAP,
          nameOf,
        );
        // Line order matches act2's summary card exactly (buildSummaryCard): state line →
        // well-known → best posts → active mirror accounts. Missing v2 fields (an older
        // server) → the whole new section is simply omitted.
        const titleLines = [
          renderCopy(lang, 'world.summary.title', {
            windowHours: String(summary.window_hours),
            totalPosts: String(summary.total_posts),
            distinctAuthors: String(summary.distinct_authors),
          }),
        ];
        if (summary.world_state !== undefined) {
          titleLines.push(formatWorldStateLine(summary.world_state, lang));
        }
        const blocks: string[] = [titleLines.join('\n')];
        const people = (summary.notable_people ?? []).slice(0, NOTABLE_PEOPLE_CAP);
        if (people.length > 0) {
          blocks.push(
            `${notablePeopleHeading(lang)}\n${people.map((p) => formatNotablePersonLine(p, lang)).join('\n')}`,
          );
        }
        const colon = lang === 'zh-CN' ? '：' : ':';
        blocks.push(
          lines.length > 0
            ? `${summary.summary_note ?? hotPostsFallbackHeading(lang)}${colon}\n${lines.join('\n')}`
            : renderCopy(lang, 'world.summary.noHotPosts'),
        );
        if (notable.length > 0) {
          blocks.push(
            `${mirrorAuthorsHeading(lang)}\n` +
              notable.map((a) => formatNotableAuthorLine(a, lang)).join('\n'),
          );
        }
        // #588: the house answered, and the answer was "nothing". That reads
        // as a calm world whether the world is calm or the OTHER mounted
        // houses have gone dark, so an empty summary says when each house last
        // delivered a frame. Cache-only, never a second call out.
        if (summary.total_posts === 0) {
          // Guarded like the feed path's `silenceNote`: the summary is the
          // deliverable, the outage note is the footnote, and a footnote must
          // never be what takes the answer down.
          try {
            const silence = houseSilenceText(houseSilenceOf(await runtimeBag(deps)), { lang });
            if (silence) blocks.push(silence);
          } catch {
            // No note this turn; the summary still goes out intact.
          }
        }
        return { type: 'text' as const, text: blocks.join('\n\n') };
      },
    });

    api.registerTool({
      name: 'popclaw_author_latest',
      description:
        'Call when the owner wants the latest from one specific person (e.g. "Elon Musk\'s latest posts"), with count 1–5. ' +
        'Also call it when the owner wants to get to know someone properly (go through their history, decide whether to follow), ' +
        'with count 30–100 (50 is a good default) — it returns compact dated timeline material for you to read and sum up for the owner in this same turn. ' +
        'Pass the name exactly as the owner said it, the tool resolves the person itself ' +
        '(name / name#sigil / a bare sigil / a full popclaw_id are all accepted); ' +
        'when several people are close matches the tool returns a disambiguation list — read it back to the owner to pick from.',
      parameters: AuthorLatestSchema,
      execute: async (_callId: string, params: unknown) => {
        const p = params as { name: string; count?: number };
        const lang = ownerLang();
        const count = Math.min(
          AUTHOR_LATEST_MAX_COUNT,
          Math.max(1, Math.floor(typeof p.count === 'number' ? p.count : 1)),
        );
        const wd = await getWorldDeps();
        const { sources, allFailed } = await fetchAuthorSources(wd);
        if (allFailed) {
          return { type: 'text' as const, text: lanternDownText(lang) };
        }
        const candidates = resolveAuthor(p.name, sources);
        let only = candidates[0];
        if (candidates.length > 1) {
          return { type: 'text' as const, text: disambiguationText(p.name, candidates, lang) };
        }
        if (!only) {
          // No such name in the world feed → go through PersonResolver (the four forms of
          // person resolution: full id / name#sigil / bare sigil / bond-book name). They
          // may simply not have posted recently.
          const person = await resolvePersonRef(p.name, deps);
          if (person.kind !== 'resolved') {
            // Say the reason once: only a genuine no-such-person case should suggest the
            // summary view; ambiguity and lore-house-unreachable each have their own wording
            // (stacking both would just contradict each other).
            const text =
              person.kind === 'notFound' && !person.lanternDown
                ? renderCopy(lang, 'world.author.notFoundHint', { name: p.name })
                : unresolvedText(p.name, person, lang);
            return { type: 'text' as const, text };
          }
          only = { popclawId: person.popclawId, nickname: person.nickname || p.name, platforms: [] };
        }
        // Once resolved, the name reported back to the owner goes through the single name chain (alias > self-reported name).
        const authorNameOf = await nameChainOf(deps);
        only = { ...only, nickname: authorNameOf?.(only.popclawId, only.nickname) || only.nickname };
        // The owner's own snapshot: the feed stamps rows with the name the
        // author had when indexed — often the registration-time auto name — so
        // the owner is named by what they declared, the same name status prints.
        const ownName = await ownDeclaredName(deps, only.popclawId);
        if (ownName) only = { ...only, nickname: ownName };
        // Social-log `person_asked` — the owner asking "how has so-and-so been" is an implicit
        // form of attention, more honest even than a follow. This is hung **after resolution
        // succeeds**: the disambiguation list and no-such-person cases both already returned
        // above, and in either of those cases we don't actually know who the owner meant, so
        // logging them would just be noise. It's still logged even if the lore-house snapshot
        // fetch that follows fails — the owner genuinely asked, and getting no content back
        // doesn't change the fact that they asked.
        safeRecord(await socialLogOf(runtime), {
          kind: 'person_asked',
          actor: { id: only.popclawId, name: only.nickname },
        });
        let items: WorldSnapshotItemLike[];
        try {
          items = await wd.snapshotClient.fetchSnapshot({
            author: only.popclawId,
            limit: count,
          });
        } catch {
          return { type: 'text' as const, text: lanternDownText(lang) };
        }
        if (items.length === 0) {
          return {
            type: 'text' as const,
            text: renderCopy(lang, 'world.author.noRecentSnapshot', { nickname: only.nickname }),
          };
        }
        // C3: remember the exact short-id→event-id mapping
        // this trusted read just produced. author_latest reads straight from
        // the lore-house — the LOCAL world-stream cache may be empty — and a
        // later popclaw_draft_post reply/quote on one of these short links
        // must still resolve to the exact full event_id seen here
        // (unique-or-refuse; see world/post-ref.ts). Mirror rows are filtered
        // out inside: their platformPostId belongs to the external platform.
        rememberObservedPostIds(items);
        return {
          type: 'text' as const,
          text: renderAuthorHistory({ author: only, items, requestedCount: count, webBaseUrl: wd.webBaseUrl, lang }),
        };
      },
    });

    api.registerTool({
      name: 'popclaw_follow',
      description:
        'Call when the owner says "follow X", gives a sigil (#4f68bd), a name#sigil (Blackfeather#4f68bd) or a full popclaw_id; ' +
        "pass the owner's own words as name. Following is lightweight and reversible — on an exact match, execute directly without confirmation. " +
        'Lore-house resolution: a sigil/id that matches exactly one person is followed straight away; for a bare name, or when sigils collide, ' +
        'read the candidate list back to the owner to pick from, then call this tool again with "name#sigil" for an exact match. ' +
        // Follow doorbell carve-out (spec §6.5): the one exception to the
        // exact-match fast path above — batch confirmations coming from the
        // injected pending-follow list echo first.
        'When confirming names from the injected pending-follow list, batches of 6+ or ambiguous picks require echoing the full list back for a Y/N first.',
      parameters: PopclawFollowSchema,
      execute: async (_callId: string, params: unknown) => {
        const p = params as { name: string };
        const lang = ownerLang();
        if (!p.name?.trim()) {
          return { type: 'text' as const, text: renderCopy(lang, 'follow.askWho') };
        }
        // Person resolution (ADR-0028 + 2026-07-25 revision): check the two local sources
        // first (bond book ∪ follow list / world-feed cache), and only go to the
        // lore-house's /v1/resolve directory (name card ∪ verified handles) if local is
        // empty — so even someone who "hasn't posted" can still be followed by sigil/name,
        // while someone already known needs zero round trips.
        const personSources = await buildPersonSources(deps);
        const resolved = await resolveFollowTarget(p.name, localFirst(personSources));
        // The owner is a person to read about, never a person to follow.
        const resolution = withoutOwner(resolved, await ownerPopclawId(deps));
        if (resolution === 'self') {
          return { type: 'text' as const, text: renderCopy(lang, 'person.thatIsYou') };
        }
        if (resolution.kind === 'lantern') {
          return { type: 'text' as const, text: lanternDownText(lang) };
        }
        if (resolution.kind === 'empty') {
          return {
            type: 'text' as const,
            text: renderCopy(lang, 'follow.notRegistered', { ref: resolution.ref }),
          };
        }
        if (resolution.kind === 'choose') {
          return { type: 'text' as const, text: formatCandidateList(resolution.candidates, lang) };
        }
        // kind === 'follow': run the existing follow command path (runFollowCommand →
        // SocialGraph.declareFollow signs + declared.jsonl + pushes to the lore-house);
        // the protocol logic itself is never rewritten here.
        try {
          const rt = await runtime();
          const { reply, named } = await followResolved(
            resolution,
            {
              socialGraph: rt.socialGraph,
              bondsStore: rt.bondsStore,
              ownPopclawId: await ownerPopclawId(deps),
              socialLog: rt.socialLog,
              /** Follow doorbell: pending → confirmed once the follow is on the wire. */
              pendingFollows: rt.pendingFollows,
              houseDisplayName: (slug) => houseDisplayName(rt.paths, rt.boot.loreHouseUrls, slug),
            },
            // The sources built above already hold the house resolver (#468).
            // Tolerates a runtime without a bond book, as the tool always has.
            { bondOf: (id) => rt.bondsStore?.get?.(id), house: personSources.house },
          );
          // Anything but an accepted follow is honestly passed through as-is.
          if (reply.outcome.kind !== 'accepted') {
            return { type: 'text' as const, text: reply.text };
          }
          // G1-copy / architect ruling: reply.house is the house
          // runFollowCommand's own receipt named — carried over so
          // re-rendering with the resolved name#sigil doesn't drop the name.
          // Undefined (home house, never guessed) renders the no-house variant.
          return {
            type: 'text' as const,
            // The one follow receipt, rendered with the resolved name#sigil
            // instead of the bare id runFollowCommand used.
            text: followReceivedText(lang, named ?? resolution.popclawId, reply.house),
          };
        } catch (err) {
          return { type: 'text' as const, text: failureText('follow', err) };
        }
      },
    });

    api.registerTool({
      name: 'popclaw_unfollow',
      description:
        'Call when the owner says "unfollow X" / "stop following X"; pass the owner\'s own words as name. ' +
        'Unfollowing is lightweight and reversible — on an exact match, execute directly without confirmation. ' +
        'Local resolution: the bond book ∪ the follow list are checked first; for someone never followed it answers honestly right away, without asking the lore-house.',
      parameters: PopclawUnfollowSchema,
      execute: async (_callId: string, params: unknown) => {
        const p = params as { name: string };
        const lang = ownerLang();
        if (!p.name?.trim()) {
          return { type: 'text' as const, text: renderCopy(lang, 'unfollow.askWho') };
        }
        // Symmetric to popclaw_follow: the two local sources take priority, and the lore-house is only asked if local is empty.
        const personSources = await buildPersonSources(deps);
        const resolved = await resolveFollowTarget(p.name, localFirst(personSources));
        // Symmetric to popclaw_follow: revoking a relation with oneself would
        // sign and push a revocation of something that never existed.
        const resolution = withoutOwner(resolved, await ownerPopclawId(deps));
        if (resolution === 'self') {
          return { type: 'text' as const, text: renderCopy(lang, 'person.thatIsYou') };
        }
        if (resolution.kind === 'lantern') {
          return { type: 'text' as const, text: lanternDownText(lang) };
        }
        if (resolution.kind === 'empty') {
          return { type: 'text' as const, text: renderCopy(lang, 'unfollow.notFound', { ref: resolution.ref }) };
        }
        if (resolution.kind === 'choose') {
          return { type: 'text' as const, text: formatCandidateList(resolution.candidates, lang, 'unfollow') };
        }
        // kind === 'follow' (resolveFollowTarget's shared result type; here it means "a
        // precise popclaw_id has been resolved"): run the existing unfollow command path
        // (runPopclawUnfollowCommand → SocialGraph.revokeFollow signs + pushes to the
        // lore-house + writes back to bonds + social log); the protocol logic itself is
        // never rewritten here.
        try {
          const rt = await runtime();
          const reply = await runPopclawUnfollowCommand(
            resolution.popclawId,
            {
              socialGraph: rt.socialGraph,
              bondsStore: rt.bondsStore,
              ownPopclawId: await ownerPopclawId(deps),
              socialLog: rt.socialLog,
              houseDisplayName: (slug) => houseDisplayName(rt.paths, rt.boot.loreHouseUrls, slug),
            },
          );
          // Anything but an accepted unfollow is honestly passed through as-is (including
          // "not currently following" — an honest reply that produces no event at all).
          // The outcome decides, never how the receipt happens to be worded.
          if (reply.outcome.kind !== 'accepted') {
            return { type: 'text' as const, text: reply.text };
          }
          const c = resolution.candidate;
          const who = c ? `${c.nickname}#${c.sigil}` : resolution.popclawId;
          // G1-copy / architect ruling: same carry-over as popclaw_follow above.
          const house = reply.house;
          return {
            type: 'text' as const,
            // The one unfollow receipt (relation.unfollowReceived / …NoHouse),
            // same rule as popclaw_follow: no per-path wording of its own.
            text: renderCopy(
              lang,
              house ? 'relation.unfollowReceived' : 'relation.unfollowReceivedNoHouse',
              house ? { who, house } : { who },
            ),
          };
        } catch (err) {
          return { type: 'text' as const, text: failureText('unfollow', err) };
        }
      },
    });

    // Reader-pass claim (follow-doorbell §5.3, owner rulings 2026-09-13): the
    // page open in the reader's browser shows a 6-digit code; the reader sends
    // it to their OWN PopClaw and this tool vouches for that browser with
    // their key. Pairing is what makes a browser theirs for ANY shared page —
    // a ➕ tapped on someone else's paper is credited to whoever the pass
    // names, and an unpaired tap is recorded for nobody at all. Canvas base
    // URL comes from boot, same as every other canvas use (see read-tools'
    // publish deps).
    api.registerTool({
      name: 'popclaw_pair_browser',
      description:
        'Call when the owner wants to PAIR the browser he is reading a shared page in — he will say the pairing phrase printed on ' +
        'that page — his language\'s plain word for "pair" — followed by a 6-digit code; the page header and its tap-time hint ' +
        'print exactly this. ' +
        'Pairing is how the owner makes his taps on ANY page his own: a follow ➕ tapped on a paper — his own or one a friend ' +
        'shared — is credited to the identity the paired browser carries, the page shows HIS "following" marks, and without ' +
        'pairing a tap is recorded for nobody at all. Pass the code exactly as the owner said it (the older paper-specific zh ' +
        'phrases for the same action also route here) — one code is one shot and expires fast; if the claim fails, the page issues ' +
        'a fresh code and you call this again with the new one. Never guess, reuse, or invent a code.',
      parameters: PopclawPairBrowserSchema,
      execute: async (_callId: string, params: unknown) => {
        const p = params as { code?: unknown };
        const lang = ownerLang();
        const code = typeof p.code === 'string' ? p.code.trim() : '';
        // A blank code can never claim anything — skip the wire and hand back
        // the same honest receipt (its recovery, "have the page issue a fresh
        // code", is exactly right for a code that never made it through).
        if (!code) {
          return { type: 'text' as const, text: renderCopy(lang, 'newspaper.doorbell.pairFail') };
        }
        try {
          const rt = (await runtime()) as { boot: { signer: Signer; canvasBaseUrl?: string | null } };
          // Pairing a browser only means something when there is a published
          // page to pair with. With no publisher the tool stays registered
          // (the three tool tables must agree) and answers honestly.
          if (!rt.boot.canvasBaseUrl) {
            return { type: 'text' as const, text: renderCopy(lang, 'newspaper.publisher.unavailable') };
          }
          const ok = await pairBrowser({
            baseUrl: rt.boot.canvasBaseUrl,
            signer: rt.boot.signer,
            code,
          });
          return {
            type: 'text' as const,
            text: renderCopy(lang, ok ? 'newspaper.doorbell.pairOk' : 'newspaper.doorbell.pairFail'),
          };
        } catch (err) {
          // pairBrowser only throws for network trouble (a non-2xx is an honest
          // false above) — report it as a failure, never as "bad code".
          return { type: 'text' as const, text: failureText('popclaw_pair_browser', err) };
        }
      },
    });
  }
}
