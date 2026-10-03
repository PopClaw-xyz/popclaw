/**
 * A reader's ➕ has to reach an MCP-only citizen AND lead somewhere.
 *
 * Collecting the intent was the first half, and fixing only that made things
 * worse than the silence it replaced: the pull loop enqueues an L2 saying "N
 * pending follow requests — say 'follow list'", and `pendingFollows` was
 * absent from the MCP runtime bag. `stub-tools.ts` and `world-tools.ts` both
 * read that slot through a local `pendingFollows?:` cast, so the list came
 * back empty and the follow never graduated — a dead end the owner was
 * explicitly invited into.
 *
 * So the whole chain is walked here, out of process, against a real spawned
 * `mcp.ts` and a house that actually takes the push:
 *
 *   the canvas is holding an intent
 *     → the doorbell pulls and absorbs it            (the loop)
 *     → popclaw_show_dream_review names the person   (the bag)
 *     → popclaw_follow declares it and it graduates  (the bag again)
 *     → the card no longer offers them               (markConfirmed took)
 *
 * An in-process assertion on the bag's shape would prove none of this: the
 * slot is read through casts that bypass the type, which is exactly how it
 * went missing.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { LocalHostDb } from '../../src/host/local-host-db.js';
import { mintHouse, type MintedHouse } from '../helpers/signed-manifest.js';
import { popclaw } from '@popclaw/contracts';
import { decodeEnvelope } from '../../src/protocol/public-envelope.js';

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Base58 and production-length, so absorb's id check treats it as a real person. */
const FOLLOWEE = 'ELbgz8Lc4HHmZkSQRtRkVvNRy8UmVNbY4Ep2xP1nJ9vZ';
const FOLLOWEE_LABEL = 'Cloudboat#3m8v';

interface JsonRpcResponse {
  jsonrpc: string;
  id?: number;
  result?: Record<string, unknown>;
  error?: { message: string };
}

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
    child.stderr.on('data', (chunk: string) => {
      this.stderr += chunk;
    });
  }

  request(method: string, params: unknown = {}): Promise<JsonRpcResponse> {
    const id = this.nextId++;
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return new Promise((res, rej) => {
      const timer = setTimeout(() => rej(new Error(`timeout: ${method}\nstderr:\n${this.stderr}`)), 45_000);
      this.pending.set(id, (r) => {
        clearTimeout(timer);
        res(r);
      });
    });
  }

  /** The text blocks of a tools/call result, joined. */
  async callText(name: string, args: Record<string, unknown> = {}): Promise<string> {
    const res = await this.request('tools/call', { name, arguments: args });
    return ((res.result?.['content'] as Array<{ text: string }> | undefined) ?? [])
      .map((b) => b.text)
      .join('\n');
  }

  notify(method: string, params: unknown = {}): void {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  kill(): void {
    this.child.kill('SIGKILL');
  }
}

/**
 * One loopback fixture wearing both hats — the house this root is pinned to
 * and the canvas that holds its owner's clicks. Two origins would prove
 * nothing extra here and would double the offline surface.
 */
function startFixture() {
  const pushes: string[] = [];
  let intents: Array<Record<string, unknown>> = [];
  let minted: MintedHouse | undefined;
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const path = url.pathname;
    // A declared follow is refused before signing unless the house proves its
    // identity over bytes that declare `relations.ordered = 1` — and the proof
    // is fetched live, per call, from the SAME bytes. A house that cannot say
    // this is a house no follow can be sent to, so the fixture mints a real
    // one (tests/helpers/signed-manifest.ts, checked against a running Rust
    // house) rather than a shape that only looks right.
    if (path === '/v1/manifest' && minted) {
      res.writeHead(200, {
        'content-type': 'application/json',
        'X-Popclaw-Manifest-Proof': minted.proofHeader,
      });
      res.end(Buffer.from(minted.bodyBytes));
      return;
    }
    // The canvas half: the owner's own clicks, waiting to be collected. The
    // signature on the request is not checked — what is under test is whether
    // anybody on this root ever asks.
    if (path === '/v1/follow-intents') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ intents: intents.map((i) => ({ ...i, owner_popclaw_id: url.searchParams.get('owner') })) }));
      return;
    }
    if (path === '/v1/sync-requests') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ requests: [] }));
      return;
    }
    // The house half. Acceptance is a receipt NAMING THIS EVENT — a bare 200
    // leaves the follow `queued`, and a queued follow deliberately does not
    // graduate its pending row (commands/follow.ts). So the id is read back
    // off the signed bytes rather than invented, which also means a push that
    // never arrived cannot be faked into a receipt.
    if (path === '/v1/push' && req.method === 'POST') {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => void chunks.push(c));
      req.on('end', () => {
        try {
          const signed = popclaw.identity.SignedPayload.decode(Buffer.concat(chunks));
          const eventId = decodeEnvelope(signed.payload).eventId;
          pushes.push(eventId);
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ event_id: eventId }));
        } catch {
          res.writeHead(400, { 'content-type': 'application/json' }).end('{}');
        }
      });
      return;
    }
    if (path.includes('stream')) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      return;
    }
    res.writeHead(404).end('{}');
  });
  return {
    pushes,
    hold(rows: Array<Record<string, unknown>>) {
      intents = rows;
    },
    /** The identity this house proves, known only once it has a port. */
    get house(): MintedHouse {
      if (!minted) throw new Error('fixture not listening yet');
      return minted;
    },
    async listen(): Promise<string> {
      await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
      const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      minted = mintHouse({ origin, manifest: { relations: { ordered: 1 } } });
      return origin;
    },
    close() {
      server.closeAllConnections();
      server.close();
    },
  };
}

/**
 * A data root that knows the house's address and nothing else.
 *
 * Deliberately NOT pre-pinned. The default-house-pinning loop this root runs
 * does the real thing at boot — fetch the manifest, verify its proof, pin, and
 * ACTIVATE participation — and participation is what a declared follow needs
 * (a pin alone answers `HOUSE_OWNER_MOVED_ON`). Seeding a pin by hand skips
 * the activation and would have this test pass on a machine where following
 * is impossible.
 */
function seedDataRoot(minted: MintedHouse): string {
  const dir = mkdtempSync(join(tmpdir(), 'popclaw-doorbell-'));
  mkdirSync(join(dir, 'config', 'cadence'), { recursive: true });
  writeFileSync(join(dir, 'config', 'plugin.json'), JSON.stringify({ lore_houses: [minted.origin] }));
  writeFileSync(
    join(dir, 'config', 'cadence', 'cadence.json'),
    JSON.stringify({ schemaVersion: 1, delivery: { primaryLanguage: 'en' } }),
  );
  return dir;
}

/** The pending rows as the social DB holds them — the ledger behind the card. */
function pendingRows(dataRoot: string): Array<{ followee_popclaw_id: string; status: string }> {
  const db = new LocalHostDb(join(dataRoot, 'vault', 'social', 'my-social-assets.db'), { readOnly: true });
  try {
    return db.queryAll('SELECT followee_popclaw_id, status FROM pending_follows');
  } finally {
    db.close();
  }
}

describe('a reader"s follow intent reaches an MCP-only citizen and leads somewhere', () => {
  let fixture: ReturnType<typeof startFixture>;
  let dataRoot: string;
  let mcp: McpProcess;

  beforeAll(async () => {
    fixture = startFixture();
    const url = await fixture.listen();
    fixture.hold([
      {
        followee_popclaw_id: FOLLOWEE,
        followee_label: FOLLOWEE_LABEL,
        first_ts: Date.now() - 1_000,
        latest_ts: Date.now() - 1_000,
        click_count: 1,
      },
    ]);
    dataRoot = seedDataRoot(fixture.house);
    mcp = new McpProcess(
      spawn(process.execPath, ['--import', 'tsx', join(pkgRoot, 'src', 'mcp.ts')], {
        cwd: pkgRoot,
        env: { ...process.env, POPCLAW_DATA_ROOT: dataRoot, POPCLAW_CANVAS_BASE_URL: url },
        stdio: ['pipe', 'pipe', 'pipe'],
      }) as ChildProcessWithoutNullStreams,
    );
    const init = await mcp.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'vitest', version: '0' },
    });
    expect(init.result?.['serverInfo']).toMatchObject({ name: 'popclaw' });
    mcp.notify('notifications/initialized');
  }, 90_000);

  afterAll(() => {
    mcp?.kill();
    fixture?.close();
    if (dataRoot) rmSync(dataRoot, { recursive: true, force: true });
  });

  it('pulls the intent, offers the person on the card, follows them, and stops offering', async () => {
    // Boot the lazy runtime — the doorbell starts where the house pin and the
    // DM recovery do, so nothing reaches the canvas until a tool is called.
    const status = await mcp.request('tools/call', { name: 'popclaw_check_status', arguments: {} });
    expect(status.result?.['isError']).toBeFalsy();

    // ① the loop collected it, and ② the bag can show it. Polled together:
    // the card IS the observation, so a pass here cannot be a row nobody can
    // reach.
    let card = '';
    for (let attempt = 0; attempt < 40 && !card.includes(FOLLOWEE_LABEL); attempt += 1) {
      await new Promise((done) => setTimeout(done, 500));
      card = await mcp.callText('popclaw_show_dream_review');
    }
    expect(card).toContain('To follow');
    expect(card).toContain(FOLLOWEE_LABEL);
    expect(pendingRows(dataRoot)).toEqual([{ followee_popclaw_id: FOLLOWEE, status: 'pending' }]);

    // ③ the owner acts on the invitation. The house takes the push, so the
    // follow is on the wire and the row graduates. G1-copy / architect
    // ruling: the receipt names the fixture's own (ephemeral-port) house
    // slug, not a generic "the lore-house" — that's the whole point of the
    // fix, so match the shape rather than hardcoding the port, which changes
    // every run.
    const followed = await mcp.callText('popclaw_follow', { name: FOLLOWEE });
    expect(followed).toMatch(/\S+ has the follow declaration\./);
    expect(followed).not.toContain('the lore-house has');
    expect(fixture.pushes.length).toBeGreaterThan(0);
    expect(pendingRows(dataRoot)).toEqual([{ followee_popclaw_id: FOLLOWEE, status: 'confirmed' }]);

    // ④ and they are never offered again — the whole point of graduating.
    expect(await mcp.callText('popclaw_show_dream_review')).not.toContain(FOLLOWEE_LABEL);
  }, 90_000);
});
