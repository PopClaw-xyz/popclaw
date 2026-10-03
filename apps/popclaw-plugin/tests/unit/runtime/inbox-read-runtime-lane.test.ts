import { afterEach, expect, it, vi } from 'vitest';
import { resolve } from 'node:path';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { InMemoryHostDb } from '../../../src/host/in-memory-host-db.js';
import { runMigrations } from '../../../src/host/migrations.js';
import { HouseRuntime } from '../../../src/runtime/house-lifecycle/house-runtime.js';
import { houseReadAuthority } from '../../../src/identity/read-authority.js';
import { INBOX_TOKEN_HEADER, READ_CREDENTIAL_SCHEME } from '../../../src/identity/read-credential.js';
import { beginHouseAdd, prepareHouseTrust, commitEstablishAndActivate } from '../../../src/world/house-trust.js';
import { confirmHouseTrust } from '../../../src/world/house-trust.js';
import { mintHouse } from '../../helpers/signed-manifest.js';
import { SESSION_BOARD } from '../../helpers/read-authority.js';
import { noDmCrypto } from '../../helpers/test-signer.js';
import type { InboxStreamOptions } from '../../../src/messaging/inbox-stream-client.js';
import type { AnyEventSource, EventSourceInit } from '../../../src/messaging/inbox-stream-client.js';

// Capture only the transport boundary. The resident, resource set, gate,
// signed-manifest trust commit and credential signer all run production code.
const opened = vi.hoisted(() => [] as InboxStreamOptions[]);
vi.mock('../../../src/messaging/inbox-stream-client.js', () => ({
  InboxStreamClient: class {
    receiving = false;
    constructor(readonly opts: InboxStreamOptions) { opened.push(opts); }
    start() { this.receiving = true; }
    stop() { this.receiving = false; }
    whenIdle() { return Promise.resolve(); }
    isReceiving() { return this.receiving; }
  },
}));
const HOUSE = 'https://inbox.example';
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); opened.length = 0; });

async function fixture(options: { sessionBoard?: boolean; identity?: boolean; sessionId?: string } = {}) {
  const db = new InMemoryHostDb();
  runMigrations(db, resolve('migrations'));
  let now = 1_780_000_000_000;
  const pair = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(77));
  const sign = vi.fn(async (bytes: Uint8Array) => nacl.sign.detached(bytes, pair.secretKey));
  const signer = { publicKey: async () => pair.publicKey, popclawId: async () => bs58.encode(pair.publicKey), sign, ...noDmCrypto };
  const authority = vi.fn((origin: string) => houseReadAuthority({ db, signer, clock: () => now }, origin));
  const noNetwork = vi.fn(async () => { throw new Error('UNEXPECTED_NETWORK'); });
  const logs: string[] = [];
  const rt = new HouseRuntime({ db, signer, origins: [HOUSE], publicV1Mode: true,
    readAuthorityFor: authority, clock: () => now, fetch: noNetwork, log: line => logs.push(line) });
  cleanup.push(async () => { await rt.stop(); db.close(); });
  const manifest = { ...(options.sessionBoard !== false ? { house_session: SESSION_BOARD } : {}),
    ...(options.identity !== false ? { read_auth: { schemes: [READ_CREDENTIAL_SCHEME] } } : {}) };
  const house = mintHouse({ origin: HOUSE, manifest });
  const prepared = await prepareHouseTrust(db, HOUSE, { attempt: beginHouseAdd(db, HOUSE), fetch: house.fetch as typeof fetch,
    now: () => now / 1000 });
  expect(prepared.ok).toBe(true);
  if (!prepared.ok) throw new Error('fixture trust failed');
  expect(commitEstablishAndActivate(db, prepared.prepared, { now: () => now / 1000 }).ok).toBe(true);
  // A restored, previously verified ACK row, under the real resident gate.
  db.execute(`INSERT INTO house_participation(house_origin, installation_id, desired, phase, op_seq,
    session_id, inbox_read_token, lease_expires_at, renew_after, ack_key_hex)
    VALUES(?, ?, 'enabled', 'connected', 3, ?, 'itk-current-ack', ?, ?, ?)`,
  [HOUSE, rt.manager.installationId, options.sessionId ?? 'session-current', now / 1000 + 600,
    now / 1000 + 500, Buffer.from(bs58.decode(house.houseKey)).toString('hex')]);
  const store = { baseUrl: HOUSE, slug: 'inbox-example', db, executionDb: db, dbPath: ':memory:', cache: {} as never };
  rt.configureResources({ stores: [store], openStore: async () => store, host: { db } as never,
    recipientPopclawId: await signer.popclawId(), worldStreamMode: true, isOfficialActor: () => false });
  rt.start();
  await vi.waitFor(() => expect(opened, JSON.stringify({ logs, active: rt.captureGate(HOUSE).isActive(),
    state: db.queryOne('SELECT desired,phase,op_seq,session_id FROM house_participation WHERE house_origin=?', [HOUSE]) })).toHaveLength(1));
  expect(opened[0]!.gate!.isActive()).toBe(true);
  return { db, rt, sign, authority, noNetwork, read: async () => {
      const captured = await opened[0]!.readToken!();
      return typeof captured === 'string' ? captured : captured.token;
    }, advance: () => { now += 700_000; },
    withdraw: async (next: Record<string, unknown>) => {
      const changed = mintHouse({ origin: HOUSE, manifest: next });
      expect((await confirmHouseTrust(db, HOUSE, { fetch: changed.fetch as typeof fetch, now: () => now / 1000 })).ok).toBe(true);
    } };
}

it.each([true, false])('resident session lane skips identity signing with identity declaration=%s', async identity => {
  const f = await fixture({ identity });
  f.sign.mockRejectedValue(new Error('IDENTITY_SIGNER_UNAVAILABLE'));
  expect(await f.read()).toBe('itk-current-ack');
  f.db.execute("UPDATE house_participation SET inbox_read_token='itk-renewed-ack' WHERE house_origin=?", [HOUSE]);
  expect(await f.read()).toBe('itk-renewed-ack');
  expect(f.authority).not.toHaveBeenCalled(); expect(f.sign).not.toHaveBeenCalled(); expect(f.noNetwork).not.toHaveBeenCalled();
});

it('selected session with a missing ACK token fails without trying a granted identity lane', async () => {
  const f = await fixture();
  f.db.execute("UPDATE house_participation SET inbox_read_token='' WHERE house_origin=?", [HOUSE]);
  await expect(f.read()).rejects.toThrow('HOUSE_SESSION_READ_TOKEN_MISSING');
  expect(f.authority).not.toHaveBeenCalled(); expect(f.sign).not.toHaveBeenCalled();
});

it('a real inbox transport refused with 401 reconnects only with the current session token, never identity', async () => {
  const f = await fixture();
  const { InboxStreamClient } = await vi.importActual<typeof import('../../../src/messaging/inbox-stream-client.js')>(
    '../../../src/messaging/inbox-stream-client.js');
  const connections: FakeSource[] = [];
  class FakeSource implements AnyEventSource {
    onmessage: ((event: { data: string }) => void) | null = null;
    onerror: ((event: unknown) => void) | null = null;
    constructor(readonly url: string, readonly init?: EventSourceInit) { connections.push(this); }
    addEventListener() {}
    close() {}
  }
  vi.useFakeTimers();
  const client = new InboxStreamClient({ ...opened[0]!, eventSourceCtor: FakeSource });
  try {
    client.start(); await vi.advanceTimersByTimeAsync(0);
    expect(connections).toHaveLength(1);
    expect(connections[0]!.init?.headers?.[INBOX_TOKEN_HEADER]).toBe('itk-current-ack');
    f.db.execute("UPDATE house_participation SET inbox_read_token='itk-new-ack' WHERE house_origin=?", [HOUSE]);
    connections[0]!.onerror!({ status: 401 });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(connections).toHaveLength(2);
    expect(connections[1]!.init?.headers?.[INBOX_TOKEN_HEADER]).toBe('itk-new-ack');
    expect(f.authority).not.toHaveBeenCalled(); expect(f.sign).not.toHaveBeenCalled();
  } finally { client.stop(); vi.useRealTimers(); await client.whenIdle(); }
});

it.each(['session-current', ''])('identity-only declaration sends v2, never a remembered itk, session=%s', async sessionId => {
  const f = await fixture({ sessionBoard: false, sessionId });
  expect(await f.read()).toMatch(/^v2\./);
  expect(f.sign).toHaveBeenCalledOnce(); expect(f.noNetwork).not.toHaveBeenCalled();
});

it.each(['missing-pin', 'blocked-pin', 'wrong-declaration-key', 'expired', 'logout', 'different-session', 'no-declaration'])(
  'resident inbox refuses %s without any identity signing or credential request', async change => {
    const f = await fixture();
    if (change === 'missing-pin') f.db.execute('DELETE FROM house_binding_pin WHERE origin=?', [HOUSE]);
    if (change === 'blocked-pin') f.db.execute("UPDATE house_binding_pin SET blocked_reason='test block' WHERE origin=?", [HOUSE]);
    if (change === 'wrong-declaration-key') f.db.execute("UPDATE house_read_declaration SET house_key='other' WHERE origin=?", [HOUSE]);
    if (change === 'expired') f.advance();
    if (change === 'logout') f.db.execute("UPDATE house_participation SET desired='disabled', op_seq=op_seq+1 WHERE house_origin=?", [HOUSE]);
    if (change === 'different-session') f.db.execute("UPDATE house_participation SET session_id='session-replacement', op_seq=op_seq+2 WHERE house_origin=?", [HOUSE]);
    if (change === 'no-declaration') await f.withdraw({});
    await expect(f.read()).rejects.toThrow();
    expect(f.sign).not.toHaveBeenCalled(); expect(f.noNetwork).not.toHaveBeenCalled();
  });

it.each(['logout', 'relogin', 'declaration', 'pin', 'session-added'])(
  'an identity signature pending during %s cannot select a new lane or open the old one', async change => {
    const f = await fixture({ sessionBoard: false, sessionId: change === 'session-added' ? '' : 'session-current' });
    let release!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; });
    f.sign.mockImplementation(async bytes => { await hold; return nacl.sign.detached(bytes, new Uint8Array(64)); });
    const reading = f.read();
    const rejected = expect(reading).rejects.toThrow();
    await vi.waitFor(() => expect(f.sign).toHaveBeenCalledOnce());
    if (change === 'logout') f.db.execute("UPDATE house_participation SET desired='disabled', op_seq=op_seq+1 WHERE house_origin=?", [HOUSE]);
    if (change === 'relogin' || change === 'session-added') f.db.execute("UPDATE house_participation SET session_id='session-new', op_seq=op_seq+2, inbox_read_token='itk-other' WHERE house_origin=?", [HOUSE]);
    if (change === 'declaration') await f.withdraw({ house_session: SESSION_BOARD });
    if (change === 'pin') f.db.execute('UPDATE house_binding_pin SET revision=revision+1 WHERE origin=?', [HOUSE]);
    release(); await rejected;
    expect(f.authority).toHaveBeenCalledOnce(); expect(f.noNetwork).not.toHaveBeenCalled();
  });

const transportCases = [true, false].flatMap(sessionBoard =>
  ['unchanged', 'blocked-pin', 'declaration-withdrawn', 'pin-revision', 'logout', 'relogin', 'expired']
    .map(change => ({ sessionBoard, change })));
it.each(transportCases)('transport validates its captured lane before send: session=$sessionBoard change=$change', async ({ sessionBoard, change }) => {
  const f = await fixture({ sessionBoard });
  const { InboxStreamClient } = await vi.importActual<typeof import('../../../src/messaging/inbox-stream-client.js')>(
    '../../../src/messaging/inbox-stream-client.js');
  const connections: EventSourceInit[] = [];
  class FakeSource implements AnyEventSource {
    onmessage = null; onerror = null;
    constructor(readonly url: string, init?: EventSourceInit) { connections.push(init!); }
    addEventListener() {} close() {}
  }
  const read = opened[0]!.readToken;
  const client = new InboxStreamClient({ ...opened[0]!, eventSourceCtor: FakeSource, readToken: () => {
    const result = read();
    // This mutation lands after the runtime's selection, before the transport
    // resumes. Both callbacks and all validation are production code.
    queueMicrotask(() => {
      if (change === 'blocked-pin') f.db.execute("UPDATE house_binding_pin SET blocked_reason='test block' WHERE origin=?", [HOUSE]);
      if (change === 'declaration-withdrawn') f.db.execute('UPDATE house_read_declaration SET session_board=0, schemes=NULL WHERE origin=?', [HOUSE]);
      if (change === 'pin-revision') f.db.execute('UPDATE house_binding_pin SET revision=revision+1 WHERE origin=?', [HOUSE]);
      if (change === 'logout') f.db.execute("UPDATE house_participation SET desired='disabled', op_seq=op_seq+1 WHERE house_origin=?", [HOUSE]);
      if (change === 'relogin') f.db.execute("UPDATE house_participation SET session_id='session-new', op_seq=op_seq+2, inbox_read_token='itk-other' WHERE house_origin=?", [HOUSE]);
      if (change === 'expired') f.advance();
    });
    return result;
  } });
  try {
    client.start(); await client.whenIdle();
    expect(connections).toHaveLength(change === 'unchanged' ? 1 : 0);
    if (change === 'unchanged') {
      const token = connections[0]!.headers![INBOX_TOKEN_HEADER];
      if (sessionBoard) expect(token).toBe('itk-current-ack');
      else expect(token).toMatch(/^v2\./);
    }
    if (sessionBoard) { expect(f.sign).not.toHaveBeenCalled(); expect(f.authority).not.toHaveBeenCalled(); }
    expect(f.noNetwork).not.toHaveBeenCalled();
  } finally { client.stop(); await client.whenIdle(); }
});

it.each(['', 'itk-renewed'])('an ACK token changed to %s after capture is not sent; a reconnect must reselect it', async token => {
  const f = await fixture();
  const captured = await opened[0]!.readToken();
  expect(typeof captured).toBe('object');
  if (typeof captured === 'string') throw new Error('capture missing');
  f.db.execute('UPDATE house_participation SET inbox_read_token=? WHERE house_origin=?', [token, HOUSE]);
  expect(captured.assertCurrent).toThrow('READ_AUTH_HOUSE_NOT_TRUSTED');
  expect(f.sign).not.toHaveBeenCalled();
});
