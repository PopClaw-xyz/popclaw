import { afterEach, expect, it, vi } from 'vitest';
import { InMemoryHostDb } from '../../../src/host/in-memory-host-db.js';
import type { Signer } from '../../../src/identity/signer.js';
import { HouseRuntime } from '../../../src/runtime/house-lifecycle/house-runtime.js';
import { refusingReadAuthorityFor } from '../../helpers/read-authority.js';
import { renderCopy } from '../../../src/lexicon/index.js';

const origin = 'https://world.example';
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });

function fixture() {
  const db = new InMemoryHostDb();
  let now = 1_780_000_000_000;
  const runtime = new HouseRuntime({ readAuthorityFor: refusingReadAuthorityFor, db, signer: {} as Signer, origins: [origin], clock: () => now });
  db.execute(`INSERT INTO house_participation(house_origin, installation_id, op_seq, desired, phase,
    session_id, house_revision, lease_expires_at, ack_key_hex)
    VALUES (?, 'installation', 3, 'enabled', 'connected', 'session', 17, ?, ?)`,
  [origin, now / 1000 + 90, 'ab'.repeat(32)]);
  cleanup.push(async () => { await runtime.stop(); db.close(); });
  return { db, runtime, advance: (ms: number) => { now += ms; } };
}

it('captures the verified session for a reader without claiming stream ownership', () => {
  const { runtime } = fixture();
  expect(runtime.resident.authority.captureEpoch()).toBeNull();
  expect(runtime.captureGate(origin).isActive()).toBe(false);
  const context = runtime.captureSessionCommandContext(origin);
  expect(context).toMatchObject({ installationId: 'installation', sessionId: 'session',
    fence: '17', leaseExpiresAt: 1_780_000_090, gate: { origin, generation: 3 } });
  expect(context.gate.isActive()).toBe(true);
  expect(runtime.resident.authority.captureEpoch()).toBeNull();
});

it.each([
  ['op_seq', 5], ['session_id', 'new-session'], ['house_revision', 18],
  ['installation_id', 'new-installation'], ['ack_key_hex', 'cd'.repeat(32)],
  ['desired', 'disabled'], ['phase', 'connecting'],
] as const)('fences a captured command when %s changes', (column, value) => {
  const { db, runtime } = fixture();
  const context = runtime.captureSessionCommandContext(origin);
  db.execute(`UPDATE house_participation SET ${column}=? WHERE house_origin=?`, [value, origin]);
  expect(context.gate.isActive()).toBe(false);
  // Captured signing inputs never pick up a later row.
  expect(context.fence).toBe('17'); expect(context.sessionId).toBe('session');
});

it('permits renewal of the same session but rejects an expired current lease', () => {
  const { db, runtime, advance } = fixture();
  const context = runtime.captureSessionCommandContext(origin);
  db.execute('UPDATE house_participation SET lease_expires_at=lease_expires_at+90 WHERE house_origin=?', [origin]);
  advance(100_000);
  expect(context.gate.isActive()).toBe(true);
  expect(context.leaseExpiresAt).toBe(1_780_000_090);
  advance(80_000);
  expect(context.gate.isActive()).toBe(false);
  expect(() => runtime.captureSessionCommandContext(origin)).toThrow('HOUSE_SESSION_CONTEXT_UNAVAILABLE');
});

it.each([
  ['session_id', ''], ['ack_key_hex', ''], ['house_revision', 0],
  ['house_revision', Number.MAX_SAFE_INTEGER + 1], ['house_revision', 1.5],
] as const)('rejects unavailable or inexact session input %s=%s', (column, value) => {
  const { db, runtime } = fixture();
  db.execute(`UPDATE house_participation SET ${column}=? WHERE house_origin=?`, [value, origin]);
  expect(() => runtime.captureSessionCommandContext(origin)).toThrow('HOUSE_SESSION_CONTEXT_UNAVAILABLE');
});

it('does not recapture a newer session from a command that started before logout', async () => {
  const { db, runtime } = fixture();
  let release!: () => void;
  const hold = new Promise<void>(done => { release = done; });
  const command = runtime.runCommand(async () => { await hold; return runtime.captureSessionCommandContext(origin); });
  await Promise.resolve();
  db.execute('UPDATE house_participation SET op_seq=5, house_revision=19, session_id=? WHERE house_origin=?', ['new', origin]);
  release();
  await expect(command).rejects.toThrow('no longer active');
  expect(runtime.captureSessionCommandContext(origin).fence).toBe('19');
});

it('does not replace a command fence after awaiting even if other session fields stay unchanged', async () => {
  const { db, runtime } = fixture();
  let release!: () => void;
  const hold = new Promise<void>(done => { release = done; });
  const command = runtime.runCommand(async () => { await hold; return runtime.captureSessionCommandContext(origin); });
  await Promise.resolve();
  db.execute('UPDATE house_participation SET house_revision=18 WHERE house_origin=?', [origin]);
  release();
  await expect(command).rejects.toThrow('no longer active');
});

// House acceptance round 8: a house whose verified manifest declares
// house_session: null (true of every official Rust LoreHouse on launch day)
// left the owner with the bare code and nothing to act on. remote_status
// captures that exact verdict durably (participation-store.ts), and
// house-runtime.ts re-reads it fresh at throw time so the extra sentence
// only ever fires when it is actually true — for either throw site.
it('names the missing session control when the house never captured one and remote_status says unsupported', () => {
  const { db, runtime } = fixture();
  db.execute("UPDATE house_participation SET session_id='', remote_status='unsupported' WHERE house_origin=?", [origin]);
  const expected = `HOUSE_SESSION_CONTEXT_UNAVAILABLE: ${renderCopy('en', 'house.session.unsupported', { origin })}`;
  let caught: unknown;
  try { runtime.captureSessionCommandContext(origin); } catch (err) { caught = err; }
  expect((caught as Error).message).toBe(expected);
});

it('names the missing session control when a live session goes stale because a renewal found the house unsupported', () => {
  const { db, runtime } = fixture();
  expect(runtime.captureSessionCommandContext(origin).gate.isActive()).toBe(true);
  db.execute("UPDATE house_participation SET phase='connecting', remote_status='unsupported' WHERE house_origin=?", [origin]);
  const expected = `HOUSE_SESSION_CONTEXT_UNAVAILABLE: ${renderCopy('en', 'house.session.unsupported', { origin })}`;
  let caught: unknown;
  try { runtime.captureSessionCommandContext(origin); } catch (err) { caught = err; }
  expect((caught as Error).message).toBe(expected);
});

// Negative control: a house that DOES offer sessions but is merely not
// active right now (reconnecting, lease not yet renewed) must never claim
// "this house does not offer session control" — that would be false.
it('leaves the bare code when the session is merely inactive, not unsupported', () => {
  const { db, runtime } = fixture();
  db.execute("UPDATE house_participation SET phase='connecting' WHERE house_origin=?", [origin]);
  let caught: unknown;
  try { runtime.captureSessionCommandContext(origin); } catch (err) { caught = err; }
  expect((caught as Error).message).toBe('HOUSE_SESSION_CONTEXT_UNAVAILABLE');
});

it('stops captured contexts without querying a closed database', async () => {
  const { db, runtime } = fixture();
  const context = runtime.captureSessionCommandContext(origin);
  await runtime.stop();
  const query = vi.spyOn(db, 'queryOne').mockImplementation(() => { throw new Error('database closed'); });
  expect(context.gate.signal.aborted).toBe(true);
  expect(context.gate.isActive()).toBe(false);
  expect(() => runtime.captureSessionCommandContext(origin)).toThrow('HOUSE_RUNTIME_STOPPED');
  expect(query).not.toHaveBeenCalled();
  query.mockRestore();
});
