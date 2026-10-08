/**
 * `/popclaw`'s subcommand map — the wiring of the ONE slash command (P-001).
 *
 * Lifted out of `index.ts`, which had grown to hold both the runtime bootstrap
 * and 640 lines of command wiring in one register() closure. Nothing about the
 * dispatch changed: `buildSubcommands` returns the same object literal, with
 * the same closures, built at the same moment.
 *
 * ⚠️ LAZINESS IS LOAD-BEARING (ADR-0035: `register()` must be cheap — loading a
 * plugin is not enabling it). Every handler below reaches the runtime through
 * `w.runtime()` and the data root through `w.paths()`, both of which are only
 * called INSIDE a handler body. Building this map must not open a database, a
 * socket or a file; if a new subcommand needs something constructed, construct
 * it inside its handler, never in this function's body.
 */
import {
  type SubcommandContext,
  type SubcommandHandler,
} from './popclaw-router.js';
import type { PopclawPaths } from '../host/popclaw-paths.js';
import type { OpenClawPluginRuntime } from '../runtime/gateway-runtime.js';
import { findBonds } from '../bonds/find-bonds.js';
import { followReceivedText, followResolved } from '../commands/follow.js';
import { runHelpCommand, type HelpEntry } from '../commands/help.js';
import { runNotifyHereCommand, runNotifyOffCommand } from '../commands/notify-target.js';
import { runBondCommand } from '../commands/popclaw-bond.js';
import { runPopclawBriefCommand } from '../commands/popclaw-brief.js';
import { runPopclawCanvasCommand } from '../commands/popclaw-canvas.js';
import { runPopclawDoctorCommand } from '../commands/popclaw-doctor.js';
import { runPopclawDreamCommand } from '../commands/popclaw-dream.js';
import { runPopclawFeedCommand } from '../commands/popclaw-feed.js';
import { runPopclawFeedbackCommand } from '../commands/popclaw-feedback.js';
import { runPopclawInboxCommand } from '../commands/popclaw-inbox.js';
import { runHouseRecoveryCommand, runHouseLoginCommand, runHouseLogoutCommand, type HouseCommandContext } from './popclaw-house.js';
import { runPopclawMarkCommand, runPopclawMarksCommand, runPopclawUnmarkCommand } from '../commands/popclaw-mark.js';
import { runPopclawMessageCommand } from '../commands/popclaw-message.js';
import { runPopclawNameCommand } from '../commands/popclaw-name.js';
import { runPopclawNewspaperCommand } from '../commands/popclaw-newspaper.js';
import { runPopclawNextCommand, runPopclawSkipCommand } from '../commands/popclaw-next.js';
import { runPopclawPostCommand } from '../commands/popclaw-post.js';
import { runPopclawReactCommand } from '../commands/popclaw-react.js';
import { runPopclawRecommendCommand } from '../commands/popclaw-recommend.js';
import { runPopclawReplyCommand } from '../commands/popclaw-reply.js';
import { runPopclawReviewCommand } from '../commands/popclaw-review.js';
import { runPopclawSearchCommand } from '../commands/popclaw-search.js';
import { runPopclawStartCommand } from '../commands/popclaw-start.js';
import { runPopclawTasteCommand } from '../commands/popclaw-taste.js';
import { runPopclawUnfollowCommand } from '../commands/popclaw-unfollow.js';
import { runPopclawWhoCommand } from '../commands/popclaw-who.js';
import { runProfileCommand } from '../commands/profile.js';
import { runStatusCommand } from '../commands/status.js';
import { statusDepsFrom } from './status-deps.js';
import { buildDoctorReport } from '../diagnostics/collect.js';
import { sqliteNativeBindingLabel } from '../host/local-host-db.js';
import { formatCandidateList, resolveFollowTarget, verifyPopclawId } from '../identity/follow-resolution.js';
import { localFirst, personSourcesFrom, resolvePerson } from '../identity/person-resolver.js';
import { hostDbSlug, houseUrlOf } from '../ingress/host-slug.js';
import { houseDisplayName } from '../world/house-handshake.js';
import { submitInvite } from '../invite/submit-invite.js';
import { watchInvite } from '../invite/pending-invites.js';
import { renderCopy, type Lang } from '../lexicon/index.js';
import { ownerLang, failureText } from '../lexicon/owner-language.js';
import { extractPostId } from '../quest/verify-invite-handler.js';
import { collectingLogger } from '../runtime/collecting-logger.js';
import { readLastBuild } from '../runtime/last-build.js';
import { canonicalPlatform } from '../scraper/platform-scraper.js';
import { readHouseGuide } from '../world/house-handshake.js';
import { ResolveClient } from '../world/resolve-client.js';

/**
 * Every subcommand name — the single source of truth. `SUBCOMMANDS` is a
 * `Record` over it, so adding or removing a handler without touching this list
 * is a compile error; `HELP_SUBS` is held to the same set by
 * tests/unit/commands/help-parity.test.ts. A subcommand missing from the help
 * table works perfectly and is, to the owner, not there at all — which is
 * exactly what happened to notify-here / notify-off / taste for months.
 */
export const SUBCOMMAND_NAMES = [
  'notify-here', 'notify-off', 'invite', 'follow', 'unfollow', 'recommend', 'react',
  'feedback', 'reply', 'message', 'post', 'canvas', 'brief', 'newspaper', 'inbox',
  'mark', 'unmark', 'marks', 'bond', 'dream', 'taste', 'review', 'who', 'status',
  'version', 'profile', 'name', 'feed', 'search', 'start', 'next', 'skip',
  'doctor', 'help', 'login', 'logout', 'recover',
] as const;

/**
 * `/popclaw help`'s table, in print order. Only the shape lives here — every
 * word comes from the lexicon under `help.<sub>.summary` / `.usage` /
 * `.examples` (newline-separated), so the listing follows the owner's
 * language like every other slash surface (S12).
 *
 * Built per call rather than at register time: `register()` must stay cheap
 * (ADR-0035), and the owner's language is not settled that early.
 */
export const HELP_SUBS: readonly { name: string; usage?: true; examples?: true }[] = [
  { name: 'start' },
  { name: 'login', usage: true, examples: true },
  { name: 'logout', usage: true, examples: true },
  { name: 'recover', usage: true, examples: true },
  { name: 'next', usage: true },
  { name: 'skip' },
  { name: 'status' },
  { name: 'version' },
  { name: 'name', usage: true, examples: true },
  { name: 'profile', usage: true, examples: true },
  { name: 'feed', usage: true },
  { name: 'search', usage: true },
  { name: 'recommend', usage: true },
  { name: 'react', usage: true },
  { name: 'feedback', usage: true },
  { name: 'doctor', usage: true, examples: true },
  { name: 'reply', usage: true, examples: true },
  { name: 'message', usage: true },
  { name: 'post', usage: true, examples: true },
  { name: 'inbox' },
  { name: 'mark', usage: true, examples: true },
  { name: 'unmark', usage: true },
  { name: 'marks', usage: true },
  { name: 'follow', usage: true },
  { name: 'unfollow', usage: true },
  { name: 'bond', usage: true },
  { name: 'dream' },
  { name: 'taste' },
  { name: 'review', usage: true },
  { name: 'who', usage: true, examples: true },
  // ADR-0040 act one, the ideal script for the agent: have the owner post
  // first, use a browser to find that post's link, then submit once with
  // --proof (a low-follower/new account's search index is often blind to
  // it). Once submitted, the result is proactively pushed to the owner —
  // don't poll, don't repeatedly check status.
  { name: 'invite', usage: true },
  { name: 'canvas', usage: true, examples: true },
  { name: 'brief', usage: true },
  { name: 'newspaper', usage: true },
  { name: 'notify-here' },
  { name: 'notify-off' },
  { name: 'help' },
];

/**
 * Everything the map needs from the composition root — and nothing more.
 *
 * All of it is a thunk on purpose (see the laziness note in the file header):
 * the map is built during `register()`, long before any of this may be touched.
 */
export interface SubcommandWiring {
  /** The lazily-booted gateway runtime (getOrCreatePerProcess in index.ts). */
  readonly runtime: () => Promise<OpenClawPluginRuntime>;
  /** Resolved only inside a house command; registration never starts the resident. */
  readonly getHouseCommandContext?: () => HouseCommandContext | Promise<HouseCommandContext>;
  /** The data root, resolved per call the way index.ts always resolved it. */
  readonly paths: () => PopclawPaths;
  /** `<taste>/learned/picks.jsonl` — node:path stays in the composition root. */
  readonly picksFile: () => string;
  /** Host logger warn sink (already carrying the `popclaw: ` prefix). */
  readonly warn: (line: string) => void;
  readonly llmComplete: (prompt: string) => Promise<string>;
  /**
   * How many tools THIS process registered — only known after
   * registerPopclawTools() has run, which is after this map is built, so
   * `/popclaw doctor` has to read it late.
   */
  readonly toolsRegisteredCount: () => number | null;
  /** POPCLAW_BUILD; the esbuild define lives in the composition root. */
  readonly buildStamp: string;
}

function helpEntries(lang: Lang): HelpEntry[] {
  return HELP_SUBS.map((sub) => ({
    name: sub.name,
    summary: renderCopy(lang, `help.${sub.name}.summary`),
    ...(sub.usage ? { usage: renderCopy(lang, `help.${sub.name}.usage`) } : {}),
    ...(sub.examples ? { examples: renderCopy(lang, `help.${sub.name}.examples`).split('\n') } : {}),
  }));
}

// Helper: extract positional + flags from a SubcommandContext whose args
// object carries { positional, flags } (populated by the registerCommand
// wrapper below via parseArgs on the raw string).
function subArgs(ctx: SubcommandContext): { positional: string[]; flags: Record<string, string> } {
  return {
    positional: ctx.args.positional,
    flags: (ctx.args as unknown as { flags?: Record<string, string> }).flags ?? {},
  };
}

/** Build the `/popclaw` subcommand map. Cheap by construction — see the header. */
export function buildSubcommands(
  w: SubcommandWiring,
): Record<(typeof SUBCOMMAND_NAMES)[number], SubcommandHandler> {
  // Person-resolution (ADR-0028 revision): the three sources on the slash-command
  // side — bond book ∪ follow list / world-feed cache authors / lore-house.
  // Order is decided inside PersonResolver; a local hit costs zero round-trips.
  const personSources = (rt: OpenClawPluginRuntime) =>
    personSourcesFrom({
      bonds: () => rt.bondsStore.list(),
      follows: () => rt.socialGraph.following(),
      // Someone who follows me also counts as known (on real hardware,
      // 2026-07-30: host-c followed the owner and the notification even
      // fired, but resolution still "couldn't recognize them" because this
      // table wasn't in the person-resolution source list).
      followers: () => rt.knownFollowers.allFollowerIds(),
      feedAuthors: () => rt.worldFeedCache.authorIds(),
      // The name reported to the owner once someone is resolved goes through
      // the single name chain (an alias overrides the self-declared name from lore-house).
      nameOf: rt.nameOf,
      house: (q) => new ResolveClient({ baseUrl: rt.boot.loreHouseUrl, fetch: rt.houseRuntime?.fetchHouse }).resolve(q),
      // Resolving someone writes it down: a name resolved via lore-house is
      // backfilled into the bond book (fills empty fields only, never creates a row).
      learn: (id, nickname) => void rt.bondsStore.fillNickname(id, nickname),
    });

  // The full dependency set for the DM path (signing / encryption /
  // person-resolution / reply routing / social log). `/popclaw message` and
  // `/popclaw feedback` share the exact same one — feedback IS an ordinary DM
  // (ADR-0042), so whoever adds a dependency to it automatically benefits the
  // other path too; they never drift apart.
  const dmDeps = (rt: OpenClawPluginRuntime) => ({
    signer: rt.boot.signer,
    egress: rt.egress,
    nickname: rt.boot.nickname,
    // Ordinary new slash messages use home; contact history never selects a house.
    houseOfRecipient: () => rt.egress.home.slug,
    verifyRecipient: (id: string, houseSlug?: string) =>
      verifyPopclawId(id, (q) =>
        new ResolveClient({ baseUrl: rt.houseRuntime && houseSlug ? rt.houseRuntime.originForSlug(houseSlug) : houseUrlOf(rt.boot.loreHouseUrls, houseSlug), fetch: rt.houseRuntime?.fetchHouse }).resolve(q),
      ),
    // Person-resolution: name#sigil / bare sigil / name can all be used
    // directly as the recipient.
    resolveRecipient: (ref: string) => resolvePerson(ref, personSources(rt)),
    nameOf: rt.nameOf,
    socialLog: rt.socialLog,
  });

  /** Dependencies for `/popclaw react` (formerly named feedback): the world-feed cache + the picks log. */
  const reactDeps = (rt: OpenClawPluginRuntime) => ({
    cache: rt.worldFeedCache,
    picksFile: w.picksFile(),
  });

  const houseCommand = (operation: 'login' | 'logout' | 'recover'): SubcommandHandler => async (ctx) => {
    const { positional } = subArgs(ctx);
    const target = positional[0]?.trim();
    if (positional.length !== 1 || !target) {
      return { text: renderCopy(ownerLang(), `help.${operation}.usage`) };
    }
    if (!w.getHouseCommandContext) {
      return { text: renderCopy(ownerLang(), 'house.command.unavailable') };
    }
    try {
      const commandContext = await w.getHouseCommandContext();
      const run = operation === 'recover' ? runHouseRecoveryCommand : operation === 'login' ? runHouseLoginCommand : runHouseLogoutCommand;
      return { text: await run(commandContext, target) };
    } catch (err) {
      return { text: failureText(`/popclaw ${operation}`, err) };
    }
  };

  const handlers: Record<(typeof SUBCOMMAND_NAMES)[number], SubcommandHandler> = {
    login: houseCommand('login'),
    logout: houseCommand('logout'),
    recover: houseCommand('recover'),
    // Pin the current channel as the proactive-notification target. The
    // capture hook above stashes rt.lastCommandAddress before routeSubcommand
    // dispatches here (its runtime().then runs before this handler's await).
    'notify-here': async () => {
      const rt = await w.runtime();
      return runNotifyHereCommand(rt.lastCommandAddress ?? {}, rt.ownerNotifyTargetStore);
    },
    'notify-off': async () => {
      const rt = await w.runtime();
      return runNotifyOffCommand(rt.ownerNotifyTargetStore);
    },
    invite: async (ctx) => {
      const a = subArgs(ctx);
      // Canonicalize before signing: "X"/"Twitter" must not become distinct
      // platforms server-side (already-verified checks are keyed by platform).
      const platform = a.positional[0] ? canonicalPlatform(a.positional[0]) : a.positional[0];
      const handle = a.positional[1];
      if (!platform || !handle) {
        return {
          text: renderCopy(ownerLang(), 'invite.usage'),
        };
      }
      // ADR-0034 preflight: a bad proof URL would otherwise be signed, stored,
      // and only surface ~5min later as an unexplained REJECT behind the 24h gate.
      if (a.flags['proof'] !== undefined && !extractPostId(a.flags['proof'])) {
        return {
          text: renderCopy(ownerLang(), 'invite.badProofUrl', { got: a.flags['proof'] }),
        };
      }
      try {
        const rt = await w.runtime();
        // Strip a leading '@' if user types /popclaw invite twitter @blackfeather
        const cleanHandle = handle.replace(/^@/, '');
        return await submitInvite({
          initiate: (opts) => rt.initiator.initiate(opts),
          recordPending: (entry) => rt.pendingInvites.add(entry),
          watch: (taskId) => watchInvite(rt.inviteWatch, taskId),
          onWatchError: (message) => w.warn(message),
          webBaseUrl: rt.boot.webBaseUrl,
        }, {
          platform,
          handle: cleanHandle,
          nickname: a.flags['nickname'] ?? rt.boot.nickname,
          // ADR-0026: swap an already-verified account on this platform.
          replace: a.flags['replace'] !== undefined,
          // ADR-0034: post URL → rangers verify by-id instead of by search.
          proofUrl: a.flags['proof'],
          // `--sync` is the whole opt-in; absent = no.
          mirrorOptin: a.flags['sync'] !== undefined && a.flags['sync'] !== 'false',
        });
      } catch (err) {
        return { text: failureText('invite', err) };
      }
    },

    follow: async (ctx) => {
      const target = (ctx.args.positional[0] ?? '').trim();
      if (!target) return { text: renderCopy(ownerLang(), 'follow.cli.usage') };
      try {
        const rt = await w.runtime();
        // Person-resolution (ADR-0028 + 2026-07-25 revision): sigil/name →
        // local two-source priority first; only query lore-house /v1/resolve
        // when local is empty → a followable popclaw_id.
        const sources = personSources(rt);
        const resolution = await resolveFollowTarget(target, localFirst(sources, target));
        const lang = ownerLang();
        if (resolution.kind === 'lantern') return { text: renderCopy(lang, 'world.lanternDown') };
        if (resolution.kind === 'empty') {
          return { text: renderCopy(lang, 'follow.cli.notRegistered', { ref: resolution.ref }) };
        }
        if (resolution.kind === 'choose') return { text: formatCandidateList(resolution.candidates) };
        const { reply, named } = await followResolved(
          resolution,
          {
            socialGraph: rt.socialGraph,
            ...(subArgs(ctx).flags['house'] !== undefined ? { house: subArgs(ctx).flags['house'] as string } : {}),
            bondsStore: rt.bondsStore,
            socialLog: rt.socialLog,
            ownPopclawId: rt.boot.popclawId,
            houseDisplayName: (slug) => houseDisplayName(rt.paths, rt.boot.loreHouseUrls, slug),
          },
          // `sources` above already holds the house resolver (#468).
          { bondOf: (id) => rt.bondsStore.get(id), house: sources.house },
        );
        if (reply.outcome.kind !== 'accepted') return { text: reply.text };
        // reply.house is the house
        // runFollowCommand's own receipt named — carried over so re-rendering
        // with the resolved name#sigil (or the unverified-id warnings below)
        // doesn't drop the name. Undefined (home house, never guessed) picks
        // the no-house variant.
        const house = reply.house;
        // The one follow receipt; the id checks below only add a line of their own around it.
        const receipt = (who: string): string => `✓ ${followReceivedText(lang, who, house)}`;
        if (resolution.unverified === 'unknown') {
          const warning = renderCopy(lang, 'follow.cli.unknownId', {
            sigil: resolution.sigil ?? '',
            id: resolution.popclawId,
          });
          return { text: `${warning}\n${receipt(resolution.popclawId)}` };
        }
        if (resolution.unverified === 'offline') {
          return { text: `${receipt(resolution.popclawId)} ${renderCopy(lang, 'follow.cli.uncheckedNote')}` };
        }
        // A nameless local hit (someone who followed first) got their name
        // from the house during the follow; the receipt reads it back.
        return { text: receipt(named ?? resolution.popclawId) };
      } catch (err) {
        return { text: failureText('/popclaw follow', err) };
      }
    },

    unfollow: async (ctx) => {
      const target = ctx.args.positional[0] ?? '';
      try {
        const rt = await w.runtime();
        // `outcome` is for in-process callers (the tool); the host gets the
        // slash reply exactly as before — `text`, plus the `house` key on the
        // accepted branch (present even when undefined), nothing else.
        const reply = await runPopclawUnfollowCommand(target, {
          socialGraph: rt.socialGraph,
          ...(subArgs(ctx).flags['house'] !== undefined ? { house: subArgs(ctx).flags['house'] as string } : {}),
          socialLog: rt.socialLog,
          bondsStore: rt.bondsStore,
          ownPopclawId: rt.boot.popclawId,
          houseDisplayName: (slug) => houseDisplayName(rt.paths, rt.boot.loreHouseUrls, slug),
        });
        return 'house' in reply ? { text: reply.text, house: reply.house } : { text: reply.text };
      } catch (err) {
        return { text: failureText('/popclaw unfollow', err) };
      }
    },

    recommend: async (ctx) => {
      try {
        const rt = await w.runtime();
        const paths = w.paths();
        return await runPopclawRecommendCommand(subArgs(ctx), {
          cache: rt.worldFeedCache,
          tasteLoader: rt.tasteLoader,
          cadenceLoader: rt.cadenceLoader,
          socialGraph: rt.socialGraph,
          llmScore: w.llmComplete,
          llmRender: w.llmComplete,
          scoreCache: rt.scoreCache,
          styleFile: paths.canvasStyleFile(),
        });
      } catch (err) {
        return { text: failureText('/popclaw recommend', err) };
      }
    },

    react: async (ctx) => {
      try {
        const rt = await w.runtime();
        return await runPopclawReactCommand(subArgs(ctx), reactDeps(rt));
      } catch (err) {
        return { text: failureText('/popclaw react', err) };
      }
    },

    // The owner/agent speaking to the house officially (ADR-0042): the
    // recipient is the contact declared in this house's guide.md, and it goes
    // through the ordinary DM path. `feedback up|down …` still forwards to
    // react (deprecated alias).
    feedback: async (ctx) => {
      try {
        const rt = await w.runtime();
        return await runPopclawFeedbackCommand(subArgs(ctx), {
          ...dmDeps(rt),
          fetchGuide: () => rt.guideClient.fetchGuideText(),
          houseSlug: hostDbSlug(rt.boot.loreHouseUrl),
          // `--house <slug>`: that house's guide, persisted at handshake time (ADR-0041).
          readHouseGuide: (slug: string) => readHouseGuide(rt.paths, slug),
          knownHouseSlugs: rt.boot.loreHouseUrls.map(hostDbSlug),
          buildStamp: w.buildStamp,
          react: reactDeps(rt),
        });
      } catch (err) {
        return { text: failureText('/popclaw feedback', err) };
      }
    },

    // Beta joint-debug diagnostics (final doc 2026-08-11; the owner renamed
    // the command from diagnose to doctor midway). send reuses feedback's DM
    // path — the attachment is the health report, deps are the same as the
    // `feedback:` entry above, minus the react alias (doctor has no use for it).
    doctor: async (ctx) => {
      try {
        const rt = await w.runtime();
        return await runPopclawDoctorCommand(subArgs(ctx), {
          buildReport: (opts) => buildDoctorReport(rt, w.buildStamp, w.toolsRegisteredCount(), opts),
          feedbackDeps: {
            ...dmDeps(rt),
            fetchGuide: () => rt.guideClient.fetchGuideText(),
            houseSlug: hostDbSlug(rt.boot.loreHouseUrl),
            readHouseGuide: (slug: string) => readHouseGuide(rt.paths, slug),
            knownHouseSlugs: rt.boot.loreHouseUrls.map(hostDbSlug),
            buildStamp: w.buildStamp,
          },
        });
      } catch (err) {
        return { text: failureText('/popclaw doctor', err) };
      }
    },

    reply: async (ctx) => {
      try {
        const rt = await w.runtime();
        return await runPopclawReplyCommand(subArgs(ctx), {
          signer: rt.boot.signer,
          egress: rt.egress,
          cache: rt.worldFeedCache,
          nickname: rt.boot.nickname,
          socialLog: rt.socialLog,
        });
      } catch (err) {
        return { text: failureText('/popclaw reply', err) };
      }
    },

    message: async (ctx) => {
      try {
        const rt = await w.runtime();
        return await runPopclawMessageCommand(subArgs(ctx), dmDeps(rt));
      } catch (err) {
        return { text: failureText('/popclaw message', err) };
      }
    },

    post: async (ctx) => {
      try {
        const rt = await w.runtime();
        return await runPopclawPostCommand(subArgs(ctx), {
          signer: rt.boot.signer,
          egress: rt.egress,
          nickname: rt.boot.nickname,
          cache: rt.worldFeedCache,
          webBaseUrl: rt.boot.webBaseUrl,
          socialLog: rt.socialLog,
        });
      } catch (err) {
        return { text: failureText('/popclaw post', err) };
      }
    },

    canvas: async (ctx) => {
      try {
        const rt = await w.runtime();
        return await runPopclawCanvasCommand(subArgs(ctx), {
          signer: rt.boot.signer,
          nickname: rt.boot.nickname,
          canvasBaseUrl: rt.boot.canvasBaseUrl,
        });
      } catch (err) {
        return { text: failureText('/popclaw canvas', err) };
      }
    },

    // #137: brief retired into the newspaper extra — thin alias. --feedback
    // still records layout notes (canvas-style.md); anything else forwards to
    // the same agent-turn newspaper flow (no plugin-side LLM call).
    brief: async (ctx) => {
      try {
        const paths = w.paths();
        return await runPopclawBriefCommand(subArgs(ctx), {
          styleFile: paths.canvasStyleFile(),
        });
      } catch (err) {
        return { text: failureText('/popclaw brief', err) };
      }
    },

    // Render happens in the agent's turn: hand off (continueAgent) → the agent
    // calls popclaw_newspaper / popclaw_publish_newspaper (spec 2026-06-18).
    // --feedback records a layout note instead (canvas-style.md, #137).
    newspaper: async (ctx) => {
      const paths = w.paths();
      return runPopclawNewspaperCommand(subArgs(ctx), {
        styleFile: paths.canvasStyleFile(),
      });
    },

    inbox: async (ctx) => {
      try {
        const rt = await w.runtime();
        return await runPopclawInboxCommand(subArgs(ctx), { store: rt.inboxStore, nameOf: rt.nameOf });
      } catch (err) {
        return { text: failureText('/popclaw inbox', err) };
      }
    },

    mark: async (ctx) => {
      try {
        const rt = await w.runtime();
        return await runPopclawMarkCommand(subArgs(ctx), {
          cache: rt.worldFeedCache,
          markService: rt.markService,
          socialLog: rt.socialLog,
          nameOf: rt.nameOf,
        });
      } catch (err) {
        return { text: failureText('/popclaw mark', err) };
      }
    },

    unmark: async (ctx) => {
      try {
        const rt = await w.runtime();
        return await runPopclawUnmarkCommand(subArgs(ctx), {
          cache: rt.worldFeedCache,
          markService: rt.markService,
          store: rt.marksStore,
          socialLog: rt.socialLog,
          nameOf: rt.nameOf,
        });
      } catch (err) {
        return { text: failureText('/popclaw unmark', err) };
      }
    },

    marks: async (ctx) => {
      try {
        const rt = await w.runtime();
        return await runPopclawMarksCommand(subArgs(ctx), { store: rt.marksStore, nameOf: rt.nameOf });
      } catch (err) {
        return { text: failureText('/popclaw marks', err) };
      }
    },

    bond: async (ctx) => {
      try {
        const rt = await w.runtime();
        return await runBondCommand(
          { positional: subArgs(ctx).positional },
          {
            bondsStore: rt.bondsStore,
            socialGraph: rt.socialGraph,
            nameOf: rt.nameOf,
            ownPopclawId: rt.boot.popclawId,
            resolvePerson: (ref) => resolvePerson(ref, personSources(rt)),
            // Manual tier sets settle that person's pending proposals —
            // absent on old runtimes, then skipped.
            ...(rt.proposalsStore ? { proposalsStore: rt.proposalsStore } : {}),
          },
        );
      } catch (err) {
        return { text: failureText('/popclaw bond', err) };
      }
    },

    dream: async () => runPopclawDreamCommand(),

    // One-time harvest: has the agent dig "who the owner is" out of its own
    // memory, from whatever it already knows. Expensive (measured at ~590K
    // tokens per run) → only ever triggered by the owner asking, never hung
    // off nightly dreaming.
    taste: async () => runPopclawTasteCommand(),

    review: async (ctx) => {
      try {
        const rt = await w.runtime();
        return await runPopclawReviewCommand(
          { positional: subArgs(ctx).positional },
          {
            bondsStore: rt.bondsStore,
            proposalsStore: rt.proposalsStore,
            nameOf: rt.nameOf,
            // Doorbell §6.5 morning-card double insurance: the gateway root
            // always carries the store (it is the root that pulls the batch).
            pendingFollows: rt.pendingFollows,
          },
        );
      } catch (err) {
        return { text: failureText('/popclaw review', err) };
      }
    },

    who: async (ctx) => {
      try {
        const rt = await w.runtime();
        return await runPopclawWhoCommand(
          { positional: subArgs(ctx).positional },
          { findBonds: (q) => findBonds({ bondsStore: rt.bondsStore, llmComplete: rt.llmComplete }, q) },
        );
      } catch (err) {
        return { text: failureText('/popclaw who', err) };
      }
    },

    status: async (_ctx) => {
      try {
        const rt = await w.runtime();
        const logger = collectingLogger();
        await runStatusCommand({
          ...(await statusDepsFrom(rt, logger)),
          // The capture hook above stamped this command's channel before
          // dispatch → "this channel ✅" vs "not this one".
          currentChannel: rt.lastCommandAddress?.channel,
          // No buildStamp here: the closing position shouldn't carry the
          // least valuable information, and `/popclaw version` already
          // reports the build number specifically (plus Node/ABI). As of
          // slice ④ it lives in the status card's footer instead.
          // Install credential: readLastBuild returns null if missing/corrupt,
          // and this line is silently omitted in that case.
          lastBuildUpgrade: (() => {
            const rec = readLastBuild(rt.paths.lastBuildFile());
            return rec?.previous
              ? { from: rec.previous.build, to: rec.build, recordedAt: rec.recordedAt }
              : null;
          })(),
        });
        return { text: logger.lines.join('\n') };
      } catch (err) {
        return { text: failureText('status', err) };
      }
    },

    // Build/runtime provenance — for dev & testing. Mirrors the boot-log
    // `popclaw: build …` stamp but on demand, plus runtime Node/ABI and the
    // multi-ABI sqlite binary actually loaded.
    version: async () => {
      return {
        text: [
          `popclaw build: ${w.buildStamp}`,
          `runtime: Node ${process.version} (ABI ${process.versions.modules}) ${process.platform}-${process.arch}`,
          `sqlite native: ${sqliteNativeBindingLabel()}`,
        ].join('\n'),
      };
    },

    profile: async (ctx) => {
      const target = ctx.args.positional[0] ?? '';
      if (!target) {
        return { text: 'usage: /popclaw profile <handle>#<sigil>\nexample: /popclaw profile elonmusk#5a57bf' };
      }
      try {
        const rt = await w.runtime();
        return await runProfileCommand(
          { target },
          {
            loreHouseUrl: rt.boot.loreHouseUrl,
            webBaseUrl: rt.boot.webBaseUrl,
            self: { popclawId: rt.boot.popclawId, nickname: rt.boot.nickname },
            fetch: rt.houseRuntime?.fetchHouse ?? globalThis.fetch,
          },
        );
      } catch (err) {
        return { text: failureText('/popclaw profile', err) };
      }
    },

    name: async (ctx) => {
      try {
        const rt = await w.runtime();
        return await runPopclawNameCommand(
          { nickname: ctx.args.positional.join(' ').trim() },
          {
            host: rt.host,
            signer: rt.boot.signer,
            egress: rt.egress,
            popclawId: rt.boot.popclawId,
            clock: rt.host.clock,
            houseOrigins: rt.boot.loreHouseUrls,
            webBaseUrl: rt.boot.webBaseUrl,
            fetch: globalThis.fetch,
          },
        );
      } catch (err) {
        return { text: failureText('/popclaw name', err) };
      }
    },

    feed: async (ctx) => {
      try {
        const rt = await w.runtime();
        return await runPopclawFeedCommand(subArgs(ctx), rt.worldFeedClient, {
          cache: rt.worldFeedCache, publicFeedDisplay: rt.publicFeedDisplay,
        });
      } catch (err) {
        return { text: failureText('/popclaw feed', err) };
      }
    },

    search: async (ctx) => {
      try {
        const rt = await w.runtime();
        return await runPopclawSearchCommand(subArgs(ctx), rt.worldFeedCache, rt.publicFeedDisplay);
      } catch (err) {
        return { text: failureText('/popclaw search', err) };
      }
    },

    start: async (_ctx) => {
      try {
        const rt = await w.runtime();
        return await runPopclawStartCommand({ orchestrator: rt.orchestrator });
      } catch (err) {
        return { text: failureText('/popclaw start', err) };
      }
    },

    next: async (ctx) => {
      try {
        const rt = await w.runtime();
        // S3-T4: all remaining positionals are joined into a free-text answer
        // (candidate number / self-chosen name / menu selection / interest
        // description). No arguments → undefined (bare next).
        const answer = ctx.args.positional.join(' ').trim();
        return await runPopclawNextCommand(
          { orchestrator: rt.orchestrator },
          answer.length > 0 ? answer : undefined,
        );
      } catch (err) {
        return { text: failureText('/popclaw next', err) };
      }
    },

    skip: async (_ctx) => {
      try {
        const rt = await w.runtime();
        return await runPopclawSkipCommand({ orchestrator: rt.orchestrator });
      } catch (err) {
        return { text: failureText('/popclaw skip', err) };
      }
    },

    help: async (ctx) => runHelpCommand(ctx, helpEntries(ownerLang())),
  };
  for (const name of SUBCOMMAND_NAMES) {
    if (['help', 'version', 'login', 'logout'].includes(name)) continue;
    const handler = handlers[name];
    handlers[name] = async ctx => {
      const rt = await w.runtime();
      return rt?.houseRuntime ? rt.houseRuntime.runCommand(() => handler(ctx)) : handler(ctx);
    };
  }
  return handlers;
}
