import { describe, it, expect } from 'vitest';
import nacl from 'tweetnacl';
import { InMemoryHostAdapter } from '../../../src/host/host-adapter.in-memory.js';
import { Keystore } from '../../../src/identity/keystore.js';
import { MasterKeySigner } from '../../../src/identity/master-key-signer.js';

describe('MasterKeySigner', () => {
  it('signs bytes verifiable by the derived pubkey', async () => {
    const host = new InMemoryHostAdapter();
    const key = await new Keystore(host).loadOrGenerate();
    const signer = new MasterKeySigner(key);

    const msg = new TextEncoder().encode('hello popclaw');
    const sig = await signer.sign(msg);
    expect(sig.length).toBe(64);

    const ok = nacl.sign.detached.verify(msg, sig, await signer.publicKey());
    expect(ok).toBe(true);
  });

  // TS `private` is compile-time only. Every route that can serialize or print
  // an object must come back redacted: JSON, util.inspect/console.log, spread,
  // enumeration, structuredClone.
  //
  // Assertions are deliberately boolean/shape-only — a naive `.not.toContain(seed)`
  // would dump the seed into the failure output on the very run where it matters.
  it('JSON.stringify yields only a redacted placeholder', async () => {
    const host = new InMemoryHostAdapter();
    const signer = new MasterKeySigner(await new Keystore(host).loadOrGenerate());
    expect(JSON.parse(JSON.stringify(signer))).toEqual({
      type: 'MasterKeySigner',
      key: '[redacted]',
    });
    expect(JSON.parse(JSON.stringify({ signer }))).toEqual({
      signer: { type: 'MasterKeySigner', key: '[redacted]' },
    });
  });

  it('util.inspect / console.log cannot reach the seed', async () => {
    const { inspect } = await import('node:util');
    const host = new InMemoryHostAdapter();
    const key = await new Keystore(host).loadOrGenerate();
    const signer = new MasterKeySigner(key);
    for (const text of [inspect(signer), inspect({ signer }), inspect(signer, { depth: 10 })]) {
      expect(text.includes('[redacted]')).toBe(true);
      expect(/seed|secretKey|Uint8Array/.test(text)).toBe(false);
    }
  });

  it('spread / enumeration / structuredClone expose nothing', async () => {
    const host = new InMemoryHostAdapter();
    const signer = new MasterKeySigner(await new Keystore(host).loadOrGenerate());
    expect(Object.keys(signer)).toEqual([]);
    expect(Object.entries(signer)).toEqual([]);
    expect(Object.getOwnPropertyNames(signer)).toEqual([]);
    expect({ ...signer }).toEqual({});
    expect(structuredClone({ ...signer })).toEqual({});
  });

  it('popclawId matches Base58(publicKey)', async () => {
    const host = new InMemoryHostAdapter();
    const key = await new Keystore(host).loadOrGenerate();
    const signer = new MasterKeySigner(key);
    expect(await signer.popclawId()).toBe(key.popclawId);
  });
});
