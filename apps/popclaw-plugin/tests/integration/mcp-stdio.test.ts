/**
 * The MCP bridge's end-to-end contract, proven against a real spawned process.
 *
 * THE bug this file exists to catch: in a stdio MCP server fd 1 IS the protocol
 * channel, so one stray `console.log` / pino line on stdout corrupts the stream
 * and the client silently drops the session. Asserting "every stdout line parses
 * as JSON-RPC" is the only check that stays true as dependencies change.
 *
 * Runs fully offline: the scratch data root is pre-seeded with a plugin config
 * pointing at an unreachable lore-house, so the boot path takes its network
 * failures for real — which is exactly when a server is most likely to log.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { LocalHostDb } from '../../src/host/local-host-db.js';
import { seedTrustedHouse } from '../helpers/seed-trusted-house.js';

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
/** Unroutable on purpose: every lore-house call must fail during this test. */
const OFFLINE_HOUSE = 'http://127.0.0.1:9';

interface JsonRpcResponse {
  jsonrpc: string;
  id?: number;
  result?: Record<string, unknown>;
  error?: { message: string };
}

class McpProcess {
  readonly stdoutLines: string[] = [];
  initResult?: Record<string, unknown>;
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
        this.stdoutLines.push(line);
        // Deliberately not tolerant: a non-JSON line must surface as a failure
        // here rather than as a mysterious hang.
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

  notify(method: string, params: unknown = {}): void {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  kill(): void {
    this.child.kill('SIGKILL');
  }
}

/** Spawn the server on a scratch data root and complete the MCP handshake. */
async function startServer(dataRoot: string, extraEnv: NodeJS.ProcessEnv = {}): Promise<McpProcess> {
  const mcp = new McpProcess(
    spawn(process.execPath, ['--import', 'tsx', join(pkgRoot, 'src', 'mcp.ts')], {
      cwd: pkgRoot,
      env: { ...process.env, POPCLAW_DATA_ROOT: dataRoot, ...extraEnv },
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams,
  );
  const init = await mcp.request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'vitest', version: '0' },
  });
  expect(init.result?.['serverInfo']).toMatchObject({ name: 'popclaw' });
  mcp.initResult = init.result;
  mcp.notify('notifications/initialized');
  return mcp;
}

/**
 * A scratch data root pointed at `house`.
 *
 * Pins `cadence.delivery.primaryLanguage` to zh-CN explicitly: this suite's
 * assertions below (`私信`, `新粉`, …) are the pre-S6-lexicon production zh
 * strings, so the fixture needs an owner who has actually said "speak
 * Chinese to me" — an unconfigured install now defaults to English
 * (S1 `DEFAULT_OWNER_LANGUAGE`), which would otherwise fail these for the
 * right reason (no config = no Chinese) rather than a real regression.
 */
function seedDataRoot(house: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'popclaw-mcp-'));
  mkdirSync(join(dir, 'config', 'cadence'), { recursive: true });
  writeFileSync(join(dir, 'config', 'plugin.json'), JSON.stringify({ lore_houses: [house] }));
  writeFileSync(
    join(dir, 'config', 'cadence', 'cadence.json'),
    JSON.stringify({ schemaVersion: 1, delivery: { primaryLanguage: 'zh-CN' } }),
  );
  // A modern house this machine already trusts: without a verified binding
  // and a declared read scheme, the inbox stream refuses to open and the
  // consumer-stream assertions below would be measuring the refusal.
  seedTrustedHouse(dir, house);
  return dir;
}

describe('popclaw MCP server over stdio', () => {
  let dataRoot: string;
  let mcp: McpProcess;

  beforeAll(async () => {
    dataRoot = seedDataRoot(OFFLINE_HOUSE);
    mcp = await startServer(dataRoot);
  }, 60_000);

  afterAll(() => {
    mcp?.kill();
    rmSync(dataRoot, { recursive: true, force: true });
  });

  it('lists the popclaw tool surface with JSON-Schema inputs', async () => {
    const res = await mcp.request('tools/list');
    const tools = res.result?.['tools'] as Array<{ name: string; description: string; inputSchema: { type: string } }>;
    expect(tools.length).toBeGreaterThan(30);
    expect(tools.map((t) => t.name)).toContain('popclaw_check_status');
    for (const t of tools) {
      expect(t.inputSchema.type).toBe('object');
      expect(t.description.length).toBeGreaterThan(0);
    }
  }, 30_000);

  it('runs a read-only tool (boots the real runtime) and degrades offline', async () => {
    const res = await mcp.request('tools/call', { name: 'popclaw_check_status', arguments: {} });
    const content = res.result?.['content'] as Array<{ type: string; text: string }>;
    // NOT merely "returned something": a boot-path breakage (e.g. a migrations
    // dir resolved from the wrong depth) shows up here as isError, and only here.
    expect(res.result?.['isError']).toBeFalsy();
    expect(content[0]?.type).toBe('text');
    expect(content[0]?.text).toContain('🔑'); // the identity report's key line
    // The identity boot messages must survive — on stderr.
    expect(mcp.stderr).toMatch(/NEW IDENTITY CREATED|identity loaded/);
  }, 60_000);

  // The gap this closes: `/popclaw start` is a gateway-only surface, so an
  // MCP-only citizen (Claude Code / Codex) had no way into act one at all — the
  // onboarding tools all dead-ended at `idle` telling them to type a slash
  // command their host does not have. Asserted against the REAL state DB: the
  // stage has to actually move. (Rendering act one needs an LLM, which this
  // deliberately-offline fixture has none of; the transition lands first.)
  it('lets a brand-new MCP citizen into act one — continue starts onboarding', async () => {
    const db = new LocalHostDb(join(dataRoot, 'vault', 'social', 'my-social-assets.db'));
    // Run isolated (`-t`), the migrations may not have run yet, and querying a
    // table that does not exist throws. No table = no row = no stage, which is
    // exactly the "not started" this asserts — and it stays honest afterwards
    // too: a missing table would leave the post-check an empty list, which
    // fails `toContain('arrival')` rather than passing vacuously.
    const stages = (): string[] => {
      try {
        return db.queryAll<{ stage: string }>('SELECT stage FROM onboarding_state').map((r) => r.stage);
      } catch {
        return [];
      }
    };
    try {
      expect(stages()).not.toContain('arrival');
      const res = await mcp.request('tools/call', {
        name: 'popclaw_onboarding_continue',
        arguments: { answer: "let's do it" },
      });
      const text = (res.result?.['content'] as Array<{ text: string }>)[0]?.text ?? '';
      expect(text).not.toContain('/popclaw start');
      expect(stages()).toContain('arrival');
    } finally {
      db.close();
    }
  }, 60_000);

  it('turns a throwing tool into an MCP error result, not a dead server', async () => {
    const bad = await mcp.request('tools/call', { name: 'popclaw_not_a_tool', arguments: {} });
    expect(bad.result?.['isError']).toBe(true);
    // …and the server still answers afterwards.
    const after = await mcp.request('tools/list');
    expect((after.result?.['tools'] as unknown[]).length).toBeGreaterThan(30);
  }, 30_000);

  // A host that never declared MCP form elicitation cannot ask the owner, so the
  // world action must refuse instead of executing unconfirmed. The ACTUAL gate
  // here is the adapter's own code: `bindMcpWorldInvoke` enters
  // `withInvocation`, which refuses an unusable client with
  // OWNER_CONFIRMATION_UNAVAILABLE and its host hint BEFORE the capability
  // projection could turn this into a generic WORLD_LOCAL_UNSUPPORTED.
  it('refuses a world action on a client with no elicitation, and writes no request', async () => {
    const res = await mcp.request('tools/call', {
      name: 'popclaw_world_invoke',
      arguments: { house: OFFLINE_HOUSE, kind: 'rangermap.check_in', params: {}, expected_capability_revision: 'a'.repeat(64) },
    });
    expect(res.result?.['isError']).toBe(true);
    const text = (res.result?.['content'] as Array<{ text: string }>)[0]!.text;
    expect(text).toContain('OWNER_CONFIRMATION_UNAVAILABLE');
    expect(text).toContain('MCP elicitation');
    // Nothing was signed: the server never asked the client anything.
    expect(mcp.stdoutLines.some(line => line.includes('elicitation/create'))).toBe(false);
    // …and the server still answers afterwards.
    expect((( await mcp.request('tools/list')).result?.['tools'] as unknown[]).length).toBeGreaterThan(30);
  }, 60_000);

  it('keeps stdout pure JSON-RPC while the boot path logs to stderr', () => {
    expect(mcp.stdoutLines.length).toBeGreaterThan(0);
    for (const line of mcp.stdoutLines) {
      const msg = JSON.parse(line) as JsonRpcResponse;
      expect(msg.jsonrpc).toBe('2.0');
    }
    // Proof the guard is load-bearing: boot really did produce log output, and
    // all of it went to fd 2.
    expect(mcp.stderr).toContain('popclaw-mcp starting');
  });
});

/**
 * §3.5 L1 piggyback + L2 notifications tool, proven against a real process.
 *
 * The whole ladder's point is that an MCP host can't let popclaw push, so the
 * unread count must RIDE a normal tool result and the owner must be able to
 * pull the items. Both halves are asserted at the wire: the notice is its OWN
 * content block after the primary result (never concatenated), a clean queue
 * appends nothing, the tool drains, and stdout stays pure JSON-RPC throughout.
 */
describe('MCP unread piggyback + notifications tool', () => {
  let dataRoot: string;
  let mcp: McpProcess;
  const socialDb = () => join(dataRoot, 'vault', 'social', 'my-social-assets.db');

  beforeAll(async () => {
    dataRoot = seedDataRoot(OFFLINE_HOUSE);
    mcp = await startServer(dataRoot);
    // Boot the runtime so migrations create notification_queue before we seed.
    await mcp.request('tools/call', { name: 'popclaw_check_status', arguments: {} });
  }, 60_000);

  afterAll(() => {
    mcp?.kill();
    rmSync(dataRoot, { recursive: true, force: true });
  });

  type Block = { type: string; text: string };
  // The piggyback is identified by its pointer suffix, NOT by 📬 — the
  // notifications tool's own body also opens with 📬.
  const hasPiggyback = (content: Block[]): boolean =>
    content.some((b) => b.text.includes('调 popclaw_notifications 查看'));

  const callStatus = async (): Promise<Block[]> => {
    const res = await mcp.request('tools/call', { name: 'popclaw_check_status', arguments: {} });
    expect(res.result?.['isError']).toBeFalsy();
    return res.result?.['content'] as Block[];
  };

  it('a clean queue appends no unread block', async () => {
    expect(hasPiggyback(await callStatus())).toBe(false);
  }, 30_000);

  it('the unread notice rides as its OWN block after the primary result', async () => {
    // Seed via a second WAL connection (the server holds the db open).
    const db = new LocalHostDb(socialDb());
    const now = Math.floor(Date.now() / 1000);
    for (const [level, kind, payload] of [
      ['L1', 'dm', { fromPopclawId: 'abcdef0123456789', body: '在吗' }],
      ['L1', 'ranger_verify_done', { platform: 'x', handle: 'kaito' }],
      ['L2', 'followed_you', { followerPopclawId: 'ffee00112233' }],
      // L3 must NOT count toward "unread": it belongs to the paper.
      ['L3', 'recommendation', { note: 'hot' }],
    ] as const) {
      db.execute(
        'INSERT INTO notification_queue (level, kind, payload_json, enqueued_at) VALUES (?,?,?,?)',
        [level, kind, JSON.stringify({...payload, houseOrigin: OFFLINE_HOUSE}), now],
      );
    }
    db.close();

    const content = await callStatus();
    // Primary block unchanged: still the identity report, still first.
    expect(content[0]?.text).toContain('🔑');
    // The notice is a SEPARATE trailing block — 2 L1 + 1 L2, L3 excluded.
    const notice = content[content.length - 1]!;
    expect(notice.type).toBe('text');
    expect(notice.text).toBe('📬 2 条新私信/提及待看，1 条动态 —— 调 popclaw_notifications 查看');
    expect(content.length).toBeGreaterThan(1);
  }, 30_000);

  it('popclaw_notifications remains pending until explicit host acknowledgement', async () => {
    const res = await mcp.request('tools/call', { name: 'popclaw_notifications', arguments: {} });
    const content = res.result?.['content'] as Block[];
    expect(content[0]?.text).toContain('私信');
    expect(content[0]?.text).toContain('新粉');
    expect(hasPiggyback(content)).toBe(true);
    const metadata = JSON.parse(content[0]!.text.split('\n').at(-1)!);
    await mcp.request('tools/call', { name: 'popclaw_acknowledge_notifications', arguments: { notification_ids: metadata.notifications.map((n: { notification_id: number }) => n.notification_id) } });
    expect(hasPiggyback(await callStatus())).toBe(false);
  }, 30_000);

  it('retains unattributed history without an automatic unread reminder', async () => {
    const db = new LocalHostDb(socialDb());
    db.execute('INSERT INTO notification_queue (level, kind, payload_json, enqueued_at) VALUES (?,?,?,?)',
      ['L1', 'dm', JSON.stringify({fromPopclawId:'old-history', body:'unattributed history'}), Math.floor(Date.now()/1000)]);
    db.close();
    expect(hasPiggyback(await callStatus())).toBe(false);
    const res = await mcp.request('tools/call', {name:'popclaw_notifications', arguments:{}});
    const content = res.result?.['content'] as Block[];
    expect(content[0]?.text).toContain('unattributed history');
    expect(hasPiggyback(content)).toBe(false);
  }, 30_000);

  it('keeps stdout pure JSON-RPC across all of the above', () => {
    for (const line of mcp.stdoutLines) {
      expect((JSON.parse(line) as JsonRpcResponse).jsonrpc).toBe('2.0');
    }
  });

  it('advertises popclaw_notifications and populates initialize instructions', async () => {
    const list = await mcp.request('tools/list');
    const names = (list.result?.['tools'] as Array<{ name: string }>).map((t) => t.name);
    expect(names).toContain('popclaw_notifications');
    // §3.5 L2 开席注入: the host agent is told to pull + relay at session start.
    expect(mcp.initResult?.['instructions']).toContain('popclaw_notifications');
  }, 30_000);
});

/**
 * 主人 2026-07-28 裁定：MCP 会话默认**只做消费者**，绝不冒充游侠。
 *
 * Observed at the wire, not in a log: a stub lore-house records every path the
 * server touches. A citizen session may subscribe to the consumer streams
 * (world-feed / inbox) and must NEVER open the ranger's `/v1/discovery` quest
 * stream or POST to `/v1/push`. Both directions are asserted, because a test
 * that only proves "off" would still pass if the flag were dead code.
 */
describe('MCP citizen mode does not advertise as a ranger', () => {
  let house: Server;
  let houseUrl: string;
  const paths: string[] = [];
  const roots: string[] = [];
  const servers: McpProcess[] = [];

  beforeAll(async () => {
    house = createServer((req, res) => {
      paths.push(`${req.method} ${(req.url ?? '').split('?')[0]}`);
      // Hang the SSE subscriptions open; answer everything else with 404.
      if ((req.url ?? '').includes('stream') || (req.url ?? '').includes('discovery')) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((r) => house.listen(0, '127.0.0.1', r));
    houseUrl = `http://127.0.0.1:${(house.address() as AddressInfo).port}`;
  });

  afterAll(() => {
    for (const s of servers) s.kill();
    for (const r of roots) rmSync(r, { recursive: true, force: true });
    house.close();
  });

  const bootAndSettle = async (extraEnv: NodeJS.ProcessEnv): Promise<McpProcess> => {
    const root = seedDataRoot(houseUrl);
    roots.push(root);
    const mcp = await startServer(root, extraEnv);
    servers.push(mcp);
    // Force the lazy runtime to boot (that is where any ranger would start).
    await mcp.request('tools/call', { name: 'popclaw_check_status', arguments: {} });
    await new Promise((r) => setTimeout(r, 1500));
    return mcp;
  };

  it('opens the consumer streams but never the ranger quest stream', async () => {
    paths.length = 0;
    const mcp = await bootAndSettle({});
    expect(paths.some((p) => p.includes('/world-feed/stream'))).toBe(true);
    expect(paths.some((p) => p.includes('/inbox/'))).toBe(true);
    expect(paths.filter((p) => p.includes('/v1/discovery'))).toEqual([]);
    expect(paths.filter((p) => p.startsWith('POST /v1/push'))).toEqual([]);
    expect(mcp.stderr).toContain('mode=citizen (consumer-only)');
  }, 60_000);

  it('opts in only on the literal flag value (fail-closed)', async () => {
    paths.length = 0;
    const off = await bootAndSettle({ POPCLAW_MCP_ENABLE_RANGER: '1' });
    expect(paths.filter((p) => p.includes('/v1/discovery'))).toEqual([]);
    expect(off.stderr).toContain('mode=citizen (consumer-only)');

    paths.length = 0;
    const on = await bootAndSettle({ POPCLAW_MCP_ENABLE_RANGER: 'true' });
    expect(paths.some((p) => p.includes('/v1/discovery'))).toBe(true);
    expect(on.stderr).toContain('mode=ranger');
  }, 90_000);
});

/**
 * The elicitation exchange itself, against the REAL SDK server and client.
 *
 * Scope, stated plainly: this case stops at the confirmation dialog. Driving a
 * genuinely signed invoke needs the logged-in house fixture (manifest proof,
 * capability view, receipt journal on file SQLite) that
 * `tests/unit/runtime/world-runtime.test.ts` builds, which this harness
 * cannot host — the runtime half of the lane is covered there (T-i…T-n).
 * What is proven here is the part only a real Server/Client pair can prove:
 * the capability gate, the message the owner actually sees, the one-boolean
 * schema, and that `accept {confirm:true}` is what produces a grant.
 */
describe('MCP owner confirmation over a real server/client pair', () => {
  it('asks the owner through elicitation and turns one accepted confirm into a grant', async () => {
    const { Server: McpServer } = await import('@modelcontextprotocol/sdk/server/index.js');
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
    const { CallToolRequestSchema: CallTool, ElicitRequestSchema } = await import('@modelcontextprotocol/sdk/types.js');
    const { createMcpOwnerAuthorization } = await import('../../src/host/mcp-owner-authorization.js');
    const bs58 = (await import('bs58')).default;

    const actorId = bs58.encode(new Uint8Array(32).fill(23));
    const house = 'http://127.0.0.1:8787';
    const box: { current?: InstanceType<typeof McpServer> } = {};
    const adapter = createMcpOwnerAuthorization({ actorId, server: box as never, duplicates: { unresolved: () => [] } });
    const seen: string[] = [];

    const server = new McpServer({ name: 'popclaw-test', version: '0' }, { capabilities: { tools: {} } });
    box.current = server;
    server.setRequestHandler(CallTool, async (req, extra) => {
      const callId = `mcp_${extra.requestId ?? Date.now()}`;
      const args = req.params.arguments as unknown as { house: string; kind: string; params: Record<string, unknown>; expected_capability_revision: string };
      try {
        const body = await adapter.withInvocation(callId, args, extra.signal,
          async ask => ({ grant: await ask.authorize(args), reference: ask.reference }));
        return { content: [{ type: 'text' as const,
          text: JSON.stringify({ job_id: body.grant.jobId, expires_at: body.grant.expiresAt, reference: body.reference }) }] };
      } catch (error) {
        return { content: [{ type: 'text' as const, text: String(error) }], isError: true };
      }
    });

    const client = new Client({ name: 'vitest-host', version: '0' }, { capabilities: { elicitation: { form: {} } } });
    const confirmDescriptions: string[] = [];
    client.setRequestHandler(ElicitRequestSchema, request => {
      seen.push(request.params.message);
      // The SDK's params are a union (form vs url mode); a URL-mode ask would be
      // the wrong dialog entirely, so narrowing here is also an assertion.
      if (!('requestedSchema' in request.params)) throw new Error('EXPECTED_FORM_ELICITATION');
      // Every host gets the same form: the explanation is the message, and the
      // one input is the confirmation — no text box whose answer is ignored.
      const properties = request.params.requestedSchema.properties as Record<string, { description: string }>;
      confirmDescriptions.push(properties['confirm']!.description);
      expect(request.params.requestedSchema).toEqual({
        type: 'object',
        properties: {
          confirm: { type: 'boolean', default: false, title: 'Approve this action', description: properties['confirm']!.description },
        },
        required: ['confirm'],
      });
      return { action: 'accept' as const, content: { confirm: true } };
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    try {
      const result = await client.callTool({ name: 'popclaw_world_invoke',
        arguments: { house, kind: 'rangermap.check_in', params: { spot: 'north gate' }, expected_capability_revision: 'c'.repeat(64) } });
      expect(result.isError).toBeFalsy();
      const body = JSON.parse((result.content as Array<{ text: string }>)[0]!.text) as { job_id: string; expires_at: number; reference: string };
      expect(body.job_id).toMatch(/^mcp-owner:[0-9a-f]{16}$/);
      expect(body.expires_at).toBeGreaterThan(Math.floor(Date.now() / 1000));
      // The correlation reference, over a real pair: what the owner read in the
      // dialog and what came back with the grant are the same six characters,
      // cut from the one nonce that also became the job id.
      expect(body.reference).toMatch(/^[0-9a-f]{6}$/);
      expect(body.job_id).toBe(`mcp-owner:${body.reference}${body.job_id.slice(-10)}`);
      expect(confirmDescriptions).toEqual([
        `Runs the world action described above, once (ref ${body.reference}). Decline or cancel and nothing happens.`]);
      // The whole message the owner reads, over the real pair: the four fixed
      // facts on the first line, then each in full, every parameter on a `> `
      // line, the reference and the deadline.
      expect(seen[0]!.split('\n')).toEqual([
        `rangermap.check_in at 127.0.0.1:8787 as ${actorId.slice(0, 6)}… cap cccccc…`,
        'PopClaw: confirm world action',
        `House: ${house}`,
        `Identity: ${actorId}`,
        'Action: rangermap.check_in',
        `Capability revision: ${'c'.repeat(64)}`,
        'Parameters:',
        '> spot: north gate',
        `Reference: ${body.reference}`,
        'Answer within 360 s.',
      ]);
    } finally {
      adapter.stop();
      await client.close();
      await server.close();
    }
  }, 30_000);

  it('refuses when the connected client never declared form elicitation', async () => {
    const { Server: McpServer } = await import('@modelcontextprotocol/sdk/server/index.js');
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
    const { createMcpOwnerAuthorization } = await import('../../src/host/mcp-owner-authorization.js');
    const bs58 = (await import('bs58')).default;

    const box: { current?: InstanceType<typeof McpServer> } = {};
    const adapter = createMcpOwnerAuthorization({ actorId: bs58.encode(new Uint8Array(32).fill(24)), server: box as never, duplicates: { unresolved: () => [] } });
    const server = new McpServer({ name: 'popclaw-test', version: '0' }, { capabilities: { tools: {} } });
    box.current = server;
    const client = new Client({ name: 'vitest-host', version: '0' }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    const input = { house: 'http://127.0.0.1:8787', kind: 'rangermap.check_in', params: {}, expected_capability_revision: 'c'.repeat(64) };
    try {
      expect(() => adapter.assertActive()).toThrow('OWNER_CONFIRMATION_UNAVAILABLE');
      await expect(adapter.withInvocation('mcp_1', input, undefined, async ask => ask.authorize(input)))
        .rejects.toThrow('MCP elicitation');
    } finally {
      adapter.stop();
      await client.close();
      await server.close();
    }
  }, 30_000);
});
