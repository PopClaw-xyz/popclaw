/**
 * The single name chain (owner's call, 2026-07-29) — a person has exactly one
 * form of address in front of the owner, with a fixed source order:
 *
 *   alias (bonds.remark_name) > self-reported nickname (bonds.nickname ∪ the
 *     server-given nickname) > world-feed handle > house name (official house
 *     nickname only) > '' (→ `displayPerson` falls back to `#sigil`)
 *
 * Like WeChat: **the alias I gave you always overrides your self-reported
 * name**. The name the server gives (lore-house `/v1/resolve`, world-summary,
 * namecard) **is** the other party's self-reported nickname, so it slots into
 * the second tier of the chain rather than sitting alongside the alias.
 *
 * Fully synchronous, zero network — it runs on the delivery hot path (same
 * discipline as `displayPerson`). The alias is a **purely local** asset: only
 * rendering reads it, and it never leaves the client in any envelope or
 * outbound request.
 *
 * `displayPerson` only handles "how to display" (`nickname#sigil` / `#sigil`);
 * this file handles "where the name comes from".
 */
import { displayPerson } from './person-resolver.js';

/** The two bond-book fields relevant to "what to call them". */
export interface BondNames {
  readonly nickname?: string;
  readonly remarkName?: string;
}

/**
 * The name chain. `serverName` = the server's/the other party's self-reported
 * nickname (omit if there is none); it only competes for the chain's second
 * tier. Returns `''` = nothing at all, and the caller hands it to
 * `displayPerson` to fall back to `#sigil`.
 */
export type NameChain = (popclawId: string, serverName?: string) => string;

/** Assembles a name chain. Either source may be missing (skip that tier if so). */
export function makeNameChain(src: {
  /** One bond-book row (`BondsStore.get`). */
  bond?: (popclawId: string) => BondNames | null | undefined;
  /** This author's most recent handle in the world-feed cache. */
  handleFromFeed?: (popclawId: string) => string | undefined;
  /**
   * This nickname is a connected house's official nickname → that house's
   * name. Official houses don't issue namecards, so the first three tiers
   * are always empty for them (real machine: a postcard notification only
   * ever reports `#6q0w4z7r`). Last tier in the chain, never outranks a
   * person's self-reported name.
   */
  houseOfficialName?: (popclawId: string) => string | undefined;
}): NameChain {
  return (popclawId, serverName) => {
    if (!popclawId) return (serverName ?? '').trim();
    // A db lookup going sideways (runtime not up / sqlite hiccup) must never
    // let one line of address take down the whole render.
    let bond: BondNames | null | undefined;
    try {
      bond = src.bond?.(popclawId);
    } catch {
      bond = null;
    }
    return (
      (bond?.remarkName ?? '').trim() ||
      (bond?.nickname ?? '').trim() ||
      (serverName ?? '').trim() ||
      (src.handleFromFeed?.(popclawId) ?? '').trim() ||
      houseNameOf(src, popclawId) ||
      ''
    );
  };
}

/** The house-name fallback reads the on-disk handshake file; unreadable = treated as absent (same discipline as the bond-book lookup: never take down the render). */
function houseNameOf(
  src: { houseOfficialName?: (popclawId: string) => string | undefined },
  popclawId: string,
): string {
  try {
    return (src.houseOfficialName?.(popclawId) ?? '').trim();
  } catch {
    return '';
  }
}

/**
 * `nickname#sigil`, with the name resolved via the single name chain. **Any
 * form of address shown to the owner should go through here**; if the chain
 * isn't injected (some test fixtures / legacy call sites), it falls back to
 * the server-given name — identical to the pre-change behavior.
 */
export function displayNamed(
  popclawId: string,
  nameOf: NameChain | undefined,
  serverName?: string,
): string {
  return displayPerson(popclawId, nameOf ? nameOf(popclawId, serverName) : serverName);
}
