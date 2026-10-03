/**
 * `popclaw_house_entry_link` — who decided to mint a login key, and for which site.
 *
 * The load-bearing assertion in this file is a pair of zeros: after the first
 * call, the signer has been asked for nothing and the network has been touched
 * not at all. Everything else here is about the second call being about the
 * SAME operation the owner was shown — a confirm that re-reads the world and
 * refuses when the identity, the pin or the declaration has moved under it.
 *
 * The house is mounted through the real trust machinery, so the declaration
 * this tool acts on is the one a verified manifest projected, not a row
 * written by hand.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { InMemoryHostDb } from '../../../src/host/in-memory-host-db.js';
import { runMigrations } from '../../../src/host/migrations.js';
import {
  beginHouseAdd,
  commitEstablishAndActivate,
  confirmHouseTrust,
  prepareHouseTrust,
} from '../../../src/world/house-trust.js';
import { MasterKeySigner } from '../../../src/identity/master-key-signer.js';
import { registerHouseEntryTools } from '../../../src/tools/house-entry-tools.js';
import { _draftsForTest, makeDraftToken, putDraft } from '../../../src/tools/draft-store.js';
import { BROWSER_ENTRY_PROFILE } from '../../../src/identity/browser-entry.js';
import { BROWSER_ENTRY_TTL_SECONDS } from '../../../src/identity/browser-entry-token.js';
import { verifyBrowserEntryToken } from '../../helpers/browser-entry-verifier.js';
import { mintHouse } from '../../helpers/signed-manifest.js';
import type { ToolsCtx } from '../../../src/tools/tools-context.js';
import { renderCopy } from '../../../src/lexicon/index.js';
import { setOwnerLang } from '../../../src/lexicon/owner-language.js';
import { EN as en } from '../../../src/lexicon/en.js';
import { ZH_CN as zhCN } from '../../../src/lexicon/zh-CN.js';
import { matchLexicon, renderL2Hit } from '../../../src/routing/lexicon.js';

const MIGRATIONS = resolve(dirname(fileURLToPath(import.meta.url)), '../../../migrations');
const HOUSE = 'https://house.example';
const APP = 'https://app.example';
const NOW = 1_789_000_000;

const ENTRY = {
  profile: BROWSER_ENTRY_PROFILE,
  audience: APP,
  entry_url: `${APP}/welcome`,
  shorten_url: `${APP}/api/shorten`,
};

/** A throwaway identity. Fixed seed so the assertions are reproducible; never an identity. */
function makeSigner(fill: number) {
  const seed = new Uint8Array(32).fill(fill);
  const kp = nacl.sign.keyPair.fromSeed(seed);
  const real = new MasterKeySigner({ seed, publicKey: kp.publicKey, secretKey: kp.secretKey, popclawId: bs58.encode(kp.publicKey) });
  const sign = vi.fn((bytes: Uint8Array) => real.sign(bytes));
  return {
    real,
    sign,
    popclawId: bs58.encode(kp.publicKey),
    // The seam the tool actually holds: it can ask for a public id and for a
    // signature, and there is nothing else on it to reach for.
    signer: { publicKey: () => real.publicKey(), popclawId: () => real.popclawId(), sign },
  };
}

interface Rig {
  db: InMemoryHostDb;
  call: (params: unknown) => Promise<string>;
  sign: ReturnType<typeof vi.fn>;
  post: ReturnType<typeof vi.fn>;
  signerBox: ReturnType<typeof makeSigner>;
  urls: string[];
  /** Every origin the tool asked the runtime for a read lane to. */
  lanes: string[];
  /** The description the agent reads before calling. */
  description: string;
}

async function mount(
  db: InMemoryHostDb,
  manifest: Record<string, unknown>,
  now = 1_700_000_000,
  origin = HOUSE,
  seed = 1,
) {
  const house = mintHouse({ origin, seed, manifest });
  const prepared = await prepareHouseTrust(db, origin, {
    fetch: house.fetch as typeof globalThis.fetch,
    attempt: beginHouseAdd(db, origin),
    now: () => now,
  });
  if (!prepared.ok) throw new Error('fixture house did not verify');
  const outcome = commitEstablishAndActivate(db, prepared.prepared, { now: () => now });
  if (!outcome.ok) throw new Error('fixture house did not commit');
}

async function rig(
  opts: {
    manifest?: Record<string, unknown>;
    shortenReply?: { status: number; text: string };
    /** Mount several pinned houses instead of the single default `HOUSE`. */
    houses?: ReadonlyArray<{ origin: string; seed: number; manifest?: Record<string, unknown> }>;
    /** Mount nothing at all: the house is configured here but never pinned. */
    unpinned?: boolean;
    /**
     * The house's guarded read lane, as the runtime hands it out. Absent means
     * this runtime offers none, which is how every rig above is built.
     */
    houseReadFetch?: ReturnType<typeof vi.fn>;
  } = {},
): Promise<Rig> {
  const db = new InMemoryHostDb();
  runMigrations(db, MIGRATIONS);
  const lanes: string[] = [];
  let urls: string[];
  if (opts.unpinned) {
    urls = [HOUSE];
  } else if (opts.houses) {
    for (const h of opts.houses) await mount(db, h.manifest ?? {}, 1_700_000_000, h.origin, h.seed);
    urls = opts.houses.map((h) => h.origin);
  } else {
    await mount(db, opts.manifest ?? { browser_entry: ENTRY });
    urls = [HOUSE];
  }
  const signerBox = makeSigner(7);
  const post = vi.fn(async () => opts.shortenReply ?? { status: 200, text: JSON.stringify({ url: `${APP}/w/abc123` }) });
  const runtime = (async () => ({
    boot: { signer: signerBox.signer, popclawId: signerBox.popclawId, loreHouseUrls: urls, nickname: 'Lobster' },
    host: { db },
    ...(opts.houseReadFetch === undefined
      ? {}
      : { houseRuntime: { houseReadFetch: (origin: string) => { lanes.push(origin); return opts.houseReadFetch; } } }),
  })) as unknown as ToolsCtx['runtime'];
  const tools: Array<{ name: string; description: string; execute: (id: string, p: unknown) => Promise<{ text: string }> }> = [];
  const api = { registerTool: (t: unknown) => tools.push(t as (typeof tools)[number]) };
  registerHouseEntryTools(
    { api, runtime, deps: { api, runtime }, total: 0 } as unknown as ToolsCtx,
    { postJson: post as never, nowSeconds: () => NOW },
  );
  const tool = tools[0]!;
  return {
    db,
    urls,
    signerBox,
    sign: signerBox.sign,
    post,
    lanes,
    description: tool.description,
    call: async (params: unknown) => (await tool.execute('c', params)).text,
  };
}

/** The `confirm_token: xyz` line the preview hands back. */
const tokenOf = (text: string): string => /confirm_token: (\S+)/.exec(text)![1]!;

beforeEach(() => _draftsForTest.clear());
afterEach(() => _draftsForTest.clear());

describe('the first call previews and commits nothing', () => {
  it('shows the identity, the house, the site and the key warning', async () => {
    const r = await rig();
    const text = await r.call({ house: 'house.example' });
    expect(text).toContain(r.signerBox.popclawId);
    // The house origin and the application origin are different things, and
    // the owner is shown both — on real hardware they really are two names.
    expect(text).toContain(HOUSE);
    expect(text).toContain(APP);
    expect(text).toContain(`${APP}/welcome`);
    expect(text).toContain('seven days');
    expect(text).toMatch(/confirm_token: house-entry-\d+/);
  });

  /**
   * The load-bearing pair of zeros. A preview that signed eagerly would still
   * look identical to the owner and would have already produced the key.
   */
  it('asks the signer for nothing and the network for nothing', async () => {
    const r = await rig();
    await r.call({ house: 'house.example' });
    expect(r.sign).toHaveBeenCalledTimes(0);
    expect(r.post).toHaveBeenCalledTimes(0);
  });

  it('names the self-portrait it would carry, and says so when it would carry none', async () => {
    const r = await rig();
    expect(await r.call({ house: 'house.example', persona: 'curious' })).toContain('persona: curious');
    expect(await r.call({ house: 'house.example' })).toMatch(/no description, persona or home city/);
  });
});

describe('the second call is the one that mints', () => {
  it('signs a token the site verifies, and returns the short link', async () => {
    const r = await rig();
    const preview = await r.call({ house: 'house.example', persona: 'curious' });
    const out = await r.call({ confirm_token: tokenOf(preview) });

    expect(r.sign).toHaveBeenCalledTimes(1);
    expect(r.post).toHaveBeenCalledTimes(1);
    expect(out).toContain(`${APP}/w/abc123`);

    // What was actually handed to the shortener has to verify against the
    // site's own rules, under the site's own audience.
    const body = JSON.parse(r.post.mock.calls[0]![2] as string) as { token: string };
    const verdict = verifyBrowserEntryToken(body.token, { audience: APP, nowSeconds: NOW });
    expect(verdict.ok).toBe(true);
    expect(verdict.ok && verdict.claims['popclaw_id']).toBe(r.signerBox.popclawId);
    expect(verdict.ok && verdict.claims['self_portrait']).toEqual({ persona: 'curious' });
    expect(verdict.ok && verdict.claims['exp']).toBe(NOW + BROWSER_ENTRY_TTL_SECONDS);
    // The shortener that was asked is the declared one, not one this machine chose.
    expect(r.post.mock.calls[0]![0]).toBe(`${APP}/api/shorten`);
  });

  it('carries only the portrait fields the owner actually gave', async () => {
    const r = await rig();
    const preview = await r.call({ house: 'house.example', description: 'a test lobster', home_city: '   ' });
    await r.call({ confirm_token: tokenOf(preview) });
    const body = JSON.parse(r.post.mock.calls[0]![2] as string) as { token: string };
    const verdict = verifyBrowserEntryToken(body.token, { audience: APP, nowSeconds: NOW });
    expect(verdict.ok && verdict.claims['self_portrait']).toEqual({ description: 'a test lobster' });
  });

  it('falls back to the long link on the SAME site when the shortener fails', async () => {
    const r = await rig({ shortenReply: { status: 502, text: 'nope' } });
    const preview = await r.call({ house: 'house.example' });
    const out = await r.call({ confirm_token: tokenOf(preview) });
    expect(out).toContain('BROWSER_ENTRY_SHORTEN_FAILED');
    expect(out).toContain(`${APP}/welcome?t=pcw2.`);
  });

  it('discards a short link that points at another site', async () => {
    const r = await rig({ shortenReply: { status: 200, text: JSON.stringify({ url: 'https://evil.example/w/abc' }) } });
    const preview = await r.call({ house: 'house.example' });
    const out = await r.call({ confirm_token: tokenOf(preview) });
    expect(out).not.toContain('evil.example');
    expect(out).toContain(`${APP}/welcome?t=pcw2.`);
  });

  it('says so plainly when the house offers no shortener at all', async () => {
    const r = await rig({
      manifest: { browser_entry: { profile: BROWSER_ENTRY_PROFILE, audience: APP, entry_url: `${APP}/welcome` } },
    });
    const preview = await r.call({ house: 'house.example' });
    const out = await r.call({ confirm_token: tokenOf(preview) });
    expect(r.post).toHaveBeenCalledTimes(0);
    expect(out).toContain('no short link');
    expect(out).toContain(`${APP}/welcome?t=pcw2.`);
  });
});

/**
 * The minted link is a bearer key that cannot be revoked. An agent on a real
 * host re-posted it verbatim in a later reply under another name; the receipt
 * therefore says, in the owner's language, that it is shown once, and keeps
 * the link alone under a separator so the explanation can travel without it.
 */
describe('the entry link is shown once and named consistently', () => {
  const occurrences = (text: string, needle: string): number => text.split(needle).length - 1;
  const HOME_NAMES = /home link|link home|回家链接/i;

  afterEach(() => setOwnerLang('en', 'config'));

  for (const lang of ['en', 'zh-CN'] as const) {
    it(`says show-once, never repeat, issue a new one — and carries the link exactly once (${lang})`, async () => {
      setOwnerLang(lang, 'config');
      const r = await rig();
      const preview = await r.call({ house: 'house.example' });
      const out = await r.call({ confirm_token: tokenOf(preview) });
      const link = `${APP}/w/abc123`;

      expect(out).toContain(renderCopy(lang, 'houseEntry.showOnce'));
      expect(occurrences(out, link)).toBe(1);
      // The link sits alone on the last line, right under the separator label.
      const lines = out.split('\n');
      expect(lines.at(-1)).toBe(link);
      expect(lines.at(-2)).toBe(renderCopy(lang, 'houseEntry.linkLabel'));
      expect(occurrences(lines.slice(0, -1).join('\n'), 'abc123')).toBe(0);
      expect(out).not.toMatch(HOME_NAMES);
    });
  }

  it('carries the long link exactly once when there is no short one', async () => {
    const r = await rig({ shortenReply: { status: 502, text: 'nope' } });
    const preview = await r.call({ house: 'house.example' });
    const out = await r.call({ confirm_token: tokenOf(preview) });
    expect(occurrences(out, 'pcw2.')).toBe(1);
    expect(out.split('\n').at(-1)).toContain(`${APP}/welcome?t=pcw2.`);
  });

  it('the instruction is in both lexicons, and the description says it too', async () => {
    const r = await rig();
    expect(en.copy['houseEntry.showOnce']).toMatch(/shown this once/i);
    expect(en.copy['houseEntry.showOnce']).toMatch(/never repeat, quote or rewrite/);
    expect(en.copy['houseEntry.showOnce']).toMatch(/issue a new one/);
    expect(zhCN.copy['houseEntry.showOnce']).toContain('只显示这一次');
    expect(zhCN.copy['houseEntry.showOnce']).toContain('不要重复、引用或改写');
    expect(zhCN.copy['houseEntry.showOnce']).toContain('重新签一条');
    expect(r.description).toMatch(/shown ONCE/);
    expect(r.description).toMatch(/never repeat, quote or rewrite/);
    expect(r.description).toMatch(/issue a\s+new one/);
  });

  it('never calls it a home link in the copy the owner or the agent reads', async () => {
    const r = await rig();
    const copy = [en, zhCN].flatMap((l) =>
      Object.entries(l.copy).filter(([k]) => k.startsWith('houseEntry.')).map(([, v]) => v),
    );
    expect(copy.length).toBeGreaterThan(0);
    for (const v of copy) expect(v).not.toMatch(HOME_NAMES);
    expect(r.description).not.toMatch(HOME_NAMES);
  });

  it('still routes an owner who says 回家链接, while naming it 入门链接 to the agent', () => {
    // `say` is owner input, matched against what the owner types; only say[0]
    // is rendered to the agent (renderL2Hit).
    const hits = matchLexicon('给我回家链接');
    expect(hits.map((e) => e.tool)).toContain('popclaw_house_entry_link');
    const entry = hits.find((e) => e.tool === 'popclaw_house_entry_link')!;
    expect(entry.say[0]).toBe('入门链接');
    expect(renderL2Hit(entry)).not.toMatch(HOME_NAMES);
  });
});

/**
 * A different lapse than show-once: on a real host the agent recalled a link
 * issued the PREVIOUS DAY from its own conversation context and re-pasted it
 * during a plain preview call, where no link is minted at all. The plugin
 * cannot see or filter a host model's recall, so the fix is an instruction
 * the agent reads on every preview and every issue, not a runtime control.
 */
describe('the agent is told never to restate a previously issued entry link', () => {
  const HOME_NAMES = /home link|link home|回家链接/i;

  afterEach(() => setOwnerLang('en', 'config'));

  for (const lang of ['en', 'zh-CN'] as const) {
    it(`both the preview and the issue output carry the no-restate instruction, before the link (${lang})`, async () => {
      setOwnerLang(lang, 'config');
      const r = await rig();
      const preview = await r.call({ house: 'house.example' });
      expect(preview).toContain(renderCopy(lang, 'houseEntry.noRestate'));

      const out = await r.call({ confirm_token: tokenOf(preview) });
      expect(out).toContain(renderCopy(lang, 'houseEntry.noRestate'));

      // The instruction has to be read before the key it is warning about,
      // not after — the receipt reads top to bottom.
      const lines = out.split('\n');
      const noRestateLine = lines.indexOf(renderCopy(lang, 'houseEntry.noRestate'));
      const linkLine = lines.indexOf(`${APP}/w/abc123`);
      expect(noRestateLine).toBeGreaterThanOrEqual(0);
      expect(linkLine).toBeGreaterThan(noRestateLine);
    });
  }

  it('the instruction says the old link stays valid until it expires, never claims re-issuing revokes or replaces it, and the description carries the memory point too', async () => {
    const r = await rig();
    expect(en.copy['houseEntry.noRestate']).toMatch(/never restate, summarize, or re-link/i);
    expect(en.copy['houseEntry.noRestate']).toMatch(/stays valid until it expires/);
    expect(en.copy['houseEntry.noRestate']).toMatch(/does not revoke or otherwise affect the old one/);
    expect(zhCN.copy['houseEntry.noRestate']).toContain('不要复述、概括或重新贴出');
    expect(zhCN.copy['houseEntry.noRestate']).toContain('在到期前仍然有效');
    expect(zhCN.copy['houseEntry.noRestate']).toContain('不会作废也不会影响它');
    expect(r.description).toMatch(/never restate, summarize or re-link it from memory/);
    expect(r.description).toMatch(/does not revoke the old one/);
  });

  it('never calls it a home link in the new copy either', () => {
    expect(en.copy['houseEntry.noRestate']).not.toMatch(HOME_NAMES);
    expect(zhCN.copy['houseEntry.noRestate']).not.toMatch(HOME_NAMES);
  });
});

describe('a confirmation belongs to one operation and one moment', () => {
  it('refuses a second use of the same token, and signs nothing the second time', async () => {
    const r = await rig();
    const token = tokenOf(await r.call({ house: 'house.example' }));
    await r.call({ confirm_token: token });
    expect(r.sign).toHaveBeenCalledTimes(1);
    const again = await r.call({ confirm_token: token });
    expect(again).toContain('unknown or expired confirm_token');
    expect(r.sign).toHaveBeenCalledTimes(1);
  });

  it('refuses an expired draft', async () => {
    vi.useFakeTimers();
    try {
      const r = await rig();
      const token = tokenOf(await r.call({ house: 'house.example' }));
      vi.advanceTimersByTime(31 * 60 * 1000);
      const out = await r.call({ confirm_token: token });
      expect(out).toContain('unknown or expired confirm_token');
      expect(r.sign).toHaveBeenCalledTimes(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses a token minted by another tool, and leaves that other draft alone', async () => {
    const r = await rig();
    const foreign = makeDraftToken('message');
    const fired = vi.fn(async () => ({ text: 'the DM went out' }));
    putDraft(foreign, fired);
    const out = await r.call({ confirm_token: foreign });
    expect(out).toContain('unknown or expired confirm_token');
    expect(fired).toHaveBeenCalledTimes(0);
    expect(r.sign).toHaveBeenCalledTimes(0);
  });

  it('refuses after the acting identity changed', async () => {
    const r = await rig();
    const token = tokenOf(await r.call({ house: 'house.example' }));
    const other = makeSigner(9);
    r.signerBox.signer.popclawId = other.signer.popclawId;
    const out = await r.call({ confirm_token: token });
    expect(out).toContain('IDENTITY_OR_PIN_CHANGED');
    expect(r.sign).toHaveBeenCalledTimes(0);
  });

  it('refuses after the pin was blocked', async () => {
    const r = await rig();
    const token = tokenOf(await r.call({ house: 'house.example' }));
    r.db.execute('UPDATE house_binding_pin SET blocked_reason = ? WHERE origin = ?', ['HOUSE_KEY_CHANGED', HOUSE]);
    const out = await r.call({ confirm_token: token });
    expect(out).toContain('HOUSE_NOT_PINNED');
    expect(r.sign).toHaveBeenCalledTimes(0);
  });

  it('refuses after the pin moved to another revision', async () => {
    const r = await rig();
    const token = tokenOf(await r.call({ house: 'house.example' }));
    r.db.execute('UPDATE house_binding_pin SET revision = revision + 1 WHERE origin = ?', [HOUSE]);
    const out = await r.call({ confirm_token: token });
    expect(out).toContain('IDENTITY_OR_PIN_CHANGED');
    expect(r.sign).toHaveBeenCalledTimes(0);
  });

  it('refuses after the declaration moved the site the link leads to', async () => {
    const r = await rig();
    const token = tokenOf(await r.call({ house: 'house.example' }));
    // A NEW verified manifest, through the real confirm path — the house
    // genuinely moved its entrance while the owner was being asked.
    const moved = mintHouse({
      origin: HOUSE,
      seed: 1,
      manifest: { browser_entry: { ...ENTRY, entry_url: `${APP}/enter` } },
    });
    const confirmed = await confirmHouseTrust(r.db, HOUSE, {
      fetch: moved.fetch as typeof globalThis.fetch,
      now: () => 1_700_000_100,
    });
    expect(confirmed.ok).toBe(true);
    const out = await r.call({ confirm_token: token });
    expect(out).toContain('IDENTITY_OR_PIN_CHANGED');
    expect(r.sign).toHaveBeenCalledTimes(0);
  });

  it('refuses after the house withdrew its entrance, by the entrance’s own name', async () => {
    const r = await rig();
    const token = tokenOf(await r.call({ house: 'house.example' }));
    const withdrawn = mintHouse({ origin: HOUSE, seed: 1, manifest: {} });
    await confirmHouseTrust(r.db, HOUSE, {
      fetch: withdrawn.fetch as typeof globalThis.fetch,
      now: () => 1_700_000_100,
    });
    const out = await r.call({ confirm_token: token });
    expect(out).toContain('BROWSER_ENTRY_NOT_DECLARED');
    expect(r.sign).toHaveBeenCalledTimes(0);
  });
});

describe('what the tool refuses to be told', () => {
  it.each([
    ['origin', { house: 'house.example', origin: 'https://evil.example' }],
    ['audience', { house: 'house.example', audience: 'https://evil.example' }],
    ['ttl', { house: 'house.example', ttl: 999999 }],
    ['popclaw_id', { house: 'house.example', popclaw_id: 'someone-else' }],
    ['bytes', { house: 'house.example', bytes: 'AAAA' }],
  ])('refuses a caller-supplied %s instead of ignoring it', async (field, params) => {
    const r = await rig();
    const out = await r.call(params);
    expect(out).toContain(field);
    expect(out).toContain('does not take');
    expect(r.sign).toHaveBeenCalledTimes(0);
    expect(r.post).toHaveBeenCalledTimes(0);
  });

  it('refuses a URL where a house name belongs', async () => {
    const r = await rig();
    const out = await r.call({ house: 'https://evil.example' });
    expect(out).toContain('HOUSE_NOT_MOUNTED');
    expect(r.sign).toHaveBeenCalledTimes(0);
  });

  it('refuses a house this machine has not mounted, and lists the ones it has', async () => {
    const r = await rig();
    const out = await r.call({ house: 'somewhere-else' });
    expect(out).toContain('HOUSE_NOT_MOUNTED');
    expect(out).toContain('house-example');
  });

  it('refuses a fragment that names two mounted houses, instead of guessing which one', async () => {
    // Both slugs contain "house" (house-north-example / house-south-example),
    // so a bare "house" is genuinely ambiguous between two real, pinned
    // houses — not a typo against one. Picking the first would hand a login
    // key to whichever house happened to sort first.
    const r = await rig({
      houses: [
        { origin: 'https://house-north.example', seed: 1 },
        { origin: 'https://house-south.example', seed: 2 },
      ],
    });
    const out = await r.call({ house: 'house' });
    expect(out).toContain('HOUSE_NOT_MOUNTED');
    expect(r.sign).toHaveBeenCalledTimes(0);
    expect(r.post).toHaveBeenCalledTimes(0);
  });

  it('asks which house when told nothing', async () => {
    const r = await rig();
    expect(await r.call({})).toMatch(/Which house/);
  });
});

describe('a house that declares no browser entrance', () => {
  it('refuses by name, with the signer untouched', async () => {
    const r = await rig({ manifest: {} });
    const out = await r.call({ house: 'house.example' });
    expect(out).toContain('BROWSER_ENTRY_NOT_DECLARED');
    expect(r.sign).toHaveBeenCalledTimes(0);
    expect(r.post).toHaveBeenCalledTimes(0);
  });

  it('refuses an entrance whose URLs left the site it named', async () => {
    const r = await rig({
      manifest: { browser_entry: { ...ENTRY, entry_url: 'https://elsewhere.example/welcome' } },
    });
    const out = await r.call({ house: 'house.example' });
    expect(out).toContain('BROWSER_ENTRY_ORIGIN_MISMATCH');
    expect(r.sign).toHaveBeenCalledTimes(0);
  });
});

/**
 * A projection is a snapshot, and a snapshot can be older than the house.
 *
 * Found in real acceptance: a root pinned the house before it declared an
 * entrance, and the tool kept reporting "that house never opened the door"
 * off that snapshot while the live, verified manifest said otherwise. Whether
 * the owner recovered depended on which other tool the agent happened to
 * call. The fix is ONE re-check through the same verified confirm every
 * reconnect uses — never a looser read, and never on the happy path.
 */
describe('a declaration older than the house is re-checked once, through the verified path', () => {
  const MOUNTED_AT = 1_700_000_000;
  const MOUNTED_ISO = new Date(MOUNTED_AT * 1000).toISOString().replace('.000Z', 'Z');
  const NOW_ISO = new Date(NOW * 1000).toISOString().replace('.000Z', 'Z');

  const row = (db: InMemoryHostDb) =>
    db.queryOne<{ browser_entry: string | null; updated_at: number }>(
      'SELECT browser_entry, updated_at FROM house_read_declaration WHERE origin = ?',
      [HOUSE],
    );

  afterEach(() => setOwnerLang(null));

  it('refreshes a projection that predates the entrance, and then issues the link', async () => {
    const live = mintHouse({ origin: HOUSE, seed: 1, manifest: { browser_entry: ENTRY } });
    const fetch = vi.fn(live.fetch);
    const r = await rig({ manifest: {}, houseReadFetch: fetch });
    expect(row(r.db)?.browser_entry).toBeNull();

    const preview = await r.call({ house: 'house.example' });
    expect(preview).toMatch(/confirm_token: house-entry-\d+/);
    expect(preview).toContain(`${APP}/welcome`);
    // Exactly one manifest fetch, through the house's own lane.
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(fetch.mock.calls[0]![0])).toBe(`${HOUSE}/v1/manifest`);
    expect(r.lanes).toEqual([HOUSE]);
    // Persisted the way a confirm persists it, so the next call is local.
    expect(row(r.db)?.browser_entry).not.toBeNull();
    expect(row(r.db)?.updated_at).toBe(NOW);

    // And the parked operation is still the one the owner was shown.
    const out = await r.call({ confirm_token: tokenOf(preview) });
    expect(out).toContain(`${APP}/w/abc123`);
    expect(r.sign).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('does not touch the network when the projection already declares an entrance', async () => {
    const fetch = vi.fn();
    const r = await rig({ houseReadFetch: fetch });
    const preview = await r.call({ house: 'house.example' });
    expect(preview).toMatch(/confirm_token: house-entry-\d+/);
    expect(fetch).toHaveBeenCalledTimes(0);
    expect(r.lanes).toEqual([]);
  });

  it('keeps the refusal, dated, when the re-check succeeds and the house still has no entrance', async () => {
    const live = mintHouse({ origin: HOUSE, seed: 1, manifest: {} });
    const fetch = vi.fn(live.fetch);
    const r = await rig({ manifest: {}, houseReadFetch: fetch });
    const out = await r.call({ house: 'house.example' });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(out).toBe(renderCopy('en', 'houseEntry.notDeclared', { house: HOUSE, checkedAt: NOW_ISO }));
    expect(out).toContain('BROWSER_ENTRY_NOT_DECLARED');
    expect(out).toContain(NOW_ISO);
    expect(out).not.toContain('last verified check');
    expect(row(r.db)?.updated_at).toBe(NOW);
  });

  it('says how old its answer is when the re-check cannot reach the house', async () => {
    const fetch = vi.fn(async () => {
      throw new Error('connect ECONNREFUSED');
    });
    const r = await rig({ manifest: {}, houseReadFetch: fetch });
    const out = await r.call({ house: 'house.example' });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(out).toContain('BROWSER_ENTRY_NOT_DECLARED');
    expect(out).toContain('as of the last verified check');
    expect(out).toContain(MOUNTED_ISO);
    expect(out).toContain('popclaw_house_login');
    expect(out).not.toContain('confirm_token');
    // Nothing moved.
    expect(row(r.db)).toEqual({ browser_entry: null, updated_at: MOUNTED_AT });
    expect(r.sign).toHaveBeenCalledTimes(0);
  });

  it('does not let an unverifiable manifest that claims an entrance unlock the link', async () => {
    const impostor = mintHouse({
      origin: HOUSE,
      seed: 1,
      manifest: { browser_entry: ENTRY },
      signWith: nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(9)).secretKey,
    });
    const fetch = vi.fn(impostor.fetch);
    const r = await rig({ manifest: {}, houseReadFetch: fetch });
    const out = await r.call({ house: 'house.example' });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(out).toContain('BROWSER_ENTRY_NOT_DECLARED');
    expect(out).toContain('as of the last verified check');
    expect(out).toContain(MOUNTED_ISO);
    expect(out).not.toContain('confirm_token');
    expect(out).not.toContain(APP);
    expect(row(r.db)).toEqual({ browser_entry: null, updated_at: MOUNTED_AT });
    expect(r.sign).toHaveBeenCalledTimes(0);
  });

  it('says so honestly when this runtime has no lane to re-check through', async () => {
    const r = await rig({ manifest: {} });
    const out = await r.call({ house: 'house.example' });
    expect(out).toContain('as of the last verified check');
    expect(out).toContain(MOUNTED_ISO);
  });

  it('never re-checks a house that is not pinned here', async () => {
    const fetch = vi.fn();
    const r = await rig({ unpinned: true, houseReadFetch: fetch });
    const out = await r.call({ house: 'house.example' });
    expect(out).toContain('HOUSE_NOT_PINNED');
    expect(fetch).toHaveBeenCalledTimes(0);
    expect(r.lanes).toEqual([]);
  });

  it('reports the block, not a stale "no entrance", when the re-check blocks the pin', async () => {
    const reincarnated = mintHouse({ origin: HOUSE, seed: 1, incarnation: '2', manifest: { browser_entry: ENTRY } });
    const fetch = vi.fn(reincarnated.fetch);
    const r = await rig({ manifest: {}, houseReadFetch: fetch });
    const out = await r.call({ house: 'house.example' });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(out).toContain('HOUSE_NOT_PINNED');
    expect(out).not.toContain('BROWSER_ENTRY_NOT_DECLARED');
    expect(out).not.toContain('confirm_token');
    const pin = r.db.queryOne<{ blocked_reason: string | null }>(
      'SELECT blocked_reason FROM house_binding_pin WHERE origin = ?',
      [HOUSE],
    );
    expect(pin?.blocked_reason).toBeTruthy();
    expect(row(r.db)).toEqual({ browser_entry: null, updated_at: MOUNTED_AT });
    expect(r.sign).toHaveBeenCalledTimes(0);
  });

  it('does not re-check again within a minute of a verified check', async () => {
    const live = mintHouse({ origin: HOUSE, seed: 1, manifest: {} });
    const fetch = vi.fn(live.fetch);
    const r = await rig({ manifest: {}, houseReadFetch: fetch });
    const first = await r.call({ house: 'house.example' });
    const second = await r.call({ house: 'house.example' });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
    expect(second).toBe(renderCopy('en', 'houseEntry.notDeclared', { house: HOUSE, checkedAt: NOW_ISO }));
  });

  it('does not take an entrance from a manifest validly signed by a different house key', async () => {
    const other = mintHouse({ origin: HOUSE, seed: 2, manifest: { browser_entry: ENTRY } });
    const fetch = vi.fn(other.fetch);
    const r = await rig({ manifest: {}, houseReadFetch: fetch });
    const out = await r.call({ house: 'house.example' });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(out).not.toContain('confirm_token');
    expect(out).not.toContain(APP);
    expect(row(r.db)).toEqual({ browser_entry: null, updated_at: MOUNTED_AT });
    expect(r.sign).toHaveBeenCalledTimes(0);
  });

  it('does not fetch for a house the owner has left, and says why the answer is old', async () => {
    const fetch = vi.fn();
    const r = await rig({ manifest: {}, houseReadFetch: fetch });
    r.db.execute('UPDATE relation_participation SET active = 0');
    const out = await r.call({ house: 'house.example' });
    expect(fetch).toHaveBeenCalledTimes(0);
    expect(out).toBe(
      renderCopy('en', 'houseEntry.notDeclaredStale', {
        house: HOUSE,
        checkedAt: MOUNTED_ISO,
        reason: 'HOUSE_OWNER_MOVED_ON',
      }),
    );
  });

  it('never re-checks a house whose pin is blocked', async () => {
    const fetch = vi.fn();
    const r = await rig({ manifest: {}, houseReadFetch: fetch });
    r.db.execute('UPDATE house_binding_pin SET blocked_reason = ? WHERE origin = ?', ['HOUSE_KEY_CHANGED', HOUSE]);
    const out = await r.call({ house: 'house.example' });
    expect(out).toContain('HOUSE_NOT_PINNED');
    expect(fetch).toHaveBeenCalledTimes(0);
  });

  it('renders both refusals in the zh-CN lane too', async () => {
    setOwnerLang('zh-CN', 'config');
    const down = await rig({ manifest: {}, houseReadFetch: vi.fn(async () => { throw new Error('down'); }) });
    const stale = await down.call({ house: 'house.example' });
    expect(stale).toBe(
      renderCopy('zh-CN', 'houseEntry.notDeclaredStale', { house: HOUSE, checkedAt: MOUNTED_ISO, reason: 'down' }),
    );
    expect(stale).not.toBe(
      renderCopy('en', 'houseEntry.notDeclaredStale', { house: HOUSE, checkedAt: MOUNTED_ISO, reason: 'down' }),
    );
    expect(stale).toContain(MOUNTED_ISO);
    expect(stale).toContain('popclaw_house_login');

    const live = mintHouse({ origin: HOUSE, seed: 1, manifest: {} });
    const fresh = await rig({ manifest: {}, houseReadFetch: vi.fn(live.fetch) });
    const dated = await fresh.call({ house: 'house.example' });
    expect(dated).toBe(renderCopy('zh-CN', 'houseEntry.notDeclared', { house: HOUSE, checkedAt: NOW_ISO }));
    expect(dated).not.toBe(renderCopy('en', 'houseEntry.notDeclared', { house: HOUSE, checkedAt: NOW_ISO }));
    expect(dated).toContain(NOW_ISO);
  });
});
