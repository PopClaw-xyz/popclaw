import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { popclaw } from '@popclaw/contracts';
import { LocalHostDb } from '../../../src/host/local-host-db.js';
import type { HostDb } from '../../../src/host/host-db.js';
import { WorldParticipation, validateParticipationDescriptor, participationDescriptorFromProto, type ParticipationDescriptor, type ParticipationInvocation,
  type ParticipationLocalPolicy, type ParticipationCeilings, type ParticipationResult, type ParticipationBatchOutcome } from '../../../src/world/world-participation.js';

const cap = 'a'.repeat(64);
const now = '2026-09-08T14:00:00Z';
// Frozen pure-protocol fixtures copied in-tree (see tests/fixtures/world/README.md).
const fixtures = new URL('../../fixtures/world/', import.meta.url);
const load = (file: string) => JSON.parse(readFileSync(new URL(file, fixtures), 'utf8'));
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const directories: string[] = [];
const handles: LocalHostDb[] = [];
const evidence = { source: 'verified_action_result' as const, trustedCurrent: true, capabilityRevision: cap };
const ceiling = (): ParticipationCeilings => ({ aggregate: { agent_turn: 100, outbound_message: 100, owner_notice: 100 },
  rolling: { seconds: 86400 * 30, limits: { agent_turn: 100, outbound_message: 100, owner_notice: 100 } }, count_successful_owner_messages: true });
function value<T>(r: ParticipationResult<T>): T { expect(r.ok, JSON.stringify(r)).toBe(true); if (!r.ok) throw Error(r.code); return r.value; }
function success(r: ParticipationResult<ParticipationBatchOutcome[]>) {
  const first = value(r)[0]!; expect(first.ok, JSON.stringify(first)).toBe(true); if (!first.ok) throw Error(first.code); return first.reservation;
}
function code(r: ParticipationResult<ParticipationBatchOutcome[]>): string {
  if (!r.ok) return r.code;
  return r.value[0]!.ok ? 'SUBMITTED' : r.value[0]!.code;
}
function make(world = 'train') {
  const d: ParticipationDescriptor = load(`participation/${world === 'train' ? 'train-window-w42' : 'reading-window-wk8'}.json`).document;
  const house = { origin: d.house.origin, houseKey: d.house.house_key, incarnation: d.house.incarnation };
  const dir = mkdtempSync(join(tmpdir(), 'world-policy-')); directories.push(dir); const path = join(dir, 'policy.db');
  let db = new LocalHostDb(path); handles.push(db);
  let engine = new WorldParticipation(db, house, d.actor_id, d.participation_id);
  value(engine.mergeAuthenticatedDescriptor(d, evidence, now));
  value(engine.configureCeilings(ceiling()));
  const grant = (overrides: Partial<ParticipationLocalPolicy> = {}) => value(engine.grant({ allowed_action_kinds: d.action_groups.flatMap(g => g.intent_kinds),
    expires_at: '2026-10-01T00:00:00Z', max_agent_turns: 3, max_outbound_messages: 3, max_owner_notices: 2, ...overrides }));
  let counter = 0;
  const invoke = (opportunityId: string, kind?: string, channel: ParticipationInvocation['channel'] = 'intent', at = now): ParticipationInvocation => {
    const current = engine.facts()!;
    const opportunity = current.opportunities.find(o => o.id === opportunityId)!;
    return { opportunityId, kind: kind ?? current.action_groups.find(g => g.id === opportunity.action_group_id)!.intent_kinds[0]!, channel,
      message: channel === 'direct_message' || current.budgets.find(b => b.id === opportunity.budget_group_id)!.resource === 'outbound_message',
      contextValidUntil: new Date(Math.min(Date.parse(opportunity.expires_at), Date.parse(at) + 300000)).toISOString().replace('.000Z', 'Z'), expectedCapabilityRevision: cap };
  };
  const reserve = (invs: ParticipationInvocation[], at = now) => engine.reserveBatch({ jobId: `job_${++counter}`, turnId: `turn_${counter}`, invocations: invs }, at);
  const reopen = () => { db.close(); db = new LocalHostDb(path); handles.push(db); engine = new WorldParticipation(db, house, d.actor_id, d.participation_id); };
  return { d, house, path, get db() { return db; }, get engine() { return engine; }, grant, invoke, reserve, reopen };
}
afterEach(() => { handles.splice(0).forEach(db => db.close()); directories.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })); });

describe('WorldParticipation strict descriptor boundary', () => {
  it('asserts the immutable database, complete house, actor and participation binding', () => {
    const h = make(), other = make();
    expect(() => h.engine.assertBinding(h.db, h.house, h.d.actor_id, h.d.participation_id)).not.toThrow();
    expect(() => h.engine.assertBinding(other.db, h.house, h.d.actor_id, h.d.participation_id)).toThrow('PARTICIPATION_BINDING_MISMATCH');
    for (const house of [{ ...h.house, origin: 'https://other.invalid' }, { ...h.house, houseKey: 'other' }, { ...h.house, incarnation: 'other' }]) {
      expect(() => h.engine.assertBinding(h.db, house, h.d.actor_id, h.d.participation_id)).toThrow('PARTICIPATION_BINDING_MISMATCH');
    }
    expect(() => h.engine.assertBinding(h.db, h.house, 'other_actor', h.d.participation_id)).toThrow('PARTICIPATION_BINDING_MISMATCH');
    expect(() => h.engine.assertBinding(h.db, h.house, h.d.actor_id, 'other_participation')).toThrow('PARTICIPATION_BINDING_MISMATCH');
  });
  it.each(['train', 'reading'])('validates the frozen %s descriptor without vocabulary branches', world => {
    const h = make(world);
    expect(validateParticipationDescriptor(h.d, h.house, h.d.actor_id)).toEqual(h.d);
    expect(h.engine.eligibleOpportunities(now)).toEqual([]); // T1: facts never grant jobs.
    expect(h.engine.reservations()).toEqual([]);
  });
  it.each(load('participation/invalid-cases.json').cases as { name: string; delta?: any; mutate?: any; push?: any; custom?: string }[])('rejects frozen invalid case $name', testCase => {
    const h = make(); const bad: any = clone(h.d);
    if (testCase.delta) Object.assign(bad, testCase.delta);
    if (testCase.mutate) {
      const keys = [...testCase.mutate.path]; const last = keys.pop();
      keys.reduce((row: any, key: any) => row[key], bad)[last] = testCase.mutate.value;
    }
    if (testCase.push) testCase.push.array_path.reduce((row: any, key: any) => row[key], bad).push(testCase.push.item);
    if (testCase.custom === 'declared_slot_key_mismatch') bad.opportunities.find((o: any) => o.channels?.includes('direct_message')).dedupe_key = 'evil_slot';
    if (testCase.custom === 'groups_over_limit') bad.action_groups = Array.from({ length: 17 }, (_, i) => ({ id: `group_${i}`, control_reset: 'window', intent_kinds: ['neutral.kind'] }));
    expect(() => validateParticipationDescriptor(bad, h.house, h.d.actor_id)).toThrow();
  });
  it('rejects calendar errors, malformed identities and field extensions', () => {
    const h = make();
    for (const mutate of [
      (d: any) => { d.window.opens_at = '2026-02-30T13:00:00Z'; },
      (d: any) => { d.actor_id = '1'.repeat(33); },
      (d: any) => { d.opportunities[0].instruction = 'execute'; },
      (d: any) => { d.opportunities[0].budget_window_id = 'other_window'; },
    ]) { const bad = clone(h.d); mutate(bad); expect(() => validateParticipationDescriptor(bad, h.house, h.d.actor_id)).toThrow(); }
    const max = { ...h.d, revision: '18446744073709551615' };
    expect(validateParticipationDescriptor(max, h.house, h.d.actor_id).revision).toBe(max.revision);
  });
  it('adapts verified proto Longs without rounding revisions or rejecting valid pre-epoch times', () => {
    const h = make(); const d = h.d;
    const p = popclaw.world.ParticipationDescriptor.fromObject({ version: 1, house: h.house, actorId: d.actor_id,
      participationId: d.participation_id, revision: '18446744073709551615', windowId: 'historical', windowOpensAt: '-60', windowClosesAt: '60',
      actionGroups: d.action_groups.map(g => ({ id: g.id, intentKinds: g.intent_kinds, controlReset: g.control_reset, channels: g.channels })), budgets: [], opportunities: [],
    });
    expect(validateParticipationDescriptor(participationDescriptorFromProto(p), h.house, d.actor_id)).toMatchObject({ revision: '18446744073709551615', window: { opens_at: '1969-12-31T23:59:00Z' } });
    expect(() => participationDescriptorFromProto({ ...p, revision: Number.MAX_SAFE_INTEGER + 1 })).toThrow('UINT64_INVALID');
  });
  it('conflicts equal revision canonical content, ignores older revisions, requires explicit current refresh after gap', () => {
    const h = make(); h.grant();
    value(h.engine.invalidate('gap'));
    expect(h.engine.eligibleOpportunities(now)).toEqual([]);
    value(h.engine.mergeAuthenticatedDescriptor(h.d, { ...evidence, trustedCurrent: false }, now));
    expect(h.engine.eligibleOpportunities(now)).toEqual([]);
    value(h.engine.mergeAuthenticatedDescriptor(h.d, evidence, now));
    expect(h.engine.eligibleOpportunities(now).length).toBeGreaterThan(0);
    expect(value(h.engine.mergeAuthenticatedDescriptor({ ...h.d, revision: '0' }, evidence, now))).toBe('old');
    const altered = clone(h.d); altered.budgets[0]!.suggested_limit++;
    expect(h.engine.mergeAuthenticatedDescriptor(altered, evidence, now)).toMatchObject({ ok: false, code: 'DESCRIPTOR_REVISION_CONFLICT' });
    expect(h.engine.eligibleOpportunities(now)).toEqual([]);
    expect(h.engine.facts()).toEqual(h.d);
    const reordered = Object.fromEntries(Object.entries(h.d).reverse());
    expect(value(h.engine.mergeAuthenticatedDescriptor(reordered, evidence, now))).toBe('duplicate');
    expect(h.engine.eligibleOpportunities(now).length).toBeGreaterThan(0);
  });
  it('installs non-current authenticated facts while disabling autonomy until an explicitly current refresh', () => {
    const h = make(); h.grant(); const r = success(h.reserve([h.invoke('o_decision')]));
    expect(h.engine.eligibleOpportunities(now).length).toBeGreaterThan(0);
    const newer = { ...h.d, revision: '13' };
    value(h.engine.mergeAuthenticatedDescriptor(newer, { ...evidence, trustedCurrent: false }, now));
    expect(h.engine.facts()!.revision).toBe('13'); expect(h.engine.eligibleOpportunities(now)).toEqual([]);
    expect(code(h.reserve([h.invoke('o_statement')]))).toBe('DESCRIPTOR_UNAVAILABLE');
    expect(h.engine.authorizeReservation({ reservationId: r.reservationId, jobId: r.jobId, invocation: r.invocation }, now).ok).toBe(false);
    value(h.engine.mergeAuthenticatedDescriptor(newer, evidence, now));
    const current = success(h.reserve([h.invoke('o_statement')]));
    value(h.engine.mergeAuthenticatedDescriptor(newer, { ...evidence, trustedCurrent: false }, now));
    expect(h.engine.authorizeReservation({ reservationId: current.reservationId, jobId: current.jobId, invocation: current.invocation }, now)).toMatchObject({ ok: false, code: 'DESCRIPTOR_UNAVAILABLE' });
    value(h.engine.takeover({ whole: true }));
    value(h.engine.mergeAuthenticatedDescriptor(newer, evidence, now));
    expect(h.engine.eligibleOpportunities(now)).toEqual([]);
    value(h.engine.resume({ whole: true }));
    expect(h.engine.eligibleOpportunities(now).length).toBeGreaterThan(0);
    value(h.engine.mergeAuthenticatedDescriptor(h.d, { ...evidence, trustedCurrent: false }, now));
    expect(h.engine.eligibleOpportunities(now).length).toBeGreaterThan(0); // Older evidence cannot roll current availability back.
  });
});

describe('WorldParticipation durable reservations and control', () => {
  it('keeps failed-persistence invalidation fenced until a complete current descriptor commits', () => {
    const h = make(); h.grant(); const r = success(h.reserve([h.invoke('o_decision')]));
    const check = { reservationId: r.reservationId, jobId: r.jobId, invocation: r.invocation };
    const replay = { jobId: r.jobId, turnId: r.turnId, invocations: [r.invocation] };
    const blocked = () => {
      expect(h.engine.eligibleOpportunities(now)).toEqual([]);
      expect(h.engine.authorizeReservation(check, now)).toMatchObject({ ok: false, code: 'DESCRIPTOR_UNAVAILABLE' });
      expect(h.engine.reserveBatch(replay, now)).toMatchObject({ ok: false, code: 'DESCRIPTOR_UNAVAILABLE' });
      expect(code(h.reserve([h.invoke('o_statement')]))).toBe('DESCRIPTOR_UNAVAILABLE');
    };
    h.db.execute("CREATE TRIGGER reject_invalidation BEFORE UPDATE ON world_participation_policy BEGIN SELECT RAISE(ABORT, 'injected_disk_failure'); END");
    expect(h.engine.invalidate('untrusted')).toMatchObject({ ok: false, code: 'injected_disk_failure' });
    blocked();
    expect(h.engine.mergeAuthenticatedDescriptor(h.d, evidence, now)).toMatchObject({ ok: false, code: 'injected_disk_failure' });
    h.db.execute('DROP TRIGGER reject_invalidation');
    expect(JSON.parse(h.db.queryOne<{ state: string }>('SELECT state FROM world_participation_policy')!.state).available).toBe(true);
    blocked();
    expect(value(h.engine.mergeAuthenticatedDescriptor({ ...h.d, revision: String(BigInt(h.d.revision) - 1n) }, evidence, now))).toBe('old');
    blocked();
    value(h.engine.mergeAuthenticatedDescriptor(h.d, { ...evidence, trustedCurrent: false }, now));
    blocked();
    value(h.engine.mergeAuthenticatedDescriptor(h.d, evidence, now));
    expect(h.engine.eligibleOpportunities(now).length).toBeGreaterThan(0);
    value(h.engine.authorizeReservation(check, now));
    expect(h.engine.reservations()).toHaveLength(1);
  });
  it.each(['shape', 'conflict'])('retains the %s invalidation fence when a caller rolls back its enclosing transaction', kind => {
    const h = make(); h.grant(); const r = success(h.reserve([h.invoke('o_decision')]));
    const bad: any = clone(h.d);
    if (kind === 'shape') bad.version = 2;
    else bad.budgets[0]!.suggested_limit++;
    expect(() => h.db.transaction(() => {
      expect(h.engine.mergeAuthenticatedDescriptor(bad, evidence, now).ok).toBe(false);
      throw Error('rollback_outer_delivery');
    })).toThrow('rollback_outer_delivery');
    expect(JSON.parse(h.db.queryOne<{ state: string }>('SELECT state FROM world_participation_policy')!.state).available).toBe(true);
    expect(h.engine.eligibleOpportunities(now)).toEqual([]);
    expect(h.engine.authorizeReservation({ reservationId: r.reservationId, jobId: r.jobId, invocation: r.invocation }, now)).toMatchObject({ ok: false, code: 'DESCRIPTOR_UNAVAILABLE' });
  });
  it.each(['train', 'reading'])('executes frozen %s state sequences against the durable engine', world => {
    const h = make(world);
    const fixture = load(`state-sequences/${world === 'train' ? 'train-t1-t14' : 'reading-parity'}.json`);
    let at = now; let request = 1; const caps = ceiling();
    // The referee has revision-only patches and source-added metadata. The real
    // engine only accepts authenticated complete descriptors. Scale revisions to
    // leave a monotonic slot for each explicitly authenticated source update.
    value(h.engine.mergeAuthenticatedDescriptor({ ...h.d, revision: String(BigInt(h.d.revision) * 100n) }, evidence, at));
    const rows = [...fixture.rows, ...(fixture.rows_after_restart?.rows ?? [])];
    for (const row of rows) {
      if (row.t.startsWith('T20')) break; // T1–T19; C2 cases have separate stricter boundary tests.
      const before = h.engine.usage(); const outcomes: any[] = [];
      for (const op of row.ops) {
        if (op.op === 'time') at = op.at;
        else if (op.op === 'grant') h.grant({ ...(op.kinds ? { allowed_action_kinds: op.kinds } : {}), ...(op.expires_at ? { expires_at: op.expires_at } : {}) });
        else if (op.op === 'revoke') value(h.engine.revoke(h.engine.facts()!.action_groups.flatMap(g => g.intent_kinds)));
        else if (op.op === 'takeover') value(h.engine.takeover(op.scope === 'participation' ? { whole: true } : { groupId: op.group }));
        else if (op.op === 'resume') value(h.engine.resume(op.scope === 'participation' ? { whole: true } : { kinds: h.engine.facts()!.action_groups.find(g => g.id === op.group)!.intent_kinds }));
        else if (op.op === 'restart') h.reopen();
        else if (op.op === 'source' || op.op === 'replay') {
          value(h.engine.sourceArrived(op.event_id));
          if (op.adds_opportunity) {
            const d = h.engine.facts()!; d.revision = String(BigInt(d.revision) + 1n); d.opportunities.push(op.adds_opportunity);
            value(h.engine.mergeAuthenticatedDescriptor(d, evidence, at));
          }
        } else if (op.op === 'descriptor') {
          const d = h.engine.facts()!; const change = op.document; d.revision = String(BigInt(change.revision) * 100n);
          if (change.window) {
            d.window = change.window; d.budgets = change.budgets; d.opportunities = change.opportunities;
            delete d.dm_response_slot_key; if (change.dm_response_slot_key) d.dm_response_slot_key = change.dm_response_slot_key;
          }
          if (change.add_group) d.action_groups.push(change.add_group);
          if (change.add_opportunity) d.opportunities.push(change.add_opportunity);
          value(h.engine.mergeAuthenticatedDescriptor(d, evidence, at));
          // T11's fixture prose explicitly sets the owner's local turn limit to
          // 2. It is a local policy change, not an implicit global descriptor pool.
          if (row.t === 'T11') h.grant({ max_agent_turns: 2 });
        } else if (op.op === 'set_policy') {
          if (op.max_agent_turns_total !== undefined) caps.aggregate.agent_turn = op.max_agent_turns_total;
          if (op.max_outbound_messages_total !== undefined) caps.aggregate.outbound_message = op.max_outbound_messages_total;
          value(h.engine.configureCeilings(caps));
        } else if (op.op === 'owner_message') {
          for (let i = 0; i < op.count; i++) value(h.engine.recordSuccessfulOwnerMessage((request++).toString(16).padStart(64, '0'), at));
        } else if (op.op === 'turn' || op.op === 'dm') {
          const invocations = op.op === 'dm' ? [h.invoke(op.opportunity, 'direct_message', 'direct_message', at)] : op.invocations.map((inv: any) => h.invoke(inv.opportunity, inv.kind, 'intent', at));
          const result = value(h.reserve(invocations, at));
          for (const outcome of result) {
            outcomes.push({ kind: outcome.invocation.kind, code: outcome.ok ? 'SUBMITTED' : outcome.code });
            if (outcome.ok && op.outcome_unknown) {
              const id = (request++).toString(16).padStart(64, '0');
              value(h.engine.associateRequest(outcome.reservation.reservationId, id)); value(h.engine.settle(id, 'unknown'));
            }
          }
        } else throw Error(`Unhandled frozen operation ${op.op}`);
      }
      if (row.expect.outcomes) {
        // The older R6 fixture prechecks channels before takeover. Current §5/§8
        // mandates control and budgets before channel qualification; retain the
        // safer normative precedence rather than adopting that stale ordering.
        const expected = row.t.startsWith('R6 ') ? [{ kind: 'direct_message', code: 'GROUP_TAKEOVER_ACTIVE' }] : row.expect.outcomes;
        expect(outcomes, row.t).toEqual(expected);
      }
      const delta = h.engine.usage().slice(before.length);
      if (row.expect.turns_used !== undefined) expect(delta.filter(c => c.resource === 'agent_turn').length, row.t).toBe(row.expect.turns_used);
      if (row.expect.messages_used !== undefined) expect(delta.filter(c => c.resource === 'outbound_message').length, row.t).toBe(row.expect.messages_used + (row.expect.owner_messages_used ?? 0));
    }
  });
  it.each(['train', 'reading'])('T2/T5/T9: %s one turn batch and zero-message decisions survive a real file close/reopen', world => {
    const h = make(world); h.grant();
    for (const o of h.d.opportunities) if (o.source_event_id) value(h.engine.sourceArrived(o.source_event_id));
    const decision = h.d.opportunities.find(o => h.d.budgets.find(b => b.id === o.budget_group_id)!.resource === 'agent_turn')!;
    const message = h.d.opportunities.find(o => h.d.budgets.find(b => b.id === o.budget_group_id)!.resource === 'outbound_message')!;
    const input = { jobId: 'batch1', turnId: 'host_turn1', invocations: [h.invoke(message.id), h.invoke(decision.id)] };
    const result = value(h.engine.reserveBatch(input, now));
    expect(result.every(o => o.ok)).toBe(true);
    expect(h.engine.usage().map(c => c.resource).sort()).toEqual(['agent_turn', 'outbound_message']);
    const r = result[0]!; if (!r.ok) throw Error(r.code);
    value(h.engine.associateRequest(r.reservation.reservationId, 'b'.repeat(64)));
    value(h.engine.settle('b'.repeat(64), 'unknown'));
    h.reopen();
    expect(h.engine.reservations()[0]!.status).toBe('unknown');
    expect(value(h.engine.reserveBatch(input, now))).toHaveLength(2);
    expect(h.engine.usage()).toHaveLength(2);
    expect(code(h.reserve([h.invoke(message.id)]))).toBe('DEDUPE_KEY_RESERVED');
    for (const o of h.d.opportunities) if (o.source_event_id) value(h.engine.sourceArrived(o.source_event_id));
    expect(h.engine.usage()).toHaveLength(2);
    value(h.engine.settle('b'.repeat(64), 'rejected'));
    expect(h.engine.usage()).toHaveLength(2); // Rejected/unknown sends never refund.
    expect(h.engine.settle('b'.repeat(64), 'succeeded')).toMatchObject({ ok: false, code: 'RESULT_CONFLICT' });
  });
  it('T3/T4/T6/T7/T14: kind controls survive remapping and owner replacement failure, with per-invocation isolation', () => {
    const h = make(); h.grant();
    const old = success(h.reserve([h.invoke('o_decision')]));
    value(h.engine.takeover({ groupId: 'g_decision' })); h.reopen();
    expect(code(h.reserve([h.invoke('o_statement', 'train.vote')]))).toBe('KIND_NOT_IN_GROUP');
    const updated = clone(h.d); updated.revision = '13';
    updated.action_groups[0]!.id = 'new_group'; updated.opportunities[0]!.action_group_id = 'new_group';
    value(h.engine.mergeAuthenticatedDescriptor(updated, evidence, now));
    const mixed = value(h.reserve([h.invoke('o_statement'), h.invoke('o_decision')]));
    expect(mixed.map(r => r.ok ? 'SUBMITTED' : r.code)).toEqual(['SUBMITTED', 'GROUP_TAKEOVER_ACTIVE']);
    value(h.engine.resume({ kinds: ['train.vote'] }));
    expect(h.engine.authorizeReservation({ reservationId: old.reservationId, jobId: old.jobId, invocation: old.invocation }, now)).toMatchObject({ ok: false, code: 'RESERVATION_OBSOLETE' });
    value(h.engine.takeover({ whole: true })); h.reopen();
    expect(h.engine.eligibleOpportunities(now)).toEqual([]);
    value(h.engine.mergeAuthenticatedDescriptor({ ...updated, revision: '14' }, evidence, now));
    expect(code(h.reserve([h.invoke('o_item_17')]))).toBe('PARTICIPATION_MANUAL');
    expect(h.engine.facts()!.revision).toBe('14');
    value(h.engine.resume({ whole: true }));
    expect(code(h.reserve([h.invoke('o_item_17')]))).toBe('SUBMITTED');
  });
  it('owner revoke/takeover then resume cannot resurrect a previously reserved unsent job', () => {
    const h = make(); h.grant(); const r = success(h.reserve([h.invoke('o_statement')]));
    value(h.engine.takeover({ groupId: 'g_expression' })); value(h.engine.resume({ kinds: ['train.say'] }));
    const check = () => h.engine.authorizeReservation({ reservationId: r.reservationId, jobId: r.jobId, invocation: r.invocation }, now);
    expect(check()).toMatchObject({ ok: false, code: 'RESERVATION_CANCELLED' });
    value(h.engine.revoke(['train.say'])); h.grant(); expect(check()).toMatchObject({ ok: false, code: 'RESERVATION_CANCELLED' });
    expect(code(h.reserve([h.invoke('o_statement')]))).toBe('DEDUPE_KEY_RESERVED');
  });
  it('T8: new windows cancel old jobs, retain explicit/manual controls and owner window scope', () => {
    const h = make(); h.grant(); const r = success(h.reserve([h.invoke('o_statement')]));
    value(h.engine.takeover({ groupId: 'g_inventory' })); value(h.engine.takeover({ groupId: 'g_decision' }));
    const next = newWindow(h.d); value(h.engine.mergeAuthenticatedDescriptor(next, evidence, now));
    const at = '2026-09-09T14:00:00Z';
    expect(h.engine.authorizeReservation({ reservationId: r.reservationId, jobId: r.jobId, invocation: r.invocation }, at)).toMatchObject({ ok: false, code: 'RESERVATION_OBSOLETE' });
    expect(code(h.reserve([h.invoke(next.opportunities[0]!.id, undefined, 'intent', at)], at))).toBe('SUBMITTED');
    expect(code(h.reserve([h.invoke(next.opportunities[2]!.id, undefined, 'intent', at)], at))).toBe('GROUP_TAKEOVER_ACTIVE');
    h.grant({ window_ref: next.window.id });
    const third = newWindow(next); value(h.engine.mergeAuthenticatedDescriptor(third, evidence, at));
    expect(code(h.reserve([h.invoke(third.opportunities[0]!.id, undefined, 'intent', '2026-09-10T14:00:00Z')], '2026-09-10T14:00:00Z'))).toBe('GRANT_MISSING');
  });
  it('T11/T12/T13: shared owner messages exhaust expression only; arrival and fresh IDs never mint turns', () => {
    const h = make(); h.grant({ max_agent_turns: 1, max_outbound_messages: 1 });
    value(h.engine.recordSuccessfulOwnerMessage('b'.repeat(64), now)); value(h.engine.recordSuccessfulOwnerMessage('b'.repeat(64), now));
    expect(code(h.reserve([h.invoke('o_statement')]))).toBe('BUDGET_EXHAUSTED');
    expect(code(h.reserve([h.invoke('o_decision')]))).toBe('SUBMITTED');
    const d = clone(h.d); d.revision = '13'; d.opportunities[0]!.id = 'new_event_revision_transport_id';
    d.opportunities.push({ ...d.opportunities[2]!, id: 'new_gift', dedupe_key: 'new_gift_key' });
    value(h.engine.mergeAuthenticatedDescriptor(d, evidence, now));
    value(h.engine.sourceArrived('c'.repeat(64))); h.reopen();
    expect(h.engine.eligibleOpportunities(now)).toEqual([]);
    expect(code(h.reserve([h.invoke('new_gift')]))).toBe('BUDGET_EXHAUSTED');
    expect(h.engine.usage().filter(c => c.resource === 'outbound_message')).toHaveLength(1);
    expect(h.engine.facts()!.opportunities).toHaveLength(7);
  });
  it('per-invocation denial leaves successful siblings and only one turn charge (T14/R4/T18/T19)', () => {
    const h = make(); h.grant({ max_outbound_messages: 1 });
    const inv = h.invoke('o_statement');
    const result = value(h.reserve([inv, inv, h.invoke('o_reply'), h.invoke('o_decision')]));
    expect(result.map(r => r.ok ? 'SUBMITTED' : r.code)).toEqual(['SUBMITTED', 'BUDGET_EXHAUSTED', 'BUDGET_EXHAUSTED', 'SUBMITTED']);
    expect(h.engine.reservations()).toHaveLength(2);
    expect(h.engine.usage().map(c => c.resource).sort()).toEqual(['agent_turn', 'outbound_message']);
  });
  it('a real SQLite write failure rolls back every accepted reservation and charge', () => {
    const h = make(); h.grant();
    h.db.execute("CREATE TRIGGER reject_policy_write BEFORE UPDATE ON world_participation_policy BEGIN SELECT RAISE(ABORT, 'injected_disk_failure'); END");
    const attempted = h.reserve([h.invoke('o_decision'), h.invoke('o_statement')]);
    expect(attempted).toMatchObject({ ok: false, code: 'injected_disk_failure' });
    h.db.execute('DROP TRIGGER reject_policy_write'); h.reopen();
    expect(h.engine.reservations()).toEqual([]); expect(h.engine.usage()).toEqual([]);
    expect(value(h.reserve([h.invoke('o_decision'), h.invoke('o_statement')])).every(r => r.ok)).toBe(true);
  });
  it('enforces exact job/invocation/revision/capability/expiry and durable request identity', () => {
    const h = make(); h.grant(); const r = success(h.reserve([h.invoke('o_statement')]));
    const check = { reservationId: r.reservationId, jobId: r.jobId, invocation: r.invocation };
    value(h.engine.authorizeReservation(check, now));
    expect(h.engine.authorizeReservation({ ...check, jobId: 'other_job' }, now)).toMatchObject({ ok: false, code: 'RESERVATION_MISMATCH' });
    expect(h.engine.authorizeReservation({ ...check, invocation: { ...r.invocation, kind: 'train.vote' } }, now)).toMatchObject({ ok: false, code: 'RESERVATION_MISMATCH' });
    expect(h.engine.authorizeReservation(check, r.invocation.contextValidUntil)).toMatchObject({ ok: false, code: 'OPPORTUNITY_EXPIRED' });
    value(h.engine.associateRequest(r.reservationId, 'b'.repeat(64)));
    expect(h.engine.associateRequest(r.reservationId, 'c'.repeat(64))).toMatchObject({ ok: false, code: 'REQUEST_ID_CONFLICT' });
    expect(code(h.reserve([{ ...h.invoke('o_decision'), expectedCapabilityRevision: 'f'.repeat(64) }]))).toBe('CAPABILITY_REVISION_MISMATCH');
    value(h.engine.mergeAuthenticatedDescriptor(h.d, { ...evidence, capabilityRevision: 'f'.repeat(64) }, now));
    expect(h.engine.authorizeReservation(check, now)).toMatchObject({ ok: false, code: 'CAPABILITY_REVISION_MISMATCH' });
  });
  it('retains the stored capability binding for a stale descriptor and updates it for a newer one', () => {
    const h = make();
    expect(h.engine.capabilityRevision()).toBe(cap);
    const stale = clone(h.d); stale.revision = String(BigInt(h.d.revision) - 1n);
    const nextCapability = 'f'.repeat(64);
    expect(value(h.engine.mergeAuthenticatedDescriptor(stale, { ...evidence, capabilityRevision: nextCapability }, now))).toBe('old');
    h.reopen();
    expect(h.engine.capabilityRevision()).toBe(cap);
    const newer = clone(h.d); newer.revision = String(BigInt(h.d.revision) + 1n);
    expect(value(h.engine.mergeAuthenticatedDescriptor(newer, { ...evidence, capabilityRevision: nextCapability }, now))).toBe('installed');
    h.reopen();
    expect(h.engine.capabilityRevision()).toBe(nextCapability);
  });
  it('missing ceilings/limits never inherit suggestions and new kinds need explicit permission', () => {
    const h = make();
    const d = clone(h.d); d.action_groups.push({ id: 'fresh_group', control_reset: 'window', intent_kinds: ['neutral.fresh'] });
    d.opportunities.push({ ...d.opportunities[0]!, id: 'fresh', action_group_id: 'fresh_group', dedupe_key: 'fresh' }); d.revision = '13';
    h.grant(); value(h.engine.mergeAuthenticatedDescriptor(d, evidence, now));
    expect(code(h.reserve([h.invoke('fresh')]))).toBe('GRANT_MISSING');
    expect(h.engine.grant({ allowed_action_kinds: ['neutral.fresh'], expires_at: '2026-10-01T00:00:00Z' } as ParticipationLocalPolicy)).toMatchObject({ ok: false, code: 'POLICY_INVALID' });
    value(h.engine.configureCeilings({ ...ceiling(), aggregate: { agent_turn: 0, outbound_message: 100, owner_notice: 100 } }));
    expect(code(h.reserve([h.invoke('o_decision')]))).toBe('BUDGET_EXHAUSTED');
  });
  it('rejects message/decision budget resource swaps using trusted egress classification', () => {
    const h = make(); h.grant(); const d = clone(h.d); d.revision = '13';
    d.opportunities.find(o => o.id === 'o_statement')!.budget_group_id = 'b_turn';
    value(h.engine.mergeAuthenticatedDescriptor(d, evidence, now));
    const trustedMessage = { ...h.invoke('o_statement'), message: true };
    expect(code(h.reserve([trustedMessage]))).toBe('BUDGET_GROUP_MISMATCH');
    expect(h.engine.reservations()).toEqual([]); expect(h.engine.usage()).toEqual([]);
    const decisionSwap = clone(d); decisionSwap.revision = '14';
    decisionSwap.opportunities.find(o => o.id === 'o_decision')!.budget_group_id = 'b_message';
    value(h.engine.mergeAuthenticatedDescriptor(decisionSwap, evidence, now));
    expect(code(h.reserve([{ ...h.invoke('o_decision'), message: false }]))).toBe('BUDGET_GROUP_MISMATCH');
    expect(code(h.reserve([h.invoke('o_statement', 'direct_message', 'direct_message')]))).toBe('BUDGET_GROUP_MISMATCH');
    expect(h.engine.usage()).toEqual([]);
  });
});

function newWindow(original: ParticipationDescriptor): ParticipationDescriptor {
  const d = clone(original); const old = d.window.id; const id = old + '_next';
  const later = (v: string) => new Date(Date.parse(v) + 86400000).toISOString().replace('.000Z', 'Z');
  d.revision = String(BigInt(d.revision) + 1n); d.window = { id, opens_at: later(d.window.opens_at), closes_at: later(d.window.closes_at) };
  for (const b of d.budgets) { b.window_id = id; b.id += '_new'; }
  for (const o of d.opportunities) { o.id += '_new'; o.budget_window_id = id; o.budget_group_id += '_new'; o.not_before = later(o.not_before); o.expires_at = later(o.expires_at); o.dedupe_key += '_new'; }
  if (d.dm_response_slot_key) d.dm_response_slot_key += '_new';
  return d;
}

describe('WorldParticipation shared DM, rolling ceilings and notice policy', () => {
  it('allows a DM-only group and enforces the explicit group/opportunity channel intersection', () => {
    const h = make(); h.grant(); const d = clone(h.d); d.revision = '13';
    d.action_groups.find(g => g.id === 'g_expression')!.channels = ['direct_message'];
    value(h.engine.mergeAuthenticatedDescriptor(d, evidence, now));
    expect(h.engine.eligibleOpportunities(now).some(o => o.id === 'o_reply')).toBe(true);
    expect(code(h.reserve([h.invoke('o_reply')]))).toBe('CHANNEL_NOT_IN_GROUP');
    expect(code(h.reserve([h.invoke('o_reply', 'direct_message', 'direct_message')]))).toBe('SUBMITTED');
    expect(h.engine.usage().map(c => c.resource).sort()).toEqual(['agent_turn', 'outbound_message']);
  });
  it('tracks independent same-resource message pools under one shared owner ceiling and ignores unreferenced turn pools', () => {
    const h = make(); h.grant({ max_outbound_messages: 2 }); const d = clone(h.d); d.revision = '13';
    d.budgets.find(b => b.resource === 'agent_turn')!.suggested_limit = 0;
    d.budgets.find(b => b.id === 'b_message')!.suggested_limit = 1;
    d.budgets.push({ id: 'second_message_pool', window_id: d.window.id, resource: 'outbound_message', suggested_limit: 2 });
    d.opportunities.push({ ...d.opportunities.find(o => o.id === 'o_statement')!, id: 'message_second_pool', budget_group_id: 'second_message_pool', dedupe_key: 'message_second' });
    d.opportunities.push({ ...d.opportunities.find(o => o.id === 'o_statement')!, id: 'message_third', budget_group_id: 'second_message_pool', dedupe_key: 'message_third' });
    value(h.engine.mergeAuthenticatedDescriptor(d, evidence, now));
    const outcomes = value(h.reserve([h.invoke('o_statement'), h.invoke('message_second_pool'), h.invoke('o_reply'), h.invoke('message_third')]));
    expect(outcomes.map(o => o.ok ? 'SUBMITTED' : o.code)).toEqual(['SUBMITTED', 'SUBMITTED', 'BUDGET_EXHAUSTED', 'BUDGET_EXHAUSTED']);
    expect(h.engine.usage().map(c => c.resource).sort()).toEqual(['agent_turn', 'outbound_message', 'outbound_message']);
    expect(h.engine.budgetUsage().map(c => c.budgetGroupId).sort()).toEqual(['b_message', 'second_message_pool']);
    h.reopen(); h.grant({ max_outbound_messages: 3 });
    expect(code(h.reserve([h.invoke('o_reply')]))).toBe('BUDGET_EXHAUSTED'); // First pool remains consumed despite higher local allowance.
    expect(code(h.reserve([h.invoke('message_third')]))).toBe('SUBMITTED');
    expect(h.engine.usage().filter(c => c.resource === 'agent_turn')).toHaveLength(2);
  });
  it('charges each referenced decision pool once in a batch while charging the shared local turn once', () => {
    const h = make(); h.grant(); const d = clone(h.d); d.revision = '13';
    d.budgets.find(b => b.id === 'b_turn')!.suggested_limit = 1;
    d.budgets.push({ id: 'second_turn_pool', window_id: d.window.id, resource: 'agent_turn', suggested_limit: 1 });
    d.opportunities.find(o => o.id === 'o_item_17')!.budget_group_id = 'second_turn_pool';
    d.opportunities.push({ ...d.opportunities[0]!, id: 'decision_extra', dedupe_key: 'decision_extra' });
    d.opportunities.push({ ...d.opportunities.find(o => o.id === 'o_item_17')!, id: 'item_extra', dedupe_key: 'item_extra' });
    value(h.engine.mergeAuthenticatedDescriptor(d, evidence, now));
    expect(value(h.reserve([h.invoke('o_decision'), h.invoke('o_item_17'), h.invoke('decision_extra')])).every(o => o.ok)).toBe(true);
    expect(h.engine.usage().map(c => c.resource)).toEqual(['agent_turn']);
    expect(h.engine.budgetUsage().map(c => c.budgetGroupId).sort()).toEqual(['b_turn', 'second_turn_pool']);
    h.reopen();
    expect(code(h.reserve([h.invoke('item_extra')]))).toBe('BUDGET_EXHAUSTED');
    expect(code(h.reserve([h.invoke('o_statement')]))).toBe('SUBMITTED'); // The exhausted decision pools are unrelated to this message.
  });
  it('a message cannot bypass an exhausted local turn ceiling even with an unreferenced descriptor pool', () => {
    const h = make(); h.grant({ max_agent_turns: 0 });
    expect(code(h.reserve([h.invoke('o_statement')]))).toBe('BUDGET_EXHAUSTED');
    expect(h.engine.usage()).toEqual([]);
  });
  it('binds a DM reservation to the exact original grant kind even when another grant has the same epoch', () => {
    const h = make(); const d = clone(h.d); d.revision = '13';
    d.action_groups.find(g => g.id === 'g_expression')!.intent_kinds.push('train.reply');
    value(h.engine.mergeAuthenticatedDescriptor(d, evidence, now));
    h.grant({ allowed_action_kinds: ['train.say', 'train.reply'] });
    const r = success(h.reserve([h.invoke('o_reply', 'direct_message', 'direct_message')]));
    const check = { reservationId: r.reservationId, jobId: r.jobId, invocation: r.invocation };
    value(h.engine.authorizeReservation(check, now));
    value(h.engine.revoke(['train.say'])); h.reopen();
    expect(h.engine.authorizeReservation(check, now)).toMatchObject({ ok: false, code: 'GRANT_MISSING' });
    h.grant({ allowed_action_kinds: ['train.say'] });
    expect(h.engine.authorizeReservation(check, now)).toMatchObject({ ok: false, code: 'RESERVATION_CANCELLED' });
    expect(h.engine.usage().map(c => c.resource).sort()).toEqual(['agent_turn', 'outbound_message']);
    expect(code(h.reserve([h.invoke('o_reply', 'direct_message', 'direct_message')]))).toBe('DEDUPE_KEY_RESERVED');
  });
  it('retains but never reauthorizes legacy reservations whose original grant kind was not persisted', () => {
    const h = make(); h.grant(); const r = success(h.reserve([h.invoke('o_reply', 'direct_message', 'direct_message')]));
    const row = h.db.queryOne<{ binding: string; state: string }>('SELECT binding,state FROM world_participation_policy')!;
    const stored = JSON.parse(row.state);
    delete stored.reservations[0].grantKind;
    h.db.execute('UPDATE world_participation_policy SET state=? WHERE binding=?', [JSON.stringify(stored), row.binding]);
    h.reopen();
    expect(h.engine.authorizeReservation({ reservationId: r.reservationId, jobId: r.jobId, invocation: r.invocation }, now)).toMatchObject({ ok: false, code: 'RESERVATION_CANCELLED' });
    expect(code(h.reserve([h.invoke('o_reply', 'direct_message', 'direct_message')]))).toBe('DEDUPE_KEY_RESERVED');
    expect(h.engine.usage().map(c => c.resource).sort()).toEqual(['agent_turn', 'outbound_message']);
  });
  it('requires BOTH channels after aggregate budget gates, allows DM-only opportunities', () => {
    const h = make(); h.grant();
    expect(code(h.reserve([h.invoke('o_statement', 'direct_message', 'direct_message')]))).toBe('CHANNEL_NOT_IN_GROUP');
    value(h.engine.configureCeilings({ ...ceiling(), aggregate: { agent_turn: 0, outbound_message: 100, owner_notice: 100 } }));
    expect(code(h.reserve([h.invoke('o_statement', 'direct_message', 'direct_message')]))).toBe('BUDGET_EXHAUSTED');
    value(h.engine.configureCeilings(ceiling()));
    const d = clone(h.d); d.revision = '13'; d.opportunities.find(o => o.id === 'o_reply')!.channels = ['direct_message'];
    value(h.engine.mergeAuthenticatedDescriptor(d, evidence, now));
    expect(h.engine.eligibleOpportunities(now).some(o => o.id === 'o_reply')).toBe(true);
    expect(code(h.reserve([h.invoke('o_reply')]))).toBe('CHANNEL_NOT_IN_GROUP');
    const r = success(h.reserve([h.invoke('o_reply', 'direct_message', 'direct_message')]));
    value(h.engine.authorizeReservation({ reservationId: r.reservationId, jobId: r.jobId, invocation: r.invocation }, now));
    expect(h.engine.usage().map(c => c.resource).sort()).toEqual(['agent_turn', 'outbound_message']);
  });
  it.each(['intent', 'direct_message'] as const)('one declared slot cannot be reused after %s, new ids, revisions or restart', channel => {
    const h = make(); h.grant();
    const d = clone(h.d); d.revision = '13'; const original = d.opportunities.find(o => o.id === 'o_reply')!;
    d.opportunities.push({ ...original, id: 'same_slot_other_opportunity' }); value(h.engine.mergeAuthenticatedDescriptor(d, evidence, now));
    success(h.reserve([h.invoke('o_reply', channel === 'direct_message' ? 'direct_message' : undefined, channel)])); h.reopen();
    expect(code(h.reserve([h.invoke('same_slot_other_opportunity', 'direct_message', 'direct_message')]))).toBe('DEDUPE_KEY_RESERVED');
    for (const slot of [undefined, 'evil_slot']) {
      const bad = clone(d); bad.revision = '14'; delete bad.dm_response_slot_key;
      if (slot) { bad.dm_response_slot_key = slot; for (const o of bad.opportunities) if (o.channels?.includes('direct_message')) o.dedupe_key = slot; }
      expect(h.engine.mergeAuthenticatedDescriptor(bad, evidence, now)).toMatchObject({ ok: false, code: 'RESPONSE_SLOT_IMMUTABLE' });
    }
    value(h.engine.mergeAuthenticatedDescriptor(d, evidence, now));
    expect(h.engine.reservations()).toHaveLength(1);
  });
  it('without declared slot distinct qualified keys are allowed under one shared allowance', () => {
    const h = make('reading'); h.grant();
    const d = clone(h.d); d.revision = '9'; const dm = d.opportunities.find(o => o.id === 'o_dm')!;
    d.opportunities.push({ ...dm, id: 'second_thread', dedupe_key: 'thread2/key' });
    value(h.engine.mergeAuthenticatedDescriptor(d, evidence, now));
    const result = value(h.reserve([h.invoke('o_dm', 'direct_message', 'direct_message'), h.invoke('second_thread', 'direct_message', 'direct_message')]));
    expect(result.every(r => r.ok)).toBe(true);
    expect(h.engine.usage().map(c => c.resource).sort()).toEqual(['agent_turn', 'outbound_message', 'outbound_message']);
  });
  it('a first declaration in an undeclared window narrows future slots and then becomes immutable', () => {
    const h = make('reading'); h.grant(); const d = clone(h.d); d.revision = '9';
    d.dm_response_slot_key = d.opportunities.find(o => o.id === 'o_dm')!.dedupe_key;
    value(h.engine.mergeAuthenticatedDescriptor(d, evidence, now));
    const removal = clone(d); removal.revision = '10'; delete removal.dm_response_slot_key;
    expect(h.engine.mergeAuthenticatedDescriptor(removal, evidence, now)).toMatchObject({ ok: false, code: 'RESPONSE_SLOT_IMMUTABLE' });
  });
  it('rolling and aggregate limits persist across windows, groups, budget ids and SQLite reopen', () => {
    const h = make(); h.grant(); const caps = ceiling(); caps.rolling.limits.agent_turn = 1; caps.rolling.seconds = 172800;
    value(h.engine.configureCeilings(caps)); success(h.reserve([h.invoke('o_decision')]));
    const d = newWindow(h.d); d.action_groups[0]!.id = 'renamed'; d.opportunities[0]!.action_group_id = 'renamed';
    value(h.engine.mergeAuthenticatedDescriptor(d, evidence, now)); h.reopen(); const at = '2026-09-09T14:00:00Z';
    expect(code(h.reserve([h.invoke(d.opportunities[0]!.id, undefined, 'intent', at)], at))).toBe('BUDGET_EXHAUSTED');
    caps.rolling.seconds = 10; caps.aggregate.agent_turn = 1; value(h.engine.configureCeilings(caps));
    expect(code(h.reserve([h.invoke(d.opportunities[0]!.id, undefined, 'intent', at)], at))).toBe('BUDGET_EXHAUSTED');
    caps.aggregate.agent_turn = 2; value(h.engine.configureCeilings(caps));
    expect(code(h.reserve([h.invoke(d.opportunities[0]!.id, undefined, 'intent', at)], at))).toBe('SUBMITTED');
  });
  it('notice permission is separate and state receipts do not reserve notices', () => {
    const h = make(); h.grant(); const d = clone(h.d); d.revision = '13';
    d.budgets.push({ id: 'notice_budget', window_id: d.window.id, resource: 'owner_notice', suggested_limit: 1 });
    d.opportunities.push({ ...d.opportunities[0]!, id: 'notice', budget_group_id: 'notice_budget', dedupe_key: 'notice_key' });
    value(h.engine.mergeAuthenticatedDescriptor(d, { ...evidence, source: 'verified_private_state' }, now));
    expect(h.engine.usage()).toEqual([]);
    const inv = h.invoke('notice');
    success(h.engine.reserveNotice({ jobId: 'notice1', turnId: 'notice_turn1', invocation: inv }, now));
    expect(h.engine.usage().map(c => c.resource).sort()).toEqual(['agent_turn', 'owner_notice']);
    expect(code(h.reserve([h.invoke('o_decision')]))).toBe('SUBMITTED');
  });
  it('all facts, controls, sources, grants and reservations are isolated by full house binding and actor', () => {
    const h = make(); h.grant(); success(h.reserve([h.invoke('o_decision')])); value(h.engine.takeover({ whole: true }));
    for (const [house, actor] of [
      [{ ...h.house, origin: 'https://other.invalid' }, h.d.actor_id],
      [{ ...h.house, incarnation: 'different' }, h.d.actor_id],
      [{ ...h.house, houseKey: h.d.actor_id }, h.d.actor_id],
      [h.house, h.house.houseKey],
    ] as const) {
      const other = new WorldParticipation(h.db as HostDb, house, actor, h.d.participation_id);
      expect(other.facts()).toBeUndefined(); expect(other.reservations()).toEqual([]); expect(other.usage()).toEqual([]);
      const d = clone(h.d); d.house = { origin: house.origin, house_key: house.houseKey, incarnation: house.incarnation }; d.actor_id = actor;
      value(other.mergeAuthenticatedDescriptor(d, evidence, now)); expect(other.eligibleOpportunities(now)).toEqual([]);
    }
  });
  it('two participations of the same house and actor have independent authority, sources, budgets and jobs after reopen', () => {
    const h = make(); h.grant({ max_agent_turns: 1 });
    const first = success(h.reserve([h.invoke('o_decision')]));
    value(h.engine.associateRequest(first.reservationId, 'b'.repeat(64)));
    value(h.engine.settle('b'.repeat(64), 'unknown'));
    value(h.engine.takeover({ whole: true }));
    value(h.engine.sourceArrived(h.d.opportunities.find(o => o.id === 'o_scene')!.source_event_id!));
    value(h.engine.recordSuccessfulOwnerMessage('c'.repeat(64), now));

    const d = { ...clone(h.d), participation_id: 'independent_participation' };
    let second = new WorldParticipation(h.db, h.house, h.d.actor_id, d.participation_id);
    value(second.mergeAuthenticatedDescriptor(d, evidence, now));
    const inv = h.invoke('o_decision');
    const sameIdentities = { jobId: first.jobId, turnId: first.turnId, invocations: [inv] };
    expect(code(second.reserveBatch({ ...sameIdentities, jobId: 'before_grant' }, now))).toBe('GRANT_MISSING');
    expect(second.usage()).toEqual([]); expect(second.reservations()).toEqual([]);
    value(second.configureCeilings(ceiling()));
    value(second.grant({ allowed_action_kinds: d.action_groups.flatMap(g => g.intent_kinds), expires_at: '2026-10-01T00:00:00Z',
      max_agent_turns: 3, max_outbound_messages: 3, max_owner_notices: 1 }));
    const otherReservation = success(second.reserveBatch(sameIdentities, now));
    expect(otherReservation.dedupeKey).toBe(first.dedupeKey);
    expect(otherReservation.reservationId).not.toBe(first.reservationId);
    value(second.associateRequest(otherReservation.reservationId, 'b'.repeat(64)));
    value(second.settle('b'.repeat(64), 'succeeded'));
    expect(second.authorizeReservation({ reservationId: first.reservationId, jobId: first.jobId, invocation: first.invocation }, now)).toMatchObject({ ok: false, code: 'RESERVATION_MISMATCH' });

    h.reopen(); second = new WorldParticipation(h.db, h.house, h.d.actor_id, d.participation_id);
    expect(h.engine.reservations()[0]!.status).toBe('unknown'); expect(second.reservations()[0]!.status).toBe('succeeded');
    expect(h.engine.usage()).toHaveLength(2); expect(second.usage()).toHaveLength(1);
    expect(code(h.reserve([h.invoke('o_statement')]))).toBe('PARTICIPATION_MANUAL');
    expect(code(second.reserveBatch({ jobId: 'scene_check', turnId: 'scene_turn', invocations: [h.invoke('o_scene')] }, now))).toBe('SOURCE_NOT_ARRIVED');
    expect(code(second.reserveBatch({ jobId: 'second_message', turnId: 'second_turn', invocations: [h.invoke('o_statement')] }, now))).toBe('SUBMITTED');
    value(second.takeover({ groupId: 'g_inventory' }));
    value(h.engine.resume({ whole: true }));
    expect(code(h.reserve([h.invoke('o_item_17')]))).toBe('BUDGET_EXHAUSTED'); // Other participation's takeover did not spread.
    expect(second.mergeAuthenticatedDescriptor(h.d, evidence, now)).toMatchObject({ ok: false, code: 'PARTICIPATION_ID_MISMATCH' });
    expect(second.facts()!.participation_id).toBe(d.participation_id);
  });
  it('preserves initial single-entity durable state only for its recorded participation during migration', () => {
    const h = make(); h.grant(); const r = success(h.reserve([h.invoke('o_decision')]));
    value(h.engine.associateRequest(r.reservationId, 'b'.repeat(64))); value(h.engine.settle('b'.repeat(64), 'unknown'));
    value(h.engine.takeover({ whole: true }));
    const originalKey = JSON.stringify([h.house.origin, h.house.houseKey, h.house.incarnation, h.d.actor_id]);
    h.db.execute('UPDATE world_participation_policy SET binding=?', [originalKey]);
    h.reopen();
    expect(h.engine.reservations()[0]!.status).toBe('unknown'); expect(h.engine.usage()).toHaveLength(1);
    expect(code(h.reserve([h.invoke('o_statement')]))).toBe('PARTICIPATION_MANUAL');
    const other = new WorldParticipation(h.db, h.house, h.d.actor_id, 'new_entity');
    expect(other.facts()).toBeUndefined(); expect(other.reservations()).toEqual([]); expect(other.usage()).toEqual([]);
    value(h.engine.resume({ whole: true })); h.reopen();
    expect(code(h.reserve([h.invoke('o_statement')]))).toBe('SUBMITTED'); // Existing migrated state wins over the retained legacy copy.
  });
});


describe('WorldParticipation read-only local policy view', () => {
  it('returns detached JSON grants, controls and configured ceilings without exposing grant epochs or revoked sibling kinds', () => {
    const h = make(); h.grant(); value(h.engine.takeover({ groupId: 'g_decision' }));
    value(h.engine.revoke(['train.say']));
    const persisted = h.db.queryAll('SELECT state FROM world_participation_policy');
    const original = h.engine.view(now); const changed = h.engine.view(now);
    expect(JSON.parse(JSON.stringify(original))).toEqual(original);
    expect(original).toMatchObject({ house: h.d.house, actor_id: h.d.actor_id, participation_id: h.d.participation_id,
      descriptor_validity: 'current', durable_available: true, runtime_fenced: false, manual: false, ceilings: ceiling() });
    expect(original.grants.some(grant => grant.kind === 'train.say')).toBe(false);
    expect(original.grants[0]).not.toHaveProperty('epoch'); expect(original.grants[0]!.policy).not.toHaveProperty('allowed_action_kinds');
    changed.house.incarnation = 'changed'; changed.descriptor!.action_groups[0]!.intent_kinds.push('injected.kind');
    changed.grants[0]!.policy.max_agent_turns = 999; changed.grants.splice(0, 1);
    changed.locks[0]!.active = false; changed.ceilings!.rolling.limits.agent_turn = 999;
    expect(h.engine.view(now)).toEqual(original);
    expect(h.db.queryAll('SELECT state FROM world_participation_policy')).toEqual(persisted);
  });

  it('recovers durable revoke, takeover and ceilings state after SQLite reopen and reflects explicit resume', () => {
    const h = make(); h.grant(); value(h.engine.revoke(['train.say']));
    value(h.engine.takeover({ groupId: 'g_decision' })); value(h.engine.takeover({ whole: true }));
    const view = h.engine.view(now); h.reopen(); expect(h.engine.view(now)).toEqual(view);
    expect(view.manual).toBe(true);
    expect(view.locks).toContainEqual({ kind: 'train.vote', window_ref: h.d.window.id, active: true, applies_to_current_window: true });
    value(h.engine.resume({ whole: true })); value(h.engine.resume({ kinds: ['train.vote'] }));
    expect(h.engine.view(now)).toMatchObject({ manual: false, locks: [{ active: false }] });
    expect(h.engine.view(now).grants.some(grant => grant.kind === 'train.say')).toBe(false);
  });

  it('distinguishes descriptor and grant time validity, window-scoped grants, and effective takeover windows without writing', () => {
    const h = make(); h.grant({ window_ref: h.d.window.id, expires_at: '2026-09-10T00:00:00Z' });
    value(h.engine.takeover({ groupId: 'g_decision' })); value(h.engine.takeover({ groupId: 'g_inventory' }));
    expect(h.engine.view('2026-09-08T12:00:00Z').descriptor_validity).toBe('not_open');
    expect(h.engine.view(h.d.window.closes_at).descriptor_validity).toBe('expired');
    const next = newWindow(h.d); value(h.engine.mergeAuthenticatedDescriptor(next, evidence, now));
    const view = h.engine.view('2026-09-09T14:00:00Z');
    expect(view.descriptor_validity).toBe('current'); expect(view.grants.every(grant => grant.status === 'other_window')).toBe(true);
    expect(view.locks.find(lock => lock.kind === 'train.vote')).toMatchObject({ active: true, applies_to_current_window: false });
    expect(view.locks.find(lock => lock.kind === 'train.item')).toMatchObject({ active: true, window_ref: null, applies_to_current_window: true });
    expect(h.engine.view('2026-09-10T00:00:00Z').grants.every(grant => grant.status === 'expired')).toBe(true);
  });

  it('exposes absent local authority and an in-memory invalidation even when durable invalidation fails', () => {
    const h = make(); const empty = new WorldParticipation(h.db, h.house, h.d.actor_id, 'unconfigured');
    expect(empty.view(now)).toMatchObject({ descriptor: null, descriptor_validity: 'missing', grants: [], ceilings: null, manual: false });
    value(empty.mergeAuthenticatedDescriptor({ ...h.d, participation_id: 'unconfigured' }, evidence, now));
    expect(empty.view(now)).toMatchObject({ descriptor_validity: 'current', grants: [], ceilings: null });
    expect(empty.view(now).descriptor!.budgets[0]!.suggested_limit).toBeGreaterThan(0);
    h.grant(); h.db.execute("CREATE TRIGGER fail_invalidation_view BEFORE UPDATE ON world_participation_policy BEGIN SELECT RAISE(ABORT,'view-disk-fault'); END");
    expect(h.engine.invalidate('untrusted')).toMatchObject({ ok: false });
    expect(h.engine.view(now)).toMatchObject({ descriptor_validity: 'fenced', runtime_fenced: true, durable_available: true });
    h.db.execute('DROP TRIGGER fail_invalidation_view');
    value(h.engine.invalidate('untrusted')); h.reopen();
    expect(h.engine.view(now)).toMatchObject({ descriptor_validity: 'unavailable', runtime_fenced: false, durable_available: false });
    value(h.engine.mergeAuthenticatedDescriptor(h.d, evidence, now));
    expect(h.engine.view(now)).toMatchObject({ descriptor_validity: 'current', runtime_fenced: false, durable_available: true });
  });
});

describe('WorldParticipation two-stage model turns', () => {
  const until = '2026-09-08T14:04:00Z';
  const start = (h: ReturnType<typeof make>, ids = ['o_statement'], jobId = 'host_job', turnId = 'host_turn') => value(h.engine.reserveTurn({ jobId, turnId, opportunityIds: ids, expectedCapabilityRevision: cap, contextValidUntil: until }, now));
  const identity = (t: { turnReservationId: string; jobId: string; turnId: string }) => ({ turnReservationId: t.turnReservationId, jobId: t.jobId, turnId: t.turnId });
  const attempt = (h: ReturnType<typeof make>, t: Parameters<typeof identity>[0], id = 'o_statement', attemptId = 'attempt1', at = now) => h.engine.reserveAttempt({ ...identity(t), attemptId, invocation: { ...h.invoke(id), contextValidUntil: until } }, at);
  it.each(['no_action', 'invalid_output', 'model_failed'] as const)('spends the turn before %s, no outbound or fake result', outcome => {
    const h = make(); h.grant(); const r = start(h); expect(r.created).toBe(true);
    expect(h.engine.usage().map(c => c.resource)).toEqual(['agent_turn']); expect(h.engine.budgetUsage()).toEqual([]); expect(h.engine.reservations()).toEqual([]);
    expect(h.engine.eligibleOpportunities(now).some(o => o.id === 'o_statement')).toBe(false);
    value(h.engine.finishTurn({ ...identity(r.ticket), outcome }, now)); h.reopen(); expect(start(h).created).toBe(false);
    expect(h.engine.authorizeTurn(identity(r.ticket), now)).toMatchObject({ ok: false, code: 'TURN_CLOSED' }); expect(h.engine.usage()).toHaveLength(1); expect(h.engine.reservations()).toEqual([]);
  });
  it('rechecks captured alternatives independently and rejects revoke/regrant revival', () => {
    const h = make(); h.grant(); const t = start(h, ['o_decision', 'o_statement']).ticket; value(h.engine.takeover({ groupId: 'g_decision' }));
    expect(value(h.engine.authorizeTurn(identity(t), now)).candidates.map(c => c.opportunityId)).toEqual(['o_statement']);
    expect(attempt(h, t, 'o_decision')).toMatchObject({ ok: false, code: 'GROUP_TAKEOVER_ACTIVE' });
    value(h.engine.revoke(['train.say'])); h.grant({ allowed_action_kinds: ['train.say'] });
    expect(h.engine.authorizeTurn(identity(t), now)).toMatchObject({ ok: false, code: 'TURN_NOT_ELIGIBLE' }); expect(attempt(h, t).ok).toBe(false); expect(h.engine.usage()).toHaveLength(1);
  });
  it('reserves decision pools and one local turn first, actual messages later, retaining exact unknown retries after finish/reopen', () => {
    const h = make(); h.grant(); const t = start(h, ['o_decision', 'o_statement']).ticket;
    expect(h.engine.usage().map(c => c.resource)).toEqual(['agent_turn']); expect(h.engine.budgetUsage().map(c => c.resource)).toEqual(['agent_turn']);
    value(attempt(h, t, 'o_decision', 'decision')); const later = '2026-09-08T14:00:30Z'; const sent = value(attempt(h, t, 'o_statement', 'message', later));
    expect(h.engine.usage().map(c => c.resource).sort()).toEqual(['agent_turn', 'outbound_message']); expect(h.engine.usage().find(c => c.resource === 'outbound_message')!.at).toBe(Date.parse(later) / 1000);
    expect(value(attempt(h, t, 'o_statement', 'message', later))).toEqual(sent);
    value(h.engine.associateRequest(sent.reservationId, 'f'.repeat(64))); value(h.engine.settle('f'.repeat(64), 'unknown')); value(h.engine.finishTurn({ ...identity(t), outcome: 'completed' }, later)); h.reopen();
    expect(value(attempt(h, t, 'o_statement', 'message', later)).requestId).toBe('f'.repeat(64)); expect(h.engine.usage()).toHaveLength(2);
    expect(attempt(h, t, 'o_statement', 'different', later)).toMatchObject({ ok: false, code: 'TURN_CLOSED' });
  });
  it('shares legacy/new turn IDs and dedupe and rejects changed exact jobs', () => {
    const h = make(); h.grant(); const t = start(h).ticket;
    expect(h.engine.reserveBatch({ jobId: 'legacy', turnId: t.turnId, invocations: [h.invoke('o_decision')] }, now)).toMatchObject({ ok: false, code: 'TURN_ID_CONFLICT' });
    expect(code(h.reserve([h.invoke('o_statement')]))).toBe('DEDUPE_KEY_RESERVED');
    expect(h.engine.reserveTurn({ jobId: t.jobId, turnId: t.turnId, opportunityIds: ['o_decision'], expectedCapabilityRevision: cap, contextValidUntil: until }, now)).toMatchObject({ ok: false, code: 'JOB_ID_CONFLICT' });
    const other = make(); other.grant(); success(other.reserve([other.invoke('o_statement')]));
    expect(other.engine.reserveTurn({ jobId: 'new', turnId: 'turn_1', opportunityIds: ['o_decision'], expectedCapabilityRevision: cap, contextValidUntil: until }, now)).toMatchObject({ ok: false, code: 'TURN_ID_CONFLICT' });
    expect(other.engine.reserveTurn({ jobId: 'new', turnId: 'fresh', opportunityIds: ['o_statement'], expectedCapabilityRevision: cap, contextValidUntil: until }, now)).toMatchObject({ ok: false, code: 'TURN_NOT_ELIGIBLE' });
  });
  it('binds ticket identity and original lease and rejects unreserved decisions', () => {
    const h = make(); h.grant(); const t = start(h).ticket;
    expect(h.engine.authorizeTurn({ ...identity(t), jobId: 'foreign' }, now)).toMatchObject({ ok: false, code: 'TURN_MISMATCH' });
    expect(attempt(h, t, 'o_decision')).toMatchObject({ ok: false, code: 'OPPORTUNITY_NOT_RESERVED' });
    expect(h.engine.reserveAttempt({ ...identity(t), attemptId: 'extended', invocation: { ...h.invoke('o_statement'), contextValidUntil: '2026-09-08T14:05:00Z' } }, now)).toMatchObject({ ok: false, code: 'TURN_CONTEXT_MISMATCH' });
    expect(h.engine.authorizeTurn(identity(t), until)).toMatchObject({ ok: false, code: 'TURN_NOT_ELIGIBLE' }); expect(h.engine.usage()).toHaveLength(1);
  });
  it.each(['gap', 'revision', 'capability', 'manual', 'ceiling'] as const)('rejects %s changes after turn reservation without refund', cause => {
    const h = make(); h.grant(); const t = start(h).ticket;
    if (cause === 'gap') value(h.engine.invalidate('gap'));
    if (cause === 'manual') value(h.engine.takeover({ whole: true }));
    if (cause === 'ceiling') value(h.engine.configureCeilings({ ...ceiling(), aggregate: { agent_turn: 0, outbound_message: 100, owner_notice: 100 } }));
    if (cause === 'revision' || cause === 'capability') { const d = clone(h.d); d.revision = String(BigInt(d.revision) + 1n); value(h.engine.mergeAuthenticatedDescriptor(d, { ...evidence, capabilityRevision: cause === 'capability' ? 'b'.repeat(64) : cap }, now)); }
    expect(h.engine.authorizeTurn(identity(t), now).ok).toBe(false); expect(attempt(h, t).ok).toBe(false); expect(h.engine.usage()).toHaveLength(1);
  });
  it('requires real grant, source and turn budget before model invocation', () => {
    const h = make(); const input = { jobId: 'job', turnId: 'turn', opportunityIds: ['o_scene'], expectedCapabilityRevision: cap, contextValidUntil: until };
    expect(h.engine.reserveTurn(input, now).ok).toBe(false); h.grant(); expect(h.engine.reserveTurn(input, now).ok).toBe(false);
    value(h.engine.sourceArrived(h.d.opportunities.find(o => o.id === 'o_scene')!.source_event_id!)); h.grant({ max_agent_turns: 0 }); expect(h.engine.reserveTurn(input, now).ok).toBe(false); expect(h.engine.usage()).toEqual([]);
  });
  it('spends no message before a model; a later competing send can exhaust messages without blocking its decision', () => {
    const h = make(); h.grant({ max_outbound_messages: 1 }); const t = start(h, ['o_decision', 'o_statement']).ticket;
    success(h.reserve([h.invoke('o_reply')])); expect(attempt(h, t)).toMatchObject({ ok: false, code: 'BUDGET_EXHAUSTED' }); value(attempt(h, t, 'o_decision'));
    expect(h.engine.usage().filter(c => c.resource === 'agent_turn')).toHaveLength(2); expect(h.engine.usage().filter(c => c.resource === 'outbound_message')).toHaveLength(1);
  });
});

describe('WorldParticipation turn attempt boundary regressions', () => {
  const until = '2026-09-08T14:04:00Z';
  const start = (h: ReturnType<typeof make>, ids: string[], jobId = 'job', turnId = 'turn') => value(h.engine.reserveTurn({ jobId, turnId, opportunityIds: ids, expectedCapabilityRevision: cap, contextValidUntil: until }, now)).ticket;
  const id = (t: { turnReservationId: string; jobId: string; turnId: string }) => ({ turnReservationId: t.turnReservationId, jobId: t.jobId, turnId: t.turnId });
  const send = (h: ReturnType<typeof make>, t: Parameters<typeof id>[0], inv: ParticipationInvocation, attemptId = 'a') => h.engine.reserveAttempt({ ...id(t), attemptId, invocation: { ...inv, contextValidUntil: until } }, now);
  it('reserves a shared DM/reply slot once, permits only one route and retains immutable exact attempts', () => {
    const h = make(); h.grant(); const t = start(h, ['o_reply']);
    expect(t.candidates.map(c => c.channel).sort()).toEqual(['direct_message', 'intent']);
    const dm = h.invoke('o_reply', 'direct_message', 'direct_message'), r = value(send(h, t, dm));
    expect(value(send(h, t, dm))).toEqual(r);
    expect(send(h, t, h.invoke('o_reply'), 'other')).toMatchObject({ ok: false, code: 'DEDUPE_KEY_RESERVED' });
    expect(send(h, t, h.invoke('o_reply'))).toMatchObject({ ok: false, code: 'ATTEMPT_ID_CONFLICT' });
    expect(h.engine.usage().map(c => c.resource).sort()).toEqual(['agent_turn', 'outbound_message']);
    expect(h.engine.finishTurn({ ...id(t), outcome: 'no_action' }, now)).toMatchObject({ ok: false, code: 'TURN_OUTCOME_CONFLICT' });
    expect(h.engine.authorizeReservation({ reservationId: r.reservationId, jobId: r.jobId, invocation: r.invocation }, now).ok).toBe(true);
    value(h.engine.takeover({ groupId: 'g_expression' }));
    expect(h.engine.authorizeReservation({ reservationId: r.reservationId, jobId: r.jobId, invocation: r.invocation }, now)).toMatchObject({ ok: false, code: 'GROUP_TAKEOVER_ACTIVE' });
  });
  it('charges actual owner notices separately under the same model ticket', () => {
    const h = make(); const d = clone(h.d); d.revision = '13';
    d.budgets.push({ id: 'notices', window_id: d.window.id, resource: 'owner_notice', suggested_limit: 2 });
    d.opportunities.push({ ...d.opportunities[0]!, id: 'notice', budget_group_id: 'notices', dedupe_key: 'notice/1' });
    value(h.engine.mergeAuthenticatedDescriptor(d, evidence, now)); h.grant(); const t = start(h, ['notice']);
    expect(h.engine.usage().map(c => c.resource)).toEqual(['agent_turn']); expect(h.engine.budgetUsage()).toEqual([]);
    value(send(h, t, { ...h.invoke('notice'), channel: 'owner_notice', message: false }));
    expect(h.engine.usage().map(c => c.resource).sort()).toEqual(['agent_turn', 'owner_notice']);
  });
  it('keeps distinct referenced decision pools and does not require unrelated turn pools for speech', () => {
    const h = make(); const d = clone(h.d); d.revision = '13';
    d.budgets.push({ id: 'other_turn', window_id: d.window.id, resource: 'agent_turn', suggested_limit: 1 });
    d.opportunities.find(o => o.id === 'o_item_17')!.budget_group_id = 'other_turn';
    value(h.engine.mergeAuthenticatedDescriptor(d, evidence, now)); h.grant(); const t = start(h, ['o_decision', 'o_item_17']);
    expect(h.engine.usage()).toHaveLength(1); expect(h.engine.budgetUsage().map(c => c.budgetGroupId).sort()).toEqual(['b_turn', 'other_turn']);
    value(send(h, t, h.invoke('o_decision'), 'a')); value(send(h, t, h.invoke('o_item_17'), 'b'));
    expect(h.engine.usage()).toHaveLength(1); expect(h.engine.budgetUsage()).toHaveLength(2);
    const other = make(); const dd = clone(other.d); dd.revision = '13'; dd.budgets.find(b => b.resource === 'agent_turn')!.suggested_limit = 0;
    value(other.engine.mergeAuthenticatedDescriptor(dd, evidence, now)); other.grant(); start(other, ['o_statement']); expect(other.engine.budgetUsage()).toEqual([]);
  });
  it('does not capture or later borrow another kind grant when only speech can pay for a turn', () => {
    const h = make(); h.grant({ allowed_action_kinds: ['train.say'] }); h.grant({ allowed_action_kinds: ['train.vote'], max_agent_turns: 0 });
    const t = start(h, ['o_decision', 'o_statement']); expect(t.candidates.map(c => c.kind)).toEqual(['train.say']);
    h.grant({ allowed_action_kinds: ['train.vote'], max_agent_turns: 3 });
    expect(send(h, t, h.invoke('o_decision'))).toMatchObject({ ok: false, code: 'OPPORTUNITY_NOT_RESERVED' });
  });
  it('leaves no partial ticket, attempt, quota or association after real SQLite deferred commit failure', () => {
    const h = make(); h.grant(); h.db.execute('PRAGMA foreign_keys=ON');
    h.db.execute('CREATE TABLE commit_parent(id INTEGER PRIMARY KEY)');
    h.db.execute('CREATE TABLE commit_child(id INTEGER REFERENCES commit_parent(id) DEFERRABLE INITIALLY DEFERRED)');
    const block = () => h.db.execute('CREATE TRIGGER fail_commit AFTER UPDATE ON world_participation_policy BEGIN INSERT INTO commit_child VALUES(1); END');
    const unblock = () => h.db.execute('DROP TRIGGER fail_commit');
    const input = { jobId: 'job', turnId: 'turn', opportunityIds: ['o_statement'], expectedCapabilityRevision: cap, contextValidUntil: until };
    block(); expect(h.engine.reserveTurn(input, now).ok).toBe(false); expect(h.engine.usage()).toEqual([]); unblock();
    const t = value(h.engine.reserveTurn(input, now)).ticket;
    block(); expect(send(h, t, h.invoke('o_statement')).ok).toBe(false); expect(h.engine.usage()).toHaveLength(1); expect(h.engine.reservations()).toEqual([]); unblock();
    const r = value(send(h, t, h.invoke('o_statement'))); block(); expect(h.engine.associateRequest(r.reservationId, 'd'.repeat(64)).ok).toBe(false); unblock();
    expect(h.engine.reservations()[0]!.requestId).toBeUndefined(); expect(h.engine.usage()).toHaveLength(2); h.reopen();
    expect(value(h.engine.reserveTurn(input, now)).created).toBe(false); expect(value(send(h, t, h.invoke('o_statement'))).reservationId).toBe(r.reservationId);
  });
  it('returns detached candidates and does not write from authorizeTurn', () => {
    const h = make(); h.grant(); const t = start(h, ['o_statement']); t.candidates[0]!.kind = 'train.vote';
    h.db.execute('PRAGMA query_only=ON'); const allowed = value(h.engine.authorizeTurn(id(t), now));
    expect(allowed.candidates[0]!.kind).toBe('train.say'); expect(h.engine.usage()).toHaveLength(1);
    h.db.execute('PRAGMA query_only=OFF');
  });
});


describe('WorldParticipation actual process contention', () => {
  it('gives one durable creator across two processes/SQLite handles and returns inspection-only on reopen', async () => {
    const h = make(); h.grant();
    const dir = mkdtempSync(join(tmpdir(), 'world-turn-process-')); directories.push(dir);
    // The temp runner must resolve natives from THIS package's dependency root
    // (repo-root node_modules does not link better-sqlite3 in the export layout).
    symlinkSync(fileURLToPath(new URL('../../../node_modules', import.meta.url)), join(dir, 'node_modules'), 'dir');
    const runner = join(dir, 'runner.mjs');
    const { build } = await import('esbuild');
    await build({ stdin: { contents: `
      import { WorldParticipation } from ${JSON.stringify(fileURLToPath(new URL('../../../src/world/world-participation.ts', import.meta.url)))};
      import { LocalHostDb } from ${JSON.stringify(fileURLToPath(new URL('../../../src/host/local-host-db.ts', import.meta.url)))};
      const c = JSON.parse(process.argv[2]); const db = new LocalHostDb(c.path);
      const policy = new WorldParticipation(db,c.house,c.actor,c.pid);
      process.once('message', () => {
        const result = policy.reserveTurn(c.input,c.now); db.close();
        process.send({result}, () => process.disconnect());
      });
      process.send({ready:true});
    `, resolveDir: fileURLToPath(new URL('../../../', import.meta.url)), sourcefile: 'world-turn-process.ts', loader: 'ts' },
      outfile: runner, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent',
      banner: { js: "import {createRequire as nodeRequire} from 'node:module'; const require=nodeRequire(import.meta.url);" } });
    const input = { jobId: 'concurrent_job', turnId: 'concurrent_turn', opportunityIds: ['o_statement'], expectedCapabilityRevision: cap, contextValidUntil: '2026-09-08T14:04:00Z' };
    const config = JSON.stringify({ path: h.path, house: h.house, actor: h.d.actor_id, pid: h.d.participation_id, input, now });
    const children = [0, 1].map(() => {
      const child = fork(runner, [config], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      let errorText = '';
      child.stderr?.on('data', bytes => { errorText += String(bytes).slice(0, 4000); });
      let readyResolve: () => void, readyReject: (e: Error) => void;
      const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
      let resultResolve: (r: { ok: boolean; value?: { created: boolean } }) => void;
      const result = new Promise<{ ok: boolean; value?: { created: boolean } }>(resolve => { resultResolve = resolve; });
      child.on('message', (m: { ready?: boolean; result?: { ok: boolean; value?: { created: boolean } } }) => { if (m.ready) readyResolve(); if (m.result) resultResolve(m.result); });
      const exited = new Promise<void>((resolve, reject) => child.once('exit', code => { if (code === 0) resolve(); else { const error = new Error(errorText || `Child exited ${code}`); readyReject(error); reject(error); } }));
      return { child, ready, result, exited };
    });
    try {
      await Promise.all(children.map(c => c.ready)); children.forEach(c => c.child.send('reserve'));
      const results = await Promise.all(children.map(c => c.result)); await Promise.all(children.map(c => c.exited));
      expect(results.every(r => r.ok)).toBe(true); expect(results.map(r => r.value!.created).sort()).toEqual([false, true]);
      h.reopen(); expect(value(h.engine.reserveTurn(input, now)).created).toBe(false); expect(h.engine.usage().map(c => c.resource)).toEqual(['agent_turn']);
      expect(h.engine.reservations()).toEqual([]);
    } finally { for (const c of children) if (c.child.exitCode === null && c.child.signalCode === null) c.child.kill('SIGKILL'); }
  }, 15000);
});
