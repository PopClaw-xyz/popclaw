/**
 * "Someone followed you" reaching an MCP-only citizen from the RELATION
 * STREAM, on a data root that has never polled anything.
 *
 * Its sibling (`mcp-followed-you.test.ts`) proves the poll leg, and seeds
 * `known_followers_baseline` by hand to do it. That seed is the whole
 * difference: every announcement used to join that table, and the poll's first
 * successful pass is the only thing that writes it — so on a brand-new install
 * a follow the house delivered in seconds was held until the poll got round to
 * it, or, if the poll's first list happened to name that person, filed as
 * history and never mentioned at all.
 *
 * So nothing here seeds a baseline, and the house REFUSES the follower list
 * outright. If this root announces anybody it can only be because it took
 * delivery of the signed declaration and acted on it.
 *
 * What this does NOT decide is whether the chain's attach won its race with
 * the trust pin: the follow is only relayed once the personal stream opens,
 * and that stream opens only after the pin exists, so on most runs the
 * session is already attached when the frame lands. Which side of that race a
 * frame falls on is not something an out-of-process test can hold still, and
 * both sides are pinned at the unit level instead
 * (`tests/unit/social-graph/relation-frame-before-a-trusted-session.test.ts`).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { popclaw } from '@popclaw/contracts';
import { cidFromCanonical } from '@popclaw/algorithms';
import { canonicalizeEnvelope } from '../../src/protocol/public-envelope.js';
import { LocalHostDb } from '../../src/host/local-host-db.js';
import { READ_CREDENTIAL_SCHEME } from '../../src/identity/read-credential.js';
import { mintHouse, type MintedHouse } from '../helpers/signed-manifest.js';

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const followerKp = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(19));
const FOLLOWER = bs58.encode(followerKp.publicKey);

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

/** The signed FollowDeclared this house relays on the owner's personal stream. */
function followFrame(houseKey: string, followee: string): Uint8Array {
  const env = {
    actor: { popclawId: FOLLOWER },
    target: {},
    lorehouse: houseKey,
    timestamp: 1_713_657_600,
    followDeclared: { followeePopclawId: followee, order: { seq: '1', houseKey } },
  };
  const canonical = canonicalizeEnvelope(env);
  return popclaw.event.EventEnvelope.encode({
    ...env,
    eventId: cidFromCanonical(canonical),
    signature: nacl.sign.detached(canonical, followerKp.secretKey),
  }).finish();
}

/**
 * A house that serves a real binding proof, relays one relation frame on the
 * personal stream, and REFUSES the follower list. The refusal is the point:
 * with it, no baseline can ever be established here, so nothing the poll does
 * can be the reason the owner hears about anybody.
 */
function startRelayingHouse() {
  let origin = '';
  let minted: MintedHouse | undefined;
  let ownerPopclawId = '';
  const listAsks: string[] = [];
  const streams: ServerResponse[] = [];

  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    if (path === '/v1/manifest' && minted) {
      res.writeHead(200, {
        'content-type': 'application/json',
        'X-Popclaw-Manifest-Proof': minted.proofHeader,
      });
      res.end(Buffer.from(minted.bodyBytes));
      return;
    }
    const list = /^\/followers\/([^/]+)$/.exec(path);
    if (list) {
      // Never answered. A root that announced someone did not learn it here.
      listAsks.push(list[1]!);
      res.writeHead(503).end('unavailable');
      return;
    }
    const inbox = /^\/inbox\/([^/]+)\/stream$/.exec(path);
    if (inbox) {
      ownerPopclawId = inbox[1]!;
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      streams.push(res);
      return;
    }
    if (path.includes('stream')) { res.writeHead(200, { 'content-type': 'text/event-stream' }); return; }
    res.writeHead(404).end('{}');
  });

  return {
    listAsks,
    get ownerPopclawId() { return ownerPopclawId; },
    get houseKey() { return minted?.houseKey ?? ''; },
    async listen() {
      await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
      origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      minted = mintHouse({
        origin,
        manifest: {
          relations: { ordered: 1 },
          read_auth: { schemes: [READ_CREDENTIAL_SCHEME] },
          official_ids: [],
        },
      });
      return origin;
    },
    /** Deliver the follow to whoever is listening on the personal stream. */
    relayFollow(): boolean {
      if (streams.length === 0 || ownerPopclawId === '' || minted === undefined) return false;
      const bytes = followFrame(minted.houseKey, ownerPopclawId);
      const frame = `event: envelope\nid: 1.1\ndata: ${Buffer.from(bytes).toString('base64')}\n\n`;
      for (const res of streams) res.write(frame);
      return true;
    },
    close() {
      for (const res of streams) res.end();
      server.closeAllConnections();
      server.close();
    },
  };
}

/** A data root that knows this house's address and nothing else about it. */
function freshDataRoot(house: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'popclaw-relation-followed-'));
  mkdirSync(join(dir, 'config', 'cadence'), { recursive: true });
  writeFileSync(join(dir, 'config', 'plugin.json'), JSON.stringify({ lore_houses: [house] }));
  writeFileSync(
    join(dir, 'config', 'cadence', 'cadence.json'),
    JSON.stringify({ schemaVersion: 1, delivery: { primaryLanguage: 'en' } }),
  );
  return dir;
}

const wait = (ms: number): Promise<void> => new Promise((done) => { setTimeout(done, ms); });

describe('an MCP-only citizen is told about a follow that arrived on the relation stream', () => {
  let house: ReturnType<typeof startRelayingHouse>;
  let dataRoot: string;
  let mcp: McpProcess;

  beforeAll(async () => {
    house = startRelayingHouse();
    const url = await house.listen();
    dataRoot = freshDataRoot(url);
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

  it('applies the follow and puts it in popclaw_notifications without any poll', async () => {
    // Boot the lazy runtime: nothing reaches the house until a tool is called.
    const status = await mcp.request('tools/call', { name: 'popclaw_check_status', arguments: {} });
    expect(status.result?.['isError']).toBeFalsy();

    // Wait for the personal stream, which is how we learn who this root is,
    // then relay the follow down it.
    let relayed = false;
    for (let attempt = 0; attempt < 60 && !relayed; attempt += 1) {
      await wait(500);
      relayed = house.relayFollow();
    }
    expect(relayed, `no personal stream opened\nstderr:\n${mcp.stderr}`).toBe(true);

    let text = '';
    for (let attempt = 0; attempt < 60 && !text.includes('followed you'); attempt += 1) {
      await wait(500);
      const res = await mcp.request('tools/call', { name: 'popclaw_notifications', arguments: {} });
      text = ((res.result?.['content'] as Array<{ text: string }> | undefined) ?? [])
        .map((b) => b.text).join('\n');
    }
    expect(text, `stderr:\n${mcp.stderr}`).toContain('followed you');

    // The announcement came from the stream, in this root's own words.
    expect(mcp.stderr).toContain('from the relation stream');

    const db = new LocalHostDb(join(dataRoot, 'vault', 'social', 'my-social-assets.db'));
    try {
      const rows = db.queryAll<{ kind: string; payload_json: string }>(
        "SELECT kind, payload_json FROM notification_queue WHERE kind = 'followed_you'", [],
      );
      expect(rows).toHaveLength(1);
      expect(JSON.parse(rows[0]!.payload_json).followerPopclawId).toBe(FOLLOWER);

      // The adjudicated edge, not only a notification.
      expect(db.queryAll<{ state: string }>(
        'SELECT state FROM relation_edges WHERE follower_popclaw_id = ?', [FOLLOWER],
      )).toEqual([{ state: 'following' }]);

      // And the control that makes all of the above mean what it says: the
      // poll asked, the house refused, and no baseline was ever written.
      expect(house.listAsks.length).toBeGreaterThan(0);
      expect(db.queryAll('SELECT house_slug FROM known_followers_baseline')).toEqual([]);
    } finally {
      db.close();
    }
  }, 120_000);
});
