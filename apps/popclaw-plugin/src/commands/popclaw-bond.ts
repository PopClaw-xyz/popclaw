/**
 * /popclaw bond add|friend|close|block|reject <who>  — set a bond's tier (manual)
 * /popclaw bond remark <person> [alias]                — assign an alias to a person (omit to clear)
 * /popclaw bond list                                  — the bond book (default), summary + tiers
 * /popclaw bond follows                                — full follow list (shows name#sigil)
 *
 * <who> is a popclaw_id (or 10-hex prefix). Setting a tier is a manual
 * override (tier_source='manual'); peak_tier is raised monotonically by the
 * store. This is the SURFACE over BondsStore — see bonds/bonds-store.ts.
 *
 * Principle: action commands perform actions (follow/unfollow); asset commands inspect assets (bond).
 */

import type { BondsStore, Bond } from '../bonds/bonds-store.js';
import type { BondTier } from '../bonds/bond-tier.js';
import { isAtLeast, tierLabel } from '../bonds/bond-tier.js';
import type { SocialGraph } from '../social-graph/social-graph.js';
import { deriveSigil } from '../invite/sigil.js';
import { parseFollowTarget } from '../identity/follow-resolution.js';
import { formatPerson, selfWriteRefusal, unresolvedText, type PersonResolution } from '../identity/person-resolver.js';
import type { NameChain } from '../identity/person-name.js';
import { displayNamed } from '../identity/person-name.js';
import type { ProposalsStore } from '../bonds/proposals-store.js';
import { followDisplayName } from './status.js';
import { renderCopy, type Lang } from '../lexicon/index.js';
import { ownerLang } from '../lexicon/owner-language.js';

export interface BondCommandArgs {
  positional: string[];
  /** Optional floor for the `list` branch (popclaw_show_bonds min_tier). */
  minTier?: BondTier;
  /** Optional cap for the `list` branch (popclaw_show_bonds limit). */
  limit?: number;
}
export interface BondCommandDeps {
  bondsStore: Pick<BondsStore, 'setTier' | 'list' | 'get'> & Partial<Pick<BondsStore, 'setKnowledge'>>;
  /** Following count + "follows" listing source. */
  socialGraph?: Pick<SocialGraph, 'following'>;
  /** The unique name chain (alias > self-reported name > world-feed handle); if not injected, always resolves to unknown. */
  nameOf?: NameChain;
  /** Person resolution: human-friendly form → full popclaw_id. When not injected, `remark` only accepts a full id. */
  resolvePerson?: (ref: string) => Promise<PersonResolution>;
  /** When injected, a manual tier set also settles that person's pending
   *  proposals; absent = old behaviour. */
  proposalsStore?: Pick<ProposalsStore, 'settlePendingForManualTier'>;
  /** S3 rollout — defaults to `ownerLang()` (S1 process-wide singleton). */
  lang?: Lang;
  /**
   * The owner's own popclaw_id. A tier or an alias is a judgement about
   * somebody else; a bond row about oneself is a relationship the book must
   * not hold. Checked AFTER the id is known, so it holds on every lane —
   * a full id (which skips resolution entirely, see runRemark) as well as a
   * name. Omitted = no check.
   */
  ownPopclawId?: string;
}

const VERB_TO_TIER: Record<string, BondTier> = {
  add: 'friend',
  friend: 'friend',
  close: 'close',
  block: 'blocked',
  reject: 'reject',
};

export async function runBondCommand(
  args: BondCommandArgs,
  deps: BondCommandDeps,
): Promise<{ text: string }> {
  const lang = deps.lang ?? ownerLang();
  const [verb, who] = args.positional;
  if (!verb || verb === 'list') {
    const bonds = deps.bondsStore.list({ minTier: args.minTier, limit: args.limit });
    // The header counters must agree with the rows printed below them: both
    // read the same `bonds` array, so a row marked `followed` is always
    // exactly one of the `following` the header claims (previously the
    // header counted deps.socialGraph.following() — a second, independently
    // populated source that can lag the bonds projection, e.g. before
    // SocialGraph.start() has run — while every row's marker already read
    // bond.followed; the two disagreeing is what real installs saw as
    // "following 0" over rows that say otherwise).
    const following = bonds.filter((b) => b.followed).length;
    const friends = bonds.filter((b) => isAtLeast(b.tier, 'friend')).length;
    const summary = renderCopy(lang, 'bond.summary', {
      following: String(following),
      friends: String(friends),
    });
    if (bonds.length === 0) return { text: `${summary}\n${renderCopy(lang, 'bond.empty')}` };
    // Display name#sigil (human-readable), with the full popclaw_id (machine key) at the
    // end of the line — the agent can DM/follow directly from this without resolving again
    // (ADR-0028 revision, 2026-07-25).
    const lines = bonds.map(
      (b: Bond) =>
        `${tierLabel(b.tier, lang)}\t${formatPerson({
          // The unique name chain (alias > self-reported name > handle); if the chain isn't wired up, fall back to the two fields in the book.
          nickname: deps.nameOf?.(b.popclawId) || b.remarkName || b.nickname,
          sigil: deriveSigil(b.popclawId),
          popclawId: b.popclawId,
        }, lang)}${b.followed ? renderCopy(lang, 'bond.followedMarker') : ''}`,
    );
    return {
      text: `${summary}\n${renderCopy(lang, 'bond.listHeader', { count: String(bonds.length) })}\n${lines.join('\n')}`,
    };
  }
  if (verb === 'follows') {
    const following = [...(deps.socialGraph?.following() ?? [])].sort((a, b) => b.since - a.since);
    if (following.length === 0) return { text: renderCopy(lang, 'bond.noFollows') };
    const lines = following.map((f) =>
      formatPerson({
        nickname: followDisplayName(f.popclawId, deps.nameOf),
        sigil: deriveSigil(f.popclawId),
        popclawId: f.popclawId,
      }, lang),
    );
    return { text: `${renderCopy(lang, 'bond.followsHeader', { count: String(following.length) })}\n${lines.join('\n')}` };
  }
  if (verb === 'remark') return runRemark(args.positional.slice(1), deps, lang);
  const tier = VERB_TO_TIER[verb];
  if (!tier) {
    return { text: renderCopy(lang, 'bond.unknownVerb', { verb }) };
  }
  if (!who) return { text: renderCopy(lang, 'bond.missingWho', { verb }) };
  const tierRefusal = selfWriteRefusal(who, deps.ownPopclawId, lang);
  if (tierRefusal) return { text: tierRefusal };
  const bond = deps.bondsStore.setTier(who, tier, 'manual');
  // A manual tier move settles that person's pending proposals — no stale
  // suggestion may resurface later. Best-effort: the tier HAS moved, so a
  // settle failure must not fail the receipt (the settle is idempotent,
  // retried on the next move).
  try {
    deps.proposalsStore?.settlePendingForManualTier(who, tier);
  } catch {
    // swallowed on purpose — see above
  }
  return {
    text: renderCopy(lang, 'bond.tierSet', {
      who: displayNamed(who, deps.nameOf),
      tier: tierLabel(bond.tier, lang),
    }),
  };
}

/**
 * `/popclaw bond remark <person> [alias]` — the owner assigns an alias to a person (like WeChat's remark name).
 * Once an alias exists, every name shown to the owner across the project uses it (the first tier of the unique name chain).
 * **Omitting the alias = clear it**, and the display falls back to the other person's self-reported name.
 *
 * The alias is purely local: it only writes `bonds.remark_name` and never leaves the device (no envelope carries it).
 */
async function runRemark(rest: string[], deps: BondCommandDeps, lang: Lang): Promise<{ text: string }> {
  const [ref, ...nameParts] = rest;
  if (!ref) {
    return { text: renderCopy(lang, 'bond.remark.usage') };
  }
  // A full popclaw_id skips person resolution: setting an alias is a purely local action and must work even if lore-house is down.
  let popclawId = ref;
  const parsed = parseFollowTarget(ref);
  if (parsed.kind !== 'popclawId') {
    if (!deps.resolvePerson) {
      return { text: renderCopy(lang, 'bond.remark.noResolver', { ref }) };
    }
    const r = await deps.resolvePerson(ref);
    if (r.kind !== 'resolved') return { text: unresolvedText(ref, r, lang) };
    popclawId = r.popclawId;
  }
  // After resolution AND after the full-id short-circuit above — the id lane
  // never calls `deps.resolvePerson`, so a guard living in that callback was
  // bypassed by pasting the owner's own id, which every status report prints.
  const refusal = selfWriteRefusal(popclawId, deps.ownPopclawId, lang);
  if (refusal) return { text: refusal };
  if (!deps.bondsStore.setKnowledge) {
    return { text: renderCopy(lang, 'bond.remark.noWriteAccess') };
  }
  const remarkName = nameParts.join(' ').trim();
  deps.bondsStore.setKnowledge(popclawId, { remarkName });
  const sigil = deriveSigil(popclawId);
  // The receipt shows the new display name directly -- so the owner can see at a glance "this is what they'll be called from now on."
  const bond = deps.bondsStore.get(popclawId);
  const now = deps.nameOf?.(popclawId) || bond?.remarkName || bond?.nickname || '';
  if (!remarkName) {
    return { text: renderCopy(lang, 'bond.remark.cleared', { name: now || `#${sigil}` }) };
  }
  return { text: renderCopy(lang, 'bond.remark.set', { name: `${now}#${sigil}` }) };
}
