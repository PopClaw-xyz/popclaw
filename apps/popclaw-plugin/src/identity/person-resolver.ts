/**
 * PersonResolver — identity resolution sunk down into a general translation
 * layer at the tool boundary (ADR-0028 revision, 2026-07-25).
 *
 * Every tool that takes a "person" parameter (DM / author_latest / follow)
 * goes through here: the human-usable form the owner types (full popclaw_id /
 * nickname#sigil / bare sigil / bare nickname) → the machine key (full
 * popclaw_id). The resolution order reflects storage sovereignty and
 * server-minimization:
 *   1. bond book + follow list (people I know, local authority, zero round-trip)
 *   2. world-feed local-cache authors and their latest observed names
 *   3. lore-house `/v1/resolve` (strangers, ask the house last)
 * Ambiguity lists candidates rather than guessing; a miss is reported
 * honestly (the "honesty" gene).
 *
 * Grammar and the lore-house call are always reused from follow-resolution
 * (parseFollowTarget / resolveFollowTarget) — this file only inserts two
 * local sources in front of it, it doesn't reimplement a second parser.
 */
import { deriveSigil, normalizeSigilInput } from '../invite/sigil.js';
import { resolveFollowTarget, type ResolveCandidate } from './follow-resolution.js';
import type { NameChain } from './person-name.js';
import { renderCopy, type Lang } from '../lexicon/index.js';
import { ownerLang } from '../lexicon/owner-language.js';

// Rollout slice 1: resolvePerson's `invalid` reason + unresolvedText render in
// `ownerLang()` — same S3 pattern as the pilot's disambiguationText/
// displayPerson. Self-contained strings (no per-caller Chinese wrapper), so
// safe to migrate even though this is shared with out-of-slice callers
// (send_draft, popclaw_set_remark_name, popclaw_bond, popclaw_message).

/** One row for a person I know: one id can have multiple rows (one for nickname, one for alias). */
export interface KnownPerson {
  readonly popclawId: string;
  readonly nickname: string;
}

export interface PersonSources {
  /** 1. bond book ∪ follow list ∪ people who follow me. */
  known: () => KnownPerson[];
  /** 2. Author ids seen in the world-feed cache. */
  seen: () => readonly string[];
  /** Latest explicitly observed names, tied to IDs; search clues, never credentials. */
  seenNames?: () => readonly KnownPerson[];
  /**
   * The owner's own identity, matched **exactly** — never by substring.
   *
   * It is not a row in `known()` for a reason. Every row there is somebody the
   * owner chose to know, and the name lane matches them by substring; self is
   * present on EVERY install, so the same looseness would let the owner's own
   * name shadow a stranger whose name it merely contains — owner
   * `blackfeather_ai` swallowing a real `blackfeather`, with the house never
   * asked. Sigil and full id are unaffected (they address one id by
   * construction), so only the name lane is tightened.
   */
  self?: () => { popclawId: string; nickname: string } | null | undefined;
  /** 3. lore-house `/v1/resolve`; returns null when the lore-house is unreachable (≠ an empty array's "no such person"). */
  house: (q: { sigil?: string; name?: string }) => Promise<ResolveCandidate[] | null>;
  /** Sigil derivation, defaults to deriveSigil (injectable for tests). */
  sigilOf?: (id: string) => string;
  /**
   * Write a resolved nickname back to the bond book (fill-empty-only, never
   * creates a row — the rule lives in BondsStore.fillNickname). If omitted,
   * nothing is written back. Any thrown error is swallowed by localFirst:
   * identity resolution must never fail just because the write-back failed.
   */
  learn?: (popclawId: string, nickname: string) => void;
  /**
   * The single name chain (alias > self-reported nickname > handle). **Only
   * governs display, not matching**: matching still recognizes both names
   * (the owner may address them by alias or by their self-reported
   * nickname), but once resolved, this chain decides which name is reported
   * back to the owner — alias wins. Not injected = old behavior.
   */
  nameOf?: NameChain;
}

export type PersonResolution =
  | {
      kind: 'resolved';
      popclawId: string;
      nickname: string;
      sigil: string;
      /**
       * The lore-house **failed** to verify this id: `unknown` = the
       * lore-house is online and explicitly answered "no such person";
       * `offline` = the lore-house is unreachable, no way to tell. Absent =
       * the lore-house confirmed it.
       *
       * Why this can't be swallowed (real-machine incident, 2026-07-30): an
       * agent passed in popclaw.world's official id thinking it was
       * host-c's, and the draft preview came back with `—#6q0w4z7r`, which
       * looks identical to "a recipient the lore-house confirmed" — the
       * agent got a green light and could only make up its own explanation
       * ("the nickname just hasn't propagated to the system yet"). The risk
       * of mistaken identity happens at the human/machine boundary, so the
       * verification state has to reach the caller directly.
       *
       * Still `resolved` (not a hard reject): an id the owner typed by hand
       * should work, and "this person genuinely exists, this particular
       * house just has no namecard for them" is a legitimate scenario
       * (ADR-0028 — that's exactly how following works) — a hard reject
       * would kill real use cases along with the bad ones.
       */
      unverified?: 'unknown' | 'offline';
    }
  | {
      kind: 'ambiguous';
      candidates: ResolveCandidate[];
      /** The candidates are a guess (see FollowResolution.guessed) — the owner has to confirm even if there is only one (#287). */
      guessed?: true;
    }
  | { kind: 'notFound'; ref: string; lanternDown?: boolean }
  | { kind: 'invalid'; reason: string };

/** lowercase + strip whitespace — 'host - a' / 'ELON' collapse to the same key (same convention as follow-resolution). */
function norm(s: string): string {
  return s.toLowerCase().replace(/\s+/g, '');
}

/**
 * A forward scan over the two local sources: sigil derivation is one-way, so
 * matching works by computing each id's sigil one at a time (ADR-0028).
 * Sigils are compared by prefix (ADR-0015's 6-12 char parse window). The same
 * id only ever produces one candidate.
 */
export function localCandidates(
  q: { sigil?: string; name?: string },
  sources: PersonSources,
): ResolveCandidate[] {
  const sigilOf = sources.sigilOf ?? deriveSigil;
  const me = sources.self?.();
  // Self names remain exact even when the owner's posts are in the cache.
  const observed = (sources.seenNames?.() ?? []).filter(p => p.popclawId !== me?.popclawId);
  const byId = new Map<string, ResolveCandidate>();
  const add = (popclawId: string, nickname: string): void => {
    const prev = byId.get(popclawId);
    if (!prev) byId.set(popclawId, { popclawId, nickname, sigil: sigilOf(popclawId), profiles: [] });
    else if (!prev.nickname && nickname) byId.set(popclawId, { ...prev, nickname });
  };

  if (q.sigil) {
    for (const p of [...sources.known(), ...observed]) {
      // The nickname also has to be compared in its "folded" shape: a Latin
      // nickname (blackfeather) is itself valid Crockford input, so the
      // grammar would parse it as sigil b1ackfeather — if we only compared
      // the derived sigil, every Latin nickname in the bond book would be
      // missed, reproducing the original DM incident the moment the
      // lore-house goes down.
      if (sigilOf(p.popclawId).startsWith(q.sigil) || normalizeSigilInput(p.nickname) === q.sigil) {
        add(p.popclawId, p.nickname);
      }
    }
    for (const id of sources.seen()) {
      if (sigilOf(id).startsWith(q.sigil)) add(id, '');
    }
  } else if (q.name) {
    const n = norm(q.name);
    for (const p of [...sources.known(), ...observed]) {
      if (p.nickname && norm(p.nickname).includes(n)) add(p.popclawId, p.nickname);
    }
  }

  // The owner, last (so a bond alias for the same id still supplies the
  // displayed name) and EXACT (see `self` in PersonSources). The sigil lane is
  // the ordinary one — a sigil addresses exactly one id, and the folded-name
  // comparison is an equality too — while the name lane demands the whole
  // name, not a fragment of it.
  if (me?.popclawId) {
    const matched = q.sigil
      ? sigilOf(me.popclawId).startsWith(q.sigil) || normalizeSigilInput(me.nickname) === q.sigil
      : Boolean(q.name) && me.nickname !== '' && norm(me.nickname) === norm(q.name!);
    if (matched) add(me.popclawId, me.nickname);
  }
  return [...byId.values()];
}

/**
 * Wraps the two local sources in front of the lore-house and hands the
 * result to resolveFollowTarget as its `resolve`: a local hit returns
 * immediately (zero round-trips), and the lore-house is only asked when the
 * local sources come up empty.
 *
 * **A nickname the lore-house resolves is written back to the bond book in
 * passing** (`learn`): otherwise identity resolution does all that work and
 * throws it away, so every incoming message and every follow notice falls
 * back to `#sigil` — the bond book is supposed to be the single source of
 * truth for local social assets, and the nickname of anyone I know should
 * live there. This is the only "new knowledge" exit point across the
 * three-tier resolution (tier 1's local hit means it's already known, so it
 * skips this), so the hook is wired only here, and both follow paths plus
 * DM/author_latest all funnel through this one opening.
 *
 * ponytail: for a full-id input, resolveFollowTarget calls resolve twice, so
 * the local sources get scanned twice (O(roster) each time), and the write-
 * back also fires twice (fillNickname is idempotent, so the second call is 0
 * changes). Only worth revisiting once the roster hits the tens of thousands
 * or the scan lands on a hot path.
 */
export function localFirst(
  sources: PersonSources,
): (q: { sigil?: string; name?: string }) => Promise<ResolveCandidate[] | null> {
  return async (q) => {
    const local = localCandidates(q, sources);
    if (local.length > 0) return local;
    const remote = await sources.house(q);
    if (remote && sources.learn) {
      for (const c of remote) {
        if (!c.nickname) continue;
        try {
          sources.learn(c.popclawId, c.nickname);
        } catch {
          /* The write-back is a side channel: a locked db or a missing table should never stop the owner from recognizing someone */
        }
      }
    }
    return remote;
  };
}

/**
 * Assembles the three sources from runtime parts (slash commands and tools
 * share one mapping): both a bond's nickname and its alias are names the
 * owner might use, so each gets its own row (localCandidates dedupes the
 * multiple rows for the same id).
 */
export function personSourcesFrom(parts: {
  bonds?: () => ReadonlyArray<{ popclawId: string; nickname: string; remarkName: string }>;
  follows?: () => ReadonlyArray<{ popclawId: string }>;
  /**
   * **People who follow me** (`known_followers`, aggregated across houses).
   * Id only, no nickname — same tier as `follows`.
   *
   * Why this has to be a source (real-machine incident, 2026-07-30): host-c
   * followed the owner at 23:40, and the plugin even pushed a "someone
   * followed you" notification for it — the id was sitting right there in
   * `known_followers`. But identity resolution only checked the bond book /
   * follow list / world-feed authors, so a person who should have been
   * recognized with zero round-trips instead fell back to the lore-house;
   * and their nickname had been broadcast to their old house (switching
   * houses doesn't re-seed the namecard), so they weren't in the
   * lore-house's roster either → from the owner's point of view, "popclaw
   * can't recognize this #9b2y5d3f person." **Anyone the owner has been
   * notified about, the owner must be able to name.**
   */
  followers?: () => readonly string[];
  feedAuthors?: () => readonly string[];
  /** Latest observed feed names, kept separate from the display NameChain. */
  feedNames?: () => readonly KnownPerson[];
  /**
   * **The owner's own identity.** Status hands the owner their own
   * `name#sigil` and their own popclaw_id, and the very next lookup used to
   * deny them: self was in none of the sources above, and the lore-house
   * cannot fill the gap either — a placeholder-named identity that never
   * posted has no row in `profile_cards`, `verified_profiles` or
   * `world_feed_items`, and announce-namecard deliberately publishes nothing
   * for a `ranger-xxxxxx`. The only place that knows who the owner is, is this
   * machine.
   *
   * A LOCAL row, so it costs no round-trip; and because `localFirst` only
   * learns from what the HOUSE returned, self is never written into the bond
   * book — that book is for other people.
   */
  self?: () => { popclawId: string; nickname: string } | null | undefined;
  house: (q: { sigil?: string; name?: string }) => Promise<ResolveCandidate[] | null>;
  /** A nickname the lore-house resolves is written back to the bond book; if omitted, resolution happens but nothing is recorded (old behavior). */
  learn?: (popclawId: string, nickname: string) => void;
  /** The single name chain: which name to **display** once resolved (alias takes priority). */
  nameOf?: NameChain;
}): PersonSources {
  return {
    ...(parts.learn ? { learn: parts.learn } : {}),
    ...(parts.nameOf ? { nameOf: parts.nameOf } : {}),
    known: () => {
      const out: KnownPerson[] = [];
      for (const b of parts.bonds?.() ?? []) {
        out.push({ popclawId: b.popclawId, nickname: b.nickname });
        if (b.remarkName && b.remarkName !== b.nickname) {
          out.push({ popclawId: b.popclawId, nickname: b.remarkName });
        }
      }
      for (const f of parts.follows?.() ?? []) out.push({ popclawId: f.popclawId, nickname: '' });
      for (const id of parts.followers?.() ?? []) out.push({ popclawId: id, nickname: '' });
      return out;
    },
    seen: () => parts.feedAuthors?.() ?? [],
    ...(parts.feedNames ? { seenNames: parts.feedNames } : {}),
    ...(parts.self ? { self: parts.self } : {}),
    house: parts.house,
  };
}

/**
 * The refusal a relation write owes the owner, or `null` when the target is
 * somebody else.
 *
 * ONE sentence, ONE comparison, used by every entrance: the tools, the slash
 * commands and the dev CLI all funnel into the same commands, and a guard that
 * lived only at the tool layer left `/popclaw follow <own popclaw_id>` signing
 * and pushing a self-follow — the owner's own id is printed in every status
 * report, so it is not an exotic input.
 *
 * An unknown owner id (`undefined` / '') refuses nothing: a partly wired
 * runtime must never block a legitimate write.
 */
export function selfWriteRefusal(
  target: string,
  ownerId: string | undefined,
  lang: Lang = ownerLang(),
): string | null {
  return ownerId && target === ownerId ? renderCopy(lang, 'person.thatIsYou') : null;
}

/** Human-usable form → full popclaw_id. Ambiguity lists candidates, a miss is reported honestly, empty input is invalid. */
export async function resolvePerson(
  input: string,
  sources: PersonSources,
  lang: Lang = ownerLang(),
): Promise<PersonResolution> {
  const ref = input.trim();
  if (ref.length === 0) {
    return { kind: 'invalid', reason: renderCopy(lang, 'person.mustSayWho') };
  }
  const sigilOf = sources.sigilOf ?? deriveSigil;
  const r = await resolveFollowTarget(ref, localFirst(sources));
  switch (r.kind) {
    case 'lantern':
      return { kind: 'notFound', ref, lanternDown: true };
    case 'empty':
      return { kind: 'notFound', ref: r.ref };
    case 'choose': {
      // A bare nickname only passes through on a unique hit: follow always
      // lists candidates for a fuzzy key (following is a committing action),
      // but here a single candidate is enough to pass through (the
      // downstream action has its own confirmation gate).
      //
      // #287: except when the candidates are a *guess*. A sigil that matched
      // nothing, retried as a name substring, can land on someone who has no
      // relation to what the owner meant — and the caller downstream is
      // send_draft as often as it is follow. "Unique" is only a licence to
      // skip confirmation when it is unique among things that actually
      // matched what was typed.
      const only = r.candidates[0];
      if (r.candidates.length === 1 && only && !r.guessed) {
        return {
          kind: 'resolved',
          popclawId: only.popclawId,
          nickname: shownName(sources, only.popclawId, only.nickname),
          sigil: only.sigil,
        };
      }
      // The candidate list is also shown to the owner (unresolvedText echoes it back out) → same chain.
      return {
        kind: 'ambiguous',
        ...(r.guessed ? { guessed: true as const } : {}),
        candidates: r.candidates.map((c) => ({
          ...c,
          nickname: shownName(sources, c.popclawId, c.nickname),
        })),
      };
    }
    default: {
      const c = r.candidate;
      return {
        kind: 'resolved',
        popclawId: r.popclawId,
        nickname: shownName(sources, r.popclawId, c?.nickname ?? ''),
        sigil: c?.sigil ?? r.sigil ?? sigilOf(r.popclawId),
        // resolveFollowTarget already computed this — it used to get thrown away here, see the unverified comment.
        ...(r.unverified ? { unverified: r.unverified } : {}),
      };
    }
  }
}

/** The name **reported to the owner** once resolved: the single name chain (alias > self-reported nickname). */
function shownName(sources: PersonSources, popclawId: string, serverName: string): string {
  return sources.nameOf?.(popclawId, serverName) || serverName;
}

/** `nickname#sigil（full id）`— human-readable for people, the key for machines (ADR-0015 layering). */
export function formatPerson(
  p: { nickname: string; sigil: string; popclawId: string },
  lang: Lang = ownerLang(),
): string {
  return lang === 'zh-CN'
    ? `${p.nickname || '—'}#${p.sigil}（${p.popclawId}）`
    : `${p.nickname || '—'}#${p.sigil} (${p.popclawId})`;
}

/**
 * The form of address visible to the owner (ADR-0032 convention): with a
 * nickname → `nickname#sigil`; with no nickname → report only `#sigil`.
 *
 * **Any output shown to the owner goes through here** — the first 8 chars of
 * a bare popclaw_id (`@Demo1234`) proved to be pure noise on real machines:
 * the owner has no idea who that is. The sigil itself is a legitimate form
 * of address (there's precedent in status: "report only the sigil when the
 * roster has no name for them"), and it's much better than an id prefix.
 *
 * Where the name comes from is up to the caller, but it **must be a local
 * source** (bond-book name → world-feed handle): this function runs on the
 * delivery hot path and must never touch the network.
 *
 * Never derive a sigil when there isn't even an id — the SHA-256 of an empty
 * string still produces something that looks like a valid sigil, and that
 * would be a lie.
 */
/**
 * Does this string look like a raw popclaw_id (base58, no whitespace, no @)?
 *
 * Shape only — it does not claim the id belongs to a registered person. Callers
 * use it to decide which *lookup* an input deserves: a full id addresses the
 * by-id endpoint directly, anything else has to go through resolution first.
 */
export function looksLikeBase58Id(s: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{32,64}$/.test(s);
}

/** A full public key is an identity anchor, never a nickname/display handle. */
export function displayNickname(value: string | null | undefined): string {
  const name = (value ?? '').trim();
  return looksLikeBase58Id(name) ? '' : name;
}

export function displayPerson(popclawId: string, name?: string, lang: Lang = ownerLang()): string {
  const n = (name ?? '').trim();
  if (!popclawId) return n || renderCopy(lang, 'person.unknown');
  return `${n}#${deriveSigil(popclawId)}`;
}

/** Unified copy for the non-hit states (shared by DM / tools): list candidates for the owner to pick from, or honestly say there's no match. */
export function unresolvedText(ref: string, r: PersonResolution, lang: Lang = ownerLang()): string {
  if (r.kind === 'ambiguous') {
    const lines = r.candidates.map((c, i) => `${i + 1}. ${formatPerson(c, lang)}`);
    // Say which question is being answered. "matches N people" would be a lie
    // for the guessed list: no sigil matched at all, these are name lookalikes.
    const key = r.guessed ? 'person.sigilMissedNameLookalikes' : 'person.ambiguous';
    return `${renderCopy(lang, key, { ref, count: String(r.candidates.length) })}\n${lines.join('\n')}`;
  }
  if (r.kind === 'invalid') return r.reason;
  if (r.kind === 'notFound' && r.lanternDown) {
    return renderCopy(lang, 'person.lanternDownUnknown', { ref });
  }
  return renderCopy(lang, 'person.notFound', { ref });
}
