/**
 * Where the destination of a home-entry link comes from, and what is refused.
 *
 * Two halves, and both matter. The validation matrix is pure and covers the
 * shapes a house can declare — including the ones that look fine and are not,
 * because "same origin as the audience" is the only thing standing between a
 * login key and somebody else's site. The projection half goes through the
 * real trust machinery: a real signed manifest, the real prepare/commit pair,
 * the real pin. A fixture that wrote the row by hand would prove nothing about
 * provenance, which is the whole property.
 */
import { describe, expect, it } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import nacl from 'tweetnacl';
import { InMemoryHostDb } from '../../../src/host/in-memory-host-db.js';
import { runMigrations } from '../../../src/host/migrations.js';
import {
  beginHouseAdd,
  commitEstablishAndActivate,
  confirmHouseTrust,
  prepareHouseTrust,
} from '../../../src/world/house-trust.js';
import {
  declarationFingerprint,
  declarationOf,
  readVerifiedDeclaration,
} from '../../../src/world/house-read-declaration.js';
import { pinnedBinding } from '../../../src/world/house-binding-pin.js';
import { decideBrowserEntry } from '../../../src/identity/browser-entry-authority.js';
import {
  BROWSER_ENTRY_PROFILE,
  browserEntryFingerprint,
  browserEntryOf,
  selectBrowserEntry,
} from '../../../src/identity/browser-entry.js';
import { mintHouse } from '../../helpers/signed-manifest.js';

const MIGRATIONS = resolve(dirname(fileURLToPath(import.meta.url)), '../../../migrations');
const HOUSE = 'https://house.example';
const APP = 'https://app.example';

const ENTRY = {
  profile: BROWSER_ENTRY_PROFILE,
  audience: APP,
  entry_url: `${APP}/welcome`,
  shorten_url: `${APP}/api/shorten`,
};

function freshDb() {
  const db = new InMemoryHostDb();
  runMigrations(db, MIGRATIONS);
  return db;
}

async function add(db: InMemoryHostDb, manifest: Record<string, unknown>) {
  const house = mintHouse({ origin: HOUSE, seed: 1, manifest });
  const prepared = await prepareHouseTrust(db, HOUSE, {
    fetch: house.fetch as typeof globalThis.fetch,
    attempt: beginHouseAdd(db, HOUSE),
    now: () => 1_700_000_000,
  });
  if (!prepared.ok) return { house, outcome: prepared };
  return { house, outcome: commitEstablishAndActivate(db, prepared.prepared, { now: () => 1_700_000_000 }) };
}

const bytesOf = (doc: unknown) => new TextEncoder().encode(JSON.stringify(doc));

describe('lifting browser_entry out of a manifest', () => {
  it('reads the four declared fields', () => {
    expect(browserEntryOf({ browser_entry: ENTRY })).toEqual({
      profile: BROWSER_ENTRY_PROFILE,
      audience: APP,
      entryUrl: `${APP}/welcome`,
      shortenUrl: `${APP}/api/shorten`,
    });
  });

  it('keeps "said nothing" and "said something naming nothing" apart', () => {
    // Silence: this house offers no browser entrance at all.
    expect(browserEntryOf({})).toBeUndefined();
    expect(browserEntryOf({ browser_entry: null })).toBeUndefined();
    // A block that named nothing usable is still a block — a misconfigured
    // house, which is a different thing to tell the owner than a house
    // without the feature.
    expect(browserEntryOf({ browser_entry: {} })).toEqual({});
    expect(browserEntryOf({ browser_entry: 'https://app.example' })).toEqual({});
  });

  it('drops non-string fields rather than coercing them into URLs', () => {
    expect(browserEntryOf({ browser_entry: { ...ENTRY, entry_url: 42 } })).toEqual({
      profile: BROWSER_ENTRY_PROFILE,
      audience: APP,
      shortenUrl: `${APP}/api/shorten`,
    });
  });
});

describe('the declaration validation matrix', () => {
  const ok = (over: Record<string, unknown> = {}) =>
    selectBrowserEntry(browserEntryOf({ browser_entry: { ...ENTRY, ...over } }));

  it('accepts a complete https declaration on one origin', () => {
    expect(ok()).toEqual({
      entry: {
        profile: BROWSER_ENTRY_PROFILE,
        audience: APP,
        entryUrl: `${APP}/welcome`,
        shortenUrl: `${APP}/api/shorten`,
      },
    });
  });

  it('accepts a declaration with no shortener — the long link is then the deliverable', () => {
    const out = selectBrowserEntry(
      browserEntryOf({ browser_entry: { profile: BROWSER_ENTRY_PROFILE, audience: APP, entry_url: `${APP}/welcome` } }),
    );
    expect('entry' in out && out.entry.shortenUrl).toBeUndefined();
  });

  it('refuses silence, and refuses an empty block differently from a wrong one', () => {
    expect(selectBrowserEntry(undefined)).toEqual({ refusal: 'BROWSER_ENTRY_NOT_DECLARED' });
    expect(selectBrowserEntry(browserEntryOf({ browser_entry: {} }))).toEqual({
      refusal: 'BROWSER_ENTRY_PROFILE_UNSUPPORTED',
    });
  });

  it.each([
    ['a profile from another version', { profile: 'popclaw-browser-entry-v1' }, 'BROWSER_ENTRY_PROFILE_UNSUPPORTED'],
    ['a profile that merely starts the same', { profile: `${BROWSER_ENTRY_PROFILE}-beta` }, 'BROWSER_ENTRY_PROFILE_UNSUPPORTED'],
    ['no audience', { audience: undefined }, 'BROWSER_ENTRY_DECLARATION_INCOMPLETE'],
    ['no entry url', { entry_url: undefined }, 'BROWSER_ENTRY_DECLARATION_INCOMPLETE'],
    ['a plain-http audience', { audience: 'http://app.example', entry_url: 'http://app.example/welcome', shorten_url: 'http://app.example/api/shorten' }, 'BROWSER_ENTRY_INSECURE_URL'],
    ['a plain-http entry url', { entry_url: 'http://app.example/welcome' }, 'BROWSER_ENTRY_INSECURE_URL'],
    ['credentials in the entry url', { entry_url: 'https://who:what@app.example/welcome' }, 'BROWSER_ENTRY_INSECURE_URL'],
    ['an audience that is not a URL', { audience: 'app.example' }, 'BROWSER_ENTRY_INSECURE_URL'],
    ['an audience carrying a path', { audience: `${APP}/x`, entry_url: `${APP}/x/welcome`, shorten_url: `${APP}/x/api` }, 'BROWSER_ENTRY_ORIGIN_MISMATCH'],
    ['an audience with a trailing slash', { audience: `${APP}/` }, 'BROWSER_ENTRY_ORIGIN_MISMATCH'],
    ['an entry url on another host', { entry_url: 'https://elsewhere.example/welcome' }, 'BROWSER_ENTRY_ORIGIN_MISMATCH'],
    ['an entry url on another port', { entry_url: 'https://app.example:8443/welcome' }, 'BROWSER_ENTRY_ORIGIN_MISMATCH'],
    ['a shortener on another host', { shorten_url: 'https://elsewhere.example/api/shorten' }, 'BROWSER_ENTRY_ORIGIN_MISMATCH'],
    ['a look-alike subdomain', { entry_url: 'https://app.example.evil.test/welcome' }, 'BROWSER_ENTRY_ORIGIN_MISMATCH'],
  ])('refuses %s', (_label, over, refusal) => {
    expect(selectBrowserEntry(browserEntryOf({ browser_entry: { ...ENTRY, ...over } }))).toEqual({ refusal });
  });

  it('allows plain http only where the caller opens the loopback exception', () => {
    const local = {
      profile: BROWSER_ENTRY_PROFILE,
      audience: 'http://127.0.0.1:8788',
      entry_url: 'http://127.0.0.1:8788/welcome',
    };
    const declared = browserEntryOf({ browser_entry: local });
    expect(selectBrowserEntry(declared)).toEqual({ refusal: 'BROWSER_ENTRY_INSECURE_URL' });
    // The control: the same declaration with the exception opened. Without
    // this pair the test above would pass for a build that refuses every
    // http URL for the wrong reason.
    const allowed = selectBrowserEntry(declared, { allowInsecureOrigin: (u) => u.startsWith('http://127.0.0.1:') });
    expect('entry' in allowed && allowed.entry.audience).toBe('http://127.0.0.1:8788');
  });

  it('does not let the loopback exception reach a public http address', () => {
    const declared = browserEntryOf({
      browser_entry: { profile: BROWSER_ENTRY_PROFILE, audience: 'http://app.example', entry_url: 'http://app.example/welcome' },
    });
    expect(selectBrowserEntry(declared, { allowInsecureOrigin: (u) => u.startsWith('http://127.0.0.1:') })).toEqual({
      refusal: 'BROWSER_ENTRY_INSECURE_URL',
    });
  });
});

describe('the fingerprint', () => {
  it('moves when any declared field moves, the shortener included', () => {
    const base = browserEntryOf({ browser_entry: ENTRY });
    const seen = new Set(
      [
        base,
        browserEntryOf({ browser_entry: { ...ENTRY, audience: 'https://other.example' } }),
        browserEntryOf({ browser_entry: { ...ENTRY, entry_url: `${APP}/enter` } }),
        browserEntryOf({ browser_entry: { ...ENTRY, shorten_url: `${APP}/api/s2` } }),
        browserEntryOf({ browser_entry: { ...ENTRY, profile: 'other' } }),
        undefined,
      ].map(browserEntryFingerprint),
    );
    expect(seen.size).toBe(6);
  });

  it('is part of the whole declaration fingerprint, so a moved entrance is a moved declaration', () => {
    const without = declarationOf(bytesOf({ read_auth: { schemes: ['x'] } }));
    const with_ = declarationOf(bytesOf({ read_auth: { schemes: ['x'] }, browser_entry: ENTRY }));
    expect(declarationFingerprint(without)).not.toBe(declarationFingerprint(with_));
    const moved = declarationOf(
      bytesOf({ read_auth: { schemes: ['x'] }, browser_entry: { ...ENTRY, audience: 'https://other.example' } }),
    );
    expect(declarationFingerprint(moved)).not.toBe(declarationFingerprint(with_));
  });
});

describe('the projection, through the real trust machinery', () => {
  it('is committed by the same act that pins the house', async () => {
    const db = freshDb();
    const { outcome } = await add(db, { browser_entry: ENTRY });
    expect(outcome.ok).toBe(true);
    const pin = pinnedBinding(db, HOUSE)!;
    expect(readVerifiedDeclaration(db, pin)?.browserEntry?.audience).toBe(APP);
    const decision = decideBrowserEntry(db, HOUSE);
    expect('entry' in decision && decision.entry.entryUrl).toBe(`${APP}/welcome`);
    db.close();
  });

  it('is not written at all when the proof does not verify', async () => {
    const db = freshDb();
    const impostor = mintHouse({
      origin: HOUSE,
      seed: 1,
      manifest: { browser_entry: ENTRY },
      signWith: nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(9)).secretKey,
    });
    const outcome = await prepareHouseTrust(db, HOUSE, {
      fetch: impostor.fetch as typeof globalThis.fetch,
      attempt: beginHouseAdd(db, HOUSE),
      now: () => 1_700_000_000,
    });
    expect(outcome.ok).toBe(false);
    expect(decideBrowserEntry(db, HOUSE)).toEqual({ refusal: 'HOUSE_NOT_PINNED', origin: HOUSE });
    db.close();
  });

  it('goes back to silence when a valid manifest withdraws the entrance', async () => {
    const db = freshDb();
    await add(db, { browser_entry: ENTRY });
    expect('entry' in decideBrowserEntry(db, HOUSE)).toBe(true);

    const withdrawn = mintHouse({ origin: HOUSE, seed: 1, manifest: {} });
    const confirmed = await confirmHouseTrust(db, HOUSE, {
      fetch: withdrawn.fetch as typeof globalThis.fetch,
      now: () => 1_700_000_100,
    });
    expect(confirmed.ok).toBe(true);
    expect(decideBrowserEntry(db, HOUSE)).toEqual({
      refusal: 'BROWSER_ENTRY_NOT_DECLARED',
      origin: HOUSE,
    });
    db.close();
  });

  it('does not lend one key’s entrance to another key at the same origin', async () => {
    const db = freshDb();
    await add(db, { browser_entry: ENTRY });
    db.execute('UPDATE house_binding_pin SET house_key = ? WHERE origin = ?', ['another-key', HOUSE]);
    expect(decideBrowserEntry(db, HOUSE)).toEqual({
      refusal: 'BROWSER_ENTRY_NOT_DECLARED',
      origin: HOUSE,
    });
    db.close();
  });

  it('refuses a blocked pin outright, before any declaration is read', async () => {
    const db = freshDb();
    await add(db, { browser_entry: ENTRY });
    db.execute('UPDATE house_binding_pin SET blocked_reason = ? WHERE origin = ?', ['HOUSE_KEY_CHANGED', HOUSE]);
    expect(decideBrowserEntry(db, HOUSE)).toEqual({ refusal: 'HOUSE_NOT_PINNED', origin: HOUSE });
    db.close();
  });

  it('is not taken from the guide or from any second fetch — only the verified bytes decide', async () => {
    const db = freshDb();
    // Pinned, declaring no entrance.
    await add(db, {});
    expect(decideBrowserEntry(db, HOUSE)).toEqual({
      refusal: 'BROWSER_ENTRY_NOT_DECLARED',
      origin: HOUSE,
    });
    // The positive control, so this is a test about PROVENANCE and not one in
    // which nothing happened: the same declaration arriving through the
    // verified path does take effect.
    const proving = mintHouse({ origin: HOUSE, seed: 1, manifest: { browser_entry: ENTRY } });
    const confirmed = await confirmHouseTrust(db, HOUSE, {
      fetch: proving.fetch as typeof globalThis.fetch,
      now: () => 1_700_000_100,
    });
    expect(confirmed.ok).toBe(true);
    expect('entry' in decideBrowserEntry(db, HOUSE)).toBe(true);
    db.close();
  });

  it('survives a house mounted before the column existed, as silence rather than as a crash', () => {
    const db = freshDb();
    // A row written the way migration 040 left it: no browser_entry at all.
    db.execute(
      'INSERT INTO house_read_declaration (origin, house_key, schemes, session_board, updated_at) VALUES (?, ?, ?, ?, ?)',
      [HOUSE, 'some-key', '["x"]', 0, 1_700_000_000],
    );
    const row = readVerifiedDeclaration(db, {
      origin: HOUSE,
      houseKey: 'some-key',
      incarnation: 'i',
      source: 'configured',
      firstTrustedAt: 0,
      confirmedAt: 0,
      revision: 1,
    });
    expect(row?.schemes).toEqual(['x']);
    expect(row?.browserEntry).toBeUndefined();
    db.close();
  });
});
