import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalHostDb } from '../../../src/host/local-host-db.js';
import { WorldParticipation } from '../../../src/world/world-participation.js';
import { HostWorldTurn, sealHostWorldTurnInput, type HostWorldTurnHost, type HostWorldTurnAuthority } from '../../../src/runtime/host-world-turn.js';

const actor = '11111111111111111111111111111111';
const house = { origin: 'https://world.invalid', houseKey: actor, incarnation: 'inc_1' };
const fields = () => ({ house: { ...house }, actorId: actor, installationId: 'install_1', sessionId: 'session_1', fence: '7',
  jobId: 'job_1', turnId: 'turn_1', ticketId: 'ticket_1', contextDigest: 'a'.repeat(64), prompt: 'Bound world context',
  sessionLeaseExpiresAt: 1200, ticketExpiresAt: 1150, validUntil: 1100 });
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const owned: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of owned.splice(0).reverse()) await cleanup(); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'host-world-turn-')), path = join(root, 'journal.db'), db = new LocalHostDb(path);
  let time = 1000, active = true;
  const abort = new AbortController(), gate = { origin: house.origin, generation: 3, signal: abort.signal, isActive: () => active };
  const check = vi.fn(() => {}), authority: HostWorldTurnAuthority = { gate, check };
  const isAvailable = vi.fn(async () => true);
  const run = vi.fn<HostWorldTurnHost['run']>(async input => ({ runId: input.runId, sessionKey: input.sessionKey,
    runtime: { harness: 'host', provider: 'configured', model: 'configured-model' } }));
  const waitForRun = vi.fn<HostWorldTurnHost['waitForRun']>(async input => ({ runId: input.runId, status: 'ok',
    startedAt: 1000000, endedAt: 1000500, providerStarted: true, terminalReply: { disposition: 'visible', text: '{"candidate":1}' } }));
  const readOutput = vi.fn<HostWorldTurnHost['readOutput']>(async () => ({ kind: 'bound', text: '{"candidate":1}',
    source: 'terminal_reply_and_dedicated_transcript', evidence: { transcriptDigest: 'b'.repeat(64) } }));
  const host: HostWorldTurnHost = { id: 'controlled-host', createSessionKey: token => `agent:main:popclaw-world-turn:${token}`,
    isAvailable, run, waitForRun, readOutput };
  const journal = new HostWorldTurn({ db, host, now: () => time });
  owned.push(async () => { journal.stop(); await journal.whenIdle(); db.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, path, db, journal, host, isAvailable, run, waitForRun, readOutput, authority, check, abort,
    time: (value: number) => { time = value; }, active: (value: boolean) => { active = value; }, input: sealHostWorldTurnInput(fields()) };
}

describe('durable host world turn admission', () => {
  it('uses the exact original ticket returned by real WorldParticipation.reserveTurn without charging another model turn', async () => {
    const f = fixture(), now = '1970-01-01T00:16:40Z', until = '1970-01-01T00:18:20Z';
    const policy = new WorldParticipation(f.db, house, actor, 'participation_1');
    expect(policy.mergeAuthenticatedDescriptor({ version: 1,
      house: { origin: house.origin, house_key: house.houseKey, incarnation: house.incarnation }, actor_id: actor,
      participation_id: 'participation_1', revision: '1', window: { id: 'window_1', opens_at: '1970-01-01T00:15:00Z', closes_at: '1970-01-01T00:20:00Z' },
      action_groups: [{ id: 'decision', intent_kinds: ['example.choose'], control_reset: 'explicit', channels: ['intent'] }],
      opportunities: [{ id: 'op_1', action_group_id: 'decision', budget_group_id: 'turn_budget', budget_window_id: 'window_1',
        not_before: now, expires_at: until, dedupe_key: 'choose_once', channels: ['intent'] }],
      budgets: [{ id: 'turn_budget', window_id: 'window_1', resource: 'agent_turn', suggested_limit: 2 }] },
    { source: 'verified_action_result', trustedCurrent: true, capabilityRevision: 'a'.repeat(64) }, now).ok).toBe(true);
    const limits = { agent_turn: 2, outbound_message: 0, owner_notice: 0 };
    expect(policy.configureCeilings({ aggregate: limits, rolling: { seconds: 3600, limits }, count_successful_owner_messages: false }).ok).toBe(true);
    expect(policy.grant({ allowed_action_kinds: ['example.choose'], expires_at: until, window_ref: 'window_1',
      max_agent_turns: 2, max_outbound_messages: 0, max_owner_notices: 0 }).ok).toBe(true);
    const request = { jobId: 'job_1', turnId: 'turn_1', opportunityIds: ['op_1'], expectedCapabilityRevision: 'a'.repeat(64), contextValidUntil: until };
    const reserved = policy.reserveTurn(request, now);
    expect(reserved.ok).toBe(true); if (!reserved.ok) throw new Error(reserved.code);
    const ticket = reserved.value.ticket;
    expect(ticket.turnReservationId).toContain('['); expect(ticket.turnReservationId.length).toBeGreaterThan(128);
    const input = sealHostWorldTurnInput({ ...fields(), ticketId: ticket.turnReservationId });
    const authority = { ...f.authority, check: (captured: Readonly<typeof input>) => {
      expect(captured.ticketId).toBe(ticket.turnReservationId);
      const current = policy.authorizeTurn({ turnReservationId: captured.ticketId, jobId: captured.jobId, turnId: captured.turnId }, now);
      if (!current.ok) throw new Error(current.code);
    } };
    expect((await f.journal.startOnce(input, authority)).state).toBe('accepted');
    expect(policy.reserveTurn(request, now)).toMatchObject({ ok: true, value: { created: false, ticket: { turnReservationId: ticket.turnReservationId } } });
    await f.journal.startOnce(input, authority);
    expect(f.run).toHaveBeenCalledOnce(); expect(policy.usage().filter(row => row.resource === 'agent_turn')).toHaveLength(1);
    expect(f.db.queryOne<{ input_json: string }>('SELECT input_json FROM host_world_turns_v1')?.input_json).toContain(JSON.stringify(ticket.turnReservationId));
    for (const ticketId of ['t'.repeat(8193), 'ticket\nvalue', 'bad\ud800']) expect(() => sealHostWorldTurnInput({ ...fields(), ticketId })).toThrow();
  });

  it('commits the complete input before host dispatch and only one concurrent connection creates the run', async () => {
    const f = fixture(), wait = deferred<boolean>(); f.isAvailable.mockReturnValueOnce(wait.promise);
    const first = f.journal.startOnce(f.input, f.authority);
    const persisted = f.journal.view(f.input);
    expect(persisted).toMatchObject({ state: 'unknown', inputDigest: f.input.inputDigest, acceptedSessionKey: null, runtime: null });
    expect(persisted.runId).toMatch(/^popclaw-world-turn:/);
    const peerDb = new LocalHostDb(f.path), peer = new HostWorldTurn({ db: peerDb, host: f.host, now: () => 1000 });
    try {
      expect((await peer.startOnce(f.input, f.authority)).runId).toBe(persisted.runId);
      expect(f.run).not.toHaveBeenCalled();
      wait.resolve(true);
      expect(await first).toMatchObject({ state: 'accepted', acceptedSessionKey: persisted.requestedSessionKey });
      expect(f.run).toHaveBeenCalledOnce();
      expect(f.run).toHaveBeenCalledWith({ runId: persisted.runId, sessionKey: persisted.requestedSessionKey, prompt: f.input.prompt });
      expect((await peer.startOnce(f.input, f.authority)).runId).toBe(persisted.runId);
      expect(f.run).toHaveBeenCalledOnce();
    } finally { wait.resolve(false); await first; peer.stop(); await peer.whenIdle(); peerDb.close(); }
  });

  it('rejects changed inputs, forged digests, expiry expansion, and ticket reuse without dispatch', async () => {
    const f = fixture(); await f.journal.startOnce(f.input, f.authority);
    for (const changed of [{ prompt: 'different' }, { sessionId: 'session_2' }, { fence: '8' }, { ticketId: 'ticket_2' }, { validUntil: 1101 }]) {
      await expect(f.journal.startOnce(sealHostWorldTurnInput({ ...fields(), ...changed }), f.authority)).rejects.toThrow('HOST_WORLD_TURN_INPUT_CONFLICT');
    }
    await expect(f.journal.startOnce({ ...f.input, prompt: 'forged' }, f.authority)).rejects.toThrow('HOST_WORLD_TURN_DIGEST_MISMATCH');
    expect(() => sealHostWorldTurnInput({ ...fields(), validUntil: 1201 })).toThrow('HOST_WORLD_TURN_EXPIRY_INVALID');
    await expect(f.journal.startOnce(sealHostWorldTurnInput({ ...fields(), jobId: 'other_job', turnId: 'other_turn' }), f.authority)).rejects.toThrow('HOST_WORLD_TURN_TICKET_REUSED');
    expect(f.run).toHaveBeenCalledOnce();
  });

  it('snapshots mutable input before availability and rechecks actual authorization after every await', async () => {
    const f = fixture(), wait = deferred<boolean>(); f.isAvailable.mockReturnValueOnce(wait.promise);
    const mutable = { ...f.input, house: { ...f.input.house } }, starting = f.journal.startOnce(mutable, f.authority);
    mutable.prompt = 'caller rewrite'; mutable.house.incarnation = 'foreign'; mutable.validUntil = 9999;
    wait.resolve(true); await starting;
    expect(f.run.mock.calls[0]![0].prompt).toBe(f.input.prompt);
    expect(f.check.mock.calls.length).toBeGreaterThanOrEqual(3);
    for (const [input] of f.check.mock.calls as unknown as Array<[typeof f.input]>) {
      expect(input).toEqual(f.input); expect(Object.isFrozen(input)).toBe(true); expect(Object.isFrozen(input.house)).toBe(true);
    }
  });

  it('never reruns an intent after unavailable host, thrown/lost ACK, or reopen', async () => {
    for (const failure of ['unavailable', 'lost_ack']) {
      const f = fixture();
      if (failure === 'unavailable') f.isAvailable.mockResolvedValue(false); else f.run.mockRejectedValue(new Error('ACK_LOST'));
      const result = await f.journal.startOnce(f.input, f.authority);
      expect(result.state).toBe('unknown'); expect(result.acceptedSessionKey).toBeNull();
      const calls = f.run.mock.calls.length, peerDb = new LocalHostDb(f.path), peer = new HostWorldTurn({ db: peerDb, host: f.host, now: () => 1000 });
      try {
        expect((await peer.startOnce(f.input, f.authority)).runId).toBe(result.runId);
        expect(f.run.mock.calls.length).toBe(calls);
        f.isAvailable.mockResolvedValue(true);
        expect((await peer.reconcile(f.input, f.authority, { timeoutMs: 20 })).state).toBe('completed_unverified');
        expect(f.waitForRun).toHaveBeenCalledWith({ runId: result.runId, timeoutMs: 20 });
        expect(f.readOutput).not.toHaveBeenCalled(); expect(f.run.mock.calls.length).toBe(calls);
      } finally { peer.stop(); await peer.whenIdle(); peerDb.close(); }
    }
  });

  it.each(['run', 'session', 'metadata', 'missing'])('retains uncertain admission for invalid %s ACK', async fault => {
    const f = fixture(); f.run.mockImplementation(async input => ({ runId: fault === 'run' ? 'wrong_run' : input.runId,
      ...(fault === 'missing' ? {} : { sessionKey: fault === 'session' ? 'agent:main:shared' : input.sessionKey }),
      runtime: fault === 'metadata' ? { model: 'partial' } : { harness: 'h', provider: 'p', model: 'm' } }));
    const result = await f.journal.startOnce(f.input, f.authority);
    expect(result.state).toBe('unknown'); expect(result.runtime).toBeNull();
    await f.journal.startOnce(f.input, f.authority); expect(f.run).toHaveBeenCalledOnce();
    expect(f.journal.audit(f.input).some(event => event.kind === 'run_ack')).toBe(true);
  });

  it('fences logout or expiry between availability and dispatch', async () => {
    for (const cause of ['logout', 'expired']) {
      const f = fixture(), wait = deferred<boolean>(); f.isAvailable.mockReturnValueOnce(wait.promise);
      const starting = f.journal.startOnce(f.input, f.authority);
      if (cause === 'logout') f.active(false); else f.time(1100);
      wait.resolve(true);
      expect((await starting).state).toBe('cancel_pending'); expect(f.run).not.toHaveBeenCalled();
    }
  });

  it('never replaces the originally captured gate/checker with mutable caller authority across awaits', async () => {
    const f = fixture(), wait = deferred<boolean>(); f.isAvailable.mockReturnValueOnce(wait.promise);
    const mutableGate = { ...f.authority.gate }, mutableAuthority = { gate: mutableGate, check: f.authority.check };
    const starting = f.journal.startOnce(f.input, mutableAuthority);
    f.abort.abort();
    mutableGate.signal = new AbortController().signal;
    mutableAuthority.gate = { ...mutableGate, isActive: () => true };
    mutableAuthority.check = () => {};
    wait.resolve(true);
    expect((await starting).state).toBe('cancel_pending'); expect(f.run).not.toHaveBeenCalled();
  });

  it('requires a synchronous mandatory authorization checker and an active origin-bound gate', async () => {
    const f = fixture();
    await expect(f.journal.startOnce(f.input, { gate: f.authority.gate } as HostWorldTurnAuthority)).rejects.toThrow('HOST_WORLD_TURN_AUTHORITY_REQUIRED');
    await expect(f.journal.startOnce(f.input, { ...f.authority, check: async () => {} })).rejects.toThrow('HOST_WORLD_TURN_AUTHORITY_INVALID');
    await expect(f.journal.startOnce(f.input, { ...f.authority, gate: { ...f.authority.gate, origin: 'https://foreign.invalid' } })).rejects.toThrow('HOST_WORLD_TURN_GATE_CLOSED');
    expect(f.run).not.toHaveBeenCalled();
  });
});

describe('bounded reconciliation and local cancellation', () => {
  it('preserves pending/timeout/error metadata, uses only the original run, and never equates a timeout with cancellation', async () => {
    const f = fixture(), accepted = await f.journal.startOnce(f.input, f.authority);
    for (const status of ['pending', 'timeout', 'error']) {
      const metadata = { runId: accepted.runId, status, timeoutPhase: 'queue', providerStarted: false, pendingError: true, stopReason: 'queued', error: 'not final' };
      f.waitForRun.mockResolvedValue(metadata);
      const result = await f.journal.reconcile(f.input, f.authority, { timeoutMs: 0 });
      expect(result.state).toBe(status === 'pending' ? 'pending' : 'unknown'); expect(result.lastWait).toEqual(metadata);
      expect(result.runtime).toEqual(accepted.runtime); expect(result.cancelReason).toBeNull(); expect(result.output).toBeUndefined();
    }
    expect(f.readOutput).not.toHaveBeenCalled(); expect(f.run).toHaveBeenCalledOnce();
    for (const [request] of f.waitForRun.mock.calls) expect(request).toEqual({ runId: accepted.runId, timeoutMs: 0 });
  });

  it('exposes only bound untrusted output after real terminal evidence and live authorization', async () => {
    const f = fixture(); await f.journal.startOnce(f.input, f.authority);
    const result = await f.journal.reconcile(f.input, f.authority, { timeoutMs: 20 });
    expect(result).toMatchObject({ state: 'completed', output: { text: '{"candidate":1}', trust: 'untrusted_model_output' } });
    expect(f.readOutput).toHaveBeenCalledOnce();
    expect(f.journal.view(f.input).output).toBeUndefined();
    f.time(1100);
    expect((await f.journal.reconcile(f.input, f.authority, { timeoutMs: 0 })).output).toBeUndefined();
    expect(f.run).toHaveBeenCalledOnce();
  });

  it('keeps wrong-run, incomplete terminal, or unverified output from activating', async () => {
    const f = fixture(), admitted = await f.journal.startOnce(f.input, f.authority);
    f.waitForRun.mockResolvedValue({ runId: 'foreign', status: 'ok', startedAt: 1000000, endedAt: 1000500 });
    expect((await f.journal.reconcile(f.input, f.authority, { timeoutMs: 1 })).state).toBe('unknown');
    expect(f.readOutput).not.toHaveBeenCalled();
    f.waitForRun.mockResolvedValue({ runId: admitted.runId, status: 'ok' });
    expect((await f.journal.reconcile(f.input, f.authority, { timeoutMs: 1 })).state).toBe('completed_unverified');
    f.waitForRun.mockResolvedValue({ runId: admitted.runId, status: 'ok', startedAt: 1000000, endedAt: 1000500 });
    f.readOutput.mockResolvedValue({ kind: 'unverified', reason: 'TRANSCRIPT_NOT_BOUND' });
    expect((await f.journal.reconcile(f.input, f.authority, { timeoutMs: 1 })).output).toBeUndefined();
  });

  it('stop persists cancel_pending and joins actual late run ACK without activating output', async () => {
    const f = fixture(), ack = deferred<unknown>(); f.run.mockReturnValue(ack.promise);
    const starting = f.journal.startOnce(f.input, f.authority);
    await vi.waitFor(() => expect(f.run).toHaveBeenCalledOnce());
    const request = f.run.mock.calls[0]![0];
    f.journal.stop(); expect(f.journal.view(f.input).state).toBe('cancel_pending');
    let idle = false; const quiescent = f.journal.whenIdle().then(() => { idle = true; });
    await Promise.resolve(); expect(idle).toBe(false);
    ack.resolve({ runId: request.runId, sessionKey: request.sessionKey, runtime: { harness: 'h', provider: 'p', model: 'm' } });
    expect((await starting).state).toBe('cancel_pending'); await quiescent;
    expect(f.journal.audit(f.input).some(event => event.kind === 'run_ack')).toBe(true);
    expect(f.readOutput).not.toHaveBeenCalled();
  });

  it('cancelLocal fences a late wait/output, preserves audit, and does not cancel or delete host sessions', async () => {
    const f = fixture(); await f.journal.startOnce(f.input, f.authority);
    const pending = deferred<Awaited<ReturnType<HostWorldTurnHost['readOutput']>>>(); f.readOutput.mockReturnValue(pending.promise);
    const reconcile = f.journal.reconcile(f.input, f.authority, { timeoutMs: 10 });
    await vi.waitFor(() => expect(f.readOutput).toHaveBeenCalledOnce());
    f.journal.cancelLocal(f.input, 'owner stopped');
    pending.resolve({ kind: 'bound', text: 'late result', source: 'terminal_reply_and_dedicated_transcript', evidence: {} });
    const result = await reconcile;
    expect(result.state).toBe('cancel_pending'); expect(result.output).toBeUndefined();
    expect(f.journal.audit(f.input).some(event => event.kind === 'output_evidence')).toBe(true);
    expect(f.run).toHaveBeenCalledOnce();
  });
});
