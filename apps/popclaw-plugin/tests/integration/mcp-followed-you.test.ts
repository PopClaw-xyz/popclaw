/**
 * "Someone followed you" has to reach an MCP-only citizen.
 *
 * The bug this file exists to catch, observed on a real house in both
 * directions: the follow was applied, the edge was written, the follower row
 * was written — and `popclaw_notifications` said "nothing pending", with no
 * error anywhere. The poll that writes `known_followers_baseline` lived inline
 * in the gateway's `register()`, and every announcement path joins that table,
 * so on the MCP root there was nothing to announce from and nothing to say why.
 *
 * Proven out of process, against a spawned server and a house that CHECKS the
 * read credential: an in-process wiring assertion would pass on a root whose
 * poll asks anonymously and gets an empty list back, which is exactly the
 * shape of "all your followers vanished".
 *
 * The data root starts with a baseline already established for this house —
 * the state of any install that has synced once. A fresh root would be correct
 * to announce nobody on its first pass, which is a different case and is
 * covered at the unit level (`tests/unit/social-graph/follower-sync-service.test.ts`).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { LocalHostDb } from '../../src/host/local-host-db.js';
import { hostDbSlug } from '../../src/ingress/host-slug.js';
import { readCredentialMessage } from '../../src/identity/read-credential.js';
import { seedTrustedHouse, SEEDED_HOUSE_KEY } from '../helpers/seed-trusted-house.js';

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
/** Base58, so the announcement path renders it the way it renders a real one. */
const FOLLOWER = 'ELbgz8Lc4HHmZkSQRtRkVvNRy8UmVNbY4Ep2xP1nJ9vZ';

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
        const line = this.buf.slice(0, nl);
        this.buf = this.buf.slice(nl + 1);
        if (line.trim().length === 0) continue;
        const msg = JSON.parse(line) as JsonRpcResponse;
        if (typeof msg.id === 'number') this.pending.get(msg.id)?.(msg);
      }
    });
    child.stderr.setEncoding('utf-8');
    child.stderr.on('data', (chunk: string) => { this.stderr += chunk; });
  }

  request(method: string, params: unknown = {}): Promise<JsonRpcResponse> {
    const id = this.nextId++;
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return new Promise((res, rej) => {
      const timer = setTimeout(() => rej(new Error(`timeout: ${method}\nstderr:\n${this.stderr}`)), 45_000);
      this.pending.set(id, (r) => { clearTimeout(timer); res(r); });
    });
  }

  notify(method: string, params: unknown = {}): void {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  kill(): void { this.child.kill('SIGKILL'); }
}

/**
 * A house that answers `GET /followers/:me` — and only to a caller that proves
 * it holds that identity's key, for the `relation-list` purpose, under the
 * audience this root pinned. Same four-segment check the test relay makes for
 * the inbox stream; the purpose is rebuilt here rather than read off the wire,
 * so a poll asking under the wrong purpose is refused instead of served.
 */
function startFakeHouse(followers: string[]) {
  let origin = '';
  const refusals: string[] = [];
  const asked: string[] = [];
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    const match = /^\/followers\/([^/]+)$/.exec(path);
    if (match) {
      const me = match[1]!;
      asked.push(me);
      const parts = String(req.headers['x-popclaw-inbox-token'] ?? '').split('.');
      const [version, tokenId, ts, sig] = parts;
      let valid = false;
      try {
        const expected = readCredentialMessage(
          'relation-list', me, { origin, houseKey: SEEDED_HOUSE_KEY }, Number(ts),
        );
        valid = parts.length === 4 && version === 'v2' && tokenId === me
          && Math.abs(Date.now() / 1000 - Number(ts)) <= 60
          && nacl.sign.detached.verify(Buffer.from(expected), Buffer.from(sig!, 'base64'), bs58.decode(me));
      } catch { /* invalid token */ }
      if (!valid) { refusals.push(me); res.writeHead(401).end('[]'); return; }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(followers.map((popclaw_id) => ({ popclaw_id, since: 1 }))));
      return;
    }
    // Hold the consumer subscriptions open; refuse everything else, which is
    // what an unremarkable house looks like to the rest of the boot path.
    if (path.includes('stream')) { res.writeHead(200, { 'content-type': 'text/event-stream' }); return; }
    res.writeHead(404).end('{}');
  });
  return {
    refusals, asked,
    async listen() {
      await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
      origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      return origin;
    },
    close() { server.closeAllConnections(); server.close(); },
  };
}

/** A data root pointed at `house`, which this machine already trusts and has synced once. */
function seedDataRoot(house: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'popclaw-followed-'));
  mkdirSync(join(dir, 'config', 'cadence'), { recursive: true });
  writeFileSync(join(dir, 'config', 'plugin.json'), JSON.stringify({ lore_houses: [house] }));
  writeFileSync(
    join(dir, 'config', 'cadence', 'cadence.json'),
    JSON.stringify({ schemaVersion: 1, delivery: { primaryLanguage: 'en' } }),
  );
  seedTrustedHouse(dir, house);   // runs the migrations this next write needs
  const db = new LocalHostDb(join(dir, 'vault', 'social', 'my-social-assets.db'));
  try {
    // An install that has polled before. Without it the first pass would be
    // this house's baseline, and introducing nobody would be the right answer.
    db.execute(
      'INSERT OR IGNORE INTO known_followers_baseline (house_slug, established_at) VALUES (?, ?)',
      [hostDbSlug(house), 1_700_000_000],
    );
  } finally {
    db.close();
  }
  return dir;
}

describe('an MCP-only citizen is told that someone followed them', () => {
  let house: ReturnType<typeof startFakeHouse>;
  let dataRoot: string;
  let mcp: McpProcess;

  beforeAll(async () => {
    house = startFakeHouse([FOLLOWER]);
    const url = await house.listen();
    dataRoot = seedDataRoot(url);
    mcp = new McpProcess(
      spawn(process.execPath, ['--import', 'tsx', join(pkgRoot, 'src', 'mcp.ts')], {
        cwd: pkgRoot,
        env: { ...process.env, POPCLAW_DATA_ROOT: dataRoot },
        stdio: ['pipe', 'pipe', 'pipe'],
      }) as ChildProcessWithoutNullStreams,
    );
    const init = await mcp.request('initialize', {
      protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'vitest', version: '0' },
    });
    expect(init.result?.['serverInfo']).toMatchObject({ name: 'popclaw' });
    mcp.notify('notifications/initialized');
  }, 90_000);

  afterAll(() => {
    mcp?.kill();
    house?.close();
    if (dataRoot) rmSync(dataRoot, { recursive: true, force: true });
  });

  it('polls its houses at boot and puts the new follower in popclaw_notifications', async () => {
    // Boot the lazy runtime — the poll starts where the house pin and the DM
    // recovery do, so nothing reaches the house until a tool is called.
    const status = await mcp.request('tools/call', { name: 'popclaw_check_status', arguments: {} });
    expect(status.result?.['isError']).toBeFalsy();

    let text = '';
    for (let attempt = 0; attempt < 40 && !text.includes('followed you'); attempt += 1) {
      await new Promise((done) => setTimeout(done, 500));
      const res = await mcp.request('tools/call', { name: 'popclaw_notifications', arguments: {} });
      text = ((res.result?.['content'] as Array<{ text: string }> | undefined) ?? [])
        .map((b) => b.text).join('\n');
    }

    expect(text).toContain('followed you');
    // The house was asked as the owner, and answered — a refusal here would
    // have looked exactly like "nobody follows you".
    expect(house.asked.length).toBeGreaterThan(0);
    expect(house.refusals).toEqual([]);

    // And the row is real, not only rendered.
    const db = new LocalHostDb(join(dataRoot, 'vault', 'social', 'my-social-assets.db'));
    try {
      const rows = db.queryAll<{ kind: string; payload_json: string }>(
        "SELECT kind, payload_json FROM notification_queue WHERE kind = 'followed_you'", [],
      );
      expect(rows).toHaveLength(1);
      expect(JSON.parse(rows[0]!.payload_json).followerPopclawId).toBe(FOLLOWER);
    } finally {
      db.close();
    }
  }, 90_000);
});
