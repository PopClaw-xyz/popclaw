/**
 * /popclaw follow <popclaw_id | platform:handle>
 *
 * Signs a FollowDeclared event via SocialGraph, records the durable
 * relation operation, and pushes to lore-house. Falls back to a clear error
 * message if the SocialGraph hasn't started.
 */

import type { SocialGraph } from '../social-graph/social-graph.js';
import { safeRecord, type SocialLogRecorder } from '../social-log/social-log.js';
import { personSourcesFrom, localFirst, displayPerson, selfWriteRefusal } from '../identity/person-resolver.js';
import { resolveFollowTarget, type ResolveCandidate } from '../identity/follow-resolution.js';
import { platformLabel } from '../world/summary-format.js';
import { houseDisplayName } from '../world/house-handshake.js';
import type { PopclawPaths } from '../host/popclaw-paths.js';
import { ownerLang, failureText } from '../lexicon/owner-language.js';
import { deriveSigil } from '../invite/sigil.js';
import { renderCopy, type Lang } from '../lexicon/index.js';
import { RelationWriteUnavailableError, relationRefusalCopyKey } from '../social-graph/social-graph.js';
import type { NameChain } from '../identity/person-name.js';
import type { ErrandFollowOutcome } from '../onboarding/orchestrator.js';
import type { BondsStore } from '../bonds/bonds-store.js';
import { ResolveClient } from '../world/resolve-client.js';

export interface FollowCommandDeps {
  socialGraph: SocialGraph;
  /** Explicit owner-selected house; absent uses the ordinary relation default. */
  house?: string;
  /** Social-log collection point `follow_added` (spec 2026-07-26 §4). If not injected, not recorded. */
  socialLog?: SocialLogRecorder;
  /**
   * Plan B bond-book: optional follow→bonds projection. When present, a
   * successful follow records an interaction + sets followed=true on the bond
   * (records on first contact). Optional so the dev CLI / legacy callers stay unaffected.
   */
  bondsStore?: {
    setFollowed(id: string, v: boolean): unknown;
    recordInteraction(id: string, ts?: number): unknown;
    /** #468 variant B: needed only for the name backfill below. */
    fillNickname?(id: string, nickname: string): unknown;
  };
  /**
   * #468: ask the house for this person's nickname **once, at follow time**,
   * when resolution produced none.
   *
   * Resolution deliberately short-circuits on a local hit and never asks the
   * house (`person-resolver.ts` header: tiers 1/2 are zero-round-trip, server
   * minimization) — so following someone whose only local trace is a bare id
   * writes a nameless bond row, and every later surface renders `—#sigil`
   * until the next startup nickname sync happens to pick them up.
   *
   * Following is the right place to pay for a name: it is rare, deliberate,
   * and already on the network (declareFollow signs and pushes). One resolve
   * here buys a name for every surface afterwards, without touching the
   * resolution hot path. Omitted = today's behaviour, no lookup.
   */
  resolveNickname?: (popclawId: string) => Promise<string>;
  /**
   * The name resolution already produced for this person, if any. The bond
   * row does not exist until this follow creates it, so the write-back that
   * ran during resolution (fill-only-empty, never creates a row) had nothing
   * to fill — without this, a first follow of someone the house named leaves
   * a nameless row behind. Written fill-only-empty, and costs no round trip.
   */
  knownNickname?: string;
  /**
   * The owner's own popclaw_id. Following yourself signs a FollowDeclared and
   * pushes it, asserting a relationship that cannot exist — and since the
   * owner became resolvable by name, their own NAME reaches here too, not just
   * a pasted id.
   *
   * REQUIRED, deliberately: it was optional for one round and the onboarding
   * errand's own followDeps literal (errandFollowFrom) simply did not set it,
   * so the errand followed the owner and nothing complained. The compiler is
   * the only reviewer that reads every composition root.
   */
  ownPopclawId: string;
  /**
   * Follow doorbell (spec §6.5): pending → confirmed, called ONLY after
   * declareFollow actually succeeded for that person — failures stay pending,
   * so the retry / next-day piggyback legs pick them up (nothing
   * double-counts: the absorbing side's followsIn only looks at established
   * follows, never at this status). No-op on non-pending rows, so wiring it
   * into every successful follow is safe. Optional: absent = no marking.
   */
  pendingFollows?: { markConfirmed(id: string): void };
  /**
   * Resolve a house slug (`outcome.houseSlug`) to the name shown to the
   * owner: the house's own self-reported name, or its origin host — never
   * the bare slug (owner acceptance on package 4d07af17: "house-popclaw-me"
   * leaked into the receipt). Omitted, or returning undefined for this
   * slug, falls back to the no-house wording, the same "never guess" rule
   * `relation.followReceivedNoHouse` already applies to an unresolved
   * `houseSlug`.
   */
  houseDisplayName?: (slug: string) => string | undefined;
}

/** Resolve `target` (popclaw_id or "platform:handle") to a popclaw_id. */
async function resolveTarget(target: string, _deps: FollowCommandDeps): Promise<string> {
  // Only popclaw_id is accepted directly here. Higher-level entry points
  // resolve human-readable targets before invoking this command.
  if (target.includes(':')) {
    throw new Error(`platform:handle resolution not yet supported (Plan 11.1); pass a base58 popclaw_id directly`);
  }
  return target;
}

/**
 * The name a follow may write into the bond book from its resolution: the
 * candidate's nickname, unless it is the owner's private alias for them. A
 * local hit on a row with no house name reports the alias (remark_name) as the
 * nickname, and that is not the name they go by.
 */
export function followNameOf(
  candidate: ResolveCandidate | undefined,
  remarkName: string | undefined,
): string | undefined {
  const name = candidate?.nickname;
  return name && name !== remarkName ? name : undefined;
}

/**
 * What a follow actually did, for callers to decide on — the receipt text is
 * for the owner, never for control flow.
 *
 * - `accepted`: a house took the signed declaration and the local projections
 *   (bonds, social log, names) ran. The only case whose receipt leads with `✓`.
 * - `queued`: signed and durable, no house has taken it yet; it will be re-sent.
 * - `refused`: stopped before anything was signed.
 * - `failed`: something threw. `transport: 'accepted'` means the house had
 *   already taken it and a local projection failed afterwards — do not send it
 *   again. `unknown` means it threw before this layer saw the house accept —
 *   inside the declare call, or while wording a queued receipt — so whether it
 *   left cannot be told from here.
 */
export type FollowOutcome =
  | { kind: 'accepted' }
  | { kind: 'queued' }
  | { kind: 'refused'; reason: 'usage' | 'badTarget' | 'self' | 'house' | 'writeUnavailable' }
  | { kind: 'failed'; transport: 'accepted' | 'unknown' };

export interface FollowReply {
  text: string;
  house?: string;
  outcome: FollowOutcome;
}

export async function runFollowCommand(
  target: string,
  deps: FollowCommandDeps,
): Promise<FollowReply> {
  if (!target) return { text: 'usage: /popclaw follow <popclaw_id>', outcome: { kind: 'refused', reason: 'usage' } };
  let popclawId: string;
  try {
    popclawId = await resolveTarget(target, deps);
  } catch (err) {
    return { text: `⚠️ ${String(err)}`, outcome: { kind: 'refused', reason: 'badTarget' } };
  }
  // Before anything is signed. Every entrance — tool, slash command, dev CLI —
  // passes through here, so this is the one place the check has to hold.
  const refusal = selfWriteRefusal(popclawId, deps.ownPopclawId);
  if (refusal) return { text: refusal, outcome: { kind: 'refused', reason: 'self' } };
  // Set once a house has taken the declaration, so a later projection failure
  // is reported as what it is rather than as "never sent".
  let transportAccepted = false;
  try {
    const outcome = deps.house === undefined
      ? await deps.socialGraph.declareFollowWithOutcome(popclawId)
      : await deps.socialGraph.declareFollowWithOutcome(popclawId, { house: deps.house });
    if (outcome.mode === 'none') {
      // Refused before signing. Not a failure of the network and not a follow —
      // and, when it is the HOUSE that offers no follow, not a failure of this
      // build either, which is what the single shared sentence used to claim.
      return {
        text: `⚠️ ${renderCopy(ownerLang(), relationRefusalCopyKey(outcome.reason), { who: popclawId })}`,
        outcome: { kind: 'refused', reason: 'house' },
      };
    }
    if (outcome.transport !== 'accepted') {
      // Signed and durable, but no house has taken it yet. It will be re-sent.
      // The projections below say "this happened" — bonds, the social log, a
      // pending follow graduating to confirmed — and none of that is true yet,
      // so they wait. FOLLOW-UP: nothing re-runs them when a later re-send
      // succeeds, so a queued follow stays absent from bonds until the owner
      // acts again. That gap moves with the resend path, not here.
      // not accepted yet, so no house is named —
      // naming one before it has actually landed there would claim something
      // the transport hasn't confirmed.
      return {
        text: `… ${renderCopy(ownerLang(), 'relation.followQueued', { who: popclawId })}`,
        outcome: { kind: 'queued' },
      };
    }
    transportAccepted = true;
    const houseSlug = outcome.houseSlug;
    // Follow doorbell: the follow is on the wire NOW, so its pending row (if
    // any) graduates to confirmed here — before the projections below, which
    // can still throw and mislabel an already-declared follow as failed. A
    // store hiccup must not fail the receipt either (same discipline as
    // resolveNickname below): a missed marking only means the doorbell may
    // re-ask about someone already followed.
    try {
      deps.pendingFollows?.markConfirmed(popclawId);
    } catch {
      /* stays pending; the retry / next-day piggyback legs own it */
    }
    // Record on first contact: project the follow into bonds (record interaction + followed=true).
    deps.bondsStore?.recordInteraction(popclawId);
    deps.bondsStore?.setFollowed(popclawId, true);
    // Social log: declareFollow is signed and pushed successfully. **After the bonds projection**
    // -- so tier_then captures the tier at that moment, right after "record on first contact",
    // matching what the owner saw at the time.
    // The house is resolved by declareFollow (ADR-0037: following is a per-house declaration;
    // its origin cannot be backfilled).
    safeRecord(deps.socialLog, {
      kind: 'follow_added',
      ...(houseSlug ? { house_slug: houseSlug } : {}),
      actor: { id: popclawId },
    });
    // The bond row exists now: write the name resolution already has.
    if (deps.knownNickname && deps.bondsStore?.fillNickname) {
      try {
        deps.bondsStore.fillNickname(popclawId, deps.knownNickname);
      } catch {
        /* cosmetic, same as below: the follow is already on the wire */
      }
    }
    // #468: the bond row exists now; give it a name if it has none. Never let
    // this fail the follow — the follow already succeeded and is on the wire,
    // and a missing nickname is a cosmetic loss, not a failed action.
    if (deps.resolveNickname && deps.bondsStore?.fillNickname) {
      try {
        const name = await deps.resolveNickname(popclawId);
        if (name) deps.bondsStore.fillNickname(popclawId, name);
      } catch {
        /* the house is down or slow: the startup nickname sync will get them later */
      }
    }
    // Accepted by the house — relation.followReceived says exactly that
    // ("{house} has the follow declaration"), no more: not "the other end has
    // applied it", which is a fact only their own stream can report. It used
    // to say "now publicly following", which claimed the one thing this
    // branch cannot know; that wording is gone.
    //
    // name the house ONLY when it is actually
    // known — never guess. In production `relation-scope.ts` always resolves
    // a slug (falling back to the home house's own), so `houseSlug` undefined
    // here is defensive, not a real path; `relation.followReceivedNoHouse` is
    // the same receipt with the house clause dropped for that case, not a
    // guess. `house` rides along on the return value (still possibly
    // undefined) so a caller that re-renders this same choice with a
    // resolved name#sigil (the MCP tool, the CLI, the
    // onboarding errand) doesn't have to re-derive it.
    //
    // `house` is a NAME, never the raw `houseSlug` — `deps.houseDisplayName`
    // resolves it (self-reported name, else origin host); no resolver, or no
    // name for this slug, is the same "unknown house" case as an unresolved
    // `houseSlug` and falls back to the no-house wording rather than render
    // the slug (owner acceptance on package 4d07af17).
    const house = houseSlug ? deps.houseDisplayName?.(houseSlug) : undefined;
    return { text: `✓ ${followReceivedText(ownerLang(), popclawId, house)}`, house, outcome: { kind: 'accepted' } };
  } catch (err) {
    if (err instanceof RelationWriteUnavailableError) {
      return {
        text: `⚠️ ${renderCopy(ownerLang(), 'relation.writeUnavailable')}`,
        outcome: { kind: 'refused', reason: 'writeUnavailable' },
      };
    }
    return {
      text: failureText('follow', err),
      outcome: { kind: 'failed', transport: transportAccepted ? 'accepted' : 'unknown' },
    };
  }
}

/**
 * The receipt for an accepted follow: names the house only when it is known,
 * otherwise the same sentence without the house (never a guessed one).
 */
export function followReceivedText(lang: Lang, who: string, house: string | undefined): string {
  return renderCopy(
    lang,
    house ? 'relation.followReceived' : 'relation.followReceivedNoHouse',
    house ? { who, house } : { who },
  );
}

/**
 * Follow someone resolution has already named uniquely — the part every
 * entrance (slash command, popclaw_follow, the onboarding errand) did word
 * for word: hand over the name resolution already has, or else a way to ask
 * the house for one (#468: someone already known keeps the zero-round-trip
 * promise, person-resolver.ts header), run the follow, and read back the
 * name#sigil once it was accepted. `named` is read AFTER the follow, because a
 * nameless local hit gets its name from the house during it; it is absent
 * when the follow was not accepted or resolution had no candidate — each
 * entrance picks its own fallback then.
 */
export async function followResolved(
  target: { popclawId: string; candidate?: ResolveCandidate },
  deps: FollowCommandDeps,
  names: {
    bondOf: (popclawId: string) => { nickname?: string; remarkName?: string } | null | undefined;
    house: (q: { sigil?: string; name?: string }) => Promise<ResolveCandidate[] | null>;
  },
): Promise<{ reply: FollowReply; named?: string }> {
  const c = target.candidate;
  const knownNickname = followNameOf(c, names.bondOf(target.popclawId)?.remarkName);
  const reply = await runFollowCommand(target.popclawId, {
    ...deps,
    knownNickname,
    ...(knownNickname
      ? {}
      : {
          resolveNickname: async (id: string) => {
            const cands = await names.house({ sigil: deriveSigil(id) });
            return cands?.find((cand) => cand.popclawId === id)?.nickname ?? '';
          },
        }),
  });
  if (reply.outcome.kind !== 'accepted' || !c) return { reply };
  return { reply, named: `${c.nickname || names.bondOf(c.popclawId)?.nickname || ''}#${c.sigil}` };
}

/**
 * The errand act's person-resolution + follow.
 *
 * Goes through the exact same chain as `/popclaw follow` (local two-source
 * priority → lore-house `/v1/resolve` → runFollowCommand signed push +
 * bond-book projection); this just translates the result into the four outcomes
 * onboarding can speak. **A second person-resolution path is never invented** —
 * which is why it lives here rather than in each composition root: the gateway
 * (index.ts) and the MCP bridge (mcp.ts) must be holding the same one.
 */
export function makeErrandFollow(deps: {
  bonds: () => ReadonlyArray<{ popclawId: string; nickname: string; remarkName: string }>;
  follows: () => ReadonlyArray<{ popclawId: string }>;
  /** People who follow me (`known_followers`) — see personSourcesFrom's `followers`. */
  followers: () => readonly string[];
  feedAuthors: () => readonly string[];
  nameOf: NameChain;
  house: (q: { sigil?: string; name?: string }) => Promise<ResolveCandidate[] | null>;
  fillNickname: (id: string, nickname: string) => void;
  followDeps: FollowCommandDeps;
}): (ref: string) => Promise<ErrandFollowOutcome> {
  return async (ref: string): Promise<ErrandFollowOutcome> => {
    const sources = personSourcesFrom({
      bonds: deps.bonds,
      follows: deps.follows,
      followers: deps.followers,
      feedAuthors: deps.feedAuthors,
      nameOf: deps.nameOf,
      house: deps.house,
      learn: deps.fillNickname,
    });
    const resolution = await resolveFollowTarget(ref, localFirst(sources, ref));
    if (resolution.kind === 'lantern') {
      return { kind: 'unavailable', reason: renderCopy(ownerLang(), 'world.lanternDownShort') };
    }
    if (resolution.kind === 'empty') return { kind: 'notFound', ref: resolution.ref };
    if (resolution.kind === 'choose') {
      return {
        kind: 'choose',
        lines: resolution.candidates.map((c) => `· ${c.nickname}#${c.sigil}`),
      };
    }
    const c = resolution.candidate;
    const bondOf = (id: string) => deps.bonds().find((b) => b.popclawId === id);
    const { reply, named } = await followResolved(resolution, deps.followDeps, { bondOf, house: deps.house });
    if (reply.outcome.kind !== 'accepted') return { kind: 'unavailable', reason: reply.text };
    // The verification line is **conditional**: mentioned only if the other
    // person has their own endorsement displayed; otherwise not a word about it.
    const verified = c?.profiles?.[0]?.platform;
    return {
      kind: 'followed',
      // A nameless local hit got its name from the house during the follow.
      display: named ?? displayPerson(resolution.popclawId),
      ...(verified ? { verifiedPlatform: platformLabel(verified) } : {}),
      // G1-copy: carry the house runFollowCommand's own receipt named, so the
      // errand's card doesn't fall back to a generic "the lore-house".
      ...(reply.house ? { house: reply.house } : {}),
    };
  };
}

/**
 * The errand-follow wiring both tool-registering roots hold.
 *
 * index.ts and mcp.ts assembled the same eight lines by hand — which stores
 * feed person-resolution, which lore-house answers `/v1/resolve`, where the
 * resolved nickname is written back. Same reason `makeErrandFollow` itself
 * lives here rather than in each root: the gateway and the MCP bridge must be
 * holding the same chain, and "the same" is much easier to keep true when
 * there is only one copy of it.
 */
export function errandFollowFrom(parts: {
  bondsStore: BondsStore;
  socialGraph: SocialGraph;
  /** `known_followers` — the fifth source every other resolution path already has (#438). */
  knownFollowers: { allFollowerIds(): readonly string[] };
  worldFeedCache: { authorIds: () => readonly string[] };
  socialLog?: SocialLogRecorder;
  nameOf: NameChain;
  /** The home house — the lore-house leg of person-resolution. */
  loreHouseUrl: string;
  /** The owner's own popclaw_id — required, like the field it fills in `followDeps`. */
  ownPopclawId: string;
  fetch?: typeof globalThis.fetch;
  /**
   * The data root and the full configured house list — together resolve
   * `outcome.houseSlug` to a name for the errand's follow card
   * (`FollowCommandDeps.houseDisplayName`). Both optional: omitted, the
   * card falls back to the no-house wording rather than name any house —
   * the same "never guess" rule as an unresolved `houseSlug`.
   */
  paths?: PopclawPaths;
  loreHouseUrls?: readonly string[];
}): (ref: string) => Promise<ErrandFollowOutcome> {
  return makeErrandFollow({
    bonds: () => parts.bondsStore.list(),
    follows: () => parts.socialGraph.following(),
    followers: () => parts.knownFollowers.allFollowerIds(),
    feedAuthors: () => parts.worldFeedCache.authorIds(),
    nameOf: parts.nameOf,
    house: (q) => new ResolveClient({ baseUrl: parts.loreHouseUrl, fetch: parts.fetch }).resolve(q),
    fillNickname: (id, nickname) => void parts.bondsStore.fillNickname(id, nickname),
    followDeps: {
      socialGraph: parts.socialGraph,
      bondsStore: parts.bondsStore,
      ownPopclawId: parts.ownPopclawId,
      ...(parts.socialLog ? { socialLog: parts.socialLog } : {}),
      ...(parts.paths && parts.loreHouseUrls
        ? { houseDisplayName: (slug: string) => houseDisplayName(parts.paths!, parts.loreHouseUrls!, slug) }
        : {}),
    },
  });
}
