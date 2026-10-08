import { afterEach, describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { sigil, SIGIL_LEN, normalizeSigilInput } from '@popclaw/algorithms';
import { InMemoryHostAdapter, InMemoryLogger } from '../../src/host/host-adapter.in-memory.js';
import { LocalHostAdapter } from '../../src/host/local-host-adapter.js';
import { Keystore } from '../../src/identity/keystore.js';
import { bootstrapPlugin } from '../../src/runtime/plugin-bootstrap.js';

const scratch: string[] = [];
const localHosts: LocalHostAdapter[] = [];
function localHost(root: string, logger = new InMemoryLogger()) {
  const host = new LocalHostAdapter({ dataRoot: root, logger }); localHosts.push(host); return host;
}
afterEach(() => {
  for (const host of localHosts.splice(0)) host.db.close();
  while (scratch.length) rmSync(scratch.pop()!, { recursive: true, force: true });
});

describe('Scenario 6: identity persistence + sigil', () => {
  it('restart loads the same popclawId', async () => {
    const host = new InMemoryHostAdapter();
    const first = await new Keystore(host).loadOrGenerate();
    // Simulate restart — new Keystore instance, same host.
    const second = await new Keystore(host).loadOrGenerate();
    expect(second.popclawId).toBe(first.popclawId);
    expect(Array.from(second.seed)).toEqual(Array.from(first.seed));
  });

  it('sigil from plugin-side popclawId matches the shared algorithm', async () => {
    const host = new InMemoryHostAdapter();
    const key = await new Keystore(host).loadOrGenerate();
    const s = sigil(key.popclawId);
    expect(s).toHaveLength(SIGIL_LEN);
    expect(normalizeSigilInput(s)).toBe(s); // valid Crockford base32
    // Determinism check: running twice on the same input is stable.
    expect(sigil(key.popclawId)).toBe(s);
  });

  // Admission now refuses a second host while the first schema is incomplete,
  // rather than interpreting that keyless schema as a fresh identity. Within
  // the admitted first runtime the existing O_EXCL key contract still converges.
  it('concurrent identity creation in the admitted first runtime and subsequent hosts converges on one identity', async () => {
    const root = mkdtempSync(join(tmpdir(), 'popclaw-concurrent-'));
    scratch.push(root);
    const first = localHost(root);
    expect(() => localHost(root)).toThrow('STORAGE_IDENTITY_MISSING');
    const keys = await Promise.all([0, 1, 2].map(() => new Keystore(first).loadOrGenerate()));

    const ids = new Set(keys.map((k) => k.popclawId));
    expect(ids.size).toBe(1); // one winner, the losers adopted it
    expect(keys.filter((k) => k.generated)).toHaveLength(1);
    // The adopted seed must be the winner's, not the loser's discarded bytes.
    const persisted = await new Keystore(first).loadOrGenerate();
    for (const k of keys) expect(Array.from(k.seed)).toEqual(Array.from(persisted.seed));
    await bootstrapPlugin(first);
    const hosts = [0, 1, 2].map(() => localHost(root));
    const restarted = await Promise.all(hosts.map(host => bootstrapPlugin(host)));
    expect(restarted.every(boot => boot.popclawId === persisted.popclawId && !boot.identityGenerated)).toBe(true);
  });

  it('a 0-byte master.key says what it is instead of dying on JSON.parse', async () => {
    // The brick the old write could leave behind: killed between creating the
    // file and writing it. New trees cannot get here any more, but a tree that
    // already did would otherwise fail every start with `Unexpected end of
    // JSON input` and no way to connect that to a file, let alone to the fact
    // that deleting it is safe.
    const root = mkdtempSync(join(tmpdir(), 'popclaw-empty-key-'));
    scratch.push(root);
    const host = localHost(root);
    // pathFor is optional on the Storage interface (in-memory adapters have no
    // paths); LocalHostAdapter has it, and this test is specifically about a
    // file on disk.
    if (host.storage.pathFor === undefined) throw new Error('LocalHostAdapter must expose pathFor');
    const path = host.storage.pathFor('identity', 'master.key');
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '');

    await expect(new Keystore(host).loadOrGenerate()).rejects.toThrow(/empty \(0 bytes\)/);
    // And it must say the two things that make it actionable.
    await expect(new Keystore(host).loadOrGenerate()).rejects.toThrow(/Nothing has been lost/);
  });

  it('still mints on a filesystem with no hard links, loudly', async () => {
    // exFAT has no hard links and some SMB/FUSE mounts refuse them, so link()
    // there fails with EPERM/ENOTSUP before it can decide who won. A plugin
    // that ships to arbitrary machines must not turn that into a first run
    // that dies with a bare errno — it falls back to the older two-step write
    // and says why.
    const root = mkdtempSync(join(tmpdir(), 'popclaw-nolink-'));
    scratch.push(root);
    const warnings: unknown[][] = [];
    const logger = new InMemoryLogger();
    logger.warn = (...args: unknown[]) => void warnings.push(args);
    const host = localHost(root, logger);

    const spy = vi.spyOn(fsp, 'link').mockRejectedValue(
      Object.assign(new Error('operation not permitted'), { code: 'EPERM' }),
    );
    try {
      const key = await new Keystore(host).loadOrGenerate();
      expect(key.generated).toBe(true);
      expect(key.popclawId).toBeTruthy();
      // The degraded path is not silent: it reopens a race this method exists
      // to close, so it has to be visible in the log.
      expect(JSON.stringify(warnings)).toMatch(/no hard links/);
      await bootstrapPlugin(host);
    } finally {
      spy.mockRestore();
    }
    // …and the identity really persisted: a restart loads the same one.
    const again = await new Keystore(localHost(root, logger)).loadOrGenerate();
    expect(again.generated).toBe(false);
  });
});
