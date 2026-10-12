import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ServerPushEgress } from '../../src/egress/server-push-egress.js';
import { runPopclawReplyCommand } from '../../src/commands/popclaw-reply.js';
import { runPopclawMarkCommand, runPopclawUnmarkCommand } from '../../src/commands/popclaw-mark.js';
import { MarkService } from '../../src/marks/mark-service.js';
import { MarksStore } from '../../src/marks/marks-store.js';
import { InMemoryHostDb } from '../../src/host/in-memory-host-db.js';
import { runMigrations } from '../../src/host/migrations.js';
import { OnboardingDiscovery, type DiscoveryDeps } from '../../src/onboarding/discovery.js';
import { sendSocialDraft } from '../../src/tools/draft-send-plan.js';
import type { DraftSnapshot } from '../../src/tools/draft-store.js';
import type { PluginRuntime } from '../../src/runtime/plugin-runtime.js';
import { setOwnerLang } from '../../src/lexicon/owner-language.js';
import { makeTestSigner } from '../helpers/test-signer.js';

const migrations = resolve(dirname(fileURLToPath(import.meta.url)), '../../migrations');
const item = {
  eventId: 'a'.repeat(64), platform: 'x', platformPostId: '123',
  authorPopclawId: 'SyntheticAuthor', handle: 'Author', textPreview: 'Synthetic source',
  originalUrl: 'https://example.invalid/post/123', houseSlug: 'source-house',
  platformPostCreatedAt: 1_700_000_000,
};
const servers: Server[] = [];
const databases: InMemoryHostDb[] = [];
const roots: string[] = [];
beforeEach(() => setOwnerLang('en', 'config'));
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  })));
  databases.splice(0).forEach(db => db.close());
  roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true }));
  setOwnerLang(undefined);
});

async function house(status: number, deduplicated = false) {
  const received: Buffer[] = [];
  const server = createServer(async (req, res) => {
    expect(req.url).toBe('/v1/push');
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    received.push(Buffer.concat(chunks));
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(status === 200
      ? { event_id: 'b'.repeat(64), deduplicated }
      : { error: 'synthetic conflict' }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  servers.push(server);
  const egress = new ServerPushEgress({ baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}` });
  return { egress, received };
}

function markService(egress: ServerPushEgress) {
  const db = new InMemoryHostDb();
  databases.push(db);
  runMigrations(db, migrations);
  const store = new MarksStore(db);
  const tasteRoot = mkdtempSync(join(tmpdir(), 'popclaw-receipts-'));
  roots.push(tasteRoot);
  const service = new MarkService({ store, signer: makeTestSigner('BlackFeather'), egress, nickname: 'Owner', taste: { tasteRoot } });
  return { service, store, tasteRoot };
}

describe('reply and mark outcomes from real HTTP receipts', () => {
  it.each([409, 200])('reply command reports HTTP %i without inventing delivery', async status => {
    const h = await house(status, true);
    const socialLog = { record: vi.fn() };
    const reply = await runPopclawReplyCommand({ positional: ['x:123', 'Synthetic reply'] }, {
      signer: makeTestSigner('BlackFeather'), nickname: 'Owner', egress: h.egress, cache: { lookup: () => item }, socialLog,
    });
    expect(h.received).toHaveLength(1);
    if (status === 409) {
      expect(reply).toMatchObject({ isError: true });
      expect(reply.text).toContain('not delivered');
      expect(reply.text).toContain('409');
      expect(reply.text).toContain('synthetic conflict');
      expect(socialLog.record).not.toHaveBeenCalled();
    } else {
      expect(reply.text).toContain('replied on PopClaw');
      expect(socialLog.record).toHaveBeenCalledOnce();
      expect(socialLog.record).toHaveBeenCalledWith(expect.objectContaining({ kind: 'reply_sent', text: 'Synthetic reply' }));
    }
  });

  it.each([409, 200])('restored reply draft propagates HTTP %i to its caller', async status => {
    const h = await house(status);
    const socialLog = { record: vi.fn() };
    const snapshot: DraftSnapshot = {
      kind: 'reply', target: 'x:123', body: 'Synthetic restored reply', house: item.houseSlug,
      sendPlan: { nickname: 'Owner', replySource: item },
      attachments: [], preview: null, output: null,
    };
    const reply = await sendSocialDraft(snapshot, {
      boot: { signer: makeTestSigner('BlackFeather') }, socialLog,
      egress: { pushTo: (_house: string | undefined, bytes: Uint8Array) => h.egress.push(bytes) },
    } as unknown as PluginRuntime);
    expect(h.received).toHaveLength(1);
    expect(reply.text).toContain(status === 409 ? 'not delivered' : 'replied on PopClaw');
    if (status === 409) expect(reply).toMatchObject({ isError: true });
    expect(socialLog.record).toHaveBeenCalledTimes(status === 409 ? 0 : 1);
  });

  it.each([409, 200])('mark and unmark keep local intentions and report HTTP %i', async status => {
    const h = await house(status, true);
    const m = markService(h.egress);
    const cache = { lookup: () => item, findByEventIdPrefix: () => ({ item, ambiguous: [] }) };
    const socialLog = { record: vi.fn() };
    const result = await runPopclawMarkCommand({ positional: ['x:123'] }, { cache, markService: m.service, socialLog });
    expect(m.store.has(item.eventId)).toBe(true);
    expect(JSON.parse(readFileSync(join(m.tasteRoot, 'learned', 'picks.jsonl'), 'utf8').trim())).toMatchObject({ eventId: item.eventId, signal: 'saved' });
    expect(result.text).toContain(status === 409 ? 'push failed' : 'got a +1');
    if (status === 409) { expect(result.text).toContain('409'); expect(result.text).toContain('synthetic conflict'); }
    const revoked = await runPopclawUnmarkCommand({ positional: ['x:123'] }, { cache, store: m.store, markService: m.service, socialLog });
    expect(m.store.has(item.eventId)).toBe(false);
    expect(revoked.text.includes('push failed')).toBe(status === 409);
    expect(h.received).toHaveLength(2);
    expect(socialLog.record.mock.calls.map(([entry]) => entry.kind)).toEqual(['mark_added', 'mark_removed']);
  });

  it.each([409, 200])('onboarding mark reports local-only state for HTTP %i', async status => {
    const h = await house(status);
    const m = markService(h.egress);
    const recordDone = vi.fn();
    const discovery = new OnboardingDiscovery({
      markService: m.service, recordDone,
      drafts: () => ({ lantern: { entries: [{ eventId: item.eventId, authorPopclawId: item.authorPopclawId,
        nickname: item.handle, platform: item.platform, bodyPreview: item.textPreview, replyCount: 0, line: 'Synthetic source' }] } }),
    } as unknown as DiscoveryDeps);
    const result = await discovery.answerLantern('mark 1');
    expect(result).toHaveProperty('text');
    if (!('text' in result)) throw new Error('expected mark receipt');
    expect(result.text.includes('retry')).toBe(status === 409);
    expect(result.text.includes('receives a +1')).toBe(status === 200);
    expect(m.store.has(item.eventId)).toBe(true);
    expect(recordDone).toHaveBeenCalledOnce();
    expect(h.received).toHaveLength(1);
  });
});
