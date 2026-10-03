/**
 * Task 14: the reader-pass claim leg — pairBrowser (canvas/pair-claim.ts) and
 * the popclaw_pair_browser tool registration.
 *
 * Strategy mirrors intent-pull-client.test.ts: a fake HTTP seam captures the
 * wire request, the signature is verified INDEPENDENTLY (recomputed from the
 * wire values against the signer's pubkey — the same check the canvas server
 * runs), and the three-way error contract is pinned: 200 → true, non-2xx →
 * false (an honest "didn't pair", not a throw), network trouble → throws (the
 * tool layer reports it as a failure, not as a bad code).
 *
 * The tool half pins: registration lives in the world block (so it is
 * conditional on getWorldDeps, same as every world tool), the description
 * tells the agent what pairing is for, the schema takes exactly one string
 * (`code`), and the receipts come from the lexicon in both lanes.
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { Value } from 'typebox/value';
import { pairBrowser, type PostJson } from '../../../src/canvas/pair-claim.js';
import { pairClaimSigningBytes } from '../../../src/canvas/canvas-signing.js';
import type { Signer } from '../../../src/identity/signer.js';
import { noDmCrypto } from '../../helpers/test-signer.js';
import { registerPopclawTools } from '../../../src/tools/register-tools.js';
import { PopclawPairBrowserSchema } from '../../../src/tools/tool-schemas.js';
import { setOwnerLang } from '../../../src/lexicon/owner-language.js';
import { renderCopy } from '../../../src/lexicon/index.js';

beforeAll(() => setOwnerLang('zh-CN', 'config'));

const kp = nacl.sign.keyPair();
const owner = bs58.encode(kp.publicKey);
const signer: Signer = {
  publicKey: async () => kp.publicKey,
  sign: async (b) => nacl.sign.detached(b, kp.secretKey),
  popclawId: async () => owner,
  ...noDmCrypto,
};

const FIXED_NOW = 1_712_345_678_901;
const CODE = '482913';

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: string;
}

function fakePost(
  status: number,
  text: string,
): { fetchJson: PostJson; calls: () => Captured[] } {
  const seen: Captured[] = [];
  return {
    fetchJson: async (url, headers, body) => {
      seen.push({ url, headers: { ...headers }, body });
      return { status, text };
    },
    calls: () => seen,
  };
}

describe('pairBrowser', () => {
  it('POSTs the four-key body (code/popclaw_id/ts/signature) with a signature the canvas server can verify', async () => {
    const fake = fakePost(200, JSON.stringify({ ok: true }));
    const ok = await pairBrowser({
      baseUrl: 'http://canvas.test',
      signer,
      code: CODE,
      fetchJson: fake.fetchJson,
      clock: () => FIXED_NOW,
    });
    expect(ok).toBe(true);

    expect(fake.calls()).toHaveLength(1);
    const c = fake.calls()[0]!;
    expect(c.url).toBe('http://canvas.test/v1/pair/claim');
    expect(c.headers['Content-Type']).toBe('application/json');

    const b = JSON.parse(c.body) as Record<string, unknown>;
    expect(Object.keys(b).sort()).toEqual(['code', 'popclaw_id', 'signature', 'ts']);
    expect(b['code']).toBe(CODE);
    expect(b['popclaw_id']).toBe(owner);
    expect(b['ts']).toBe(FIXED_NOW); // a JSON number — the server rejects anything else

    // Independent verification: recompute the signed bytes from the wire values
    // and check the detached sig against the signer's pubkey (verifyPairClaim's
    // exact check, minus the ±60s window which the clock test below covers).
    const sig = Buffer.from(b['signature'] as string, 'base64');
    expect(sig).toHaveLength(64);
    expect(
      nacl.sign.detached.verify(pairClaimSigningBytes(CODE, owner, FIXED_NOW), sig, kp.publicKey),
    ).toBe(true);
  });

  it('200 → true', async () => {
    const fake = fakePost(200, JSON.stringify({ ok: true }));
    await expect(
      pairBrowser({ baseUrl: 'http://canvas.test', signer, code: CODE, fetchJson: fake.fetchJson, clock: () => FIXED_NOW }),
    ).resolves.toBe(true);
  });

  it('400 (wrong / expired / used code, bad signature) → false, not a throw — the tool layer reports an honest "didn\'t pair"', async () => {
    const fake = fakePost(400, 'bad code');
    await expect(
      pairBrowser({ baseUrl: 'http://canvas.test', signer, code: CODE, fetchJson: fake.fetchJson, clock: () => FIXED_NOW }),
    ).resolves.toBe(false);
  });

  it('any other non-2xx → false as well', async () => {
    const fake = fakePost(502, 'upstream gone');
    await expect(
      pairBrowser({ baseUrl: 'http://canvas.test', signer, code: CODE, fetchJson: fake.fetchJson, clock: () => FIXED_NOW }),
    ).resolves.toBe(false);
  });

  it('network trouble → throws (so the tool layer can report a network failure, not "bad code")', async () => {
    const fetchJson: PostJson = async () => {
      throw new Error('ECONNREFUSED');
    };
    await expect(
      pairBrowser({ baseUrl: 'http://canvas.test', signer, code: CODE, fetchJson, clock: () => FIXED_NOW }),
    ).rejects.toThrow(/ECONNREFUSED/);
  });

  it('strips a trailing slash from the base url', async () => {
    const fake = fakePost(200, JSON.stringify({ ok: true }));
    await pairBrowser({
      baseUrl: 'http://canvas.test/',
      signer,
      code: CODE,
      fetchJson: fake.fetchJson,
      clock: () => FIXED_NOW,
    });
    expect(fake.calls()[0]!.url).toBe('http://canvas.test/v1/pair/claim');
  });

  it('stamps ts from the wall clock by default, inside the server ±60s window', async () => {
    const fake = fakePost(200, JSON.stringify({ ok: true }));
    const before = Date.now();
    await pairBrowser({ baseUrl: 'http://canvas.test', signer, code: CODE, fetchJson: fake.fetchJson });
    const ts = (JSON.parse(fake.calls()[0]!.body) as { ts: number }).ts;
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(Math.abs(Date.now() - ts)).toBeLessThanOrEqual(60_000);
  });
});

// ---------------------------------------------------------------------------
// Tool registration (world block, like every world tool)
// ---------------------------------------------------------------------------

function buildFakeApi() {
  const tools: Array<{
    name: string;
    description: string;
    parameters: { properties?: Record<string, unknown> };
    execute: (callId: string, params: unknown) => Promise<{ type: string; text: string }>;
  }> = [];
  const api = {
    registerTool: (tool: { name?: string; execute?: unknown }) => {
      if (tool?.name && typeof tool.execute === 'function') tools.push(tool as (typeof tools)[number]);
    },
    logger: { info: vi.fn() },
  } as Parameters<typeof registerPopclawTools>[0]['api'];
  return { api, tools };
}

const getWorldDeps = (async () => ({})) as unknown as Parameters<
  typeof registerPopclawTools
>[0]['getWorldDeps'];

describe('popclaw_pair_browser registration', () => {
  it('registers under the world block when getWorldDeps is provided, with a description naming the pairing purpose', () => {
    const { api, tools } = buildFakeApi();
    registerPopclawTools({ api, runtime: vi.fn() as unknown as Parameters<typeof registerPopclawTools>[0]['runtime'], getWorldDeps });
    const t = tools.find((t) => t.name === 'popclaw_pair_browser');
    expect(t).toBeDefined();
    // The host agent routes by description: it must say what this is for
    // (pairing the owner's browser) and what the parameter is (the code).
    expect(t!.description.toLowerCase()).toContain('pair');
    expect(t!.description.toLowerCase()).toContain('browser');
    // Owner ruling 2026-09-13: the reader pass is not a newspaper feature — it
    // makes a browser the reader's own for ANY shared page — so the phrase is
    // the plain "pair" and the parameter is a code again (the 2026-09-01 login
    // wording, and its "token", are retired). The description must also say
    // what pairing buys: without it a tap is recorded for nobody.
    expect(t!.description.toLowerCase()).toContain('code');
    expect(t!.description.toLowerCase()).toContain('without pairing');
  });

  it('does NOT register when getWorldDeps is absent (same honest degradation as every world tool)', () => {
    const { api, tools } = buildFakeApi();
    registerPopclawTools({ api, runtime: vi.fn() as unknown as Parameters<typeof registerPopclawTools>[0]['runtime'] });
    expect(tools.map((t) => t.name)).not.toContain('popclaw_pair_browser');
  });

  it('schema: exactly one required string param, code', () => {
    expect(Object.keys(PopclawPairBrowserSchema.properties)).toEqual(['code']);
    expect(Value.Check(PopclawPairBrowserSchema, { code: CODE })).toBe(true);
    expect(Value.Check(PopclawPairBrowserSchema, {})).toBe(false);
    expect(Value.Check(PopclawPairBrowserSchema, { code: 123456 })).toBe(false);
  });

  /**
   * Registered with no publisher too — the three tool tables must agree, and a
   * tool that disappears is invisible to the agent. It answers instead.
   */
  it('execute: no publisher configured → PUBLISHER_UNAVAILABLE, still registered', async () => {
    const { api, tools } = buildFakeApi();
    const runtime = vi.fn(async () => ({
      boot: { signer, canvasBaseUrl: null },
    })) as unknown as Parameters<typeof registerPopclawTools>[0]['runtime'];
    registerPopclawTools({ api, runtime, getWorldDeps });
    const t = tools.find((t) => t.name === 'popclaw_pair_browser')!;
    expect(t).toBeDefined();
    const r = await t.execute('cid', { code: CODE });
    expect(r.text).toContain(renderCopy('zh-CN', 'newspaper.publisher.unavailable'));
  });

  it('execute: a blank code never reaches the wire — the honest pairFail receipt comes back', async () => {
    const { api, tools } = buildFakeApi();
    const runtime = vi.fn(async () => ({
      boot: { signer, canvasBaseUrl: 'http://canvas.test' },
    })) as unknown as Parameters<typeof registerPopclawTools>[0]['runtime'];
    registerPopclawTools({ api, runtime, getWorldDeps });
    const t = tools.find((t) => t.name === 'popclaw_pair_browser')!;
    const r = await t.execute('cid', { code: '   ' });
    expect(r.text).toContain(renderCopy('zh-CN', 'newspaper.doorbell.pairFail'));
  });
});

describe('pair receipts exist in both lexicon lanes', () => {
  it('newspaper.doorbell.pairOk / pairFail resolve in zh-CN and en (a missing key would echo the key itself)', () => {
    for (const key of ['newspaper.doorbell.pairOk', 'newspaper.doorbell.pairFail'] as const) {
      expect(renderCopy('zh-CN', key)).not.toBe(key);
      expect(renderCopy('en', key)).not.toBe(key);
    }
  });
});
