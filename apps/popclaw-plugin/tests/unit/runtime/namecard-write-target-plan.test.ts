/**
 * One namecard write = one captured target plan (in-process entry points).
 *
 * A house holds the Profile as a whole-row upsert, so the pre-write guard has
 * to read every house the signed card will actually be sent to. The guard
 * used to read the configured houses only, while the broadcast went to every
 * house mounted on the runtime's egress — including one joined by
 * `/popclaw login` (or reloaded from persisted participation) before the
 * command started.
 *
 * Real HouseRuntime (resident owner, command bus, participation gates,
 * MultiHouseEgress), the real slash handlers from buildSubcommands (`login`,
 * `logout`, `name`, `start`, `next`, including the runCommand wrap), the real
 * onboarding orchestrator, real fetch against loopback houses. Only the stream
 * factory is stubbed, as in house-runtime-push.test.ts.
 *
 * Attribution: every Profile POST is decoded, and only POSTs carrying THIS
 * command's declaration (the new nickname, declaredAt and validated CID,
 * arriving inside the call window)
 * are counted as the command's sends. Every "zero POSTs to H2" assertion is
 * paired with a positive control in the same run.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { popclaw } from '@popclaw/contracts';
import { ackSigningInput, canonicalizeEnvelope, cidFromCanonical } from '@popclaw/algorithms';
import { runMigrations } from '../../../src/host/migrations.js';
import { fileURLToPath } from 'node:url';
import { InMemoryHostDb } from '../../../src/host/in-memory-host-db.js';
import { InMemoryHostAdapter } from '../../../src/host/host-adapter.in-memory.js';
import {mintHouse} from '../../helpers/signed-manifest.js';
import {localParticipationPort} from '../../../src/host/local-participation.js';
import { HouseRuntime } from '../../../src/runtime/house-lifecycle/house-runtime.js';
import type { HostAdapter } from '../../../src/host/host-adapter.js';
import type { Signer } from '../../../src/identity/signer.js';
import { refusingReadAuthorityFor } from '../../helpers/read-authority.js';
import { buildSubcommands, type SubcommandWiring } from '../../../src/commands/wiring.js';
import { readParticipation } from '../../../src/runtime/house-lifecycle/participation-store.js';
import { OnboardingStateRepository } from '../../../src/onboarding/state-repository.js';
import { OnboardingStateMachine } from '../../../src/onboarding/state-machine.js';
import { SqliteNotifier } from '../../../src/notifier/sqlite-notifier.js';
import { OnboardingOrchestrator } from '../../../src/onboarding/orchestrator.js';
import { SessionContextIndex } from '../../../src/onboarding/context-index.js';
import { hostDbSlug } from '../../../src/ingress/host-slug.js';
import { MultiHouseEgress } from '../../../src/egress/multi-house-egress.js';
import { captureNamecardWritePlan, guardNamecardWritePlan } from '../../../src/messaging/namecard-write-guard.js';
import { runPopclawNameCommand } from '../../../src/commands/popclaw-name.js';

vi.mock('../../../src/runtime/house-lifecycle/resource-set.js', () => ({
  createHouseStreamFactory: () => ({ open: () => ({ stop: async () => {} }) }),
}));

const hsNs = (popclaw as unknown as { housesession: {
  HouseSessionRequest: { decode(b: Uint8Array): { core: Record<string, unknown> } };
  HouseSessionAck: { encode(m: unknown): { finish(): Uint8Array } };
} }).housesession;

const ID_KEY = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(0x33));
const POPCLAW_ID = bs58.encode(ID_KEY.publicKey);
const signer = {
  publicKey: async () => ID_KEY.publicKey,
  popclawId: async () => POPCLAW_ID,
  sign: async (b: Uint8Array) => nacl.sign.detached(b, ID_KEY.secretKey),
} as unknown as Signer;

const LEAVE = 3;
const CLOSED = 4;
const ENTERED = 1;

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const f of cleanup.splice(0).reverse()) await f(); });

function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }

interface ProfilePost { at: number; nickname: string; declaredAt: string; eventId: string }

/**
 * One loopback house. `session: true` serves a house_session board and
 * answers signed acks, so an explicit login really connects. `avatar` is the
 * card this house already holds for the identity (non-empty = a field this
 * client cannot re-emit, which the guard must protect).
 */
async function house(opts: { session: boolean; avatar: string; seed: number; holdProfile?: { arrived: () => void; release: Promise<void> } }) {
  const log: Array<{ at: number; line: string }> = [];
  const posts: ProfilePost[] = [];
  const kp = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(opts.seed));
  const ackHex = Buffer.from(kp.publicKey).toString('hex');
  let projection = { nickname: 'OldName', one_line_intro: '', taste_tags: [] as string[], role_persona: '',
    location_hint: '', avatar_uri: opts.avatar, declared_at_ms: 1, payout_addresses: [] };
  const server = createServer(async (req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    log.push({ at: Date.now(), line: `${req.method} ${path}` });
    const body = async () => { const c: Buffer[] = []; for await (const x of req) c.push(Buffer.from(x)); return Buffer.concat(c); };
    if (path === '/v1/manifest') {
      res.writeHead(200, { 'content-type': 'application/json','X-Popclaw-Manifest-Proof':signedManifest.proofHeader });
      res.end(Buffer.from(signedManifest.bodyBytes));
      return;
    }
    if (path === '/v1/house-session' && opts.session) {
      const core = hsNs.HouseSessionRequest.decode(await body()).core;
      const now = Math.floor(Date.now() / 1000);
      const leaving = core.operation === LEAVE;
      const ack = { houseOrigin: core.houseOrigin, popclawId: core.popclawId, installationId: core.installationId,
        requestId: core.requestId, opSeq: core.opSeq, operation: core.operation, outcome: leaving ? CLOSED : ENTERED, houseRevision: 1,
        sessionId: 'h2-session', sessionActive: !leaving, leaseExpiresAt: leaving ? 0 : now + 3600, serverCommittedAt: now,
        inboxReadToken: leaving ? '' : 't' };
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end(Buffer.from(hsNs.HouseSessionAck.encode({ core: ack,
        signature: nacl.sign.detached(ackSigningInput(ack), kp.secretKey), signerPubkey: kp.publicKey }).finish()));
      return;
    }
    if (path.startsWith('/v1/profile/')) {
      if (opts.holdProfile) { opts.holdProfile.arrived(); await opts.holdProfile.release; }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ popclaw_id: decodeURIComponent(path.slice(12)), sigil: 's', profiles: [],
        house_follower_count: 0, house_post_count: 0, house_reply_received_count: 0,
        card: projection }));
      return;
    }
    if (path === '/v1/push') {
      const signed = popclaw.identity.SignedPayload.decode(await body());
      const env = popclaw.event.EventEnvelope.toObject(popclaw.event.EventEnvelope.decode(signed.payload), { defaults: false, longs: String }) as Record<string, unknown>;
      const profile = env['profile'] as Record<string, unknown> | undefined;
      const eventId = String(env['eventId']);
      expect(eventId).toBe(cidFromCanonical(canonicalizeEnvelope(env)));
      if (profile) {
        posts.push({ at: Date.now(), nickname: String(profile['nickname'] ?? ''), declaredAt: String(profile['declaredAt'] ?? ''), eventId });
        projection = {...projection, nickname: String(profile['nickname'] ?? ''),
          one_line_intro: String(profile['oneLineIntro'] ?? ''), declared_at_ms: Number(profile['declaredAt']) * 1000};
      }
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ event_id: eventId }));
      return;
    }
    res.writeHead(404); res.end('{}');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const signedManifest=mintHouse({origin,seed:opts.seed,manifest:{house:{name:'f',slug:'f'},core_primitives:{profile:true},
    ...(opts.session?{house_session:{version:1,endpoint:'/v1/house-session',ack_pubkey:ackHex,operations:['enter','renew','leave','status'],lease_seconds:3600,renew_interval_seconds:1800}}:{})}});
  return {
    origin, log, posts,
    lines: (from = 0) => log.slice(from).map(l => l.line),
    profileGets: (from = 0) => log.slice(from).filter(l => l.line.startsWith('GET /v1/profile/')),
  };
}

type House = Awaited<ReturnType<typeof house>>;

/** The command's own declaration: Profile POSTs with the new nickname inside [t0, t1]. */
function declaration(h: House, nickname: string, t0: number, t1: number): ProfilePost[] {
  return h.posts.filter(p => p.nickname === nickname && p.at >= t0 && p.at <= t1);
}

function newOrchestrator(host: InMemoryHostAdapter, rt: { egress: HouseRuntime['egress'] }, configured: string[], fetchFn: typeof fetch) {
  const repo = new OnboardingStateRepository(host.db);
  return new OnboardingOrchestrator({
    stateMachine: new OnboardingStateMachine(repo),
    notifier: new SqliteNotifier(host.db),
    presenter: { present: async () => {} },
    identity: { popclawId: POPCLAW_ID },
    host,
    signer,
    egress: rt.egress,
    houseOrigins: configured,
    fetch: fetchFn,
    llm: null,
    tasteRoot: join(tmpdir(), `popclaw-taste-untouched-${Date.now()}`),
    readOwnerPersona: async () => undefined,
    fetchVerifiedHandles: async () => [],
    guideClient: { fetchGuideText: async () => null },
    summaryClient: { fetchSummary: async () => null },
    snapshotClient: { fetchSnapshot: async () => [] },
    tasteLoader: { enabledSources: async () => [] },
    learnedWriter: { appendPick: async () => {} },
    markService: { mark: async () => ({ pushed: true }) },
    contextIndex: new SessionContextIndex(),
    webBaseUrl: configured[0]!,
  });
}

async function root(h1: string, opts: { db?: InMemoryHostDb; nickname?: string; commandSigner?: Signer } = {}) {
  const db = opts.db ?? new InMemoryHostDb();
  runMigrations(db, fileURLToPath(new URL('../../../migrations', import.meta.url)));
  if (!opts.db) cleanup.push(() => db.close());
  const warnings: string[] = [];
  const houses = new HouseRuntime({ readAuthorityFor: refusingReadAuthorityFor, db, signer, origins: [h1],actorId:POPCLAW_ID,participation:localParticipationPort(()=>undefined),
    commandTimeoutMs: 5000, commandPollMs: 2, log: m => warnings.push(m) });
  houses.configureResources({ stores: [], host: {} as HostAdapter, recipientPopclawId: POPCLAW_ID, worldStreamMode: false,
    openStore: async () => { throw new Error('unused'); }, isOfficialActor: () => false });
  let stopped = false;
  const stop = async () => { if (!stopped) { stopped = true; await houses.stop(); } };
  cleanup.push(stop);
  houses.start();
  expect(await houses.commands.loginHouse(h1)).toMatchObject({admission:'configured'});
  const host = new InMemoryHostAdapter({ config: { plugin: { lore_houses: [h1],
    ranger_profile: { nickname: opts.nickname ?? 'OldName', name_source: 'owner' } } } });
  const rt: Record<string, unknown> = { host, houseRuntime: houses, egress: houses.egress,
    boot: { signer: opts.commandSigner ?? signer, popclawId: POPCLAW_ID, loreHouseUrls: [h1], webBaseUrl: h1 } };
  rt['orchestrator'] = newOrchestrator(host, houses, [h1], houses.fetchHouse);
  const boom = () => { throw new Error('unused'); };
  const slash = buildSubcommands({ runtime: async () => rt, getHouseCommandContext: () => ({ coordinator: () => houses.commands, lang: () => 'en' }),
    paths: boom, picksFile: boom, warn: boom, llmComplete: boom, toolsRegisteredCount: boom, buildStamp: 'test' } as unknown as SubcommandWiring);
  const run = async (name: 'login' | 'logout' | 'name' | 'start' | 'next', ...positional: string[]) =>
    ((await slash[name]({ args: { positional } } as never)) as { text: string }).text;
  return { db, houses, run, warnings, stop };
}

describe('slash /popclaw name — the guard reads exactly the houses the card is sent to', () => {
  it('H2 joined by /popclaw login before the command, holding a protected field: zero POSTs of the declaration to H2', async () => {
    const h1 = await house({ session: false, avatar: '', seed: 7 });
    const h2 = await house({ session: true, avatar: 'https://h2.invalid/a.png', seed: 9 });
    const r = await root(h1.origin);
    await r.run('login', h2.origin);
    expect(readParticipation(r.db, h2.origin)).toMatchObject({ desired: 'enabled', phase: 'connected' });
    const g1 = h1.log.length, g2 = h2.log.length;
    const t0 = Date.now();
    const text = await r.run('name', 'NewName');
    const t1 = Date.now();
    // Positive control: the recorder sees this command's traffic (the H1 read).
    expect(h1.profileGets(g1)).toHaveLength(1);
    // Nothing of this declaration reaches H2 (and, fail closed, nowhere else either).
    expect(declaration(h2, 'NewName', t0, t1)).toEqual([]);
    expect(h2.lines(g2)).not.toContain('POST /v1/push');
    // H2 was read by this command: that read is what refused the write.
    expect(h2.profileGets(g2)).toHaveLength(1);
    expect(declaration(h1, 'NewName', t0, t1)).toEqual([]);
    // The honest message: saved locally, not issued, which house and why.
    expect(text).toContain('NewName');
    expect(text).toContain(h2.origin);
    expect(text).toContain('avatar_uri');
  }, 30_000);

  it('H2 reloaded from persisted participation (restart after login), protected field: zero POSTs to H2', async () => {
    const h1 = await house({ session: false, avatar: '', seed: 7 });
    const h2 = await house({ session: true, avatar: 'https://h2.invalid/a.png', seed: 9 });
    const db = new InMemoryHostDb();
    cleanup.push(() => db.close());
    const first = await root(h1.origin, { db });
    await first.run('login', h2.origin);
    expect(readParticipation(db, h2.origin)).toMatchObject({ desired: 'enabled', phase: 'connected' });
    await first.stop();
    // Same data root, configured houses still [H1]: H2 comes back from persistence only.
    const r = await root(h1.origin, { db });
    expect(r.houses.egress.slugs()).toContain(hostDbSlug(h2.origin));
    const g1 = h1.log.length, g2 = h2.log.length;
    const t0 = Date.now();
    const text = await r.run('name', 'NewName');
    const t1 = Date.now();
    expect(h1.profileGets(g1)).toHaveLength(1);
    expect(declaration(h2, 'NewName', t0, t1)).toEqual([]);
    expect(h2.lines(g2)).not.toContain('POST /v1/push');
    expect(h2.profileGets(g2)).toHaveLength(1);
    expect(text).toContain(h2.origin);
  }, 30_000);

  it('both houses clean: the name is issued to H1 and H2, each read before it is written', async () => {
    const h1 = await house({ session: false, avatar: '', seed: 7 });
    const h2 = await house({ session: true, avatar: '', seed: 9 });
    const r = await root(h1.origin);
    await r.run('login', h2.origin);
    const g2 = h2.log.length;
    const t0 = Date.now();
    const text = await r.run('name', 'NewName');
    const t1 = Date.now();
    const d1 = declaration(h1, 'NewName', t0, t1), d2 = declaration(h2, 'NewName', t0, t1);
    expect(d1).toHaveLength(1);
    expect(d2).toHaveLength(1);
    expect(d2[0]!.declaredAt).toBe(d1[0]!.declaredAt);
    expect(d2[0]!.eventId).toBe(d1[0]!.eventId);
    // H2 was read by this command before it was written.
    const h2Gets = h2.profileGets(g2);
    expect(h2Gets).toHaveLength(2);
    const h2Get = h2Gets[0];
    expect(h2Get).toBeDefined();
    expect(h2Get!.at).toBeLessThanOrEqual(d2[0]!.at);
    expect(h2Gets[1]!.at).toBeGreaterThanOrEqual(d2[0]!.at);
    // Publication now includes each House's exact public readback.
    expect(text).toMatch(/NewName/);
    expect(text).toContain(h2.origin);
    expect(text).toContain('confirmed');
    expect(r.warnings.join('\n')).not.toMatch(/broadcast to .* (failed|rejected)/);
  }, 30_000);
});

describe('houses joining or leaving DURING the command do not bypass participation protection', () => {
  it('H2 joins while signing: the original plan still reads and sends only H1', async () => {
    const held = deferred(), release = deferred();
    const h1 = await house({ session: false, avatar: '', seed: 7 });
    const h2 = await house({ session: true, avatar: 'https://h2.invalid/a.png', seed: 9 });
    const commandSigner = { ...signer, sign: async (bytes: Uint8Array) => {
      held.resolve(); await release.promise; return signer.sign(bytes);
    } };
    const r = await root(h1.origin, { commandSigner });
    const t0 = Date.now();
    const rename = r.run('name', 'NewName');
    await held.promise;
    await r.run('login', h2.origin);
    const g2 = h2.log.length;
    release.resolve();
    await rename;
    expect(declaration(h1, 'NewName', t0, Date.now())).toHaveLength(1);
    expect(h2.lines()).toContain('POST /v1/house-session');
    expect(h2.lines(g2)).toEqual([]);
    expect(r.warnings.join('\n')).not.toMatch(/broadcast to .* failed/);
  }, 30_000);

  it('H2 joins while the guard is reading: H2 is outside the captured plan — no read, no send attempt, no POST', async () => {
    const held = deferred(), release = deferred();
    const h1 = await house({ session: false, avatar: '', seed: 7, holdProfile: { arrived: held.resolve, release: release.promise } });
    const h2 = await house({ session: true, avatar: 'https://h2.invalid/a.png', seed: 9 });
    const r = await root(h1.origin);
    const t0 = Date.now();
    const rename = r.run('name', 'NewName');
    await held.promise;
    await r.run('login', h2.origin);
    expect(readParticipation(r.db, h2.origin)).toMatchObject({ desired: 'enabled', phase: 'connected' });
    expect(r.houses.egress.slugs()).toHaveLength(2);
    const g2 = h2.log.length;
    release.resolve();
    await rename;
    const t1 = Date.now();
    // Positive controls: H1 got this declaration; H2's recorder saw the login.
    expect(declaration(h1, 'NewName', t0, t1)).toHaveLength(1);
    expect(h2.lines()).toContain('POST /v1/house-session');
    expect(declaration(h2, 'NewName', t0, t1)).toEqual([]);
    expect(h2.lines(g2)).toEqual([]);
    // The plan was captured before H2 joined, so no send to H2 was even attempted.
    expect(r.warnings.join('\n')).not.toContain(hostDbSlug(h2.origin));
  }, 30_000);

  it('H2 leaves while the guard is reading: the send-time participation gate still refuses H2', async () => {
    const held = deferred(), release = deferred();
    const h1 = await house({ session: false, avatar: '', seed: 7, holdProfile: { arrived: held.resolve, release: release.promise } });
    const h2 = await house({ session: true, avatar: '', seed: 9 });
    const r = await root(h1.origin);
    await r.run('login', h2.origin);
    const t0 = Date.now();
    const rename = r.run('name', 'NewName');
    await held.promise;
    await r.run('logout', h2.origin);
    expect(readParticipation(r.db, h2.origin)?.desired).not.toBe('enabled');
    release.resolve();
    await rename;
    const t1 = Date.now();
    expect(declaration(h1, 'NewName', t0, t1)).toHaveLength(1);
    expect(h2.lines()).toContain('POST /v1/house-session');
    expect(declaration(h2, 'NewName', t0, t1)).toEqual([]);
    expect(r.warnings.join('\n')).toMatch(/broadcast to .* failed/);
  }, 30_000);
});

describe('write-plan address evidence', () => {
  it('reads the captured address rather than a different configured path on the same origin', async () => {
    const h1 = await house({ session: false, avatar: '', seed: 7 });
    const egress = MultiHouseEgress.fromUrls([h1.origin]);
    const plan = captureNamecardWritePlan(egress, [`${h1.origin}/obsolete-path`]);
    expect(await guardNamecardWritePlan(plan, { popclawId: POPCLAW_ID })).toEqual({ ok: true });
    expect(h1.lines()).toEqual([`GET /v1/profile/${POPCLAW_ID}`]);
  });

  it('an unknown target address blocks all writes instead of inferring it from the slug', async () => {
    const push = vi.fn(async () => ({ status: 200 }));
    const egress = new MultiHouseEgress([{ slug: 'unknown', egress: { push } }]);
    const fetch = vi.fn();
    const host = new InMemoryHostAdapter();
    const result = await runPopclawNameCommand({ nickname: 'NewName' }, {
      host, signer, egress, popclawId: POPCLAW_ID, clock: host.clock, houseOrigins: [], fetch,
    });
    expect(result.text).toContain('unknown');
    expect(await host.config.loadJson('plugin')).toMatchObject({ ranger_profile: { nickname: 'NewName' } });
    expect(fetch).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });
});

describe('onboarding passport naming through the real /popclaw start + next handlers', () => {
  it('H2 joined before onboarding, holding a protected field: the passport is not issued and H2 gets zero POSTs', async () => {
    const h1 = await house({ session: false, avatar: '', seed: 7 });
    const h2 = await house({ session: true, avatar: 'https://h2.invalid/a.png', seed: 9 });
    const r = await root(h1.origin);
    await r.run('login', h2.origin);
    await r.run('start');
    const g1 = h1.log.length, g2 = h2.log.length, p1 = h1.posts.length;
    const text = await r.run('next');
    // Positive control: this naming read H1.
    expect(h1.profileGets(g1)).toHaveLength(1);
    expect(h2.lines(g2)).not.toContain('POST /v1/push');
    expect(h1.posts.slice(p1)).toEqual([]);
    expect(h2.profileGets(g2)).toHaveLength(1);
    expect(text).toContain(h2.origin);
  }, 30_000);

  it('both houses clean: the passport is issued with one stamp per house', async () => {
    const h1 = await house({ session: false, avatar: '', seed: 7 });
    const h2 = await house({ session: true, avatar: '', seed: 9 });
    const r = await root(h1.origin);
    await r.run('login', h2.origin);
    await r.run('start');
    const g2 = h2.log.length, p1 = h1.posts.length, p2 = h2.posts.length;
    const text = await r.run('next');
    const d1 = h1.posts.slice(p1), d2 = h2.posts.slice(p2);
    expect(d1).toHaveLength(1);
    expect(d2).toHaveLength(1);
    expect(d2[0]!.declaredAt).toBe(d1[0]!.declaredAt);
    expect(d2[0]!.eventId).toBe(d1[0]!.eventId);
    const h2Get = h2.profileGets(g2)[0];
    expect(h2Get).toBeDefined();
    expect(h2Get!.at).toBeLessThanOrEqual(d2[0]!.at);
    expect(text).toContain(hostDbSlug(h1.origin));
    expect(text).toContain(hostDbSlug(h2.origin));
  }, 30_000);
});
