/**
 * One namecard write = one captured target plan, on the real MCP root.
 *
 * `popclaw_set_name` against a spawned `src/mcp.ts` (real bootstrap,
 * HouseRuntime, command bus, resident owner, tools, MultiHouseEgress) and two
 * loopback houses that record every request. Configuration names only H1; H2
 * is joined by `popclaw_house_login` before the rename (and, in one case,
 * reloaded from persisted participation after a restart). A preload refuses
 * any non-loopback connection or DNS lookup and records the attempt.
 *
 * Attribution: boot and login run a per-house namecard self-heal in the
 * background, so the test waits for both houses to go quiet first. A Profile
 * POST counts as the command's send only if it carries THIS declaration (the
 * new nickname, declaredAt and validated CID) inside the call window. The
 * two houses must receive the same CID. The "zero POSTs to H2"
 * checks are stricter: no POST of the new nickname reaches H2 at all, up to
 * one second after the call returned. Every such check has a positive control
 * (the H1 read) in the same run.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import nacl from 'tweetnacl';
import { popclaw } from '@popclaw/contracts';
import { ackSigningInput, canonicalizeEnvelope, cidFromCanonical } from '@popclaw/algorithms';
import { LocalHostDb } from '../../src/host/local-host-db.js';
import { mintHouse, type MintedHouse } from '../helpers/signed-manifest.js';

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const hsNs = (popclaw as unknown as {
  housesession: {
    HouseSessionRequest: { decode(b: Uint8Array): { core: Record<string, unknown> } };
    HouseSessionAck: { encode(m: unknown): { finish(): Uint8Array } };
  };
}).housesession;

interface JsonRpcResponse { jsonrpc: string; id?: number; result?: Record<string, unknown>; error?: { message: string } }

class McpProcess {
  stderr = '';
  private buf = '';
  private readonly pending = new Map<number, (r: JsonRpcResponse) => void>();
  private nextId = 1;
  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.setEncoding('utf-8');
    child.stdout.on('data', (chunk: string) => {
      this.buf += chunk;
      let nl: number;
      while ((nl = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, nl); this.buf = this.buf.slice(nl + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line) as JsonRpcResponse;
        if (typeof msg.id === 'number') this.pending.get(msg.id)?.(msg);
      }
    });
    child.stderr.setEncoding('utf-8');
    child.stderr.on('data', (c: string) => { this.stderr += c; });
  }
  request(method: string, params: unknown = {}): Promise<JsonRpcResponse> {
    const id = this.nextId++;
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error(`timeout: ${method}\nstderr:\n${this.stderr}`)), 45_000);
      this.pending.set(id, (r) => { clearTimeout(t); res(r); });
    });
  }
  async callText(name: string, args: Record<string, unknown> = {}): Promise<string> {
    const res = await this.request('tools/call', { name, arguments: args });
    return ((res.result?.['content'] as Array<{ text: string }> | undefined) ?? []).map((b) => b.text).join('\n');
  }
  notify(method: string, params: unknown = {}): void {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }
}

type Rec = { method: string; path: string; at: number };
type ProfilePost = { at: number; nickname: string; declaredAt: string; eventId: string };

function startHouse(opts: { session: boolean; avatar: string; seed: number }) {
  const requests: Rec[] = [];
  const posts: ProfilePost[] = [];
  const kp = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(opts.seed));
  const ackHex = Buffer.from(kp.publicKey).toString('hex');
  let minted: MintedHouse | undefined;
  const server: Server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    const at = Date.now();
    requests.push({ method: req.method ?? '', path, at });
    if (path === '/v1/manifest' && minted) {
      res.writeHead(200, { 'content-type': 'application/json', 'X-Popclaw-Manifest-Proof': minted.proofHeader });
      res.end(Buffer.from(minted.bodyBytes));
      return;
    }
    if (path === '/v1/house-session' && req.method === 'POST' && opts.session) {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => void chunks.push(c));
      req.on('end', () => {
        const core = hsNs.HouseSessionRequest.decode(Buffer.concat(chunks)).core;
        const now = Math.floor(Date.now() / 1000);
        const ackCore = {
          houseOrigin: core.houseOrigin, popclawId: core.popclawId, installationId: core.installationId,
          requestId: core.requestId, opSeq: core.opSeq, operation: core.operation, outcome: 1,
          houseRevision: 1, sessionId: 'h2-session', sessionActive: true,
          leaseExpiresAt: now + 3600, serverCommittedAt: now, inboxReadToken: 'h2-token',
        };
        const signature = nacl.sign.detached(ackSigningInput(ackCore), kp.secretKey);
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        res.end(Buffer.from(hsNs.HouseSessionAck.encode({ core: ackCore, signature, signerPubkey: kp.publicKey }).finish()));
      });
      return;
    }
    if (path.startsWith('/v1/profile/') && req.method === 'GET') {
      const id = decodeURIComponent(path.slice('/v1/profile/'.length));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        popclaw_id: id, sigil: 'abcd', profiles: [], house_follower_count: 0, house_post_count: 0, house_reply_received_count: 0,
        card: { nickname: 'OldName', one_line_intro: '', taste_tags: [], role_persona: '', location_hint: '',
          avatar_uri: opts.avatar, declared_at_ms: 1_000_000, payout_addresses: [] },
      }));
      return;
    }
    if (path === '/v1/push' && req.method === 'POST') {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => void chunks.push(c));
      req.on('end', () => {
        try {
          const signed = popclaw.identity.SignedPayload.decode(Buffer.concat(chunks));
          const env = popclaw.event.EventEnvelope.decode(signed.payload);
          const obj = popclaw.event.EventEnvelope.toObject(env, { defaults: false, longs: String }) as Record<string, unknown>;
          const profile = obj['profile'] as Record<string, unknown> | undefined;
          const eventId = String(obj['eventId']);
          if (eventId !== cidFromCanonical(canonicalizeEnvelope(obj))) throw new Error('invalid declaration CID');
          if (profile) posts.push({ at, nickname: String(profile['nickname'] ?? ''), declaredAt: String(profile['declaredAt'] ?? ''), eventId });
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ event_id: eventId }));
        } catch {
          res.writeHead(400).end('{}');
        }
      });
      return;
    }
    if (path.includes('stream')) { res.writeHead(200, { 'content-type': 'text/event-stream' }); return; }
    res.writeHead(404).end('{}');
  });
  return {
    requests, posts,
    async listen(): Promise<string> {
      await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
      const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      minted = mintHouse({ origin, seed: opts.seed, manifest: opts.session ? {
        house_session: { version: 1, endpoint: '/v1/house-session', ack_pubkey: ackHex,
          operations: ['enter', 'renew', 'leave', 'status'], lease_seconds: 3600, renew_interval_seconds: 1800 },
      } : {} });
      return origin;
    },
    close() { server.closeAllConnections(); server.close(); },
  };
}

function offlineGuard(dir: string): { guard: string; attempts: string } {
  const attempts = join(dir, 'non-loopback-attempts');
  const guard = join(dir, 'loopback-only.mjs');
  writeFileSync(guard, `import net from 'node:net'; import dns from 'node:dns'; import {appendFileSync} from 'node:fs';
const LOOP = new Set(['127.0.0.1','localhost','::1']);
const deny = (what) => { appendFileSync(${JSON.stringify(attempts)}, String(what) + '\\n'); throw new Error('test forbids non-loopback networking: ' + what); };
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const a = Array.isArray(args[0]) ? args[0][0] : args[0];
  if (typeof a === 'string' || typeof a?.path === 'string') return connect.apply(this, args);
  const host = typeof a === 'object' ? (a.host ?? 'localhost') : (typeof args[1] === 'string' ? args[1] : 'localhost');
  if (!LOOP.has(host)) return deny(host + ':' + (typeof a === 'object' ? a.port : a));
  return connect.apply(this, args);
};
const lookup = dns.lookup;
dns.lookup = function (host, ...rest) { if (!LOOP.has(host)) return deny('dns:' + host); return lookup.call(this, host, ...rest); };
`);
  return { guard, attempts };
}

const cleanup: Array<() => void> = [];
afterEach(() => { for (const f of cleanup.splice(0).reverse()) f(); });

async function scenario(opts: { h2Avatar: string; restartAfterLogin?: boolean }) {
  const h1 = startHouse({ session: false, avatar: '', seed: 7 });
  const h2 = startHouse({ session: true, avatar: opts.h2Avatar, seed: 9 });
  const o1 = await h1.listen(); const o2 = await h2.listen();
  cleanup.push(() => h1.close(), () => h2.close());
  const dir = mkdtempSync(join(tmpdir(), 'namecard-plan-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const dataRoot = join(dir, 'data');
  mkdirSync(join(dataRoot, 'config', 'cadence'), { recursive: true });
  writeFileSync(join(dataRoot, 'config', 'plugin.json'), JSON.stringify({
    lore_houses: [o1],
    ranger_profile: { nickname: 'OldName', name_source: 'owner' },
  }));
  writeFileSync(join(dataRoot, 'config', 'cadence', 'cadence.json'), JSON.stringify({ schemaVersion: 1, delivery: { primaryLanguage: 'en' } }));
  const { guard, attempts } = offlineGuard(dir);
  mkdirSync(join(dir, 'home'), { recursive: true });
  const boot = async () => {
    const child = spawn(process.execPath, ['--import', guard, '--import', 'tsx', join(pkgRoot, 'src', 'mcp.ts')], {
      cwd: pkgRoot,
      env: { PATH: process.env.PATH ?? '', HOME: join(dir, 'home'), TMPDIR: dir, LANG: 'en_US.UTF-8', POPCLAW_LANG: 'en',
        POPCLAW_DATA_ROOT: dataRoot, POPCLAW_CANVAS_BASE_URL: o1, POPCLAW_WEB_BASE_URL: o1 },
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams;
    const m = new McpProcess(child);
    // Only the process this test spawned, by its own handle.
    cleanup.push(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
    const init = await m.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'vitest', version: '0' } });
    expect(init.result?.['serverInfo']).toMatchObject({ name: 'popclaw' });
    m.notify('notifications/initialized');
    await m.request('tools/call', { name: 'popclaw_check_status', arguments: {} });
    return { m, child };
  };
  let { m: mcp, child } = await boot();
  await mcp.callText('popclaw_house_login', { host: o2 });
  if (opts.restartAfterLogin) {
    const exited = new Promise(r => child.once('exit', r));
    child.kill('SIGTERM');
    const t = setTimeout(() => child.kill('SIGKILL'), 10_000);
    await exited; clearTimeout(t);
    ({ m: mcp, child } = await boot());
  }
  const db = new LocalHostDb(join(dataRoot, 'vault', 'social', 'my-social-assets.db'), { readOnly: true });
  let h2Row: { desired: string; phase: string } | undefined;
  try {
    h2Row = db.queryAll<{ house_origin: string; desired: string; phase: string }>(
      'SELECT house_origin, desired, phase FROM house_participation').find(r => r.house_origin === o2);
  } finally { db.close(); }
  // Let background boot/login work (handshake refresh, per-house self-heal) go quiet.
  let last = -1;
  for (let i = 0; i < 40; i++) {
    const n = h1.requests.length + h2.requests.length;
    if (n === last) break;
    last = n; await new Promise(r => setTimeout(r, 1500));
  }
  const m1 = h1.requests.length, m2 = h2.requests.length;
  const t0 = Date.now();
  const renameText = await mcp.callText('popclaw_set_name', { nickname: 'NewName' });
  const t1 = Date.now();
  await new Promise(r => setTimeout(r, 1000));
  const inWindow = (p: ProfilePost) => p.nickname === 'NewName' && p.at >= t0 && p.at <= t1;
  return {
    h2Row, renameText, o1, o2,
    h1Gets: h1.requests.slice(m1).filter(r => r.at <= t1 && r.method === 'GET' && r.path.startsWith('/v1/profile/')),
    h2Gets: h2.requests.slice(m2).filter(r => r.at <= t1 && r.method === 'GET' && r.path.startsWith('/v1/profile/')),
    h1Declaration: h1.posts.filter(inWindow),
    h2Declaration: h2.posts.filter(inWindow),
    h2AnyNewName: h2.posts.filter(p => p.nickname === 'NewName'),
    nonLoopback: existsSync(attempts) ? readFileSync(attempts, 'utf8') : '',
  };
}

describe('popclaw_set_name on the real MCP root: guard and send use one captured plan', () => {
  it('H2 joined by login before the rename, holding a protected field: zero POSTs of the new name to H2', async () => {
    const r = await scenario({ h2Avatar: 'https://h2.invalid/avatar.png' });
    expect(r.nonLoopback).toBe('');
    expect(r.h2Row).toMatchObject({ desired: 'enabled', phase: 'connected' });
    // Positive control: the recorder sees this command's H1 read.
    expect(r.h1Gets).toHaveLength(1);
    expect(r.h2AnyNewName).toEqual([]);
    expect(r.h1Declaration).toEqual([]);
    expect(r.h2Gets).toHaveLength(1);
    expect(r.renameText).toContain(r.o2);
    expect(r.renameText).toContain('avatar_uri');
  }, 120_000);

  it('H2 reloaded from persisted participation after a restart, protected field: zero POSTs of the new name to H2', async () => {
    const r = await scenario({ h2Avatar: 'https://h2.invalid/avatar.png', restartAfterLogin: true });
    expect(r.nonLoopback).toBe('');
    expect(r.h2Row).toMatchObject({ desired: 'enabled', phase: 'connected' });
    expect(r.h1Gets).toHaveLength(1);
    expect(r.h2AnyNewName).toEqual([]);
    expect(r.h1Declaration).toEqual([]);
    expect(r.h2Gets).toHaveLength(1);
    expect(r.renameText).toContain(r.o2);
  }, 120_000);

  it('both houses clean: the name is issued to H1 and H2, H2 read before it is written', async () => {
    const r = await scenario({ h2Avatar: '' });
    expect(r.nonLoopback).toBe('');
    expect(r.h1Declaration).toHaveLength(1);
    expect(r.h2Declaration).toHaveLength(1);
    expect(r.h2Declaration[0]!.declaredAt).toBe(r.h1Declaration[0]!.declaredAt);
    expect(r.h2Declaration[0]!.eventId).toBe(r.h1Declaration[0]!.eventId);
    expect(r.h2Gets).toHaveLength(1);
    expect(r.h2Gets[0]!.at).toBeLessThanOrEqual(r.h2Declaration[0]!.at);
    expect(r.renameText).toMatch(/NewName/);
    expect(r.renameText).not.toContain(r.o2);
  }, 120_000);
});
