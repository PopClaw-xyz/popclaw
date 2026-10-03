import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot,
} from 'openclaw/plugin-sdk/runtime-config-snapshot';
import {
  readOwnerAllowlistState, resolveOwnerApprovalRoute,
  type OwnerApprovalRouteQuery, type OwnerApprovalRouteReaders,
} from '../../../src/host/owner-approval-route.js';

/** The turn's own reply address. The resolver never learns whose it is — the
 *  point of the relational check is that nothing here has to. */
const TURN_TO = '+15555550101';
/** The whole shape the resolver reads, with every one of the five conditions
 *  satisfied. Each test below breaks exactly one of them. */
const pinnedConfig = () => ({
  commands: { ownerAllowFrom: [TURN_TO] },
  approvals: { plugin: { enabled: true, mode: 'targets', targets: [{ channel: 'whatsapp', to: TURN_TO, accountId: 'main' }] } },
});
/** A stand-in for the host's channel normalizer, with the one distinction the
 *  real one makes: `webchat` normalizes but is not deliverable. */
const readers = (cfg: unknown): OwnerApprovalRouteReaders => ({
  readActiveConfig: () => cfg,
  resolveChannel: raw => ({ whatsapp: 'whatsapp', WhatsApp: 'whatsapp', webchat: 'webchat', telegram: 'telegram' } as Record<string, string>)[raw],
});
const call: OwnerApprovalRouteQuery = { channel: 'whatsapp', accountId: 'main', to: TURN_TO, agentId: 'main', sessionKey: 'agent:main:whatsapp:direct:1' };
const resolve = (cfg: unknown, query: OwnerApprovalRouteQuery = call) => resolveOwnerApprovalRoute(query, readers(cfg));

describe('owner approval route — the pinned case', () => {
  it('returns the targets it validated, so a caller delivers down the route it checked', async () => {
    expect(await resolve(pinnedConfig())).toEqual({
      pinned: true, targets: [{ channel: 'whatsapp', to: TURN_TO, accountId: 'main' }],
    });
  });

  it('accepts a target whose channel is spelled differently but normalizes the same', async () => {
    const cfg = pinnedConfig();
    cfg.approvals.plugin.targets[0]!.channel = 'WhatsApp';
    expect(await resolve(cfg)).toMatchObject({ pinned: true });
  });

  it('accepts a call and a target that both carry no account id', async () => {
    const cfg = pinnedConfig();
    delete (cfg.approvals.plugin.targets[0] as { accountId?: string }).accountId;
    expect(await resolve(cfg, { ...call, accountId: undefined }))
      .toEqual({ pinned: true, targets: [{ channel: 'whatsapp', to: TURN_TO }] });
  });
});

describe('owner approval route — all five conditions, not a mode string', () => {
  it('refuses when the forwarding block is not enabled, even in targets mode', async () => {
    const cfg = pinnedConfig();
    cfg.approvals.plugin.enabled = false;
    expect(await resolve(cfg)).toEqual({ pinned: false, reason: 'OWNER_ROUTE_FORWARDING_DISABLED' });
  });

  it('refuses mode "both", which also resolves a target from the turn itself', async () => {
    const cfg = pinnedConfig();
    cfg.approvals.plugin.mode = 'both';
    expect(await resolve(cfg)).toEqual({ pinned: false, reason: 'OWNER_ROUTE_MODE_NOT_TARGETS' });
  });

  it('refuses mode "session", which is also the host default when mode is absent', async () => {
    const cfg = pinnedConfig();
    delete (cfg.approvals.plugin as { mode?: string }).mode;
    expect(await resolve(cfg)).toEqual({ pinned: false, reason: 'OWNER_ROUTE_MODE_NOT_TARGETS' });
  });

  it('refuses when an agent filter excludes THIS call, though the mode still says targets', async () => {
    const cfg = { ...pinnedConfig() };
    (cfg.approvals.plugin as { agentFilter?: string[] }).agentFilter = ['somebody-else'];
    expect(await resolve(cfg)).toEqual({ pinned: false, reason: 'OWNER_ROUTE_FILTERS_EXCLUDE_CALL' });
  });

  it('refuses when a session filter excludes THIS call', async () => {
    const cfg = { ...pinnedConfig() };
    (cfg.approvals.plugin as { sessionFilter?: string[] }).sessionFilter = ['another-session'];
    expect(await resolve(cfg)).toEqual({ pinned: false, reason: 'OWNER_ROUTE_FILTERS_EXCLUDE_CALL' });
  });

  it('admits the call when the filters name it', async () => {
    const cfg = { ...pinnedConfig() };
    (cfg.approvals.plugin as { agentFilter?: string[] }).agentFilter = ['main'];
    (cfg.approvals.plugin as { sessionFilter?: string[] }).sessionFilter = ['whatsapp:direct'];
    expect(await resolve(cfg)).toMatchObject({ pinned: true });
  });

  it('refuses a target whose channel cannot receive a delivery', async () => {
    const cfg = pinnedConfig();
    cfg.approvals.plugin.targets[0]!.channel = 'webchat';
    expect(await resolve(cfg)).toEqual({ pinned: false, reason: 'OWNER_ROUTE_TARGET_NOT_DELIVERABLE' });
  });

  it('refuses a target on an unknown channel rather than letting the host skip it silently', async () => {
    const cfg = pinnedConfig();
    cfg.approvals.plugin.targets[0]!.channel = 'carrier-pigeon';
    expect(await resolve(cfg)).toEqual({ pinned: false, reason: 'OWNER_ROUTE_TARGET_NOT_DELIVERABLE' });
  });

  it('names the TURN\'s undeliverable channel as the turn\'s, not as a target\'s', async () => {
    expect(await resolve(pinnedConfig(), { ...call, channel: 'webchat' }))
      .toEqual({ pinned: false, reason: 'OWNER_ROUTE_TURN_CHANNEL_NOT_DELIVERABLE' });
    expect(await resolve(pinnedConfig(), { ...call, channel: 'carrier-pigeon' }))
      .toEqual({ pinned: false, reason: 'OWNER_ROUTE_TURN_CHANNEL_NOT_DELIVERABLE' });
    // ...and a target's undeliverable channel keeps the target's name, so the
    // two halves of the comparison are never reported as each other.
    const cfg = pinnedConfig();
    cfg.approvals.plugin.targets[0]!.channel = 'webchat';
    expect(await resolve(cfg)).toEqual({ pinned: false, reason: 'OWNER_ROUTE_TARGET_NOT_DELIVERABLE' });
  });

  it('refuses a target on an unknown channel even when the turn is fine', async () => {
    const cfg = pinnedConfig();
    cfg.approvals.plugin.targets[0]!.channel = 'carrier-pigeon';
    expect(await resolve(cfg)).toEqual({ pinned: false, reason: 'OWNER_ROUTE_TARGET_NOT_DELIVERABLE' });
  });
});

/**
 * THE TURN HAS TWO DESTINATIONS ON THE HOST'S CONTEXT, AND THEY HAD BETTER
 * AGREE.
 *
 * `channelId` (what this module compares) and `turnSourceTo` (what the host's
 * own forwarder routes on) coincide on the measured bundle, so requiring them
 * to agree costs nothing today and removes the one divergence that could send
 * a prompt down a route nothing here checked.
 *
 * THE ASYMMETRY IS THE WHOLE DESIGN. `turnSourceTo` is not in the declared
 * hook-context type, so a host update can drop it with no type error. Absent
 * therefore means "check exactly what you checked before", never "refuse":
 * refusing would turn this feature off silently on an upgrade, which is the
 * failure shape this lane keeps meeting.
 */
describe('owner approval route — the host\'s own routing target, when it says one', () => {
  it('refuses when the two destinations on the same turn disagree', async () => {
    expect(await resolve(pinnedConfig(), { ...call, turnSourceTo: '+10000000000' }))
      .toEqual({ pinned: false, reason: 'OWNER_ROUTE_TURN_TARGET_DIVERGED' });
  });

  it('admits when they agree, including across surrounding whitespace', async () => {
    expect(await resolve(pinnedConfig(), { ...call, turnSourceTo: TURN_TO })).toMatchObject({ pinned: true });
    expect(await resolve(pinnedConfig(), { ...call, turnSourceTo: ` ${TURN_TO} ` })).toMatchObject({ pinned: true });
  });

  /** A host that stops projecting the field must lose the extra narrowing and
   *  NOTHING else — so every shape that carries no readable address falls back
   *  to the check that shipped before this existed. */
  for (const [name, value] of [
    ['absent', undefined], ['null', null], ['blank', '   '], ['not a string', 42],
  ] as const) {
    it(`falls back to today's check when the host's routing target is ${name}`, async () => {
      expect(await resolve(pinnedConfig(), { ...call, turnSourceTo: value as string | null | undefined }))
        .toMatchObject({ pinned: true });
    });
  }

  /** And the fallback is a fallback, not an amnesty: the address check that
   *  was already there still refuses. */
  it('still refuses a target that is not this turn when the field is absent', async () => {
    const cfg = pinnedConfig();
    cfg.approvals.plugin.targets[0]!.to = '+10000000000';
    expect(await resolve(cfg, { ...call, turnSourceTo: undefined }))
      .toEqual({ pinned: false, reason: 'OWNER_ROUTE_TARGET_ADDRESS_NOT_THIS_TURN' });
  });
});

describe('owner approval route — this turn\'s own route, never "a target exists"', () => {
  it('refuses a target that is not where this call came from', async () => {
    const cfg = pinnedConfig();
    cfg.approvals.plugin.targets[0]!.to = '+10000000000';
    expect(await resolve(cfg)).toEqual({ pinned: false, reason: 'OWNER_ROUTE_TARGET_ADDRESS_NOT_THIS_TURN' });
  });

  it('refuses when ONE of several targets is elsewhere, because the host delivers to all of them', async () => {
    const cfg = pinnedConfig();
    cfg.approvals.plugin.targets.push({ channel: 'whatsapp', to: '+10000000000', accountId: 'main' });
    expect(await resolve(cfg)).toEqual({ pinned: false, reason: 'OWNER_ROUTE_TARGET_ADDRESS_NOT_THIS_TURN' });
  });

  /**
   * THE SAME GATE, BOUND MORE THAN ONCE ON PURPOSE.
   *
   * "every target" and "any target" are the SAME answer whenever there is one
   * target — which every other case in this file has — so a single multi-entry
   * case was the only thing standing between a reading that admits and a green
   * suite. Two more arrangements, each of which a "one of them matches, so
   * deliver" reading would let through: the stray FIRST, where the loop's own
   * short circuit is what refuses, and a stray that differs by CHANNEL rather
   * than by address, which is the axis a matcher is likeliest to drop.
   */
  it('refuses when the FIRST of several targets is elsewhere, and a later match does not rescue it', async () => {
    const cfg = pinnedConfig();
    cfg.approvals.plugin.targets.unshift({ channel: 'whatsapp', to: '+10000000000', accountId: 'main' });
    expect(await resolve(cfg)).toEqual({ pinned: false, reason: 'OWNER_ROUTE_TARGET_ADDRESS_NOT_THIS_TURN' });
  });

  it('refuses a second target on another channel, even though the first one is this turn', async () => {
    const cfg = pinnedConfig();
    cfg.approvals.plugin.targets.push({ channel: 'telegram', to: TURN_TO, accountId: 'main' });
    expect(await resolve(cfg)).toEqual({ pinned: false, reason: 'OWNER_ROUTE_TARGET_CHANNEL_NOT_THIS_TURN' });
  });

  it('refuses a target on another channel', async () => {
    const cfg = pinnedConfig();
    cfg.approvals.plugin.targets[0]!.channel = 'telegram';
    expect(await resolve(cfg)).toEqual({ pinned: false, reason: 'OWNER_ROUTE_TARGET_CHANNEL_NOT_THIS_TURN' });
  });

  it('refuses a target bound to a different account on the same channel', async () => {
    const cfg = pinnedConfig();
    cfg.approvals.plugin.targets[0]!.accountId = 'other';
    expect(await resolve(cfg)).toEqual({ pinned: false, reason: 'OWNER_ROUTE_TARGET_ACCOUNT_NOT_THIS_TURN' });
  });

  it('counts a missing account as different from a present one the channel does not resolve to', async () => {
    const cfg = pinnedConfig();
    delete (cfg.approvals.plugin.targets[0] as { accountId?: string }).accountId;
    expect(await resolve(cfg)).toEqual({ pinned: false, reason: 'OWNER_ROUTE_TARGET_ACCOUNT_NOT_THIS_TURN' });
    expect(await resolve(cfg, { ...call, accountId: undefined })).toMatchObject({ pinned: true });
  });

  it('matches an account spelled in another case, through the host normalizer', async () => {
    const cfg = pinnedConfig();
    cfg.approvals.plugin.targets[0]!.accountId = 'MAIN';
    expect(await resolve(cfg)).toMatchObject({ pinned: true });
  });

  it('never widens a phone-shaped address: a JID does not equal an E.164 number', async () => {
    // `normalizeE164` would fold these together AND would also fold a group
    // JID onto the same string, so the comparison stays exact.
    const cfg = pinnedConfig();
    cfg.approvals.plugin.targets[0]!.to = '15555550101@s.whatsapp.net';
    expect(await resolve(cfg)).toEqual({ pinned: false, reason: 'OWNER_ROUTE_TARGET_ADDRESS_NOT_THIS_TURN' });
  });

  it('refuses a target pinned to a thread, by its own name and not as a wrong address', async () => {
    const cfg = pinnedConfig();
    (cfg.approvals.plugin.targets[0] as { threadId?: string }).threadId = 't1';
    expect(await resolve(cfg)).toEqual({ pinned: false, reason: 'OWNER_ROUTE_TARGET_THREAD_PINNED' });
  });

  it('refuses an empty target list', async () => {
    const cfg = pinnedConfig();
    cfg.approvals.plugin.targets = [];
    expect(await resolve(cfg)).toEqual({ pinned: false, reason: 'OWNER_ROUTE_NO_TARGET' });
  });

  it('refuses a target missing its destination', async () => {
    const cfg = pinnedConfig();
    delete (cfg.approvals.plugin.targets[0] as { to?: string }).to;
    expect(await resolve(cfg)).toEqual({ pinned: false, reason: 'OWNER_ROUTE_NO_TARGET' });
  });

  it('refuses when the call brings no destination of its own to compare', async () => {
    expect(await resolve(pinnedConfig(), { ...call, to: '' }))
      .toEqual({ pinned: false, reason: 'OWNER_ROUTE_TURN_ADDRESS_ABSENT' });
  });
});

/**
 * A TARGET THAT NAMES NO ACCOUNT, on the instance shape that was refused.
 *
 * Measured on a real instance: `channels.whatsapp.accounts` unset, the turn on
 * the `default` account, and the configured target `{channel, to}` with no
 * `accountId`. The old comparison rebuilt the host's DEDUPE key, where a
 * missing account is kept apart from a present one — conservative there (the
 * worst case is a duplicate delivery), a false refusal here. What decides who
 * actually delivers a target with no account is the channel's default account,
 * and on a channel with exactly one account that is the account this turn
 * arrived on: one destination, not two merged. On a channel with more than one
 * it is not obviously this turn's account, so it stays refused.
 */
describe('owner approval route — a target with no account, resolved only where it is unambiguous', () => {
  const noAccountTarget = (channels?: unknown) => ({
    commands: { ownerAllowFrom: [TURN_TO] },
    approvals: { plugin: { enabled: true, mode: 'targets', targets: [{ channel: 'whatsapp', to: TURN_TO }] } },
    ...channels !== undefined ? { channels } : {},
  });
  const onDefault: OwnerApprovalRouteQuery = { ...call, accountId: 'default' };

  it('admits it on a single-account channel (accounts unset) when the turn is on the default account', async () => {
    expect(await resolve(noAccountTarget({ whatsapp: { dmPolicy: 'allowlist' } }), onDefault))
      .toEqual({ pinned: true, targets: [{ channel: 'whatsapp', to: TURN_TO }] });
    // and with no channel section at all — the same implicit single account
    expect(await resolve(noAccountTarget(), onDefault)).toMatchObject({ pinned: true });
  });

  it('still refuses it, by the account, when the channel has two accounts', async () => {
    const cfg = noAccountTarget({ whatsapp: { accounts: { default: {}, work: {} } } });
    expect(await resolve(cfg, onDefault)).toEqual({ pinned: false, reason: 'OWNER_ROUTE_TARGET_ACCOUNT_NOT_THIS_TURN' });
    expect(await resolve(cfg, { ...call, accountId: 'work' }))
      .toEqual({ pinned: false, reason: 'OWNER_ROUTE_TARGET_ACCOUNT_NOT_THIS_TURN' });
  });

  it('still refuses it when a binding names a second account beside the one configured', async () => {
    const cfg = {
      ...noAccountTarget({ whatsapp: { accounts: { default: {} } } }),
      bindings: [{ agentId: 'main', match: { channel: 'whatsapp', accountId: 'work' } }],
    };
    // the control: the same channel with no binding is single-account and admits
    expect(await resolve({ ...cfg, bindings: [] }, onDefault)).toMatchObject({ pinned: true });
    expect(await resolve(cfg, onDefault)).toEqual({ pinned: false, reason: 'OWNER_ROUTE_TARGET_ACCOUNT_NOT_THIS_TURN' });
  });

  it('refuses it on a single-account channel when the turn is on some other account', async () => {
    expect(await resolve(noAccountTarget(), { ...call, accountId: 'work' }))
      .toEqual({ pinned: false, reason: 'OWNER_ROUTE_TARGET_ACCOUNT_NOT_THIS_TURN' });
  });

  it('follows a named defaultAccount the host resolves to, not the literal "default"', async () => {
    const cfg = noAccountTarget({ whatsapp: { defaultAccount: 'work', accounts: { work: {} } } });
    expect(await resolve(cfg, { ...call, accountId: 'work' }))
      .toEqual({ pinned: true, targets: [{ channel: 'whatsapp', to: TURN_TO }] });
    expect(await resolve(cfg, onDefault)).toEqual({ pinned: false, reason: 'OWNER_ROUTE_TARGET_ACCOUNT_NOT_THIS_TURN' });
  });

  it('refuses a lone named account with no defaultAccount, since the channel may hold an implicit top-level one', async () => {
    const cfg = noAccountTarget({ whatsapp: { accounts: { work: {} } } });
    expect(await resolve(cfg, { ...call, accountId: 'work' }))
      .toEqual({ pinned: false, reason: 'OWNER_ROUTE_TARGET_ACCOUNT_NOT_THIS_TURN' });
  });

  it('refuses a defaultAccount that names no listed account, which only the channel itself could resolve', async () => {
    const cfg = noAccountTarget({ whatsapp: { defaultAccount: 'work' } });
    expect(await resolve(cfg, onDefault)).toEqual({ pinned: false, reason: 'OWNER_ROUTE_TARGET_ACCOUNT_NOT_THIS_TURN' });
    expect(await resolve(cfg, { ...call, accountId: 'work' }))
      .toEqual({ pinned: false, reason: 'OWNER_ROUTE_TARGET_ACCOUNT_NOT_THIS_TURN' });
  });

  it('refuses an accounts block it cannot read rather than counting it as no accounts', async () => {
    expect(await resolve(noAccountTarget({ whatsapp: { accounts: ['default', 'work'] } }), onDefault))
      .toEqual({ pinned: false, reason: 'OWNER_ROUTE_TARGET_ACCOUNT_NOT_THIS_TURN' });
  });

  it('refuses an accounts value of `null`, which is not a plain object either', async () => {
    const cfg = noAccountTarget({ whatsapp: { accounts: null } });
    expect(await resolve(cfg, onDefault)).toEqual({ pinned: false, reason: 'OWNER_ROUTE_TARGET_ACCOUNT_NOT_THIS_TURN' });
    expect(await resolve(cfg, { ...call, accountId: 'work' }))
      .toEqual({ pinned: false, reason: 'OWNER_ROUTE_TARGET_ACCOUNT_NOT_THIS_TURN' });
  });

  it('refuses an accounts value that is a number, not a plain object either', async () => {
    const cfg = noAccountTarget({ whatsapp: { accounts: 5 } });
    expect(await resolve(cfg, onDefault)).toEqual({ pinned: false, reason: 'OWNER_ROUTE_TARGET_ACCOUNT_NOT_THIS_TURN' });
    expect(await resolve(cfg, { ...call, accountId: 'work' }))
      .toEqual({ pinned: false, reason: 'OWNER_ROUTE_TARGET_ACCOUNT_NOT_THIS_TURN' });
  });

  it('refuses an empty array for accounts, which is still not a plain object', async () => {
    const cfg = noAccountTarget({ whatsapp: { accounts: [] } });
    expect(await resolve(cfg, onDefault)).toEqual({ pinned: false, reason: 'OWNER_ROUTE_TARGET_ACCOUNT_NOT_THIS_TURN' });
    expect(await resolve(cfg, { ...call, accountId: 'work' }))
      .toEqual({ pinned: false, reason: 'OWNER_ROUTE_TARGET_ACCOUNT_NOT_THIS_TURN' });
  });

  it('compares a NAMED target account exactly, even on a single-account channel', async () => {
    const cfg = noAccountTarget();
    (cfg.approvals.plugin.targets[0] as { accountId?: string }).accountId = 'work';
    expect(await resolve(cfg, onDefault)).toEqual({ pinned: false, reason: 'OWNER_ROUTE_TARGET_ACCOUNT_NOT_THIS_TURN' });
  });

  it('does not loosen the address: a different `to` is refused by the address, not the account', async () => {
    const cfg = noAccountTarget();
    cfg.approvals.plugin.targets[0]!.to = '+15555550102';
    expect(await resolve(cfg, onDefault)).toEqual({ pinned: false, reason: 'OWNER_ROUTE_TARGET_ADDRESS_NOT_THIS_TURN' });
  });

  it('does not fold the address by case, which some channels treat as a different id', async () => {
    const cfg = noAccountTarget();
    cfg.approvals.plugin.targets[0]!.to = 'C0123ABCD';
    expect(await resolve(cfg, { ...onDefault, to: 'c0123abcd' }))
      .toEqual({ pinned: false, reason: 'OWNER_ROUTE_TARGET_ADDRESS_NOT_THIS_TURN' });
  });

  it('does not loosen the channel', async () => {
    const cfg = noAccountTarget();
    cfg.approvals.plugin.targets[0]!.channel = 'telegram';
    expect(await resolve(cfg, onDefault)).toEqual({ pinned: false, reason: 'OWNER_ROUTE_TARGET_CHANNEL_NOT_THIS_TURN' });
  });
});

describe('owner approval route — the sixth mechanism, which deletes a validated target', () => {
  /**
   * `resolveTargets` filters every target through the target channel's own
   * `shouldSkipForwardingFallback` (`server-aux-handlers-BKv4BKQ5.mjs:340` →
   * `:215-224`), and an emptied list makes `handleRequested` return false
   * (`:387-390`). The approver-restricted adapter family never consults `mode`
   * (`approval-delivery-helpers-y-bw7F82.mjs:171-182`), so `mode: "targets"`
   * does not exclude it; what a plugin CAN read is the configuration its
   * predicate reads.
   */
  const withChannel = (whatsapp: unknown) => ({ ...pinnedConfig(), channels: { whatsapp } });

  it('refuses when the turn channel declares an approval client of its own', async () => {
    expect(await resolve(withChannel({ execApprovals: {} })))
      .toEqual({ pinned: false, reason: 'OWNER_ROUTE_CHANNEL_CLAIMS_APPROVALS' });
    // `enabled` DEFAULTS to "auto" (`exec-approvals-D22xLsQ6.mjs:28`), so a
    // block that says nothing is a block that is on.
    expect(await resolve(withChannel({ execApprovals: { enabled: 'auto' } })))
      .toEqual({ pinned: false, reason: 'OWNER_ROUTE_CHANNEL_CLAIMS_APPROVALS' });
    expect(await resolve(withChannel({ execApprovals: { enabled: true, approvers: ['someone'] } })))
      .toEqual({ pinned: false, reason: 'OWNER_ROUTE_CHANNEL_CLAIMS_APPROVALS' });
  });

  it('refuses when any account entry under that channel declares one', async () => {
    expect(await resolve(withChannel({ accounts: { main: { execApprovals: {} } } })))
      .toEqual({ pinned: false, reason: 'OWNER_ROUTE_CHANNEL_CLAIMS_APPROVALS' });
    expect(await resolve(withChannel({ accounts: { a: {}, b: { execApprovals: { enabled: true } } } })))
      .toEqual({ pinned: false, reason: 'OWNER_ROUTE_CHANNEL_CLAIMS_APPROVALS' });
  });

  it('admits the route when the operator has turned that client off, and when none is declared', async () => {
    expect(await resolve(withChannel({ execApprovals: { enabled: false } }))).toMatchObject({ pinned: true });
    expect(await resolve(withChannel({ accounts: { main: { execApprovals: { enabled: false } } } })))
      .toMatchObject({ pinned: true });
    expect(await resolve(withChannel({}))).toMatchObject({ pinned: true });
    expect(await resolve(pinnedConfig())).toMatchObject({ pinned: true });
  });

  it('asks about THIS turn\'s channel, not about every channel on the box', async () => {
    const cfg = { ...pinnedConfig(), channels: { telegram: { execApprovals: {} } } };
    expect(await resolve(cfg)).toMatchObject({ pinned: true });
  });
});

describe('owner approval route — a filter that cannot be read is not an absent filter', () => {
  const withFilter = (key: 'agentFilter' | 'sessionFilter', value: unknown) => {
    const cfg = pinnedConfig();
    (cfg.approvals.plugin as Record<string, unknown>)[key] = value;
    return cfg;
  };

  it('refuses a filter that is not a list of strings rather than treating it as no filter', async () => {
    // The host's `matchesApprovalRequestFilters` would have EXCLUDED this call;
    // dropping the filter admits where the host refuses, which is the one
    // direction that must never happen.
    for (const bad of [[1], ['ok', null], 'main', {}, [{}]]) {
      expect(await resolve(withFilter('agentFilter', bad)))
        .toEqual({ pinned: false, reason: 'OWNER_ROUTE_FILTER_UNREADABLE' });
      expect(await resolve(withFilter('sessionFilter', bad)))
        .toEqual({ pinned: false, reason: 'OWNER_ROUTE_FILTER_UNREADABLE' });
    }
  });

  it('still treats an absent filter as matching every call, which is what the host does', async () => {
    expect(await resolve(withFilter('agentFilter', undefined))).toMatchObject({ pinned: true });
    // An EMPTY list is readable and the host ignores it (`agentFilter?.length`,
    // `approval-request-filters-CyEsHpxf.mjs:18`), so it is not a refusal.
    expect(await resolve(withFilter('agentFilter', []))).toMatchObject({ pinned: true });
    expect(await resolve(withFilter('agentFilter', ['nobody'])))
      .toEqual({ pinned: false, reason: 'OWNER_ROUTE_FILTERS_EXCLUDE_CALL' });
  });
});

describe('owner allowlist state — a setup mistake told apart from a stranger', () => {
  const stateOf = (commands: unknown) => readOwnerAllowlistState({ readActiveConfig: () => ({ commands }) });

  it('reports an absent list as unconfigured, which is what makes the flag false forever', async () => {
    expect(await stateOf({})).toBe('unconfigured');
    expect(await stateOf({ ownerAllowFrom: [] })).toBe('unconfigured');
    expect(await stateOf({ ownerAllowFrom: ['*'] })).toBe('unconfigured');
    expect(await stateOf({ ownerAllowFrom: ['  '] })).toBe('unconfigured');
  });

  it('reports a list that exists as configured, and claims nothing about it being right', async () => {
    expect(await stateOf({ ownerAllowFrom: [TURN_TO] })).toBe('configured');
    expect(await stateOf({ ownerAllowFrom: ['definitely-the-wrong-spelling'] })).toBe('configured');
  });

  it('reports unknown rather than guessing when the process holds no snapshot', async () => {
    expect(await readOwnerAllowlistState({ readActiveConfig: () => null })).toBe('unknown');
    expect(await readOwnerAllowlistState({ readActiveConfig: () => { throw new Error('x'); } })).toBe('unknown');
  });
});

describe('owner approval route — the runtime route, never the file', () => {
  it('refuses when this process holds no runtime snapshot rather than reading the disk', async () => {
    expect(await resolveOwnerApprovalRoute(call, { ...readers(null) }))
      .toEqual({ pinned: false, reason: 'OWNER_ROUTE_CONFIG_UNAVAILABLE' });
  });

  it('refuses when the snapshot reader throws', async () => {
    expect(await resolveOwnerApprovalRoute(call, {
      readActiveConfig: () => { throw new Error('no runtime'); },
      resolveChannel: raw => raw,
    })).toEqual({ pinned: false, reason: 'OWNER_ROUTE_CONFIG_UNAVAILABLE' });
  });

  it('refuses when the call has no channel to compare against', async () => {
    expect(await resolve(pinnedConfig(), { ...call, channel: '' }))
      .toEqual({ pinned: false, reason: 'OWNER_ROUTE_TURN_ADDRESS_ABSENT' });
  });

  it('reads own data properties only, so a configuration getter cannot run code', async () => {
    const cfg = pinnedConfig();
    Object.defineProperty(cfg.approvals.plugin, 'enabled', { get: () => true, configurable: true });
    expect(await resolve(cfg)).toEqual({ pinned: false, reason: 'OWNER_ROUTE_FORWARDING_DISABLED' });
  });

  /**
   * MEASURES THE VARIABLE ITSELF. The pinned in-process snapshot is the very
   * object the host's approval forwarder reads
   * (`server-aux-handlers-BKv4BKQ5.mjs:469` `deps.getConfig ?? getRuntimeConfig`),
   * so setting it here and reading it back through the module's OWN default
   * reader is the difference between "this route" and "whatever is on disk":
   * a reader that loaded the file would not see a route that was never
   * written to one.
   */
  describe('against the host\'s own pinned runtime snapshot', () => {
    afterEach(() => { clearRuntimeConfigSnapshot(); });

    it('reads the route the gateway is actually running on', async () => {
      setRuntimeConfigSnapshot(pinnedConfig() as never);
      expect(await resolveOwnerApprovalRoute(call)).toEqual({
        pinned: true, targets: [{ channel: 'whatsapp', to: TURN_TO, accountId: 'main' }],
      });
    });

    it('sees a later snapshot, never a stale one', async () => {
      setRuntimeConfigSnapshot(pinnedConfig() as never);
      const revoked = pinnedConfig();
      revoked.approvals.plugin.enabled = false;
      setRuntimeConfigSnapshot(revoked as never);
      expect(await resolveOwnerApprovalRoute(call)).toEqual({ pinned: false, reason: 'OWNER_ROUTE_FORWARDING_DISABLED' });
    });

    it('refuses once the process holds no snapshot, rather than falling back to the file', async () => {
      setRuntimeConfigSnapshot(pinnedConfig() as never);
      clearRuntimeConfigSnapshot();
      expect(await resolveOwnerApprovalRoute(call)).toEqual({ pinned: false, reason: 'OWNER_ROUTE_CONFIG_UNAVAILABLE' });
    });
  });
});

/**
 * WHEN THE HOST PACKAGE ITSELF CANNOT BE LOADED — the case the environment
 * under test used to be structurally unable to produce.
 *
 * `openclaw` is an optional peer dependency and the module imports it
 * dynamically, because a static import killed the MCP roots outright (see
 * `owner-approval-route.ts`'s `loadRouteSdk` and
 * `tests/unit/mcp-bundle-host-free.test.ts`). "Optional" must never mean
 * "admits when absent": a module that failed to load has answered nothing, and
 * nothing is not consent. This drives that path directly rather than inferring
 * it, by making one of the three imports reject in a freshly loaded copy of the
 * module — the memo inside it is per module instance, so `resetModules` is what
 * makes the failure reachable at all.
 */
describe('owner approval route — the host package missing entirely', () => {
  afterEach(() => { vi.doUnmock('openclaw/plugin-sdk/routing'); vi.resetModules(); });

  it('refuses by name instead of admitting, and states nothing about a route', async () => {
    vi.doMock('openclaw/plugin-sdk/routing', () => {
      throw Object.assign(new Error("Cannot find package 'openclaw'"), { code: 'ERR_MODULE_NOT_FOUND' });
    });
    vi.resetModules();
    const fresh = await import('../../../src/host/owner-approval-route.js');
    // Readers ARE supplied, and a fully pinned config with them: the refusal is
    // about the host's own filter predicate and account normalizer being
    // unavailable, not about anything this test withheld.
    expect(await fresh.resolveOwnerApprovalRoute(call, readers(pinnedConfig())))
      .toEqual({ pinned: false, reason: 'OWNER_ROUTE_CONFIG_UNAVAILABLE' });
    // The allowlist question degrades to `unknown`, which its one caller turns
    // into a refusal — never into `unconfigured`, which would be a claim.
    expect(await fresh.readOwnerAllowlistState()).toBe('unknown');
  });
});
