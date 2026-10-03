import { afterEach, describe, expect, it } from 'vitest';
import bs58 from 'bs58';
import { NATIVE_POLICY_MALFORMED, createOpenClawWorldExecution } from '../../../src/host/openclaw-world-execution.js';
import { renderCopy, type Lang } from '../../../src/lexicon/index.js';

const actorId = bs58.encode(new Uint8Array(32).fill(91)), house = 'http://127.0.0.1:48180';
const start = Date.parse('2026-09-08T10:00:00Z') / 1000;
const input = { house, kind: 'train.join', params: {}, expected_capability_revision: 'b'.repeat(64) };
const policy = { agentId: 'main', actorId, house, kinds: ['train.join', 'train.status'],
  authorizedAt: '2026-09-08T10:00:00Z', expiresAt: '2026-09-08T11:00:00Z' };
const configured = (...policies: unknown[]) => ({ plugins: { entries: { popclaw: { config: { worldExecution: { policies } } } } } });
const refusal = (code: string, kind = input.kind) => `native world execution unavailable (${house} ${kind}): ${code}`;
function setup() {
  let now = start + 1;
  const logs: string[] = [];
  let active: unknown = configured(policy);
  let getter = () => active;
  const host = createOpenClawWorldExecution({ actorId, readActiveConfig: () => active, now: () => now, log: line => logs.push(line) });
  const factory = () => host.bindFactory({ agentId: 'main', getRuntimeConfig: () => getter() });
  return { host, factory, logs, active: () => active, setActive: (value: unknown) => { active = value; },
    setGetter: (value: () => unknown) => { getter = value; }, setNow: (value: number) => { now = value; } };
}

describe('native local execution authority', () => {
  it('permanently invalidates old permits across the supported stop-edit-restart lifecycle', async () => {
    const s = setup(), original = s.active(); let sends = 0;
    let saved!: Parameters<typeof s.host.assertPermit>[0];
    let entered!: () => void, resume!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const paused = new Promise<void>(resolve => { resume = resolve; });
    const inflight = s.factory().withInvocation('same-call', input, undefined, async permit => {
      saved = permit; entered(); await paused;
      expect(() => { permit.assertCurrent(); sends++; }).toThrow('NATIVE_AUTHORITY_INACTIVE');
    });
    await started; s.host.stop(); resume(); await inflight;
    // Config changes only after old runtime work has joined.
    s.setActive({ plugins: { entries: { popclaw: { enabled: false } } } });
    await Promise.resolve(); s.setActive(original);
    const restarted = createOpenClawWorldExecution({actorId, readActiveConfig: s.active, now: () => start + 1});
    await restarted.bindFactory({agentId: 'main', getRuntimeConfig: s.active})
      .withInvocation('same-call', input, undefined, async fresh => {
        expect(fresh.invocationKey).not.toBe(saved.invocationKey);
        expect(() => restarted.assertPermit(saved)).toThrow('NATIVE_AUTHORITY_REQUIRED');
        fresh.assertCurrent();
      });
    expect(() => saved.assertCurrent()).toThrow('NATIVE_AUTHORITY_INACTIVE');
    expect(sends).toBe(0);
  });

  it('permits configured autonomous agent calls without owner/sender metadata and expires the live scope', async () => {
    const s = setup(); let saved!: { assertCurrent(): void };
    const result = await s.factory().withInvocation('call-1', input, undefined, async permit => {
      saved = permit; permit.assertCurrent();
      expect(permit.principal).toEqual({ kind: 'openclaw_agent', agentId: 'main', actorId });
      expect(permit.policyScope.kinds).toEqual(['train.join', 'train.status']);
      expect(permit.expiresAt).toBe(start + 301);
      return 'receipt';
    });
    expect(result).toBe('receipt'); expect(() => saved.assertCurrent()).toThrow('NATIVE_AUTHORITY_INACTIVE');
  });

  it('rejects missing or stale applied configuration without a fallback', async () => {
    const s = setup(), original = s.active(); s.setGetter(() => original); s.setActive(null);
    await expect(s.factory().withInvocation('x', input, undefined, async () => 'sent')).rejects.toThrow('NATIVE_CONFIG_UNAVAILABLE');
    s.setActive({ plugins: { entries: { popclaw: { config: { worldExecution: { policies: [] } } } } } });
    await expect(s.factory().withInvocation('y', input, undefined, async () => 'sent')).rejects.toThrow('NATIVE_CONFIG_STALE');
  });

  it('checks current policy at sending boundaries but preserves an already received result', async () => {
    const s = setup(), original = s.active();
    expect(await s.factory().withInvocation('x', input, undefined, async permit => {
      permit.assertCurrent();
      s.setActive({ plugins: { entries: { popclaw: { enabled: false } } } });
      expect(() => permit.assertCurrent()).toThrow();
      s.setActive(original); expect(() => permit.assertCurrent()).toThrow('NATIVE_AUTHORITY_INACTIVE');
      return 'already-verified-receipt';
    })).toBe('already-verified-receipt');
  });

  it('checks the persisted clock floor before fresh authority and rejects mutable factory identity', async () => {
    const s = setup(); s.host.observeReservedAt(start + 1);
    s.setNow(start); expect(() => s.host.observeReservedAt(start + 1)).toThrow('NATIVE_CLOCK_ROLLBACK');
    s.setNow(start + 2);
    const ctx = { agentId: 'main', getRuntimeConfig: s.active }, bound = s.host.bindFactory(ctx);
    ctx.agentId = 'other';
    await expect(bound.withInvocation('x', input, undefined, async () => 'sent')).rejects.toThrow('NATIVE_CONTEXT_CHANGED');
  });

  it('refuses different actors, agents, houses and kinds, including model-supplied authority', async () => {
    const s = setup();
    for (const value of [{ ...input, house: 'https://other.invalid' }, { ...input, kind: 'train.say' },
      { ...input, authority: { senderIsOwner: true } }]) {
      await expect(s.factory().withInvocation('x', value, undefined, async () => 'sent')).rejects.toThrow();
    }
    const wrongAgent = s.host.bindFactory({ agentId: 'other', getRuntimeConfig: s.active });
    await expect(wrongAgent.withInvocation('x', input, undefined, async () => 'sent')).rejects.toThrow('NATIVE_POLICY_REQUIRED');
    const wrongActor = createOpenClawWorldExecution({ actorId: bs58.encode(new Uint8Array(32).fill(92)), readActiveConfig: s.active, now: () => start + 1 });
    await expect(wrongActor.bindFactory({ agentId: 'main', getRuntimeConfig: s.active })
      .withInvocation('x', input, undefined, async () => 'sent')).rejects.toThrow('NATIVE_POLICY_REQUIRED');
  });

  it('deduplicates one factory call and binds its immutable input, while isolating other factories', async () => {
    const s = setup(), factory = s.factory(); const keys: string[] = [];
    const mutable = structuredClone(input);
    const first = factory.withInvocation('x', mutable, undefined, async permit => {
      keys.push(permit.invocationKey); await Promise.resolve(); expect(permit.input.params).toEqual({}); return 'ok';
    });
    mutable.params = { changed: true };
    expect(await factory.withInvocation('x', input, undefined, async () => 'wrong')).toBe('ok');
    expect(await first).toBe('ok');
    await expect(factory.withInvocation('x', mutable, undefined, async () => 'sent')).rejects.toThrow('NATIVE_INVOCATION_CONFLICT');
    await s.factory().withInvocation('x', input, undefined, async permit => { keys.push(permit.invocationKey); });
    expect(new Set(keys).size).toBe(2);
  });

  it('rejects abort, expiry, observed clock rollback and stopped runtime', async () => {
    const s = setup(), controller = new AbortController();
    await s.factory().withInvocation('x', input, controller.signal, async permit => {
      controller.abort(); expect(() => permit.assertCurrent()).toThrow('NATIVE_AUTHORITY_INACTIVE');
    });
    await s.factory().withInvocation('y', input, undefined, async permit => {
      s.setNow(start); expect(() => permit.assertCurrent()).toThrow('NATIVE_CLOCK_ROLLBACK');
    });
    s.setNow(start + 3600);
    await expect(s.factory().withInvocation('z', input, undefined, async () => 'sent')).rejects.toThrow('NATIVE_POLICY_EXPIRED');
    s.host.stop(); expect(() => s.factory()).toThrow('NATIVE_AUTHORITY_INACTIVE');
  });
});

/** A person previewed a world action on the native host, authorized it, and
 * got a bare `NATIVE_POLICY_REQUIRED` with no receipt and nothing in `logs/`.
 * Three different situations shared that one code, and none of them left a
 * trace. These name them apart and check each leaves exactly one line. */
describe('native refusals name themselves and leave a trace', () => {
  const language = process.env.POPCLAW_LANG;
  afterEach(() => { if (language === undefined) delete process.env.POPCLAW_LANG; else process.env.POPCLAW_LANG = language; });

  it('names zero matching policies and logs that refusal exactly once', async () => {
    const s = setup(); s.setActive(configured());
    await expect(s.factory().withInvocation('x', input, undefined, async () => 'sent')).rejects.toThrow('NATIVE_POLICY_REQUIRED');
    expect(s.logs).toEqual([refusal('NATIVE_POLICY_REQUIRED')]);
  });

  it('names two conflicting policies as ambiguity rather than as a missing one', async () => {
    const s = setup(); s.setActive(configured(policy, { ...policy, kinds: ['train.join'] }));
    const failure = await s.factory().withInvocation('x', input, undefined, async () => 'sent').catch((error: Error) => error.message);
    expect(failure).toContain('NATIVE_POLICY_AMBIGUOUS');
    expect(failure).not.toContain('NATIVE_POLICY_REQUIRED');
    expect(s.logs).toEqual([refusal('NATIVE_POLICY_AMBIGUOUS')]);
  });

  it('names a disabled plugin apart from an unauthorized action', async () => {
    const s = setup(); s.setActive({ plugins: { entries: { popclaw: { enabled: false } } } });
    await expect(s.factory().withInvocation('x', input, undefined, async () => 'sent')).rejects.toThrow('NATIVE_PLUGIN_DISABLED');
    expect(s.logs).toEqual([refusal('NATIVE_PLUGIN_DISABLED')]);
  });

  it('answers readiness from the same configuration, without a clock tick or a permit', () => {
    const s = setup();
    expect(s.host.actionReadiness({ house, kind: 'train.join' })).toEqual({ ready: true, reason: null });
    expect(s.host.actionReadiness({ house, kind: 'train.say' }).ready).toBe(false);
    expect(s.host.actionReadiness({ house, kind: 'train.say' }).reason).toContain('NATIVE_POLICY_REQUIRED');
    expect(s.host.actionReadiness({ house: 'https://other.invalid', kind: 'train.join' }).ready).toBe(false);
    s.setActive(configured(policy, { ...policy, kinds: ['train.join'] }));
    expect(s.host.actionReadiness({ house, kind: 'train.join' }).reason).toContain('NATIVE_POLICY_AMBIGUOUS');
    s.setActive({ plugins: { entries: { popclaw: { enabled: false } } } });
    expect(s.host.actionReadiness({ house, kind: 'train.join' }).reason).toContain('NATIVE_PLUGIN_DISABLED');
    s.setActive(configured());
    expect(s.host.actionReadiness({ house, kind: 'train.join' }).reason).toContain('NATIVE_POLICY_REQUIRED');
  });

  it('reads readiness without touching the monotonic clock the permits depend on', () => {
    const s = setup();
    s.factory();                                                     // advances the permit clock to start + 1
    s.setNow(start);                                                 // a host clock that went backwards
    expect(() => s.host.observeReservedAt(start + 1)).toThrow('NATIVE_CLOCK_ROLLBACK');
    expect(s.host.actionReadiness({ house, kind: 'train.join' })).toEqual({ ready: true, reason: null });
    s.setNow(start + 2);
    expect(() => s.factory()).not.toThrow();
  });

  it('says in the owner language that no authorization is in place, in both locales', async () => {
    for (const [lang, fragment] of [['en', 'No usable owner authorization is in place'], ['zh-CN', '没有可用的主人授权']] as Array<[Lang, string]>) {
      process.env.POPCLAW_LANG = lang;
      const s = setup(); s.setActive(configured());
      const failure = await s.factory().withInvocation('x', input, undefined, async () => 'sent').catch((error: Error) => error.message);
      expect(failure).toContain('NATIVE_POLICY_REQUIRED');
      expect(failure).toContain(fragment);
      expect(failure).toContain(renderCopy(lang, 'world.action.notAuthorized'));
      expect(s.host.actionReadiness({ house, kind: 'train.join' }).reason).toContain(fragment);
    }
  });

  it('still executes a correctly authorized single policy, with nothing logged', async () => {
    const s = setup();
    expect(s.host.actionReadiness({ house, kind: 'train.join' })).toEqual({ ready: true, reason: null });
    const permits: string[] = [];
    expect(await s.factory().withInvocation('call-1', input, undefined, async permit => {
      permit.assertCurrent(); permits.push(permit.policyScope.agentId); return 'receipt';
    })).toBe('receipt');
    expect(permits).toEqual(['main']);
    expect(s.logs).toEqual([]);
  });

  /** The reason string reaches `logs/` AND the agent-visible capability
   *  `detail`, so a schema parser's rendering of the owner's own configuration
   *  must never ride in it. */
  it('names a malformed policy block without repeating what was in it', () => {
    const s = setup();
    const secret = 'corp-internal-house.example';
    s.setActive({ plugins: { entries: { popclaw: { config: { worldExecution: {
      policies: [{ agentId: 7, actorId, house: `https://${secret}`, kinds: 'not-an-array' }],
    } } } } } });
    const verdict = s.host.actionReadiness({ house, kind: 'train.join' });
    expect(verdict.ready).toBe(false);
    expect(verdict.reason).toBe(NATIVE_POLICY_MALFORMED);
    expect(s.logs).toEqual([refusal(NATIVE_POLICY_MALFORMED)]);
    for (const text of [verdict.reason ?? '', ...s.logs]) {
      expect(text).not.toContain(secret);
      expect(text).not.toContain('agentId');
      expect(text).not.toContain('kinds');
    }
  });

  it('keeps naming a configuration it cannot read at all by its own code', () => {
    const s = setup();
    s.setActive(null);
    expect(s.host.actionReadiness({ house, kind: 'train.join' }).reason).toBe('NATIVE_CONFIG_UNAVAILABLE');
  });

  /** One shared slot meant two refusing kinds took turns writing, so nothing
   *  was ever suppressed: a measured 5 rounds across 2 kinds wrote 10 lines. */
  it('writes one line per kind however many times the two are asked about', () => {
    const s = setup(); s.setActive(configured());
    for (let round = 0; round < 5; round++) {
      s.host.actionReadiness({ house, kind: 'train.join' });
      s.host.actionReadiness({ house, kind: 'train.status' });
    }
    expect(s.logs).toEqual([
      refusal('NATIVE_POLICY_REQUIRED', 'train.join'),
      refusal('NATIVE_POLICY_REQUIRED', 'train.status'),
    ]);
  });

  /** The probe runs on every capability read; the gate runs per invocation. A
   *  shared slot let the probe's line steal the gate's, so the one a person
   *  actually hit went unlogged. */
  it('keeps the probe from taking the slot of the refusal a person hit', async () => {
    const s = setup(); s.setActive(configured());
    s.host.actionReadiness({ house, kind: 'train.join' });
    await s.factory().withInvocation('call-1', input, undefined, async () => 'sent').catch(() => undefined);
    // Same code, same subject, two different lanes: both must be written down.
    expect(s.logs).toEqual([refusal('NATIVE_POLICY_REQUIRED'), refusal('NATIVE_POLICY_REQUIRED')]);
    // …and neither lane repeats itself afterwards.
    s.host.actionReadiness({ house, kind: 'train.join' });
    await s.factory().withInvocation('call-2', input, undefined, async () => 'sent').catch(() => undefined);
    expect(s.logs).toHaveLength(2);
  });
});
