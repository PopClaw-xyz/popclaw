/**
 * `popclaw_house_entry_link` on a machine with two identities.
 *
 * The running instance lives at `POPCLAW_DATA_ROOT` (A). A second, fully
 * legitimate identity sits at the default location under the same HOME (B,
 * the "shadow root"). The link this tool mints is a login key, so it has to be
 * A's — and the process has no business even opening B's private key to find
 * that out. This boots through the production seam (the OpenClaw host adapter
 * and `bootstrapPlugin`), not a hand-built signer, so the identity under test
 * is whichever key the real path chose.
 *
 * Every fs call that could read or open a file is recorded, and the record is
 * shown to catch A's key being read — so "B was never read" is not vacuous.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import nacl from 'tweetnacl';
import bs58 from 'bs58';

// Every read/open entry point node:fs offers, recorded by resolved path.
const touched = vi.hoisted(() => [] as string[]);
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const { resolve: res } = await import('node:path');
  const note = (p: unknown): void => {
    if (typeof p === 'string' || p instanceof URL || Buffer.isBuffer(p)) touched.push(res(String(p instanceof URL ? p.pathname : p)));
  };
  const wrap = <F extends (...a: never[]) => unknown>(f: F): F =>
    ((...a: Parameters<F>) => (note(a[0]), f(...a))) as unknown as F;
  const promises = {
    ...actual.promises,
    readFile: wrap(actual.promises.readFile),
    open: wrap(actual.promises.open),
  };
  const patched = {
    ...actual,
    promises,
    readFileSync: wrap(actual.readFileSync),
    readFile: wrap(actual.readFile),
    openSync: wrap(actual.openSync),
    open: wrap(actual.open),
    createReadStream: wrap(actual.createReadStream),
  };
  return { ...patched, default: patched };
});

import { createOpenClawHostAdapter } from '../../../src/host/openclaw-host-adapter.js';
import { bootstrapPlugin } from '../../../src/runtime/plugin-bootstrap.js';
import { PopclawPaths } from '../../../src/host/popclaw-paths.js';
import { beginHouseAdd, commitEstablishAndActivate, prepareHouseTrust } from '../../../src/world/house-trust.js';
import { registerHouseEntryTools } from '../../../src/tools/house-entry-tools.js';
import { _draftsForTest } from '../../../src/tools/draft-store.js';
import { BROWSER_ENTRY_PROFILE } from '../../../src/identity/browser-entry.js';
import { verifyBrowserEntryToken } from '../../helpers/browser-entry-verifier.js';
import { mintHouse } from '../../helpers/signed-manifest.js';
import type { HostDb } from '../../../src/host/host-db.js';
import type { ToolsCtx } from '../../../src/tools/tools-context.js';

const HOUSE = 'https://house.example';
const APP = 'https://app.example';
const NOW = 1_789_000_000;
const ENTRY = { profile: BROWSER_ENTRY_PROFILE, audience: APP, entry_url: `${APP}/welcome`, shorten_url: `${APP}/api/shorten` };

/** Writes a master.key for a fixed seed under `root` and returns its identity. */
function plantIdentity(root: string, fill: number) {
  const seed = new Uint8Array(32).fill(fill);
  const kp = nacl.sign.keyPair.fromSeed(seed);
  const popclawId = bs58.encode(kp.publicKey);
  const keyPath = join(new PopclawPaths(root).identityDir(), 'master.key');
  mkdirSync(dirname(keyPath), { recursive: true, mode: 0o700 });
  const body = { version: 1, type: 'master-raw-seed', created_at: '2026-01-01T00:00:00.000Z', public_key: popclawId, seed: Buffer.from(seed).toString('hex') };
  writeFileSync(keyPath, JSON.stringify(body), { mode: 0o600 });
  // A complete install, so a mis-rooted boot fails on identity, not on a missing config.
  mkdirSync(new PopclawPaths(root).config(), { recursive: true });
  writeFileSync(new PopclawPaths(root).configFile('plugin'), JSON.stringify({ lore_houses: [HOUSE] }));
  return { popclawId, publicKey: kp.publicKey, keyPath: resolve(keyPath) };
}

const savedEnv = { HOME: process.env.HOME, POPCLAW_DATA_ROOT: process.env.POPCLAW_DATA_ROOT };
let tmp: string;
let db: HostDb | undefined;

beforeEach(() => {
  _draftsForTest.clear();
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'popclaw-shadow-')));
});
afterEach(() => {
  _draftsForTest.clear();
  (db as { close?: () => void } | undefined)?.close?.();
  db = undefined;
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(tmp, { recursive: true, force: true });
});

describe('a machine with a second identity at the default root', () => {
  it("house entry link uses the running instance's identity and never reads a shadow root's key", async () => {
    const home = join(tmp, 'home');
    process.env.HOME = home;
    // OpenClaw's state dir is ~/.openclaw; the default root is <stateDir>/popclaw.
    const stateDir = join(homedir(), '.openclaw');
    const shadowRoot = PopclawPaths.resolveRoot({}, stateDir);
    expect(shadowRoot.startsWith(`${tmp}/`)).toBe(true);
    const b = plantIdentity(shadowRoot, 0xbb);
    expect(b.keyPath).toBe(join(home, '.openclaw/popclaw/vault/social/identity/master.key'));

    const rootA = join(tmp, 'instance-a');
    process.env.POPCLAW_DATA_ROOT = rootA;
    const a = plantIdentity(rootA, 0xaa);
    expect(a.popclawId).not.toBe(b.popclawId);

    touched.length = 0;
    const api = { runtime: { state: { resolveStateDir: () => stateDir } } };
    const host = createOpenClawHostAdapter(api as never);
    db = host.db;
    const boot = await bootstrapPlugin(host, stateDir);

    const house = mintHouse({ origin: HOUSE, seed: 1, manifest: { browser_entry: ENTRY } });
    const prepared = await prepareHouseTrust(host.db, HOUSE, {
      fetch: house.fetch as typeof globalThis.fetch,
      attempt: beginHouseAdd(host.db, HOUSE),
      now: () => 1_700_000_000,
    });
    if (!prepared.ok) throw new Error('fixture house did not verify');
    if (!commitEstablishAndActivate(host.db, prepared.prepared, { now: () => 1_700_000_000 }).ok) throw new Error('fixture house did not commit');

    const post = vi.fn(async (..._args: unknown[]) => ({ status: 200, text: JSON.stringify({ url: `${APP}/w/abc123` }) }));
    const runtime = (async () => ({ boot, host })) as unknown as ToolsCtx['runtime'];
    const tools: Array<{ execute: (id: string, p: unknown) => Promise<{ text: string }> }> = [];
    const toolApi = { registerTool: (t: unknown) => tools.push(t as (typeof tools)[number]) };
    registerHouseEntryTools({ api: toolApi, runtime, deps: { api: toolApi, runtime }, total: 0 } as unknown as ToolsCtx, {
      postJson: post as never,
      nowSeconds: () => NOW,
    });

    // Preview: the identity it would log in as is A's.
    const preview = (await tools[0]!.execute('c', { house: 'house.example' })).text;
    expect(/#\S+ \(([1-9A-HJ-NP-Za-km-z]+)\)/.exec(preview)?.[1]).toBe(a.popclawId);
    expect(preview).not.toContain(b.popclawId);

    // Issuance: the pcw2 payload names A and verifies under A's key.
    const token = /confirm_token: (\S+)/.exec(preview)![1]!;
    await tools[0]!.execute('c', { confirm_token: token });
    const minted = (JSON.parse(post.mock.calls[0]![2] as string) as { token: string }).token;
    const [, payloadSeg, sigSeg] = minted.split('.') as [string, string, string];
    const payload = JSON.parse(Buffer.from(payloadSeg, 'base64url').toString('utf8')) as Record<string, unknown>;
    expect(payload['popclaw_id']).toBe(a.popclawId);
    const verdict = verifyBrowserEntryToken(minted, { audience: APP, nowSeconds: NOW });
    expect(verdict.ok && verdict.claims['popclaw_id']).toBe(a.popclawId);
    // Control: the same signature does not hold under B's key.
    const signed = Buffer.concat([Buffer.from([0]), Buffer.from('POPCLAW_BROWSER_ENTRY_V2'), Buffer.from([0]), Buffer.from(payloadSeg, 'base64url')]);
    const sig = new Uint8Array(Buffer.from(sigSeg, 'base64url'));
    expect(nacl.sign.detached.verify(new Uint8Array(signed), sig, a.publicKey)).toBe(true);
    expect(nacl.sign.detached.verify(new Uint8Array(signed), sig, b.publicKey)).toBe(false);

    // The spy sees key reads (A's), and never saw B's.
    expect(touched).toContain(a.keyPath);
    expect(touched).not.toContain(b.keyPath);
  });
});
