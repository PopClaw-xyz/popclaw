/**
 * R5-A2 (b): the popclaw_unfollow tool reads the house name when it runs, not
 * when the tool was registered. The handshake cache is written only AFTER
 * registration and then changed between two calls; each receipt must show the
 * name on disk at that moment, and a handshake name wins over the URL host
 * fallback that is also available. Real unfollow command; synthetic runtime.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { registerPopclawTools } from '../../../src/tools/register-tools.js';
import { PopclawPaths } from '../../../src/host/popclaw-paths.js';
import { renderCopy } from '../../../src/lexicon/index.js';
import { setOwnerLang } from '../../../src/lexicon/owner-language.js';
import type { ResolveCandidate } from '../../../src/identity/follow-resolution.js';

const HOUSE_URL = 'https://north-gate.example:8443';
const HOST = 'north-gate.example:8443';
const SLUG = 'north-gate-example-8443';
const ELON: ResolveCandidate = { popclawId: 'id_elon', nickname: 'Elon Musk', sigil: '4f68bd', profiles: [] };

type Tool = { name: string; execute: (c: string, p: unknown) => Promise<{ type: string; text: string }> };

let root: string;
let paths: PopclawPaths;

beforeEach(() => {
  setOwnerLang('en', 'config');
  root = mkdtempSync(join(tmpdir(), 'popclaw-unfollow-tool-'));
  paths = new PopclawPaths(root);
});
afterEach(() => {
  setOwnerLang(undefined);
  rmSync(root, { recursive: true, force: true });
});

function writeHandshakeName(name: string): void {
  const file = paths.houseHandshakeFile(SLUG);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ house_name: name, official_ids: [], fetched_at: 0 }));
}

function registerUnfollowTool() {
  const tools: Tool[] = [];
  const api = {
    registerTool: (tool: { name?: string; execute?: unknown }) => {
      if (tool?.name && typeof tool.execute === 'function') tools.push(tool as Tool);
    },
    logger: { info: vi.fn() },
  } as Parameters<typeof registerPopclawTools>[0]['api'];
  const runtime = vi.fn(async () => ({
    boot: { popclawId: 'owner-id', loreHouseUrls: [HOUSE_URL] },
    paths,
    socialGraph: {
      activeFollowHouses: async () => ({ houses: ['synthetic-house'] }),
      following: () => [{ popclawId: 'id_elon' }],
      revokeFollowWithOutcome: async () => ({ mode: 'ordered', transport: 'accepted', houseSlug: SLUG }),
    },
    bondsStore: { setFollowed: vi.fn() },
  }));
  registerPopclawTools({
    api,
    runtime: runtime as unknown as Parameters<typeof registerPopclawTools>[0]['runtime'],
    getWorldDeps: async () =>
      ({
        guideClient: { fetchGuideText: async () => '' },
        summaryClient: { fetchSummary: async () => null },
        snapshotClient: { fetchSnapshot: async () => [] },
        resolveClient: { resolve: async () => [ELON] },
        webBaseUrl: 'http://localhost:3000',
      }) as never,
  });
  const tool = tools.find((t) => t.name === 'popclaw_unfollow')!;
  return () => tool.execute('cid', { name: '#4f68bd' });
}

const receipt = (house: string) =>
  renderCopy('en', 'relation.unfollowReceived', { who: 'Elon Musk#4f68bd', house }) + '\n' +
  renderCopy('en', 'relation.unfollowRemaining', { who: 'Elon Musk#4f68bd' });

describe('popclaw_unfollow tool — house name read at call time (R5-A2)', () => {
  it('a handshake written or changed after registration is what the receipt shows', async () => {
    const unfollow = registerUnfollowTool();

    writeHandshakeName('Lamplight Hall');
    const first = await unfollow();
    expect(first.text).toBe(receipt('Lamplight Hall'));
    expect(first.text).not.toContain(HOST);
    expect(first.text).not.toContain(SLUG);

    writeHandshakeName('Lamplight Hall Renamed');
    const second = await unfollow();
    expect(second.text).toBe(receipt('Lamplight Hall Renamed'));
  });
});
