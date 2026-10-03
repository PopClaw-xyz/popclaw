/**
 * The house STORE and the pin table have to agree on how a house is spelled.
 *
 * `config.lore_houses` is validated by `z.string().url()` and nothing else, so
 * `https://house.popclaw.me/` (trailing slash) and `https://House.PopClaw.me`
 * (mixed-case host) are both accepted verbatim. `openWorldFeedStore` used to
 * hand that raw string back as `HouseStore.baseUrl`, and reception reads it:
 * `relation-reception` calls `host.attach(house.baseUrl, house.slug)`, so
 * `originBySlug` inside the relation host held the raw spelling.
 *
 * Everything the reception side then asks about trust is an exact
 * `WHERE origin = ?` against a pin filed under the CANONICAL origin
 * (migration 034: "Canonical origin, no trailing slash, no path" — the
 * runtime normalises before it binds). So a raw spelling means:
 *
 *   - `attach` is refused HOUSE_NOT_TRUSTED before a byte goes out, because
 *     `prepareConfirmHouseTrust` finds no pin;
 *   - `handleStillTrusted` — the drain tick's re-check, the badge's start
 *     paths and the roots' world gates — never finds one either;
 *   - the snapshot gap-recovery sweep skips the gap in total silence, since
 *     it only sweeps under a handle that just passed that same re-check.
 *
 * At a house the owner configured and the runtime trusts. The two shipped
 * default houses are canonical strings already, which is why nothing caught
 * this. The canonical spelling runs through the same cases below as the
 * control: it passes before and after the fix, so a raw spelling passing is
 * the fix and not the fixture.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { InMemoryHostDb } from '../../../src/host/in-memory-host-db.js';
import { PopclawPaths } from '../../../src/host/popclaw-paths.js';
import { runMigrations } from '../../../src/host/migrations.js';
import type { Signer } from '../../../src/identity/signer.js';
import { openWorldFeedStore } from '../../../src/ingress/world-feed-store.js';
import { RelationGapStore } from '../../../src/social-graph/relation-gap-store.js';
import { openRelationReception } from '../../../src/social-graph/relation-reception.js';
import { establishHouseTrust } from '../../../src/world/house-trust.js';
import { declaringReadAuthority } from '../../helpers/read-authority.js';
import { mintHouse } from '../../helpers/signed-manifest.js';

const MIGRATIONS = resolve(dirname(fileURLToPath(import.meta.url)), '../../../migrations');

const CANONICAL = 'https://house.popclaw.me';
const SLUG = 'house-popclaw-me';
const NOW = () => 1_700_000_000;

const meKp = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(0x4d));
const ME = bs58.encode(meKp.publicKey);
const signer: Signer = {
  publicKey: async () => meKp.publicKey,
  sign: async (bytes: Uint8Array) => nacl.sign.detached(bytes, meKp.secretKey),
  popclawId: async () => ME,
} as unknown as Signer;

/** The spellings `z.string().url()` waves through, plus the canonical control. */
const SPELLINGS = [
  ['a trailing slash', 'https://house.popclaw.me/'],
  ['a mixed-case host', 'https://House.PopClaw.me'],
  ['the canonical spelling (the control)', CANONICAL],
] as const;

async function waitFor<T>(read: () => T, accepts: (v: T) => boolean): Promise<T> {
  for (let i = 0; i < 400; i++) {
    const v = read();
    if (accepts(v)) return v;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('condition not reached');
}

const closers: Array<() => void> = [];
afterEach(() => {
  for (const close of closers.splice(0)) {
    try {
      close();
    } catch {
      /* a test that already failed must not be buried under teardown noise */
    }
  }
});

/**
 * A house whose pin, participation and manifest are all in the state a real
 * login leaves behind — all of it filed under the CANONICAL origin, because
 * that is what the runtime writes. The only thing that varies is how the
 * owner spelled the house in `lore_houses`.
 */
async function fixture(configured: string, drainIntervalMs = 0) {
  const db = new InMemoryHostDb();
  runMigrations(db, MIGRATIONS);
  const minted = mintHouse({ origin: CANONICAL, manifest: { relations: { ordered: 1 } } });

  let snapshotRequests = 0;
  // The manifest is served for real; the snapshot is refused. "Was the
  // snapshot reached" is then exactly the variable under test: a sweep that
  // is skipped makes no request and says nothing at all.
  const fetchImpl = (async (input: unknown) => {
    const url = String(typeof input === 'string' ? input : ((input as { url?: string }).url ?? input));
    if (url.includes('/v1/relation-snapshot')) {
      snapshotRequests += 1;
      return new Response('{}', { status: 401 });
    }
    return minted.fetch(input);
  }) as unknown as typeof globalThis.fetch;

  const warns: string[] = [];
  const reception = await openRelationReception({
    db,
    recipientPopclawId: ME,
    signer,
    readAuthorityFor: declaringReadAuthority(db, signer),
    onMessage: () => {},
    fetch: fetchImpl,
    now: NOW,
    drainIntervalMs,
    log: { warn: (m: string) => { warns.push(m); }, info: () => {} },
  } as never);
  closers.push(() => reception.stop());
  closers.push(() => db.close());

  const first = await establishHouseTrust(db, CANONICAL, { fetch: minted.fetch as never });
  if (!first.ok) throw new Error(`fixture could not establish first trust: ${first.refusal}`);
  reception.host.wiring.login({
    houseKey: minted.houseKey,
    incarnation: minted.incarnation,
    houseSlug: SLUG,
  });

  // The real boundary: the store opened from the configured string, exactly
  // as `openHouseStores(boot.loreHouseUrls, …)` opens it at boot.
  const paths = new PopclawPaths(mkdtempSync(join(tmpdir(), 'house-store-canonical-')));
  const store = await openWorldFeedStore(configured, paths);
  closers.push(() => store.db.close());

  return { db, minted, store, reception, warns, snapshotRequests: () => snapshotRequests };
}

describe('a configured house whose spelling is not canonical', () => {
  for (const [label, configured] of SPELLINGS) {
    it(`opens a store whose baseUrl is the canonical origin — ${label}`, async () => {
      const t = await fixture(configured);
      // The boundary itself. Every consumer of `HouseStore.baseUrl` — the
      // reception attach, the world runtime's binding checks, every
      // `${baseUrl}/v1/…` — sees one spelling from here on.
      expect(t.store.baseUrl).toBe(CANONICAL);
      expect(t.store.slug).toBe(SLUG);
    });

    it(`attaches reception, and the trust re-check finds the pin — ${label}`, async () => {
      const t = await fixture(configured);

      // What HouseResourceSet does before it opens the personal stream.
      const attached = await t.reception.hooks.attachRelations!(t.store, {} as never);
      expect(attached).toEqual({ ok: true });

      // `handleStillTrusted` under the origin the attach filed — the drain
      // tick's re-check, and the one the world gates reuse. A raw spelling
      // finds no pin and this is `undefined`.
      expect(t.reception.host.trustedHandleFor(SLUG)).toBeDefined();
    });

    it(`sweeps an open gap instead of skipping it in silence — ${label}`, async () => {
      const t = await fixture(configured, 5);
      new RelationGapStore(t.db).mark({
        houseKey: t.minted.houseKey,
        incarnation: t.minted.incarnation,
        reason: 'below_floor',
        logGeneration: '5',
        floor: '120',
        at: NOW(),
      });
      const attached = await t.reception.hooks.attachRelations!(t.store, {} as never);
      expect(attached).toEqual({ ok: true });

      // The sweep signs its credential under the canonical origin and gets as
      // far as the house, which refuses it: that 401 is the proof it ran. A
      // gap whose handle fails the trust re-check is `continue`d — no
      // request, and not one line anywhere.
      const said = await waitFor(() => t.warns, (w) => w.some((m) => m.includes('401')));
      expect(said.join('\n')).toContain(t.minted.houseKey.slice(0, 8));
      expect(t.snapshotRequests()).toBeGreaterThan(0);
    });
  }
});
