import { describe, it, expect, vi } from 'vitest';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { MasterKeySigner } from '../../../src/identity/master-key-signer.js';
import type { MasterKey } from '../../../src/identity/keystore.js';
import { runPopclawPostCommand } from '../../../src/commands/popclaw-post.js';
import type { WorldFeedCache } from '../../../src/ingress/world-feed-cache.js';

function makeSigner(): MasterKeySigner {
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

function makeMockDeps(opts: {
  pushStatus?: number;
  pushThrows?: boolean;
  cacheEntries?: Array<{ platform: string; platformPostId: string }>;
} = {}) {
  const entries = opts.cacheEntries ?? [];
  return {
    signer: makeSigner(),
    egress: {
      push: vi.fn(async (_bytes: Uint8Array) => {
        if (opts.pushThrows) throw new Error('ECONNREFUSED');
        return {
          status: opts.pushStatus ?? 200,
          eventId: 'deadbeef' + 'a'.repeat(56),
        };
      }),
    },
    nickname: 'BlackFeather',
    webBaseUrl: 'http://localhost:3000',
    cache: {
      findFullEventId: (prefix: string) => {
        const matches = entries
          .filter(
            (e) =>
              e.platform === 'popclaw' &&
              e.platformPostId.startsWith(prefix) &&
              e.platformPostId.length === 64,
          )
          .map((e) => e.platformPostId);
        const unique = Array.from(new Set(matches));
        if (unique.length === 1) return { full: unique[0]!, ambiguous: [] };
        return { full: null, ambiguous: unique.slice(0, 3) };
      },
      // The social log looks here for original in_reply_to text for --reply/--quote (the self-contained-record requirement).
      // These stubs contain no matching items, so only event_id is recorded, consistent with omitting unavailable text.
      findByEventIdPrefix: () => ({ item: null, ambiguous: [] }),
    } as unknown as WorldFeedCache,
  };
}

const HEX64 = 'a'.repeat(64);

describe('runPopclawPostCommand', () => {
  it('returns USAGE when body is empty', async () => {
    const deps = makeMockDeps();
    const r = await runPopclawPostCommand({ positional: [], flags: {} }, deps);
    expect(r.text).toMatch(/usage:/i);
    expect(deps.egress.push).not.toHaveBeenCalled();
  });

  it('returns USAGE when body is whitespace-only', async () => {
    const deps = makeMockDeps();
    const r = await runPopclawPostCommand({ positional: ['   ', '\n', '  '], flags: {} }, deps);
    expect(r.text).toMatch(/usage:/i);
    expect(deps.egress.push).not.toHaveBeenCalled();
  });

  it('rejects simultaneous --reply and --quote', async () => {
    const deps = makeMockDeps();
    const r = await runPopclawPostCommand(
      { positional: ['hi'], flags: { reply: HEX64, quote: HEX64 } },
      deps,
    );
    expect(r.text).toMatch(/mutually exclusive/);
    expect(deps.egress.push).not.toHaveBeenCalled();
  });

  it('rejects non-hex --reply event_id', async () => {
    const deps = makeMockDeps();
    const r = await runPopclawPostCommand(
      { positional: ['hi'], flags: { reply: 'short' } },
      deps,
    );
    expect(r.text).toMatch(/must be hex chars/);
    expect(deps.egress.push).not.toHaveBeenCalled();
  });

  it('rejects non-hex --quote event_id', async () => {
    const deps = makeMockDeps();
    const r = await runPopclawPostCommand(
      { positional: ['hi'], flags: { quote: 'XX' + 'a'.repeat(62) } },
      deps,
    );
    expect(r.text).toMatch(/must be hex chars/);
    expect(deps.egress.push).not.toHaveBeenCalled();
  });

  it('signs and pushes root post on plain args', async () => {
    const deps = makeMockDeps();
    const r = await runPopclawPostCommand(
      { positional: ['hello', 'world'], flags: {} },
      deps,
    );
    expect(deps.egress.push).toHaveBeenCalledOnce();
    expect(r.text).toMatch(/posted/);
    // URL uses configurable web base + 10-hex short id (lore-house resolves >=6 hex)
    expect(r.text).toMatch(/http:\/\/localhost:3000\/post\/[0-9a-f]{10}(?![0-9a-f])/);
    // Headline shows 10-hex short id
    expect(r.text).toMatch(/#[0-9a-f]{10}/);
    expect(r.text).not.toMatch(/event_id:/);
    // No full 64-hex leaks anywhere.
    expect(r.text).not.toMatch(/[0-9a-f]{64}/);
  });

  it('honors a custom webBaseUrl (e.g. production https://popclaw.me)', async () => {
    const deps = makeMockDeps();
    deps.webBaseUrl = 'https://popclaw.me';
    const r = await runPopclawPostCommand({ positional: ['hi'], flags: {} }, deps);
    expect(r.text).toMatch(/https:\/\/popclaw\.me\/post\/[0-9a-f]{10}(?![0-9a-f])/);
  });

  it('signs and pushes reply post on --reply', async () => {
    const deps = makeMockDeps();
    const r = await runPopclawPostCommand(
      { positional: ['ack'], flags: { reply: HEX64 } },
      deps,
    );
    expect(deps.egress.push).toHaveBeenCalledOnce();
    expect(r.text).toMatch(/replied/);
    expect(r.text).toMatch(/http:\/\/localhost:3000\/post\//);
    // Format: "↩ replied #<new10> → #<reply10>"
    expect(r.text).toMatch(/#[0-9a-f]{10} → #[0-9a-f]{10}/);
  });

  it('signs and pushes quote post on --quote', async () => {
    const deps = makeMockDeps();
    const r = await runPopclawPostCommand(
      { positional: ['cheaper'], flags: { quote: HEX64 } },
      deps,
    );
    expect(deps.egress.push).toHaveBeenCalledOnce();
    expect(r.text).toMatch(/quoted/);
    expect(r.text).toMatch(/http:\/\/localhost:3000\/post\//);
    // Format: "📜 quoted #<new10> → #<quote10>"
    expect(r.text).toMatch(/#[0-9a-f]{10} → #[0-9a-f]{10}/);
  });

  it('reports HTTP 4xx as rejection', async () => {
    const deps = makeMockDeps({ pushStatus: 400 });
    const r = await runPopclawPostCommand({ positional: ['x'], flags: {} }, deps);
    expect(r.text).toMatch(/rejected by lore-house \(HTTP 400\)/);
  });

  it('reports HTTP 5xx with retry hint', async () => {
    const deps = makeMockDeps({ pushStatus: 500 });
    const r = await runPopclawPostCommand({ positional: ['x'], flags: {} }, deps);
    expect(r.text).toMatch(/failed server-side \(HTTP 500\)/);
    expect(r.text).toMatch(/retry/);
  });

  it('reports network errors gracefully', async () => {
    const deps = makeMockDeps({ pushThrows: true });
    const r = await runPopclawPostCommand({ positional: ['x'], flags: {} }, deps);
    expect(r.text).toMatch(/failed: .*ECONNREFUSED/);
  });
});

describe('event_id short prefix lookup (CLI polish plan)', () => {
  // Valid 64-hex event_id fixtures
  const FULL_HEX_A = 'c778b1e89c2b5d0f4854e307268f6bf85fb22fdd4134f7a5a4da6909a885b841';
  const FULL_HEX_B = 'c0e7' + 'f'.repeat(60);

  it('full 64-hex passes through unchanged (display uses 10-hex short id)', async () => {
    const deps = makeMockDeps({ cacheEntries: [] });
    const r = await runPopclawPostCommand(
      { positional: ['ack'], flags: { reply: FULL_HEX_A } },
      deps,
    );
    expect(r.text).toMatch(/replied/);
    // New format: "↩ replied #<new10> → #<replyTo10>" — full hex not displayed.
    expect(r.text).toContain(FULL_HEX_A.slice(0, 10));
    expect(r.text).not.toContain(FULL_HEX_A); // full hex NOT in output
  });

  it('6-hex unique prefix resolves to full event_id (display uses resolved 10-hex)', async () => {
    const deps = makeMockDeps({
      cacheEntries: [{ platform: 'popclaw', platformPostId: FULL_HEX_A }],
    });
    const r = await runPopclawPostCommand(
      { positional: ['ack'], flags: { reply: FULL_HEX_A.slice(0, 6) } },
      deps,
    );
    expect(r.text).toMatch(/replied/);
    // Resolved to FULL_HEX_A; display shows first 10 hex of that resolved id.
    expect(r.text).toContain(FULL_HEX_A.slice(0, 10));
  });

  it('5-hex prefix rejected as too short', async () => {
    const deps = makeMockDeps();
    const r = await runPopclawPostCommand(
      { positional: ['ack'], flags: { reply: 'c778b' } },
      deps,
    );
    expect(r.text).toMatch(/prefix too short/);
    expect(r.text).toMatch(/≥6 hex chars/);
  });

  it('65-hex string rejected as too long', async () => {
    const deps = makeMockDeps();
    const r = await runPopclawPostCommand(
      { positional: ['ack'], flags: { reply: 'a'.repeat(65) } },
      deps,
    );
    expect(r.text).toMatch(/too long/);
    expect(r.text).toMatch(/64 hex chars max/);
    expect(deps.egress.push).not.toHaveBeenCalled();
  });

  it('non-hex prefix rejected', async () => {
    const deps = makeMockDeps();
    const r = await runPopclawPostCommand(
      { positional: ['ack'], flags: { reply: 'notHex' } },
      deps,
    );
    expect(r.text).toMatch(/must be hex chars/);
  });

  it('prefix with no cache match returns helpful error', async () => {
    const deps = makeMockDeps({
      cacheEntries: [{ platform: 'popclaw', platformPostId: FULL_HEX_A }],
    });
    const r = await runPopclawPostCommand(
      { positional: ['ack'], flags: { reply: 'aaabbb' } },
      deps,
    );
    expect(r.text).toMatch(/prefix matches no known event/);
    expect(r.text).toMatch(/\/popclaw feed/);
  });

  it('ambiguous prefix lists candidates', async () => {
    // Two entries sharing the prefix 'abc123' (first 6 chars identical, rest differ)
    const entries2 = [
      { platform: 'popclaw', platformPostId: 'abc123' + FULL_HEX_A.slice(6) },
      { platform: 'popclaw', platformPostId: 'abc123' + FULL_HEX_B.slice(6) },
    ];
    const deps2 = makeMockDeps({ cacheEntries: entries2 });
    const r = await runPopclawPostCommand(
      { positional: ['ack'], flags: { reply: 'abc123' } },
      deps2,
    );
    expect(r.text).toMatch(/prefix ambiguous/);
    expect(r.text).toMatch(/use more chars/);
  });

  it('full event_id never leaks; both headline and URL use the 10-hex short id', async () => {
    // Regression guard: the long 64-char hex must not appear anywhere — the
    // headline (#<short>) and the /post/<short> URL both use the 10-hex form.
    const deps = makeMockDeps();
    const rootResult = await runPopclawPostCommand(
      { positional: ['root post test'], flags: {} },
      deps,
    );
    expect(rootResult.text).toMatch(/📜 posted #[0-9a-f]{10}/);
    expect(rootResult.text).toMatch(/\/post\/[0-9a-f]{10}(?![0-9a-f])/);
    expect(rootResult.text).not.toMatch(/[0-9a-f]{64}/);
  });
});
