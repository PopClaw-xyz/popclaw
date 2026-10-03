/**
 * The relation side and the pin table have to agree on how a house is SPELLED.
 *
 * `config.lore_houses` is validated by `z.string().url()` and nothing else, so
 * `https://house.popclaw.me/` (trailing slash) and `https://House.popclaw.me`
 * (mixed case) are both accepted verbatim and travel raw into the strict
 * slug→origin map. The trust pin, though, is filed under the CANONICAL origin
 * — `HouseRuntime` normalises before it binds, and migration 034 states the
 * key outright: "Canonical origin, no trailing slash, no path."
 *
 * `pinnedBinding` is an exact `WHERE origin = ?`. So a raw spelling in the map
 * means every ordered relation push at that house refuses with "no pinned
 * binding for …", and the scope resolver's `prepareConfirmHouseTrust` refuses
 * HOUSE_NOT_TRUSTED — at a house the owner configured and the runtime trusts.
 * The two shipped default houses happen to be canonical already, which is why
 * nothing caught this.
 *
 * The last two cases are the other half of the fix. Canonicalising collapses
 * two spellings of ONE house into one origin, and the conflict detector must
 * not read that as "the config named two houses by one name" — while two
 * genuinely different origins at one slug must still conflict, forever.
 */
import { describe, expect, it, vi } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { popclaw } from '@popclaw/contracts';
import { InMemoryHostDb } from '../../../src/host/in-memory-host-db.js';
import type { HostDb } from '../../../src/host/host-db.js';
import { runMigrations } from '../../../src/host/migrations.js';
import { buildStrictSlugMap, makeRelationScopeResolver } from '../../../src/social-graph/relation-scope.js';
import { makeRelationPush } from '../../../src/social-graph/relation-push.js';

const MIGRATIONS = resolve(dirname(fileURLToPath(import.meta.url)), '../../../migrations');

const CANONICAL = 'https://house.popclaw.me';
const HOUSE_KEY = '9xQeWy8P3vNhKd2RmTzA6BcFgJ4LnSuVoXpYrEt5Hw1Z';
const FOLLOWEE = '7LhZ8x6c8Kmw5P9Wtnm4T6E7YcbTpZ7N7tfZcqLRv5cM';

/** A db whose ONLY pin is filed under the canonical origin — what the runtime
 *  actually writes, and the whole point of the mismatch. */
function dbWithCanonicalPin(): HostDb {
  const db = new InMemoryHostDb();
  runMigrations(db, MIGRATIONS);
  db.execute(
    `INSERT INTO house_binding_pin
       (origin, house_key, incarnation, source, first_trusted_at, confirmed_at, revision)
     VALUES (?, ?, 'inc-1', 'configured', 1, 1, 1)`,
    [CANONICAL, HOUSE_KEY],
  );
  db.execute(
    `INSERT INTO relation_participation (house_key, owner_generation, active, updated_at)
     VALUES (?, 1, 1, 1)`,
    [HOUSE_KEY],
  );
  return db;
}

/** The wire shape the push adapter really decodes: an envelope carrying an
 *  ordered follow, wrapped in the SignedPayload sign-event produces. */
function orderedFollowBytes(): Uint8Array {
  const envelope = popclaw.event.EventEnvelope.encode({
    eventId: 'evt-1',
    followDeclared: { followeePopclawId: FOLLOWEE, order: { seq: 1, houseKey: HOUSE_KEY } },
  }).finish();
  return popclaw.identity.SignedPayload.encode({ payload: envelope }).finish();
}

describe('a configured house spelled uncanonically', () => {
  // The two spellings `z.string().url()` waves through unchanged.
  for (const [label, configured] of [
    ['a trailing slash', 'https://house.popclaw.me/'],
    ['a mixed-case host', 'https://House.PopClaw.me'],
  ] as const) {
    it(`still finds its pin on the push path — ${label}`, async () => {
      const db = dbWithCanonicalPin();
      const pushVerified = vi.fn(async () => ({ status: 200, eventId: 'evt-1' }) as never);
      const push = makeRelationPush({
        db,
        houses: [{ slug: 'house-popclaw-me', origin: configured }],
        pushVerified,
      });

      // The assertion is that this does NOT throw "no pinned binding for …".
      await expect(push(orderedFollowBytes(), 'house-popclaw-me')).resolves.toMatchObject({
        status: 200,
      });
      expect(pushVerified).toHaveBeenCalledTimes(1);
    });

    it(`gets past the trust gate on the scope path — ${label}`, async () => {
      const db = dbWithCanonicalPin();
      // A pin that is found sends the resolver to the network; a pin that is
      // not is refused BEFORE it, so "was the fetch reached" is exactly the
      // variable under test.
      const fetch = vi.fn(async () => {
        throw new Error('house unreachable — the resolver got this far');
      });
      const resolveScope = makeRelationScopeResolver({
        db,
        houses: [{ slug: 'house-popclaw-me', origin: configured }],
        fetch: fetch as unknown as typeof globalThis.fetch,
      });

      const scope = await resolveScope({ action: 'declare', followee: FOLLOWEE });

      expect(fetch).toHaveBeenCalledTimes(1);
      // Not the pre-network trust refusal — that is the bug's signature.
      expect(scope).not.toMatchObject({ detail: 'HOUSE_NOT_TRUSTED' });
      expect(scope.support).toBe('unreachable');
    });
  }
});

describe('the strict slug map and duplicate configuration', () => {
  it('collapses two spellings of one house instead of conflicting', () => {
    // `plugin-bootstrap` already treats these as "equivalent URLs" and
    // deduplicates them silently; an exactly-repeated line already collapses
    // here. Two spellings of one house must not be STRICTER than two
    // identical lines, or a harmless config slip silently disables every
    // relation at that house.
    const map = buildStrictSlugMap([
      { slug: 'house-popclaw-me', origin: 'https://House.popclaw.me/' },
      { slug: 'house-popclaw-me', origin: CANONICAL },
    ]);

    expect(map.lookup('house-popclaw-me')).toEqual({ origin: CANONICAL });
    // And the home house is still the first one named.
    expect(map.homeSlug).toBe('house-popclaw-me');
  });

  it('still conflicts, stickily, when one slug names two different houses', () => {
    // The case the map exists for: picking either is the guess it refuses.
    const map = buildStrictSlugMap([
      { slug: 'shared', origin: 'https://house-a.popclaw.me' },
      { slug: 'shared', origin: 'https://house-b.popclaw.me/' },
      // Sticky: a repeat of the second must not end "unconflicted B".
      { slug: 'shared', origin: 'https://house-b.popclaw.me' },
    ]);

    expect(map.lookup('shared')).toEqual({ conflict: true });
  });
});
