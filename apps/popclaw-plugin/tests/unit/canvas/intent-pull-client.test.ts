import { describe, it, expect } from 'vitest';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { makeIntentPullClient, type FetchJson } from '../../../src/canvas/intent-pull-client.js';
import { pullSigningBytes, pairClaimSigningBytes } from '../../../src/canvas/canvas-signing.js';
import type { Signer } from '../../../src/identity/signer.js';
import { noDmCrypto } from '../../helpers/test-signer.js';

const kp = nacl.sign.keyPair();
const owner = bs58.encode(kp.publicKey);
const signer: Signer = {
  publicKey: async () => kp.publicKey,
  sign: async (b) => nacl.sign.detached(b, kp.secretKey),
  popclawId: async () => owner,
  ...noDmCrypto,
};

const FIXED_NOW = 1_712_345_678_901;

const ROWS = [
  {
    owner_popclaw_id: owner,
    followee_popclaw_id: 'B' + owner.slice(1),
    followee_label: 'name-B',
    first_ts: 1_712_000_000_000,
    latest_ts: 1_712_000_000_500,
    click_count: 2,
  },
];

interface Captured {
  url: string;
  headers: Record<string, string>;
}

function fakeFetch(status: number, text: string): { fetchJson: FetchJson; calls: () => Captured[] } {
  const seen: Captured[] = [];
  return {
    fetchJson: async (url, headers) => {
      seen.push({ url, headers: { ...headers } });
      return { status, text };
    },
    calls: () => seen,
  };
}

describe('makeIntentPullClient.pull', () => {
  it('sends the four signed headers over pullSigningBytes and returns the intents', async () => {
    const fake = fakeFetch(200, JSON.stringify({ intents: ROWS }));
    const client = makeIntentPullClient({
      baseUrl: 'http://canvas.test',
      signer,
      fetchJson: fake.fetchJson,
      clock: () => FIXED_NOW,
    });
    const rows = await client.pull(owner, 1234);
    expect(rows).toEqual(ROWS);

    expect(fake.calls()).toHaveLength(1);
    const { url, headers } = fake.calls()[0]!;
    expect(url).toBe(`http://canvas.test/v1/follow-intents?owner=${owner}&after=1234`);
    expect(headers['X-Popclaw-Id']).toBe(owner);
    expect(headers['X-Ts']).toBe(String(FIXED_NOW));

    // Independent verification of the signature the server will check: recompute
    // the signed bytes from the wire values and verify against the pubkey.
    const wireNonce = headers['X-Nonce'];
    expect(wireNonce).toBeTruthy();
    const sig = Buffer.from(headers['X-Signature']!, 'base64');
    expect(sig).toHaveLength(64);
    expect(
      nacl.sign.detached.verify(pullSigningBytes(owner, wireNonce!, FIXED_NOW), sig, kp.publicKey),
    ).toBe(true);
  });

  it('mints a fresh 12-byte base64url nonce per pull', async () => {
    const fake = fakeFetch(200, JSON.stringify({ intents: [] }));
    const client = makeIntentPullClient({
      baseUrl: 'http://canvas.test', signer, fetchJson: fake.fetchJson, clock: () => FIXED_NOW,
    });
    await client.pull(owner, 0);
    await client.pull(owner, 0);
    const [a, b] = fake.calls().map((c) => c.headers['X-Nonce']);
    // 12 bytes -> exactly 16 unpadded base64url chars, no + / =
    expect(a).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(b).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(a).not.toBe(b);
  });

  it('stamps X-Ts from the wall clock by default, inside the server ±60s window', async () => {
    const fake = fakeFetch(200, JSON.stringify({ intents: [] }));
    const client = makeIntentPullClient({ baseUrl: 'http://canvas.test', signer, fetchJson: fake.fetchJson });
    const before = Date.now();
    await client.pull(owner, 0);
    const ts = Number(fake.calls()[0]!.headers['X-Ts']);
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(Math.abs(Date.now() - ts)).toBeLessThanOrEqual(60_000);
  });

  it('strips a trailing slash from the base url', async () => {
    const fake = fakeFetch(200, JSON.stringify({ intents: [] }));
    const client = makeIntentPullClient({
      baseUrl: 'http://canvas.test/', signer, fetchJson: fake.fetchJson, clock: () => FIXED_NOW,
    });
    await client.pull(owner, 0);
    expect(fake.calls()[0]!.url).toBe(`http://canvas.test/v1/follow-intents?owner=${owner}&after=0`);
  });

  it('throws with the status in the message on a non-2xx response', async () => {
    const fake = fakeFetch(401, 'bad signature');
    const client = makeIntentPullClient({
      baseUrl: 'http://canvas.test', signer, fetchJson: fake.fetchJson, clock: () => FIXED_NOW,
    });
    await expect(client.pull(owner, 0)).rejects.toThrow(/401/);
  });

  it('throws on a 200 whose body is not JSON', async () => {
    const fake = fakeFetch(200, 'not json');
    const client = makeIntentPullClient({
      baseUrl: 'http://canvas.test', signer, fetchJson: fake.fetchJson, clock: () => FIXED_NOW,
    });
    await expect(client.pull(owner, 0)).rejects.toThrow();
  });

  it('throws on a 200 whose body is not an {intents: [...]} envelope', async () => {
    const fake = fakeFetch(200, '{"nope":1}');
    const client = makeIntentPullClient({
      baseUrl: 'http://canvas.test', signer, fetchJson: fake.fetchJson, clock: () => FIXED_NOW,
    });
    await expect(client.pull(owner, 0)).rejects.toThrow();
  });

  it('refuses an owner that is not the signer own id, without hitting the wire', async () => {
    const fake = fakeFetch(200, JSON.stringify({ intents: [] }));
    const client = makeIntentPullClient({
      baseUrl: 'http://canvas.test', signer, fetchJson: fake.fetchJson, clock: () => FIXED_NOW,
    });
    await expect(client.pull('SomeoneElseld', 0)).rejects.toThrow();
    expect(fake.calls()).toHaveLength(0);
  });
});

// Mirror law: these layouts MUST stay byte-identical to
// apps/popclaw-canvas/src/signing.ts. Cross-package imports are not wired for
// plugin tests, so the expected bytes are hand-built (ASCII → charCodeAt is
// exact UTF-8) instead of importing the canvas module. The NUL separators are
// concatenated (\u0000) rather than written as \0 in the literal — `\0` before
// a digit would be an octal escape (a syntax error in ESM).
describe('canvas signing bytes (mirror law)', () => {
  const NUL = '\u0000';
  const ascii = (s: string): number[] => s.split('').map((c) => c.charCodeAt(0));

  it('pullSigningBytes = intents-pull \\0 owner \\0 nonce \\0 ts', () => {
    expect([...pullSigningBytes('o1', 'n1', 1712345678901)]).toEqual(
      ascii('intents-pull' + NUL + 'o1' + NUL + 'n1' + NUL + '1712345678901'),
    );
  });

  it('pairClaimSigningBytes = pair-claim \\0 code \\0 id \\0 ts', () => {
    expect([...pairClaimSigningBytes('C0DE12', owner, 1712345678901)]).toEqual(
      ascii('pair-claim' + NUL + 'C0DE12' + NUL + owner + NUL + '1712345678901'),
    );
  });
});
