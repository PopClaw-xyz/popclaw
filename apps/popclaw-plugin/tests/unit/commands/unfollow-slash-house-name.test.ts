/**
 * R5-A2 (a): the slash `/popclaw unfollow` names the house the revoke landed
 * on by its display name — driven through the real subcommand map, router
 * and unfollow command (nothing mocked but the runtime's social graph).
 *
 * The fixture keeps the three candidate strings apart so the assertion shows
 * which one reached the receipt: the stored slug, the URL host (the fallback
 * when no handshake name exists) and the handshake's self-reported name.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { buildSubcommands, type SubcommandWiring } from '../../../src/commands/wiring.js';
import { routeSubcommand } from '../../../src/commands/popclaw-router.js';
import { PopclawPaths } from '../../../src/host/popclaw-paths.js';
import { renderCopy } from '../../../src/lexicon/index.js';
import { setOwnerLang } from '../../../src/lexicon/owner-language.js';

const HOUSE_URL = 'https://north-gate.example:8443';
const HOST = 'north-gate.example:8443';
const SLUG = 'north-gate-example-8443';
const NAME = 'Lamplight Hall';
const TARGET = 'id_target';

let root: string;
let paths: PopclawPaths;

beforeEach(() => {
  setOwnerLang('en', 'config');
  root = mkdtempSync(join(tmpdir(), 'popclaw-unfollow-slash-'));
  paths = new PopclawPaths(root);
  const file = paths.houseHandshakeFile(SLUG);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ house_name: NAME, official_ids: [], fetched_at: 0 }));
});
afterEach(() => {
  setOwnerLang(undefined);
  rmSync(root, { recursive: true, force: true });
});

describe('slash unfollow — accepted receipt names the house (real command)', () => {
  it('shows the handshake name, not the slug or the URL host', async () => {
    const revoke = vi.fn(async () => ({ mode: 'ordered', transport: 'accepted', houseSlug: SLUG }));
    const runtime = vi.fn(async () => ({
      boot: { popclawId: 'OWNER', loreHouseUrls: [HOUSE_URL] },
      paths,
      socialGraph: { following: () => [{ popclawId: TARGET }], revokeFollowWithOutcome: revoke },
      bondsStore: { setFollowed: vi.fn() },
    }));
    const result = (await routeSubcommand(
      buildSubcommands({ runtime } as unknown as SubcommandWiring),
      { args: { positional: ['unfollow', TARGET] } },
    )) as { text: string; house?: string };

    expect(revoke).toHaveBeenCalledWith(TARGET);
    expect(result.house).toBe(NAME);
    expect(result.text).toBe(`✓ ${renderCopy('en', 'relation.unfollowReceived', { who: TARGET, house: NAME })}`);
    expect(result.text).not.toContain(SLUG);
    expect(result.text).not.toContain(HOST);
    expect(Object.keys(result)).toEqual(['text', 'house']);
    expect(runtime).toHaveBeenCalledTimes(2);
  });
});
