import { describe, it, expect } from 'vitest';
import { InMemoryHostAdapter } from '../../../src/host/host-adapter.in-memory.js';
import { Keystore } from '../../../src/identity/keystore.js';

describe('Keystore', () => {
  it('generateIfMissing creates a key and writes it', async () => {
    const host = new InMemoryHostAdapter();
    const ks = new Keystore(host);
    const k = await ks.loadOrGenerate();
    expect(k.seed.length).toBe(32);
    expect(k.publicKey.length).toBe(32);
    expect(k.popclawId.length).toBeGreaterThan(40);
    expect(await host.storage.read('identity', 'master.key')).not.toBeNull();
  });

  it('load returns the same key after generate', async () => {
    const host = new InMemoryHostAdapter();
    const ks = new Keystore(host);
    const first = await ks.loadOrGenerate();
    const second = await ks.load();
    expect(second).not.toBeNull();
    expect(second!.popclawId).toBe(first.popclawId);
    expect(Array.from(second!.seed)).toEqual(Array.from(first.seed));
  });

  it('load returns null on missing file', async () => {
    const host = new InMemoryHostAdapter();
    const ks = new Keystore(host);
    expect(await ks.load()).toBeNull();
  });

  it('writes master.key with restrictive mode 0600', async () => {
    const host = new InMemoryHostAdapter();
    await new Keystore(host).loadOrGenerate();
    expect(host.storage.modeOf('identity', 'master.key')).toBe(0o600);
  });

  it('logs a loud, distinct line when a NEW identity is generated — at info, the only level MCP hosts pass through', async () => {
    const host = new InMemoryHostAdapter();
    const key = await new Keystore(host).loadOrGenerate();
    const generated = host.logger.records.filter((r) => /NEW IDENTITY/.test(r.msg));
    expect(generated).toHaveLength(1);
    // Not a downgrade: at `warn` this line does not reach the owner on Claude Code
    // or Codex at all, which is exactly where a wrong POPCLAW_DATA_ROOT is easiest.
    expect(generated[0]!.level).toBe('info');
    // the resolved key path must be logged so a misconfigured data root is diagnosable
    expect(String(generated[0]!.obj.path)).toContain('master.key');
    expect(generated[0]!.obj.popclaw_id).toBe(key.popclawId);
  });

  it('reports generated=true when it mints, false when it restores', async () => {
    const host = new InMemoryHostAdapter();
    expect((await new Keystore(host).loadOrGenerate()).generated).toBe(true);
    expect((await new Keystore(host).loadOrGenerate()).generated).toBe(false);
  });

  it('escalates when the key is absent but the data root already holds activity', async () => {
    const host = new InMemoryHostAdapter();
    host.db.execute("INSERT INTO bonds (popclaw_id, created_at, updated_at) VALUES ('someone-i-know', 1, 1)");
    await new Keystore(host).loadOrGenerate();
    const warn = host.logger.records.find((r) => /NEW IDENTITY/.test(r.msg))!;
    expect(warn.obj.likely_wrong_data_root).toBe(true);
    expect(warn.msg).toMatch(/POPCLAW_DATA_ROOT/);
  });

  it('does not escalate on a genuinely empty data root', async () => {
    const host = new InMemoryHostAdapter();
    await new Keystore(host).loadOrGenerate();
    const warn = host.logger.records.find((r) => /NEW IDENTITY/.test(r.msg))!;
    expect(warn.obj.likely_wrong_data_root).toBe(false);
  });

  it('restoring an existing key does NOT log the new-identity warning', async () => {
    const host = new InMemoryHostAdapter();
    await new Keystore(host).loadOrGenerate();
    host.logger.records.length = 0;
    await new Keystore(host).loadOrGenerate();
    expect(host.logger.records.filter((r) => /NEW IDENTITY/.test(r.msg))).toHaveLength(0);
  });

  it('load rejects tampered public_key field', async () => {
    const host = new InMemoryHostAdapter();
    const body = {
      version: 1,
      type: 'master-raw-seed',
      created_at: '2026-04-21T00:00:00Z',
      public_key: 'NOT-THE-REAL-PUBKEY',
      seed: '0011223344556677889900aabbccddeeff00112233445566778899aabbccddee',
    };
    await host.storage.write(
      'identity',
      'master.key',
      new TextEncoder().encode(JSON.stringify(body)),
    );
    await expect(new Keystore(host).load()).rejects.toThrow(/public_key mismatch/);
  });
});
