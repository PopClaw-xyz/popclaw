import { createServer, type ServerResponse } from 'node:http';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { popclaw } from '@popclaw/contracts';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { MasterKeySigner } from '../../src/identity/master-key-signer.js';
import { readCredentialMessage } from '../../src/identity/read-credential.js';
import { seedTrustedHouse, SEEDED_HOUSE_KEY } from './seed-trusted-house.js';

export const pluginRoot = fileURLToPath(new URL('../../', import.meta.url));
export function seedIdentity(root: string, house: string, nickname: string) {
  if (existsSync(join(root, 'vault/social/identity/master.key'))) throw new Error('Refusing to replace an existing test identity');
  const seed = nacl.randomBytes(32);
  const kp = nacl.sign.keyPair.fromSeed(seed);
  const id = bs58.encode(kp.publicKey);
  mkdirSync(join(root, 'vault/social/identity'), { recursive: true });
  mkdirSync(join(root, 'config/cadence'), { recursive: true });
  writeFileSync(join(root, 'vault/social/identity/master.key'), JSON.stringify({ version: 1, type: 'master-raw-seed', created_at: new Date().toISOString(), public_key: id, seed: Buffer.from(seed).toString('hex') }), { mode: 0o600 });
  writeFileSync(join(root, 'config/plugin.json'), JSON.stringify({ lore_houses: [house], nickname }));
  writeFileSync(join(root, 'config/cadence/cadence.json'), JSON.stringify({ schemaVersion: 1, delivery: { primaryLanguage: 'en' }, notifications: { vipExternalFollowerThreshold: 100 } }));
  // A modern house this machine has already trusted. Without both halves the
  // inbox stream refuses to open and every handoff here goes quiet.
  seedTrustedHouse(root, house);
  return { id, root, signer: new MasterKeySigner({ seed, publicKey: kp.publicKey, secretKey: kp.secretKey, popclawId: id }) };
}

/** A local test relay, not lore-house or a host simulator. Uses real HTTP/SSE. */
export async function startTestRelay() {
  const frames = new Map<string, Uint8Array>();
  const streams = new Map<string, Set<ServerResponse>>();
  const identities = new Set<string>();
  const emit = (bytes: Uint8Array) => {
    const env = popclaw.event.EventEnvelope.decode(bytes);
    if (!env.directMessage) return;
    frames.set(env.eventId, bytes);
    for (const stream of streams.get(env.directMessage.toPopclawId ?? '') ?? []) stream.write(`event: envelope\ndata: ${Buffer.from(bytes).toString('base64')}\n\n`);
  };
  // Filled in once the port is known; every request that reads it arrives
  // after listen(), so the credential is always checked against a real origin.
  let relayOrigin = '';
  const server = createServer(async (req, res) => {
    const path = new URL(req.url!, 'http://127.0.0.1').pathname;
    const match = /^\/inbox\/([^/]+)\/stream$/.exec(path);
    if (match) {
      const id = match[1]!;
      // `popclaw-identity-read-v2`, four segments, exact count. The purpose
      // and the audience never ride on the wire — this relay rebuilds them
      // from what it is (the inbox route, its own origin and key), which is
      // the same thing the real house does and the only way a wrong purpose
      // gets caught rather than accepted.
      const parts = String(req.headers['x-popclaw-inbox-token'] ?? '').split('.');
      const [version, tokenId, ts, sig] = parts;
      let valid = false;
      try {
        const expected = readCredentialMessage(
          'inbox-stream', id, { origin: relayOrigin, houseKey: SEEDED_HOUSE_KEY }, Number(ts),
        );
        valid = parts.length === 4 && version === 'v2' && tokenId === id
          && Math.abs(Date.now() / 1000 - Number(ts)) <= 60
          && nacl.sign.detached.verify(Buffer.from(expected), Buffer.from(sig!, 'base64'), bs58.decode(id));
      } catch { /* invalid token */ }
      if (!valid || !identities.has(id)) { res.writeHead(401).end(); return; }
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      res.write(': test relay\n\n');
      const bucket = streams.get(id) ?? new Set(); bucket.add(res); streams.set(id, bucket);
      for (const bytes of frames.values()) if (popclaw.event.EventEnvelope.decode(bytes).directMessage?.toPopclawId === id) res.write(`event: envelope\ndata: ${Buffer.from(bytes).toString('base64')}\n\n`);
      req.on('close', () => bucket.delete(res)); return;
    }
    if (path === '/v1/push' && req.method === 'POST') {
      const chunks = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const signed = popclaw.identity.SignedPayload.decode(Buffer.concat(chunks));
      const bytes = signed.payload;
      const env = popclaw.event.EventEnvelope.decode(bytes);
      if (!nacl.sign.detached.verify(bytes, signed.signature, signed.signerPubkey)) { res.writeHead(401).end(); return; }
      if (!identities.has(env.actor?.popclawId ?? '')) { res.writeHead(403).end(); return; }
      emit(bytes); res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ event_id: env.eventId })); return;
    }
    if (path.startsWith('/v1/profile/')) {
      const id = path.split('/').at(-1)!;
      if (identities.has(id)) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ popclaw_id: id, profiles: [{ follower_count: 200 }] })); return; }
    }
    res.writeHead(404).end('{}');
  });
  await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  const port = (server.address() as { port: number }).port;
  relayOrigin = `http://127.0.0.1:${port}`;
  return { url: relayOrigin, identities, frames, streams, emit,
    async close() { for (const set of streams.values()) for (const res of set) res.end(); server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done())); },
  };
}

/**
 * How this client answers the owner-approval dialog the root raises before it
 * dispatches a tool body (`src/host/mcp-owner-approval.ts`).
 *
 * `undefined` is the pre-2026-09-22 client: it declares no form elicitation at
 * all, so the root cannot ask and the seam reports APPROVAL_SURFACE_ABSENT.
 * That is a real host configuration, not a test artefact, which is why it
 * stays the default and gets tests of its own.
 */
export type ElicitationAnswer = 'approve' | 'decline' | 'cancel';

export interface ConnectMcpOptions {
  /** Declare form elicitation and answer every approval dialog this way. */
  readonly answerApprovals?: ElicitationAnswer;
}

export async function connectMcp(root: string, consumer: string, options: ConnectMcpOptions = {}) {
  const transport = new StdioClientTransport({ command: process.execPath,
    args: ['--import', join(pluginRoot, 'node_modules/tsx/dist/loader.mjs'), resolve(pluginRoot, 'src/mcp.ts')], cwd: pluginRoot,
    env: { ...Object.fromEntries(Object.entries(process.env).filter((p): p is [string, string] => p[1] !== undefined)), POPCLAW_DATA_ROOT: root, POPCLAW_NOTIFICATION_CONSUMER: consumer, POPCLAW_RECEIVE_ON_START: '1' }, stderr: 'pipe',
  });
  // Mutable so one connected client can answer differently over its life —
  // the way a person does. It is what lets a test prove a declined draft is
  // still there by approving the very same draft a moment later.
  let answer = options.answerApprovals;
  const client = answer === undefined
    ? new Client({ name: 'popclaw-handoff-test', version: '1' })
    : new Client({ name: 'popclaw-handoff-test', version: '1' }, { capabilities: { elicitation: { form: {} } } });
  /** Every dialog this client was shown, so a test can assert the owner was
   *  really asked and read what they were asked about. */
  const dialogs: Array<{ message: string; rows: string[]; shown: string }> = [];
  if (answer !== undefined) {
    const { ElicitRequestSchema } = await import('@modelcontextprotocol/sdk/types.js');
    client.setRequestHandler(ElicitRequestSchema, (req) => {
      // The owner-approval dialog puts everything in the message and asks one
      // confirmation; the world dialog still lays parameters out as fields on
      // a folding client. A test that wants to know what the owner READ has to
      // look at both.
      const params = req.params as { message?: unknown; requestedSchema?: { properties?: Record<string, { description?: unknown }> } };
      const rows = Object.entries(params.requestedSchema?.properties ?? {})
        .filter(([key]) => key !== 'confirm')
        .map(([, field]) => String(field?.description ?? ''));
      const message = String(params.message ?? '');
      dialogs.push({ message, rows, shown: [message, ...rows].join('\n') });
      // An accepted form with the box unchecked is a refusal, not consent —
      // so `approve` is the only branch that ticks it.
      if (answer === 'approve') return { action: 'accept' as const, content: { confirm: true } };
      if (answer === 'decline') return { action: 'decline' as const };
      return { action: 'cancel' as const };
    });
  }
  await client.connect(transport);
  return { client, transport, dialogs,
    /** How the owner answers from now on. Only meaningful for a client that
     *  declared form elicitation when it connected — capability is negotiated
     *  once, and pretending otherwise would be testing a host that cannot
     *  exist. */
    answerApprovalsWith(next: ElicitationAnswer): void {
      if (answer === undefined) throw new Error('This client declared no elicitation capability; reconnect with answerApprovals');
      answer = next;
    },
    call: (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args }),
    close: () => client.close() };
}
