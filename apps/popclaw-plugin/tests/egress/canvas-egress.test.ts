import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { uploadCanvas } from '../../src/egress/canvas-egress.js';
import { canvasSigningBytes } from '../../src/canvas/canvas-signing.js';
import type { Signer } from '../../src/identity/signer.js';
import { noDmCrypto } from '../helpers/test-signer.js';

const kp = nacl.sign.keyPair();
const signer: Signer = {
  publicKey: async () => kp.publicKey,
  sign: async (b) => nacl.sign.detached(b, kp.secretKey),
  popclawId: async () => bs58.encode(kp.publicKey),
  ...noDmCrypto,
};

let server: Server;
let base: string;
let received: any;

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received = JSON.parse(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ url: 'http://canvas.test/blackfeather_ai/abc?t=tok' }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

describe('uploadCanvas', () => {
  it('signs title\\0html and POSTs a JSON envelope, returning the url', async () => {
    const { url } = await uploadCanvas({ baseUrl: base, signer, nickname: 'blackfeather_ai', title: 't', html: '<p>x</p>' });
    expect(url).toBe('http://canvas.test/blackfeather_ai/abc?t=tok');
    expect(received.popclaw_id).toBe(bs58.encode(kp.publicKey));
    const sig = Buffer.from(received.signature, 'base64');
    expect(nacl.sign.detached.verify(canvasSigningBytes('t', '<p>x</p>'), sig, kp.publicKey)).toBe(true);
  });

  it('threads optional ttlHours as ttl_hours in the envelope; absent when unset', async () => {
    await uploadCanvas({ baseUrl: base, signer, nickname: 'h', title: 't', html: 'x', ttlHours: 48 });
    expect(received.ttl_hours).toBe(48);
    await uploadCanvas({ baseUrl: base, signer, nickname: 'h', title: 't', html: 'x' });
    expect('ttl_hours' in received).toBe(false);
  });

  it('throws on a non-2xx response', async () => {
    await expect(
      uploadCanvas({ baseUrl: 'http://127.0.0.1:1', signer, nickname: 'h', title: 't', html: 'x' }),
    ).rejects.toThrow();
  });

  it('throws with 401 in the message when server returns 401', async () => {
    const authServer = createServer((_req, res) => {
      res.writeHead(401);
      res.end('bad signature');
    });
    await new Promise<void>((r) => authServer.listen(0, '127.0.0.1', r));
    const authBase = `http://127.0.0.1:${(authServer.address() as AddressInfo).port}`;
    try {
      await expect(
        uploadCanvas({ baseUrl: authBase, signer, nickname: 'h', title: 't', html: 'x' }),
      ).rejects.toThrow(/401/);
    } finally {
      authServer.close();
    }
  });

  // Same undici 300s default as ServerPushEgress — a canvas service that
  // accepts and then goes quiet must not hold the newspaper for five minutes.
  it('gives up instead of hanging when the server accepts but never replies', async () => {
    const mute = createServer(() => {
      /* swallow the request; never write a response */
    });
    await new Promise<void>((r) => mute.listen(0, '127.0.0.1', () => r()));
    const muteBase = `http://127.0.0.1:${(mute.address() as AddressInfo).port}`;
    try {
      const started = Date.now();
      await expect(
        uploadCanvas({
          baseUrl: muteBase, signer, nickname: 'h', title: 't', html: 'x', timeoutMs: 100,
        }),
      ).rejects.toThrow();
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      mute.close();
    }
  });
});
