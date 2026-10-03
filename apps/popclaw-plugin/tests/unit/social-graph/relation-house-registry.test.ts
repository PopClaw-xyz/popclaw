/** Reception rules exercised without a host, transport, scheduler or business drain. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { popclaw } from '@popclaw/contracts';
import { InMemoryHostDb } from '../../../src/host/in-memory-host-db.js';
import { runMigrations } from '../../../src/host/migrations.js';
import { createRelationWiring } from '../../../src/social-graph/relation-wiring.js';
import {
  createRelationHouseRegistry,
  type RelationHouseRegistryDeps,
} from '../../../src/social-graph/relation-house-registry.js';
import * as trustModule from '../../../src/world/house-trust.js';
import { mintHouse } from '../../helpers/signed-manifest.js';

const MIGRATIONS = resolve(dirname(fileURLToPath(import.meta.url)), '../../../migrations');
const cleanup: (() => void)[] = [];
const settle = async () => { for (let i = 0; i < 4; i++) await new Promise<void>((done) => setImmediate(done)); };
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(100_000); });
afterEach(() => { for (const close of cleanup.splice(0)) close(); vi.restoreAllMocks(); vi.useRealTimers(); });

async function fixture(options: Pick<RelationHouseRegistryDeps, 'currentConnectionSerialOf'> = {}) {
  const db = new InMemoryHostDb(); runMigrations(db, MIGRATIONS);
  const houses = {
    a: mintHouse({ origin: 'https://a.test', seed: 7, manifest: { relations: { ordered: 1 } } }),
    b: mintHouse({ origin: 'https://b.test', seed: 9, manifest: { relations: { ordered: 1 } } }),
  };
  type Slug = keyof typeof houses;
  const wiring = createRelationWiring({ db, recipientPopclawId: 'owner', now: () => 100 });
  const confirms = vi.spyOn(trustModule, 'confirmHouseTrustForSession');
  const attempts: string[] = [];
  const behavior = new Map<string, 'throw' | 'refuse'>();
  const handleAt = wiring.handleAt.bind(wiring);
  vi.spyOn(wiring, 'handleAt').mockImplementation((source, generation) => {
    const handle = handleAt(source, generation);
    if (handle) {
      const slug = source.houseKey === houses.a.houseKey ? 'a' : 'b';
      vi.spyOn(handle, 'receive').mockImplementation((frame) => {
        attempts.push(`${slug}:${frame.eventId}`);
        if (behavior.get(slug) === 'throw') throw new Error('boundary failed');
        return { firstTime: false, disposition: 'refused', reason: 'refusal consumes the held item' };
      });
      vi.spyOn(handle, 'resumeFrom').mockReturnValue('1.9');
    }
    return handle;
  });
  const departed = vi.fn(); const warnings: string[] = [];
  const fetch = vi.fn(async (input: Parameters<typeof globalThis.fetch>[0]) => {
    const url = String(input); return (url.startsWith(houses.a.origin) ? houses.a : houses.b).fetch(input);
  });
  const registry = await createRelationHouseRegistry({
    db, wiring, fetch, now: () => 100, ownedConnectionSerialOf: () => undefined,
    onDeparture: departed, log: { warn: (line) => warnings.push(line) }, ...options,
  });
  cleanup.push(() => { registry.stop(); db.close(); });
  return { db, wiring, registry, houses, confirms, attempts, behavior, departed, warnings, fetch,
    attach: (slug: Slug) => registry.attach(houses[slug].origin, slug),
    frame: (slug: Slug, id: string) => registry.reception.onFrame(
      popclaw.event.EventEnvelope.encode({ eventId: id }).finish(), slug, `1.${id}`),
    trust: async (slug: Slug) => {
      const h = houses[slug];
      const outcome = await trustModule.establishHouseTrust(db, h.origin, { fetch: h.fetch as typeof globalThis.fetch });
      if (!outcome.ok) throw new Error(outcome.refusal);
      wiring.login({ houseKey: h.houseKey, incarnation: h.incarnation, houseSlug: slug });
    },
    tick: async (ms = 0) => { vi.setSystemTime(Date.now() + ms); registry.maintain(); await settle(); },
  };
}

describe('RelationHouseRegistry', () => {
  it('remembers a refused origin and retries only while it owes held frames', async () => {
    const t = await fixture();
    expect(await t.attach('a')).toEqual({ ok: false, reason: 'HOUSE_NOT_TRUSTED' });
    await t.tick(1000); expect(t.confirms).toHaveBeenCalledTimes(1);
    t.frame('a', '1'); t.frame('a', '2'); await settle();
    expect(t.confirms).toHaveBeenCalledTimes(2); expect(t.attempts).toEqual([]);
    await t.trust('a'); await t.tick(1000);
    expect(t.attempts).toEqual(['a:1', 'a:2']);
    expect(t.registry.slugForHouseKey(t.houses.a.houseKey)).toBe('a');
    expect(t.registry.trustedHandleFor('a')).toBe(t.registry.handleFor('a'));
    await t.tick(1000); expect(t.confirms).toHaveBeenCalledTimes(3);
  });

  it('holds the thrown head ahead of a newer frame, while a returned refusal consumes it', async () => {
    const t = await fixture(); await t.attach('a'); t.frame('a', '1'); await settle();
    await t.trust('a'); t.behavior.set('a', 'throw'); await t.attach('a');
    t.frame('a', '2'); expect(t.attempts).toEqual(['a:1']);
    await t.tick(); expect(t.attempts).toEqual(['a:1', 'a:1']);
    t.behavior.set('a', 'refuse'); await t.tick(); t.frame('a', '3');
    expect(t.attempts).toEqual(['a:1', 'a:1', 'a:1', 'a:2', 'a:3']);
    await t.tick(); expect(t.attempts).toHaveLength(5);
  });

  it('bounds held debt at 100 and leaves another house able to receive synchronously', async () => {
    const t = await fixture(); await t.attach('a'); await t.trust('b'); await t.attach('b');
    for (let i = 1; i <= 100; i++) t.frame('a', String(i));
    expect(() => t.frame('a', '101')).toThrow('RELATION_SESSION_NOT_TRUSTED');
    t.frame('b', '1'); expect(t.attempts).toEqual(['b:1']);
    await settle(); await t.trust('a'); await t.tick(1000);
    expect(t.attempts.slice(1)).toEqual(Array.from({ length: 100 }, (_, i) => `a:${i + 1}`));
  });

  it('keeps retries single-flight per house without blocking another house', async () => {
    const t = await fixture(); await t.trust('a'); await t.trust('b');
    let release!: () => void;
    const wait = new Promise<void>((done) => { release = done; });
    t.fetch.mockImplementationOnce(async (input) => { await wait; return t.houses.a.fetch(input); });
    // A refused attach records the origin without installing a handle.
    t.confirms.mockResolvedValueOnce({ ok: false, refusal: 'HOUSE_NOT_TRUSTED' } as never);
    await t.attach('a'); t.frame('a', '1'); t.frame('a', '2');
    await t.tick(); expect(t.fetch).toHaveBeenCalledTimes(1);
    await t.attach('b'); t.frame('b', '3'); expect(t.attempts).toEqual(['b:3']);
    release(); await settle(); expect(t.attempts).toEqual(['b:3', 'a:1', 'a:2']);
  });

  it('backs off refusals, logs only changed reasons, and resets the streak after retry success', async () => {
    const t = await fixture(); await t.attach('a'); t.frame('a', '1'); await settle();
    await t.tick(999); expect(t.confirms).toHaveBeenCalledTimes(2);
    await t.tick(1); expect(t.confirms).toHaveBeenCalledTimes(3);
    expect(t.warnings.filter((line) => line.includes('still not attachable'))).toHaveLength(1);
    await t.trust('a'); await t.tick(1999); expect(t.attempts).toEqual([]);
    await t.tick(1); expect(t.attempts).toEqual(['a:1']);
    t.registry.leave('a'); t.frame('a', '2'); await settle();
    await t.tick(1000); expect(t.confirms).toHaveBeenCalledTimes(6);
    expect(t.warnings.filter((line) => line.includes('still not attachable'))).toHaveLength(2);
  });

  it('preserves direct attach success metadata instead of clearing the retry streak', async () => {
    const t = await fixture(); await t.attach('a'); t.frame('a', '1'); await settle();
    await t.trust('a'); await t.attach('a'); t.registry.leave('a'); t.frame('a', '2'); await settle();
    expect(t.confirms).toHaveBeenCalledTimes(3);
    await t.tick(1000); expect(t.confirms).toHaveBeenCalledTimes(4);
    await t.tick(1000); expect(t.confirms).toHaveBeenCalledTimes(4);
    await t.tick(1000); expect(t.confirms).toHaveBeenCalledTimes(5);
  });

  it('a thrown retry releases single-flight without inventing a refusal backoff', async () => {
    const t = await fixture(); await t.attach('a');
    t.confirms.mockRejectedValueOnce(new Error('lookup failed'));
    t.frame('a', '1'); await settle();
    expect(t.warnings.some((line) => line.includes('lookup failed'))).toBe(true);
    await t.trust('a'); await t.tick();
    expect(t.attempts).toEqual(['a:1']);
  });

  it('ends durable participation on explicit leave, retains debt and aliases, then reattaches at the new generation', async () => {
    const t = await fixture(); await t.trust('a'); await t.attach('a');
    const old = t.registry.handleFor('a')!;
    // Create held debt via a retryable boundary throw after a deferred arrival.
    t.registry.leave('a'); t.frame('a', '1'); await settle();
    expect(t.registry.slugForHouseKey(t.houses.a.houseKey)).toBe('a');
    expect(t.registry.hasHouseAliases()).toBe(true);
    expect(t.departed).toHaveBeenCalledWith('a', 'explicit');
    expect(t.db.queryOne<{ active: number }>('SELECT active FROM relation_participation')?.active).toBe(0);
    await t.trust('a'); await t.attach('a');
    expect(t.registry.handleFor('a')!.source.ownerGeneration).toBeGreaterThan(old.source.ownerGeneration);
    expect(t.attempts).toEqual(['a:1']);
  });

  it('observes invalidation without another logout and aborts at a synchronous departure stop', async () => {
    const t = await fixture(); await t.trust('a'); await t.attach('a'); await t.trust('b'); await t.attach('b');
    const a = t.registry.handleFor('a')!; const b = t.registry.handleFor('b')!;
    const leaveA = vi.spyOn(a, 'leave'); const leaveB = vi.spyOn(b, 'leave');
    t.db.execute('UPDATE relation_participation SET active = 0');
    t.departed.mockImplementation(() => t.registry.stop());
    expect(t.registry.maintain()).toBe(false);
    expect(t.registry.handleFor('a')).toBeUndefined(); expect(t.registry.handleFor('b')).toBe(b);
    expect(leaveA).not.toHaveBeenCalled(); expect(leaveB).not.toHaveBeenCalled();
    expect(t.departed).toHaveBeenCalledTimes(1);
    expect(t.departed).toHaveBeenCalledWith('a', 'observed');
  });

  it('terminal stop refuses in-flight and future attach without erasing historical handles', async () => {
    const t = await fixture(); await t.trust('a'); await t.attach('a'); await t.trust('b');
    let release!: () => void; const wait = new Promise<void>((done) => { release = done; });
    t.fetch.mockImplementationOnce(async (input) => { await wait; return t.houses.b.fetch(input); });
    const pending = t.attach('b'); t.registry.stop(); release();
    expect(await pending).toEqual({ ok: false, reason: 'this reception host has been stopped' });
    expect(await t.attach('b')).toEqual({ ok: false, reason: 'this reception host has been stopped' });
    expect(t.registry.handleFor('a')).toBeDefined(); expect(t.registry.handleFor('b')).toBeUndefined();
    expect(t.registry.maintain()).toBe(false);
    t.registry.reception.onCursorReset('a', { reason: 'retention', logGeneration: '2', floor: '7', reconcile: 'snapshot' }, 1);
    expect(t.db.queryAll('SELECT * FROM relation_stream_gaps')).toEqual([]);
  });

  it.each(['absent', 'undefined', 'current', 'replaced'] as const)('reset serial supplier %s and durable gap suppress resume', async (kind) => {
    const t = await fixture(kind === 'absent' ? {} : { currentConnectionSerialOf: () => kind === 'current' ? 1 : kind === 'replaced' ? 2 : undefined });
    await t.trust('a'); await t.attach('a');
    expect(t.registry.reception.resumePosition('a')).toBe('1.9');
    t.registry.reception.onCursorReset('a', { reason: 'retention', logGeneration: '2', floor: '7', reconcile: 'snapshot' }, 1);
    const accepts = kind === 'absent' || kind === 'current';
    expect(t.db.queryAll('SELECT * FROM relation_stream_gaps')).toHaveLength(accepts ? 1 : 0);
    expect(t.registry.reception.resumePosition('a')).toBe(accepts ? undefined : '1.9');
  });

  it.each(['pin', 'generation'] as const)('reset rejects a %s changed at transaction entry', async (change) => {
    const t = await fixture(); await t.trust('a'); await t.attach('a');
    const transaction = t.db.transaction.bind(t.db);
    vi.spyOn(t.db, 'transaction').mockImplementationOnce((fn) => transaction((tx) => {
      if (change === 'pin') tx.execute("UPDATE house_binding_pin SET blocked_reason = 'changed'");
      else tx.execute('UPDATE relation_participation SET owner_generation = owner_generation + 1');
      return fn(tx);
    }));
    t.registry.reception.onCursorReset('a', { reason: 'retention', logGeneration: '2', floor: '7', reconcile: 'snapshot' }, 1);
    expect(t.db.queryAll('SELECT * FROM relation_stream_gaps')).toEqual([]);
  });

  it('captures a recovery candidate and rechecks current trust on each lookup', async () => {
    const t = await fixture(); await t.trust('a'); await t.attach('a');
    const target = t.registry.recoveryTarget(t.houses.a.houseKey, t.houses.a.incarnation)!;
    expect(target).toEqual({ origin: t.houses.a.origin, handle: t.registry.handleFor('a') });
    expect(t.registry.recoveryTarget(t.houses.a.houseKey, 'another-incarnation')).toBeUndefined();
    await t.trust('a');
    expect(t.registry.recoveryTarget(t.houses.a.houseKey, t.houses.a.incarnation)).toBeUndefined();
    await t.attach('a');
    expect(t.registry.recoveryTarget(t.houses.a.houseKey, t.houses.a.incarnation)!.handle).not.toBe(target.handle);
    expect(target.handle.source.ownerGeneration).toBe(1);
    t.db.execute("UPDATE house_binding_pin SET blocked_reason = 'changed'");
    expect(t.registry.recoveryTarget(t.houses.a.houseKey, t.houses.a.incarnation)).toBeUndefined();
  });
});
