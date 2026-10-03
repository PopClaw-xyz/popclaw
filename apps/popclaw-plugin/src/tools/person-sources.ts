/**
 * Person resolution for tools: the three sources PersonResolver reads, the
 * owner's own id, and resolving the `person` parameter a tool was given.
 */

import {
  resolvePerson,
  personSourcesFrom,
  type PersonSources,
  type PersonResolution,
} from '../identity/person-resolver.js';
import type { NameChain } from '../identity/person-name.js';
import type { RegisterToolsDeps } from './tools-context.js';
import type { PluginRuntime } from '../runtime/plugin-runtime.js';

/**
 * Resolving a person (ADR-0028 revision): assemble the three sources for
 * PersonResolver. The two local sources come from runtime (bond book ∪
 * follow list / world-feed cache authors); the lore-house source goes through
 * getWorldDeps's resolveClient. When world deps aren't wired up (partial test
 * wiring), the lore-house is treated as unreachable and only local sources count.
 */
export async function buildPersonSources(deps: RegisterToolsDeps): Promise<PersonSources> {
  // Every slot optional on purpose: a read-only tool must never throw because the
  // runtime is not up or only partly wired — a missing slot is an empty source.
  // The names and shapes still come from the contract, so a rename there is a
  // compile error here rather than a source that silently goes empty.
  type PersonRuntime = Partial<
    Pick<PluginRuntime, 'bondsStore' | 'nameOf' | 'socialGraph' | 'knownFollowers' | 'worldFeedCache' | 'boot'>
  >;
  // Local sources are frozen on a single read: during person-resolution,
  // resolveFollowTarget calls resolve twice (the full-id path validates the
  // sigil first, then fetches candidates); reading once saves a second DB
  // query. Any DB hiccup (runtime not up, sqlite hiccup) is swallowed into an
  // empty source — resolution falls back to the lore-house, and a read-only
  // tool must never throw because of this.
  // ponytail: every tool call does a full read of the bond book + author
  // table; revisit indexing/caching once the roster hits tens of thousands.
  let bonds: ReadonlyArray<{ popclawId: string; nickname: string; remarkName: string }> = [];
  let follows: ReadonlyArray<{ popclawId: string }> = [];
  let followers: readonly string[] = [];
  let authors: readonly string[] = [];
  // Writing back needs the **live** store (the read was a snapshot, the write can't be); skip the write-back if it's unavailable.
  let learn: ((id: string, nickname: string) => void) | undefined;
  // Which name to **display** once someone is resolved: the single name chain (alias overrides the lore-house-supplied self-reported name).
  let nameOf: NameChain | undefined;
  // The owner themselves: read from the same snapshot, so "who am I" costs no
  // round-trip and works on an identity no house has ever heard of.
  let self: { popclawId: string; nickname: string } | undefined;
  try {
    const rt: PersonRuntime | undefined = await deps.runtime();
    bonds = rt?.bondsStore?.list?.() ?? [];
    follows = rt?.socialGraph?.following?.() ?? [];
    followers = rt?.knownFollowers?.allFollowerIds?.() ?? [];
    authors = rt?.worldFeedCache?.authorIds?.() ?? [];
    const fill = rt?.bondsStore?.fillNickname;
    if (fill) learn = (id, nickname) => void fill.call(rt!.bondsStore, id, nickname);
    nameOf = rt?.nameOf;
    const id = rt?.boot?.popclawId ?? '';
    if (id) self = { popclawId: id, nickname: rt?.boot?.nickname ?? '' };
  } catch {
    /* Both local sources unavailable → empty, only the lore-house is left */
  }
  return personSourcesFrom({
    bonds: () => bonds,
    follows: () => follows,
    followers: () => followers,
    feedAuthors: () => authors,
    ...(self ? { self: () => self } : {}),
    ...(learn ? { learn } : {}),
    ...(nameOf ? { nameOf } : {}),
    house: async (q) => {
      if (!deps.getWorldDeps) return null;
      try {
        const wd = await deps.getWorldDeps();
        return await wd.resolveClient.resolve(q);
      } catch {
        return null; // The lore-house leg is broken = unreachable; resolution honestly reports "temporarily unreachable"
      }
    },
  });
}

/**
 * The owner's own popclaw_id, or '' when the runtime cannot say.
 *
 * Self is a resolution candidate (see `self` in personSourcesFrom), which is
 * what READ tools want — "show my namecard" has to work. WRITE tools must not
 * inherit it: a follow, an unfollow, a DM or a bond row aimed at oneself signs
 * an event and pushes it, or writes a local row asserting a relation with
 * oneself. They compare against this and refuse with `person.thatIsYou`.
 *
 * '' is the safe answer: it matches nobody, so a runtime that cannot say who
 * the owner is never blocks a legitimate write.
 */
export async function ownerPopclawId(deps: RegisterToolsDeps): Promise<string> {
  try {
    // Optional on purpose: this answers '' rather than throw when the runtime cannot say.
    const rt: Partial<Pick<PluginRuntime, 'boot'>> | undefined = await deps.runtime();
    return rt?.boot?.popclawId ?? '';
  } catch {
    return '';
  }
}

/** Resolve the "person" parameter: the two local sources (bond book / world feed) take priority, the lore-house is the fallback. */
export async function resolvePersonRef(input: string, deps: RegisterToolsDeps): Promise<PersonResolution> {
  return resolvePerson(input, await buildPersonSources(deps));
}
