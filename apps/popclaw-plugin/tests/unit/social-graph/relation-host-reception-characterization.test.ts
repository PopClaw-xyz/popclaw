/** Fixed entry-point traces captured before extracting reception ownership. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { popclaw } from '@popclaw/contracts';
import { InMemoryHostDb } from '../../../src/host/in-memory-host-db.js';
import { runMigrations } from '../../../src/host/migrations.js';
import type { HostDb } from '../../../src/host/host-db.js';
import { establishTrust } from '../../../src/world/house-binding-pin.js';
import { openRelationAwareInbox, type RelationHostDeps } from '../../../src/social-graph/relation-host.js';

const ports = vi.hoisted(() => ({
  confirm: vi.fn(), recover: vi.fn(), trace: [] as string[], batch: [] as { houseSlug: string; followerId: string }[],
  serial: 1,
}));
vi.mock('../../../src/world/house-trust.js', async (original) => ({
  ...await original<typeof import('../../../src/world/house-trust.js')>(),
  confirmHouseTrustForSession: (...args: unknown[]) => ports.confirm(...args),
}));
vi.mock('../../../src/social-graph/relation-snapshot-recovery.js', () => ({
  recoverRelationGap: (...args: unknown[]) => ports.recover(...args),
}));
vi.mock('../../../src/social-graph/followers-sync.js', () => ({
  KnownFollowersStore: class {
    unannounced() { ports.trace.push('announcement:read'); return ports.batch; }
  },
  catchUpVerifiedFollowersIntoCache: (_db: unknown, _owner: unknown, slug: (key: string) => string | undefined) => {
    ports.trace.push(`catchup:${slug('key-a') ?? '-'}:${slug('key-b') ?? '-'}`);
  },
}));
vi.mock('../../../src/messaging/inbox-stream-client.js', async (original) => ({
  ...await original<typeof import('../../../src/messaging/inbox-stream-client.js')>(),
  openHouseInboxStreams: (urls: string[]) => urls.map((url) => ({
    baseUrl: url, slug: new URL(url).hostname[0],
    client: {
      start: () => ports.trace.push(`stream:start:${new URL(url).hostname[0]}`),
      stop: () => ports.trace.push(`stream:stop:${new URL(url).hostname[0]}`),
      currentConnectionSerial: () => ports.serial,
    },
  })),
}));
const MIGRATIONS = resolve(dirname(fileURLToPath(import.meta.url)), '../../../migrations');
const origin = (slug: string) => `https://${slug}.test`;
const reset = { reason: 'retention', logGeneration: '2', floor: '7', reconcile: 'snapshot' };
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const cleanup: (() => void)[] = [];
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(100_000);
  ports.trace = []; ports.batch = []; ports.serial = 1;
  ports.confirm.mockReset(); ports.recover.mockReset();
});
afterEach(() => { for (const close of cleanup.splice(0)) close(); vi.restoreAllMocks(); vi.useRealTimers(); });

async function fixture(options: { owned?: boolean; serial?: () => number | undefined; lease?: RelationHostDeps['dutyLease'] } = {}) {
  const db = new InMemoryHostDb(); runMigrations(db, MIGRATIONS);
  const trace = ports.trace;
  const blocked = new Set<string>();
  const confirmResult = (url: string) => {
    const slug = new URL(url).hostname[0]!;
    const part = db.queryOne<{ owner_generation: number; active: number }>(
      'SELECT owner_generation, active FROM relation_participation WHERE house_key = ?', [`key-${slug}`]);
    return part?.active === 1 && !blocked.has(slug)
      ? { ok: true, binding: { houseKey: `key-${slug}`, incarnation: 'inc' }, ownerGeneration: part.owner_generation }
      : { ok: false, refusal: 'HOUSE_NOT_TRUSTED' };
  };
  ports.confirm.mockImplementation(async (_db: HostDb, url: string) => {
    trace.push(`confirm:${url}`); return confirmResult(url);
  });
  if (options.owned) {
    for (const slug of ['a', 'b']) {
      establishTrust(db, { origin: origin(slug), houseKey: `key-${slug}`, incarnation: 'inc' }, 'tofu', () => 100);
      db.execute('INSERT INTO relation_participation (house_key, owner_generation, active, updated_at) VALUES (?, 1, 1, 100)', [`key-${slug}`]);
    }
  }
  ports.recover.mockImplementation(async (args: { origin: string; expected: unknown; stillValid: () => boolean }) => {
    trace.push(`snapshot:${args.origin}:${JSON.stringify(args.expected)}:${args.stillValid()}`);
    return { recovered: true };
  });
  const host = await openRelationAwareInbox({
    db, recipientPopclawId: 'owner', signer: {} as never,
    readAuthorityFor: (url) => { trace.push(`authority:${url}`); return {} as never; },
    onMessage: () => {}, now: () => 100, autostart: false, drainIntervalMs: 10_000,
    recoverDmLedger: () => trace.push('dm'), resendRelations: (valid) => { trace.push(`resend:${valid()}`); },
    notifyNewFollowers: () => { trace.push('announcement:notify'); },
    log: { info: (line) => trace.push(`info:${line}`), warn: (line) => trace.push(`warn:${line}`) },
    ...(options.serial ? { currentConnectionSerialOf: options.serial } : {}),
    ...(options.lease ? { dutyLease: options.lease } : {}),
  }, options.owned ? [origin('a'), origin('b')] : []);
  vi.spyOn(host.wiring, 'drain').mockImplementation(() => { trace.push('drain'); return {} as never; });
  cleanup.push(() => { host.stop(); db.close(); });
  const trust = (slug: string) => {
    establishTrust(db, { origin: origin(slug), houseKey: `key-${slug}`, incarnation: 'inc' }, 'tofu', () => 100);
    host.wiring.login({ houseKey: `key-${slug}`, incarnation: 'inc', houseSlug: slug });
  };
  const receive = (slug: string, behavior: (id: string) => 'throw' | 'refuse' = () => 'refuse') => {
    const handle = host.handleFor(slug)!;
    vi.spyOn(handle, 'receive').mockImplementation((frame) => {
      trace.push(`receive:${slug}:${handle.source.ownerGeneration}:${frame.eventId}:${frame.position}`);
      if (behavior(frame.eventId) === 'throw') throw new Error('commit unavailable');
      return { firstTime: false, disposition: 'refused', reason: 'fixture refusal' };
    });
    vi.spyOn(handle, 'resumeFrom').mockReturnValue('1.9');
    return handle;
  };
  const frame = (slug: string, id: string) => host.reception.onFrame(
    popclaw.event.EventEnvelope.encode({ eventId: id }).finish(), slug, `1.${id}`);
  const state = () => ({
    trace: [...trace],
    handles: ['a', 'b'].map((s) => [s, host.handleFor(s)?.source.ownerGeneration ?? null, !!host.trustedHandleFor(s)]),
    resume: ['a', 'b'].map((s) => [s, host.reception.resumePosition(s) ?? null]),
    gaps: db.queryAll('SELECT * FROM relation_stream_gaps ORDER BY house_key'),
    participation: db.queryAll('SELECT * FROM relation_participation ORDER BY house_key'),
  });
  return { db, host, trace, blocked, trust, frame, receive, state, confirmResult,
    attach: (slug: string) => host.attach(origin(slug), slug),
    tick: async (ms = 0) => { vi.setSystemTime(Date.now() + ms); host.start(); await settle(); },
  };
}

describe('relation host reception characterization', () => {
  it('runs an empty-configuration initial tick before returning its opening promise', async () => {
    const db = new InMemoryHostDb(); runMigrations(db, MIGRATIONS);
    const trace: string[] = [];
    const opening = openRelationAwareInbox({
      db, recipientPopclawId: 'owner', signer: {} as never, readAuthorityFor: () => ({} as never),
      onMessage: () => {}, recoverDmLedger: () => { trace.push('dm'); }, drainIntervalMs: 10_000,
    }, []);
    // Register cleanup even if the synchronous assertion below fails.
    const host = opening.then((opened) => { cleanup.push(() => { opened.stop(); db.close(); }); return opened; });
    expect(trace).toEqual(['dm']);
    await host;
    expect(trace).toMatchSnapshot();
  });

  it('preserves held FIFO over a new handle, thrown head, returned refusal and two-house isolation', async () => {
    const t = await fixture();
    expect(await t.attach('a')).toEqual({ ok: false, reason: 'HOUSE_NOT_TRUSTED' });
    t.frame('a', '1'); t.frame('a', '2'); await settle();
    t.trust('b'); await t.attach('b'); t.receive('b'); t.frame('b', '8');
    t.trust('a');
    const original = t.host.wiring.handleAt.bind(t.host.wiring);
    let throws = true;
    vi.spyOn(t.host.wiring, 'handleAt').mockImplementation((source, generation) => {
      const h = original(source, generation)!;
      vi.spyOn(h, 'receive').mockImplementation((f) => {
        t.trace.push(`receive:a:${generation}:${f.eventId}:${f.position}`);
        if (throws) throw new Error('commit unavailable');
        return { firstTime: false, disposition: 'refused', reason: 'fixture refusal' };
      });
      return h;
    });
    await t.attach('a'); t.frame('a', '3');
    throws = false; await t.tick();
    expect(t.trace.filter((x) => x.startsWith('receive:a'))).toEqual([
      'receive:a:1:1:1.1', 'receive:a:1:1:1.1', 'receive:a:1:2:1.2', 'receive:a:1:3:1.3',
    ]);
    expect(t.state()).toMatchSnapshot();
  });

  it('retains exactly 100 frames and throws the next into the transport replay boundary', async () => {
    const t = await fixture(); await t.attach('a');
    for (let i = 1; i <= 100; i++) t.frame('a', String(i));
    expect(() => t.frame('a', '101')).toThrow('already has 100 relation frames waiting');
    await settle(); expect(ports.confirm).toHaveBeenCalledTimes(2);
    expect(t.state()).toMatchSnapshot();
  });

  it('retries single-flight per house, backs off and clears the retry-success streak', async () => {
    const t = await fixture(); await t.attach('a');
    t.frame('a', '1'); t.frame('a', '2'); await settle();
    await t.tick(999); expect(ports.confirm).toHaveBeenCalledTimes(2);
    await t.tick(1); expect(ports.confirm).toHaveBeenCalledTimes(3);
    t.trust('a'); await t.tick(1999); expect(t.host.handleFor('a')).toBeUndefined();
    await t.tick(1); expect(t.host.handleFor('a')).toBeDefined();
    t.host.leave('a'); t.frame('a', '3'); await settle();
    await t.tick(999); expect(ports.confirm).toHaveBeenCalledTimes(5);
    await t.tick(1); expect(ports.confirm).toHaveBeenCalledTimes(6);
    expect(t.state()).toMatchSnapshot();
  });

  it('direct attach preserves the old failure streak and not-before after explicit leave', async () => {
    const t = await fixture(); await t.attach('a'); t.frame('a', '1'); await settle();
    t.trust('a'); await t.attach('a'); t.host.leave('a'); t.frame('a', '2'); await settle();
    expect(ports.confirm).toHaveBeenCalledTimes(3);
    await t.tick(1000); expect(ports.confirm).toHaveBeenCalledTimes(4);
    await t.tick(1999); expect(ports.confirm).toHaveBeenCalledTimes(4);
    await t.tick(1); expect(ports.confirm).toHaveBeenCalledTimes(5);
    expect(t.state()).toMatchSnapshot();
  });

  it('captures the confirmed owner generation and refuses an interleaved replacement', async () => {
    const t = await fixture(); t.trust('a');
    const gate = deferred<ReturnType<typeof t.confirmResult>>();
    ports.confirm.mockImplementationOnce(() => gate.promise);
    const confirmed = t.confirmResult(origin('a')); const attach = t.attach('a');
    t.trust('a'); gate.resolve(confirmed);
    expect(await attach).toEqual({ ok: false, reason: 'the live session changed during startup' });
    expect(t.state()).toMatchSnapshot();
  });

  it('pending attach cannot resurrect a stopped host and stop prevents later start', async () => {
    const t = await fixture(); t.trust('a');
    const gate = deferred<ReturnType<typeof t.confirmResult>>();
    ports.confirm.mockImplementationOnce(() => gate.promise);
    const attach = t.attach('a'); t.host.stop(); gate.resolve(t.confirmResult(origin('a')));
    expect(await attach).toEqual({ ok: false, reason: 'this reception host has been stopped' });
    await t.tick(); expect(await t.attach('b')).toEqual({ ok: false, reason: 'this reception host has been stopped' });
    t.host.reception.onCursorReset('a', reset, 1);
    expect(vi.getTimerCount()).toBe(0); expect(t.state()).toMatchSnapshot();
  });

  it('external departure leaves the durable generation alone and stops before later maintenance when its callback stops host', async () => {
    const t = await fixture({ owned: true });
    t.db.execute('UPDATE relation_participation SET active = 0');
    t.host.onHouseDeparted((slug) => { t.trace.push(`departed:${slug}`); t.host.stop(); });
    t.host.onHouseDeparted((slug) => t.trace.push(`second:${slug}`));
    await t.tick();
    expect(t.host.handleFor('a')).toBeUndefined(); expect(t.host.handleFor('b')).toBeDefined();
    expect(t.trace).not.toContain('drain'); expect(vi.getTimerCount()).toBe(0);
    expect(t.state()).toMatchSnapshot();
  });

  it('explicit departure notifies the captured listener list and retains aliases for reattach', async () => {
    const t = await fixture({ owned: true });
    t.host.onHouseDeparted((slug) => t.trace.push(`departed:${slug}`));
    t.host.leave('a'); await t.tick();
    t.trust('a'); await t.attach('a'); t.receive('a'); t.frame('a', '7');
    expect(t.state()).toMatchSnapshot();
  });

  it.each(['absent', 'current', 'replaced', 'supplied-undefined', 'owned-current', 'owned-replaced'] as const)(
    'reset serial case %s preserves the durable gap and resume behavior', async (kind) => {
      const serial = kind === 'absent' || kind.startsWith('owned') ? undefined
        : () => kind === 'current' ? 7 : kind === 'replaced' ? 8 : undefined;
      const t = await fixture({ ...(serial ? { serial } : {}), owned: kind.startsWith('owned') });
      if (!kind.startsWith('owned')) { t.trust('a'); await t.attach('a'); }
      t.receive('a'); ports.serial = kind === 'owned-current' ? 7 : 8;
      expect(t.host.reception.resumePosition('a')).toBe('1.9');
      t.host.reception.onCursorReset('a', reset, 7);
      expect(t.state()).toMatchSnapshot();
    },
  );

  it.each(['block', 'pin-key', 'pin-incarnation', 'generation', 'inactive', 'rollback'] as const)(
    'reset rechecks %s inside the same transaction as the gap write', async (change) => {
      const t = await fixture(); t.trust('a'); await t.attach('a'); t.receive('a');
      const transaction = t.db.transaction.bind(t.db);
      vi.spyOn(t.db, 'transaction').mockImplementationOnce((fn) => transaction((tx) => {
        t.trace.push('tx:begin');
        if (change === 'block') tx.execute("UPDATE house_binding_pin SET blocked_reason = 'changed'");
        if (change === 'pin-key') tx.execute("UPDATE house_binding_pin SET house_key = 'other'");
        if (change === 'pin-incarnation') tx.execute("UPDATE house_binding_pin SET incarnation = 'new'");
        if (change === 'generation') tx.execute('UPDATE relation_participation SET owner_generation = owner_generation + 1');
        if (change === 'inactive') tx.execute('UPDATE relation_participation SET active = 0');
        const value = fn(tx); t.trace.push(`tx:gap-count:${tx.queryAll('SELECT * FROM relation_stream_gaps').length}`);
        if (change === 'rollback') throw new Error('rollback');
        return value;
      }));
      if (change === 'rollback') expect(() => t.host.reception.onCursorReset('a', reset, 1)).toThrow('rollback');
      else t.host.reception.onCursorReset('a', reset, 1);
      expect(t.db.queryAll('SELECT * FROM relation_stream_gaps')).toEqual([]);
      expect(t.state()).toMatchSnapshot();
    },
  );

  it('orders maintenance, global drain, DM, resend, announcement, then one captured snapshot per tick', async () => {
    const t = await fixture({ owned: true });
    t.receive('a'); t.receive('b'); ports.batch = [{ houseSlug: 'a', followerId: 'follower' }];
    t.host.reception.onCursorReset('a', reset, 1); t.host.reception.onCursorReset('b', reset, 1);
    const trustRead = t.db.queryOne.bind(t.db);
    vi.spyOn(t.db, 'queryOne').mockImplementation((sql, params) => {
      if (sql.startsWith('SELECT owner_generation')) t.trace.push(`trust:${params?.[0]}`);
      return trustRead(sql, params);
    });
    await t.tick();
    expect(ports.recover).toHaveBeenCalledTimes(1);
    const args = ports.recover.mock.calls[0]![0];
    expect(args.handle).toBe(t.host.handleFor('a'));
    t.host.stop(); expect(args.stillValid()).toBe(false);
    expect(t.state()).toMatchSnapshot();
  });

  it('retains optional duty-lease acquire/loss and sweep validity without reviving terminal stop', async () => {
    let held = false; let round = 1;
    let listener: { onAcquired(): void; onLost(): void } | undefined;
    const lease = {
      addTransitionListener: (l: typeof listener) => { listener = l; },
      removeTransitionListener: () => { ports.trace.push('lease:remove'); },
      isHeld: () => held,
      runToken: () => { const captured = round; return held ? { valid: () => held && captured === round } : undefined; },
    } as unknown as RelationHostDeps['dutyLease'];
    const t = await fixture({ owned: true, lease });
    held = true; listener!.onAcquired(); await settle();
    held = false; round++; listener!.onLost();
    held = true; listener!.onAcquired(); await settle();
    t.host.stop(); listener!.onAcquired(); expect(vi.getTimerCount()).toBe(0);
    expect(t.state()).toMatchSnapshot();
  });
});
