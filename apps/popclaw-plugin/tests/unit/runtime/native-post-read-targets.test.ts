import {afterEach, expect, it, vi} from 'vitest';
import {InMemoryHostDb} from '../../../src/host/in-memory-host-db.js';
import {HouseRuntime} from '../../../src/runtime/house-lifecycle/house-runtime.js';
import {ensureHouseLifecycleSchema} from '../../../src/runtime/house-lifecycle/participation-store.js';
import {lookupThreadPost, type NativePostLookupFailure} from '../../../src/world/thread-post-source.js';
import {resolvePostRefWithSource, _observedPostIdsForTest} from '../../../src/world/post-ref.js';
import type {Signer} from '../../../src/identity/signer.js';
import {refusingReadAuthorityFor} from '../../helpers/read-authority.js';

const ME = 'https://me.invalid', WORLD = 'https://world.invalid', OLD = 'http://127.0.0.1:48190';
const ID = 'abcdeffeed' + 'a'.repeat(54);
const runtimes: HouseRuntime[] = [], dbs: InMemoryHostDb[] = [];
afterEach(async () => {await Promise.all(runtimes.splice(0).map(rt => rt.stop())); dbs.splice(0).forEach(db => db.close()); _observedPostIdsForTest.clear();});
function fixture() {
  const db = new InMemoryHostDb(); dbs.push(db); ensureHouseLifecycleSchema(db);
  const row = (origin: string, phase: string, desired = 'enabled') => db.execute(
    `INSERT INTO house_participation(house_origin,installation_id,desired,phase,op_seq,session_id,lease_expires_at,ack_key_hex)
     VALUES(?,'fixture',?,?,5,'synthetic-session',4102444800,?)`, [origin, desired, phase, 'ab'.repeat(32)]);
  row(ME, 'connected'); row(WORLD, 'connected'); row(OLD, 'connecting');
  const response = {nodes: [{event_id: ID, actor: {popclaw_id: 'synthetic-author', nickname: 'Parent', handle: ''}, body_text: 'Exact source body'}]};
  const fetch = vi.fn(async (input: unknown) => new Response(JSON.stringify(response), {status: String(input).startsWith(WORLD) ? 404 : 200}));
  let pin = 'ab'.repeat(32);
  const rt = new HouseRuntime({db, origins: [ME, WORLD], signer: {} as Signer, readAuthorityFor: refusingReadAuthorityFor,
    configuredPinFor: () => pin, fetch: fetch as typeof globalThis.fetch}); runtimes.push(rt);
  const targets = () => rt.capturePublicReadTargets();
  const failures: NativePostLookupFailure[] = [];
  const lookup = () => lookupThreadPost(ID.slice(0,10), targets(), origin => rt.houseReadFetch(origin), failure => failures.push(failure));
  return {db, rt, fetch, targets, lookup, response, row, failures, setPin: (value: string) => {pin = value;}};
}

it('queries connected mounts without a retained connecting loopback target, preserving every row', async () => {
  const f = fixture(), before = f.db.queryAll('SELECT * FROM house_participation ORDER BY house_origin');
  expect(f.rt.egress.capturePlan().targets.map(t => t.origin)).toContain(OLD);
  expect(f.targets().map(t => t.origin)).toEqual([ME, WORLD]);
  expect(await f.lookup()).toMatchObject({ok: true, sources: [{eventId: ID, houseSlug: 'me-invalid'}]});
  expect(f.fetch).toHaveBeenCalledTimes(2);
  expect(f.db.queryAll('SELECT * FROM house_participation ORDER BY house_origin')).toEqual(before);
});
it('keeps connected pin-refused peers in scope and fails rather than claiming uniqueness', async () => {
  const f = fixture(); f.setPin('cd'.repeat(32));
  expect(f.targets().map(t => t.origin)).toEqual([ME, WORLD]);
  expect(await f.lookup()).toEqual({ok: false, reason: 'unavailable'}); expect(f.fetch).not.toHaveBeenCalled();
  expect(f.failures).toContainEqual({origin: ME, houseSlug: 'me-invalid', stage: 'gate', gateCode: 'HOUSE_TRUST_REVOKED'});
});
it('rejects a captured peer that leaves before its request', async () => {
  const f = fixture(), targets = f.targets();
  f.db.execute("UPDATE house_participation SET desired='disabled',op_seq=op_seq+1 WHERE house_origin=?", [WORLD]);
  expect(await lookupThreadPost(ID.slice(0,10), targets, origin => f.rt.houseReadFetch(origin))).toEqual({ok: false, reason: 'unavailable'});
  expect(f.targets().map(t => t.origin)).toEqual([ME]);
});
it('rejects an already-selected peer HTTP failure', async () => {
  const f = fixture(); f.fetch.mockImplementation(async input => new Response(JSON.stringify(f.response), {status: String(input).startsWith(WORLD) ? 503 : 200}));
  expect(await f.lookup()).toEqual({ok: false, reason: 'unavailable'});
  expect(f.failures).toContainEqual({origin: WORLD, houseSlug: 'world-invalid', stage: 'http', httpStatus: 503});
});
it('retains same-prefix ambiguity across selected connected peers', async () => {
  const f = fixture(); f.fetch.mockImplementation(async input => new Response(JSON.stringify({nodes: [{...f.response.nodes[0],
    event_id: String(input).startsWith(WORLD) ? ID.slice(0,10)+'b'.repeat(54) : ID}]})));
  const result = await resolvePostRefWithSource(ID.slice(0,10), {}, f.lookup, 'en');
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.text).toContain('matches 2 posts');
});

it('rejects a replaced participation tuple even when the peer is connected again', async () => {
  const f = fixture(), targets = f.targets();
  f.db.execute("UPDATE house_participation SET op_seq=op_seq+2,session_id='replacement' WHERE house_origin=?", [WORLD]);
  expect(await lookupThreadPost(ID.slice(0,10), targets, origin => f.rt.houseReadFetch(origin))).toEqual({ok: false, reason: 'unavailable'});
});

it('rejects a selected source that changes while another peer is being read', async () => {
  const f = fixture();
  f.fetch.mockImplementation(async input => {
    if (String(input).startsWith(WORLD)) f.db.execute("UPDATE house_participation SET op_seq=op_seq+1 WHERE house_origin=?", [ME]);
    return new Response(JSON.stringify(f.response), {status: String(input).startsWith(WORLD) ? 404 : 200});
  });
  expect(await f.lookup()).toEqual({ok: false, reason: 'unavailable'});
});

it('does not reinterpret unreadable participation as an empty query scope', () => {
  const f = fixture(); f.db.execute('DROP TABLE house_participation');
  expect(() => f.targets()).toThrow(); expect(f.fetch).not.toHaveBeenCalled();
});

it('records a decode failure without parent content or exception text', async () => {
  const f = fixture(); f.fetch.mockImplementation(async () => new Response('private exception text, invalid JSON'));
  expect(await f.lookup()).toEqual({ok: false, reason: 'unavailable'});
  expect(f.failures).toContainEqual({origin: ME, houseSlug: 'me-invalid', stage: 'decode'});
  expect(JSON.stringify(f.failures)).not.toContain('private exception text');
});
