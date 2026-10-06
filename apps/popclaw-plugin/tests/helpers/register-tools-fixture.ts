/**
 * Shared fixture for the tool-registration tests: a fake OpenClaw `api` that
 * captures registered tools, a mock runtime, and the small stores the tool
 * cases build on. Extracted from register-tools.test.ts so the per-domain
 * tool test files use the same helpers instead of copies.
 */
import { vi } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { MasterKeySigner } from '../../src/identity/master-key-signer.js';
import type { MasterKey } from '../../src/identity/keystore.js';
import type { registerPopclawTools } from '../../src/tools/register-tools.js';
import { InMemoryHostDb } from '../../src/host/in-memory-host-db.js';
import { runMigrations } from '../../src/host/migrations.js';
import { BondsStore } from '../../src/bonds/bonds-store.js';
import { deriveSigil } from '../../src/invite/sigil.js';

// tests/helpers/ → ../../migrations.
export const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../migrations');

/** Real BondsStore over an in-memory db with the bonds migration applied. */
export function makeRealBondsStore(): BondsStore {
  const db = new InMemoryHostDb();
  runMigrations(db, MIGRATIONS_DIR);
  return new BondsStore(db, () => 1000);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function makeSigner(): MasterKeySigner {
  const seed = new Uint8Array(32);
  for (let i = 0; i < 32; i++) seed[i] = i;
  const kp = nacl.sign.keyPair.fromSeed(seed);
  const key: MasterKey = {
    seed,
    publicKey: kp.publicKey,
    secretKey: kp.secretKey,
    popclawId: bs58.encode(kp.publicKey),
  };
  return new MasterKeySigner(key);
}

/** Minimal fake WorldFeedCache that recognises a fixed item keyed by hex prefix. */
export function makeFakeCache(eventId: string = 'abcdef1234567890' + '0'.repeat(48)) {
  const item = {
    eventId,
    platform: 'x',
    platformPostId: '1234567890',
    authorPopclawId: 'pid123',
    handle: 'testuser',
    textPreview: 'hello world',
    originalUrl: null,
  };
  return {
    lookup: (_platform: string, _postId: string) => item,
    findByEventIdPrefix: (prefix: string) =>
      eventId.startsWith(prefix)
        ? { item, ambiguous: [] as string[] }
        : { item: null, ambiguous: [] as string[] },
  };
}

/** Fake MarksStore with an in-memory list. */
export function makeFakeMarksStore(rows: Array<{ eventId: string; handle: string; authorPopclawId: string; summaryLine: string; sourceUrl?: string }> = []) {
  const listActiveCalls: number[] = [];
  return {
    listActiveCalls,
    listActive: (limit: number) => {
      listActiveCalls.push(limit);
      return rows;
    },
  };
}

/** Fake MarkService that always succeeds. */
export function makeFakeMarkService() {
  return {
    mark: vi.fn(async () => ({ pushed: true, error: undefined })),
    unmark: vi.fn(async () => ({ pushed: true, wasMarked: true, error: undefined })),
  };
}

export function makeMockRuntime(overrides?: {
  worldFeedCache?: unknown;
  markService?: unknown;
  marksStore?: unknown;
  bondsStore?: unknown;
  knownFollowers?: unknown;
  egress?: { push: (bytes: Uint8Array) => Promise<unknown> };
  guideClient?: { fetchGuideText: () => Promise<string | null> };
  /** Duck-typed subset — only what `buildDoctorReport` actually reads
   *  (attach_doctor_report tests). Not a real PopclawPaths instance. */
  paths?: {
    rootDir: () => string;
    lastBuildFile: () => string;
    dbIntegrityFile: () => string;
    doctorDir: () => string;
    cadenceDir: () => string;
  };
}) {
  const worldFeedCache = overrides?.worldFeedCache ?? makeFakeCache();
  const markService = overrides?.markService ?? makeFakeMarkService();
  const marksStore = overrides?.marksStore ?? makeFakeMarksStore();
  const bondsStore = overrides?.bondsStore;
  // Hoisted out of the async closure: `runtime()` is called once per tool
  // invocation, so a spy created inside would be a fresh one every time and
  // "egress was never called" could never be asserted.
  const signer = makeSigner();
  const egress = overrides?.egress ?? {
    push: vi.fn(async (_bytes: Uint8Array) => ({ status: 200, eventId: 'deadbeef' + 'a'.repeat(56) })),
  };
  return vi.fn(async () => ({
    boot: {
      signer,
      nickname: 'TestUser',
      loreHouseUrl: 'http://localhost:9000',
      loreHouseUrls: ['http://localhost:9000'],
    },
    egress,
    host: {},
    socialGraph: {},
    // ADR-0042: 反馈工具从主坊说明书里读官方联系人。
    guideClient: overrides?.guideClient ?? { fetchGuideText: async () => null },
    worldFeedClient: {},
    // 切片④：草稿 DM 要问「他上封信从哪座坊来」；这里没来信记录 → 主坊。
    inboxStore: { houseOf: () => undefined },
    ...(overrides?.paths ? { paths: overrides.paths } : {}),
    worldFeedCache,
    markService,
    marksStore,
    bondsStore,
    ...(overrides?.knownFollowers ? { knownFollowers: overrides.knownFollowers } : {}),
    tasteLoader: {},
    cadenceLoader: {},
    scoreCache: {},
  })) as unknown as ReturnType<typeof vi.fn> &
    Parameters<typeof registerPopclawTools>[0]['runtime'];
}

/** Build a fake api that captures registered tools and returns them. */
export function buildFakeApi(toolCtx: Record<string, unknown> = {}) {
  const tools: Array<{
    name: string;
    execute: (callId: string, params: unknown) => Promise<{ type: string; text: string }>;
    // Kept so the description ↔ schema agreement can be checked (see the guard below).
    description?: string;
    parameters?: { properties?: Record<string, unknown> };
  }> = [];
  const push = (tool: { name?: string; execute?: unknown }) => {
    if (tool?.name && typeof tool.execute === 'function') {
      tools.push(tool as typeof tools[number]);
    }
  };
  const api = {
    // Handles BOTH registration shapes: the object form most tools use, and the
    // factory form `(toolCtx) => toolDef` (popclaw_newspaper / popclaw_publish_newspaper,
    // which read toolCtx.sessionKey to tell the dedicated workshop session from the
    // owner's chat). Factories are resolved with a fake tool context.
    registerTool: (tool: unknown, _opts?: unknown) => {
      const context = {agentId: 'main-agent', config: {fake: true}, sessionKey: 'agent:main:fixture',
        sessionId: 'fixture-session', senderIsOwner: true, assertInvocationCurrent: () => {}, ...toolCtx};
      const descriptor = tool as {contextVersion?: number; create?: (ctx: unknown) => unknown};
      const resolved = typeof tool === 'function' ? tool(context)
        : descriptor?.contextVersion === 2 ? descriptor.create!(context) : tool;
      if (Array.isArray(resolved)) resolved.forEach((t) => push(t as { name?: string; execute?: unknown }));
      else push(resolved as { name?: string; execute?: unknown });
    },
  } as Parameters<typeof registerPopclawTools>[0]['api'];
  return { api, tools };
}

export function findTool(tools: ReturnType<typeof buildFakeApi>['tools'], name: string) {
  const t = tools.find((t) => t.name === name);
  if (!t) throw new Error(`tool not found: ${name}`);
  return t;
}

/** 收件人（真公钥，seed=7）+ 已登记名号的 bondsStore。 */
export function makeImageDmFixture() {
  const bondsStore = makeRealBondsStore();
  const kp = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7));
  const recipientId = bs58.encode(kp.publicKey);
  bondsStore.setNickname(recipientId, 'Blackfeather');
  const recipient = new MasterKeySigner({
    seed: new Uint8Array(32).fill(7),
    publicKey: kp.publicKey,
    secretKey: kp.secretKey,
    popclawId: recipientId,
  });
  const push = vi.fn(async (_bytes: Uint8Array) => ({ status: 200, eventId: 'ab'.repeat(32) }));
  return {
    bondsStore,
    recipient,
    recipientRef: `Blackfeather#${deriveSigil(recipientId)}`,
    push,
    runtime: makeMockRuntime({ bondsStore, egress: { push } }),
  };
}
