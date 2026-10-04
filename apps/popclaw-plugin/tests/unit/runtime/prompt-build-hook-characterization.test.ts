import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearPerProcess, getOrCreatePerProcess } from '../../../src/runtime/once.js';
import type { HouseRuntime } from '../../../src/runtime/house-lifecycle/house-runtime.js';
import { mintHouse } from '../../helpers/signed-manifest.js';
import { NewspaperDispatchRegistry } from '../../../src/newspaper/dedicated-session.js';

/**
 * Characterization of `before_prompt_build` as registered by the REAL gateway
 * root (src/index.ts), booted offline on a temp data root. Pins today's
 * behaviour ahead of the composer / turn-builder split; these are evidence,
 * not endorsements. Every assertion reads the hook's RETURN value and the
 * queue / log state captured AFTER the call.
 */

const seam = vi.hoisted(() => ({
  renderThrows: false,
  lexiconThrows: false,
  order: [] as string[],
}));
vi.mock('../../../src/notifier/mcp-notice.js', async (orig) => {
  const real = await orig<typeof import('../../../src/notifier/mcp-notice.js')>();
  return {
    ...real,
    renderNotifications: vi.fn((...args: Parameters<typeof real.renderNotifications>) => {
      seam.order.push('render');
      if (seam.renderThrows) throw new Error('RENDER-BOOM');
      return real.renderNotifications(...args);
    }),
  };
});
vi.mock('../../../src/routing/house-lexicon.js', async (orig) => {
  const real = await orig<typeof import('../../../src/routing/house-lexicon.js')>();
  return {
    ...real,
    loadHouseLexicon: vi.fn((...args: Parameters<typeof real.loadHouseLexicon>) => {
      if (seam.lexiconThrows) throw new Error('LEXICON-BOOM');
      return real.loadHouseLexicon(...args);
    }),
  };
});

vi.mock('../../../src/runtime/house-lifecycle/resource-set.js', () => ({
  createHouseStreamFactory: () => ({open: () => ({stop:async()=>{}})}),
}));

import plugin from '../../../src/index.js';

type Service = { id: string; start(ctx?: unknown): Promise<void>; stop?(ctx?: unknown): unknown };
type Hook = (event?: unknown, ctx?: unknown) => unknown;
type Out = { prependContext?: string; appendSystemContext?: string } | undefined;
type Rt = {
  houseRuntime: HouseRuntime;
  notifier: { enqueue(a: unknown): void; count(l?: string): number };
  pendingFollows: {
    absorb(intents: unknown[], opts: unknown): unknown;
    listPending(): { first_surfaced_ts: number | null }[];
    claimSurface(nowSec?: number): number;
  };
};

const OWNER = { trigger: 'user', sessionKey: 'agent:main:main' };
const L2_TEXT = 'L2MARK maintenance tonight';
const FOLLOWEE = '8ZzQkVf3xR5yT7uW9aB2cD4eF6gH1jK3mN5pQ7rS9tU';
const FOLLOWEE_NAME = 'Zedmarker Pendingname';
const ROUTING_PROMPT = 'show me the latest posts';

const roots: string[] = [];
let savedRouting: string | undefined;
beforeEach(() => {
  savedRouting = process.env.POPCLAW_TOOL_ROUTING;
  delete process.env.POPCLAW_TOOL_ROUTING;
});
afterEach(() => {
  if (savedRouting === undefined) delete process.env.POPCLAW_TOOL_ROUTING;
  else process.env.POPCLAW_TOOL_ROUTING = savedRouting;
  clearPerProcess('runtime');
  NewspaperDispatchRegistry.clear();
  roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true }));
  seam.renderThrows = false;
  seam.lexiconThrows = false;
  seam.order.length = 0;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function newState(): string {
  const state = mkdtempSync(join(tmpdir(), 'popclaw-pbh-'));
  roots.push(state);
  mkdirSync(join(state, 'popclaw', 'config'), { recursive: true });
  writeFileSync(join(state, 'popclaw', 'config', 'plugin.json'), JSON.stringify({ lore_houses: ['http://127.0.0.1:59999'] }));
  return state;
}

/** A fresh file in the host's inbound media dir → the attachment notice. */
function dropAttachment(state: string): string {
  const dir = join(state, 'media', 'inbound');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'voice-note-marker.ogg');
  writeFileSync(path, 'x'.repeat(2048));
  return path;
}

function registerAt(state: string) {
  const services: Service[] = [];
  const hooks = new Map<string, Hook>();
  const logs: string[] = [];
  const log = (message: unknown) => { logs.push(String(message)); };
  const api = {
    registrationMode: 'full', config: {}, pluginConfig: {},
    logger: { debug: log, info: log, warn: log, error: log },
    runtime: {
      state: { resolveStateDir: () => state },
      system: { enqueueSystemEvent: vi.fn(), runHeartbeatOnce: vi.fn() },
    },
    registerCommand: vi.fn(), registerTool: vi.fn(), registerInteractiveHandler: vi.fn(),
    registerService: (service: Service) => services.push(service),
    on: (name: string, hook: Hook) => hooks.set(name, hook),
  };
  plugin.register!(api as unknown as Parameters<NonNullable<typeof plugin.register>>[0]);
  const svc = (id: string) => services.find(s => s.id === id)!;
  return {
    svc, logs,
    turn: (prompt: string, ctx: unknown) => hooks.get('before_prompt_build')!({ prompt }, ctx) as Out,
    gatewayStop: () => hooks.get('gateway_stop')!() as Promise<void>,
  };
}

const offline = () => {
  const house = mintHouse({origin:HOUSE,manifest:{read_auth:{schemes:['popclaw-identity-read-v2']}}});
  vi.stubGlobal('fetch',vi.fn(async(input:RequestInfo|URL)=>{
    if(new URL(input instanceof Request?input.url:String(input)).origin!==HOUSE)throw new Error('UNEXPECTED_NETWORK');
    return house.fetch(input);
  }));
};

async function boot(state: string, joinHouse = true) {
  const root = registerAt(state);
  await root.svc('popclaw-runtime').start();
  const rt = await getOrCreatePerProcess<Promise<Rt>>('runtime', () => { throw new Error('runtime should be memoized'); });
  if (joinHouse) expect(await rt.houseRuntime.commands.loginHouse(HOUSE)).toMatchObject({admission:'configured'});
  return { root, rt };
}

const HOUSE = 'http://127.0.0.1:59999';
/** The doorbell enqueues through notifierForOrigin(rt.notifier, loreHouseUrl), so real rows carry houseOrigin. */
const enqueueFollowIntent = (rt: Rt) =>
  rt.notifier.enqueue({ level: 'L2', kind: 'follow_intent', payload: { count: 1, houseOrigin: HOUSE } });

const enqueueNotice = (rt: Rt) =>
  rt.notifier.enqueue({ level: 'L2', kind: 'system_notice', payload: { text: L2_TEXT } });

function addPendingFollow(rt: Rt) {
  const now = Date.now();
  rt.pendingFollows.absorb(
    [{ owner_popclaw_id: 'owner', followee_popclaw_id: FOLLOWEE, followee_label: FOLLOWEE_NAME, first_ts: now, latest_ts: now, click_count: 1 }],
    {
      authors: new Map([[FOLLOWEE, { display_name: FOLLOWEE_NAME, descriptor: null, issue_date: '2026-09-28' }]]),
      followsIn: () => false,
    },
  );
}

const linesWith = (logs: string[], needle: string) => logs.filter(l => l.includes(needle));

describe('before_prompt_build through the real root (characterization)', () => {
  it('an unjoined configured House cannot render or claim its queued follow intent', async () => {
    offline();
    const {root,rt}=await boot(newState(),false);
    enqueueFollowIntent(rt);
    const claim=vi.spyOn(rt.pendingFollows,'claimSurface');
    const out=root.turn(ROUTING_PROMPT,OWNER);
    expect(out?.prependContext ?? '').not.toContain('[L2]');
    expect(rt.notifier.count('L2')).toBe(1);
    expect(claim).not.toHaveBeenCalled();
    expect(seam.order).toEqual([]);
    await root.gatewayStop();
  },30_000);

  it('owner turn: prependContext is notice → L2 block → pending-follows block → routing hit, and L2 drains 1→0', async () => {
    offline();
    const state = newState();
    const { root, rt } = await boot(state);
    const file = dropAttachment(state);
    enqueueNotice(rt);
    addPendingFollow(rt);
    const before = rt.notifier.count('L2');

    const out = root.turn(ROUTING_PROMPT, OWNER);
    const after = rt.notifier.count('L2');
    const surfaced = rt.pendingFollows.listPending().map(r => r.first_surfaced_ts);
    await root.gatewayStop();

    const pc = out?.prependContext ?? '';
    const idx = {
      notice: pc.indexOf(file),
      l2: pc.indexOf('[L2] system notice'),
      pending: pc.indexOf(FOLLOWEE_NAME),
      routing: pc.indexOf('popclaw_show_feed'),
    };
    expect({ before, after }).toEqual({ before: 1, after: 0 });
    expect(Object.values(idx).every(i => i >= 0)).toBe(true);
    expect(idx.notice).toBeLessThan(idx.l2);
    expect(idx.l2).toBeLessThan(idx.pending);
    expect(idx.pending).toBeLessThan(idx.routing);
    // Parts are joined with '\n' and nothing else; the L1 block rides separately.
    expect(pc.startsWith('The owner just handed you these files')).toBe(true);
    expect(typeof out?.appendSystemContext).toBe('string');
    expect(linesWith(root.logs, 'popclaw: L2 handed off')).toEqual(['popclaw: L2 handed off n=1 trigger=user']);
    // system_notice is not follow_intent, so no doorbell claim; pending block is the un-surfaced "full" list.
    expect(linesWith(root.logs, 'doorbell L2 claimed')).toEqual([]);
    expect(linesWith(root.logs, 'doorbell injection mode=')).toEqual(['popclaw: doorbell injection mode=full n=1']);
    expect(surfaced).toEqual([null]);
  }, 30_000);

  it('non-owner turns (cron trigger, subagent session): no drain, no claim, no pending block; "L2 held" logged', async () => {
    offline();
    const state = newState();
    const { root, rt } = await boot(state);
    enqueueNotice(rt);
    enqueueFollowIntent(rt);
    addPendingFollow(rt);
    const claim = vi.spyOn(rt.pendingFollows, 'claimSurface');

    const cron = root.turn(ROUTING_PROMPT, { trigger: 'cron', sessionKey: 'agent:main:main' });
    const sub = root.turn(ROUTING_PROMPT, { trigger: 'user', sessionKey: 'agent:main:subagent:abc' });
    const noCtx = root.turn(ROUTING_PROMPT, undefined);
    const after = rt.notifier.count('L2');
    const surfaced = rt.pendingFollows.listPending().map(r => r.first_surfaced_ts);
    await root.gatewayStop();

    for (const out of [cron, sub, noCtx]) {
      expect(out?.prependContext).not.toContain('[L2]');
      expect(out?.prependContext).not.toContain(FOLLOWEE_NAME);
      expect(out?.prependContext).toContain('popclaw_show_feed');
    }
    expect(after).toBe(2);
    expect(claim).not.toHaveBeenCalled();
    expect(seam.order).toEqual([]);
    expect(surfaced).toEqual([null]);
    // One held line per non-owner turn; ctx undefined logs trigger=?.
    expect(linesWith(root.logs, 'L2 held')).toEqual([
      "popclaw: L2 held n=2 trigger=cron (not the owner's turn)",
      "popclaw: L2 held n=2 trigger=user (not the owner's turn)",
      "popclaw: L2 held n=2 trigger=? (not the owner's turn)",
    ]);
    expect(linesWith(root.logs, 'handed off')).toEqual([]);
  }, 30_000);

  it('presentation scope: a follow_intent row WITHOUT houseOrigin is invisible to the leg (not drained, not held, stays queued)', async () => {
    offline();
    const state = newState();
    const { root, rt } = await boot(state);
    rt.notifier.enqueue({ level: 'L2', kind: 'follow_intent', payload: { count: 1 } });

    const out = root.turn('hello there', OWNER);
    const cron = root.turn('hello there', { trigger: 'cron' });
    const after = rt.notifier.count('L2');
    await root.gatewayStop();

    expect(after).toBe(1);
    expect(out?.prependContext ?? '').not.toContain('[L2]');
    expect(cron?.prependContext ?? '').not.toContain('[L2]');
    expect(seam.order).toEqual([]);
    expect(linesWith(root.logs, 'L2 held')).toEqual([]);
    expect(linesWith(root.logs, 'handed off')).toEqual([]);
  }, 30_000);

  it('render failure: live items are re-queued, claim is skipped, and the rest of the context still returns', async () => {
    offline();
    const state = newState();
    const { root, rt } = await boot(state);
    const file = dropAttachment(state);
    enqueueFollowIntent(rt);
    addPendingFollow(rt);
    const claim = vi.spyOn(rt.pendingFollows, 'claimSurface');
    seam.renderThrows = true;

    const out = root.turn(ROUTING_PROMPT, OWNER);
    const after = rt.notifier.count('L2');
    await root.gatewayStop();

    const pc = out?.prependContext ?? '';
    expect(after).toBe(1);
    expect(claim).not.toHaveBeenCalled();
    expect(linesWith(root.logs, 'L2 handoff re-queued')).toEqual([
      'popclaw: L2 handoff re-queued n=1 — Error: RENDER-BOOM trigger=user',
    ]);
    expect(pc).not.toContain('[L2]');
    expect(pc).toContain(file);
    expect(pc).toContain(FOLLOWEE_NAME);
    expect(pc).toContain('popclaw_show_feed');
    expect(typeof out?.appendSystemContext).toBe('string');
    // Unclaimed → pending block stays in "full" mode.
    expect(linesWith(root.logs, 'doorbell injection mode=')).toEqual(['popclaw: doorbell injection mode=full n=1']);
    expect(linesWith(root.logs, 'routing hook failed')).toEqual([]);
  }, 30_000);

  it('doorbell: follow_intent is claimed after render; the pending block then reads the claimed (pointer) state', async () => {
    offline();
    const state = newState();
    const { root, rt } = await boot(state);
    enqueueFollowIntent(rt);
    addPendingFollow(rt);
    const realClaim = rt.pendingFollows.claimSurface.bind(rt.pendingFollows);
    vi.spyOn(rt.pendingFollows, 'claimSurface').mockImplementation((...a) => { seam.order.push('claim'); return realClaim(...a); });

    const out = root.turn('hello there', OWNER);
    const after = rt.notifier.count('L2');
    const surfaced = rt.pendingFollows.listPending().map(r => r.first_surfaced_ts);
    await root.gatewayStop();

    expect(seam.order).toEqual(['render', 'claim']);
    expect(after).toBe(0);
    expect(surfaced).toEqual([expect.any(Number)]);
    expect(linesWith(root.logs, 'doorbell L2 claimed')).toEqual(['popclaw: doorbell L2 claimed batch n=1']);
    expect(linesWith(root.logs, 'doorbell injection mode=')).toEqual(['popclaw: doorbell injection mode=pointer n=1']);
    const pc = out?.prependContext ?? '';
    expect(pc.indexOf('[L2]')).toBeGreaterThanOrEqual(0);
    expect(pc.indexOf('[L2]')).toBeLessThan(pc.indexOf(FOLLOWEE_NAME));
  }, 30_000);

  it('doorbell: a claim that throws is logged, the rendered L2 block is kept once and NOT re-queued', async () => {
    offline();
    const state = newState();
    const { root, rt } = await boot(state);
    enqueueFollowIntent(rt);
    addPendingFollow(rt);
    vi.spyOn(rt.pendingFollows, 'claimSurface').mockImplementation(() => { throw new Error('CLAIM-BOOM'); });

    const out = root.turn('hello there', OWNER);
    const after = rt.notifier.count('L2');
    await root.gatewayStop();

    const pc = out?.prependContext ?? '';
    expect(after).toBe(0);
    expect(pc.split('[L2]').length - 1).toBe(1);
    expect(linesWith(root.logs, 'doorbell L2 claim failed')).toEqual([
      'popclaw: doorbell L2 claim failed (timer leg may ask again) — Error: CLAIM-BOOM',
    ]);
    expect(linesWith(root.logs, 'L2 handed off')).toEqual(['popclaw: L2 handed off n=1 trigger=user']);
    expect(linesWith(root.logs, 're-queued')).toEqual([]);
    // Unclaimed → the pending block still shows the full list.
    expect(linesWith(root.logs, 'doorbell injection mode=')).toEqual(['popclaw: doorbell injection mode=full n=1']);
    expect(pc).toContain(FOLLOWEE_NAME);
  }, 30_000);

  it('routing off: no L1/L2 routing text, but the attachment notice (and the L2 leg) still inject', async () => {
    offline();
    process.env.POPCLAW_TOOL_ROUTING = 'off';
    const state = newState();
    const { root, rt } = await boot(state);
    const file = dropAttachment(state);
    enqueueNotice(rt);

    const out = root.turn(ROUTING_PROMPT, OWNER);
    const after = rt.notifier.count('L2');
    await root.gatewayStop();

    expect(linesWith(root.logs, 'routing off')).toEqual([expect.stringMatching(/^popclaw: routing off \(POPCLAW_TOOL_ROUTING=off\) · trace=/)]);
    expect(out?.appendSystemContext).toBeUndefined();
    const pc = out?.prependContext ?? '';
    expect(pc).toContain(file);
    expect(pc).not.toContain('popclaw_show_feed');
    expect(pc.indexOf(file)).toBeLessThan(pc.indexOf('[L2] system notice'));
    expect(after).toBe(0);
    expect(Object.keys(out ?? {})).toEqual(['prependContext']);
  }, 30_000);

  it('outer catch: a dependency throwing before the drain returns undefined, logs the non-fatal line, queue unchanged', async () => {
    offline();
    const state = newState();
    const { root, rt } = await boot(state);
    dropAttachment(state);
    enqueueNotice(rt);
    seam.lexiconThrows = true;

    let thrown: unknown;
    let out: Out = { prependContext: 'sentinel' };
    try { out = root.turn(ROUTING_PROMPT, OWNER); } catch (e) { thrown = e; }
    const after = rt.notifier.count('L2');
    await root.gatewayStop();

    expect({ thrown, out, after }).toEqual({ thrown: undefined, out: undefined, after: 1 });
    expect(linesWith(root.logs, 'routing hook failed')).toEqual([
      'popclaw[warn]: popclaw: routing hook failed (non-fatal): Error: LEXICON-BOOM',
    ]);
    expect(seam.order).toEqual([]);
  }, 30_000);

  it('slot freshness: turns before / during boot skip L2 and never boot the runtime; the first turn after boot delivers', async () => {
    offline();
    const state = newState();
    // Queue a notice on disk from a previous lifecycle on the same data root.
    {
      const { root, rt } = await boot(state);
      enqueueNotice(rt);
      await root.gatewayStop();
      clearPerProcess('runtime');
    }
    const root = registerAt(state);
    const buildLines = () => linesWith(root.logs, 'popclaw: build ').length;

    const beforeStart = root.turn('hello there', OWNER);
    const buildsAfterEarlyTurn = buildLines();
    const starting = root.svc('popclaw-runtime').start();
    const duringBoot = root.turn('hello there', OWNER);
    await starting;
    const rt = await getOrCreatePerProcess<Promise<Rt>>('runtime', () => { throw new Error('runtime should be memoized'); });
    const queuedAfterBoot = rt.notifier.count('L2');
    const afterBoot = root.turn('hello there', OWNER);
    const after = rt.notifier.count('L2');
    await root.gatewayStop();

    expect(buildsAfterEarlyTurn).toBe(0);
    expect(beforeStart?.prependContext ?? '').not.toContain('[L2]');
    expect(duringBoot?.prependContext ?? '').not.toContain('[L2]');
    // L1 still rides on the early turns: only the L2 / pending passengers wait for boot.
    expect(typeof beforeStart?.appendSystemContext).toBe('string');
    expect(buildLines()).toBe(1);
    expect(queuedAfterBoot).toBe(1);
    expect(afterBoot?.prependContext).toContain('[L2] system notice');
    expect(after).toBe(0);
    expect(linesWith(root.logs, 'L2 held')).toEqual([]);
  }, 60_000);
});
