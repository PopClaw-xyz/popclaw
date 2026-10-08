/**
 * Namecard write guard — every branch pinned.
 *
 * The guard exists so a whole-row profile re-issue (ADR-0008 upsert) can
 * never clear content this public client cannot re-emit. Each test names
 * the evidence class it fixes: only a complete match of the fixed server's
 * ProfileResponse contract (profiles.rs at e753) may prove "no card" or
 * "clean card"; every unknown shape — 404, partial cards, wrong types,
 * wrong identity, null — fails closed. Covers the independent negative set
 * from reviews/namecard-evidence-v1 (partial cards permit writes; 404 /
 * missing-card / empty-card / wrong-actor / false-card each pushed once).
 */
import { describe, expect, it, vi } from 'vitest';
import {
  classifyNamecardCard,
  guardNamecardWrite,
  readHouseProfileEvidence,
} from '../../../src/messaging/namecard-write-guard.js';

const ID = 'Dh5SiYGF3oQPCbJPUbHnCT5LXGwABp2fRC1GJZKeYqhr';

/** A complete card with every unowned field empty. */
const CLEAN_CARD = {
  nickname: 'a',
  one_line_intro: '',
  taste_tags: [],
  role_persona: '',
  location_hint: '',
  avatar_uri: '',
  declared_at_ms: 1000,
  payout_addresses: [],
};

function completeBody(withCard?: Record<string, unknown>): Record<string, unknown> {
  return {
    popclaw_id: ID,
    sigil: 'abc234',
    profiles: [],
    house_follower_count: 0,
    house_post_count: 0,
    house_reply_received_count: 0,
    ...(withCard === undefined ? {} : { card: withCard }),
  };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('classifyNamecardCard', () => {
  it('rejects null/undefined — the conformant no-card answer omits the key', () => {
    expect(classifyNamecardCard(null)).toMatchObject({ kind: 'malformed' });
    expect(classifyNamecardCard(undefined)).toMatchObject({ kind: 'malformed' });
  });

  it('rejects non-object cards as malformed', () => {
    expect(classifyNamecardCard('card').kind).toBe('malformed');
    expect(classifyNamecardCard([]).kind).toBe('malformed');
    expect(classifyNamecardCard(42).kind).toBe('malformed');
    expect(classifyNamecardCard(false).kind).toBe('malformed');
  });

  it('rejects partial cards — a projection omitting stored fields proves nothing (review P1)', () => {
    expect(classifyNamecardCard({})).toMatchObject({ kind: 'malformed' });
    expect(classifyNamecardCard({ nickname: 'old' })).toMatchObject({ kind: 'malformed', detail: expect.stringContaining('missing') });
    expect(classifyNamecardCard({ nickname: 'old', declared_at_ms: 1000 })).toMatchObject({ kind: 'malformed' });
    expect(classifyNamecardCard({ ...CLEAN_CARD, payout_addresses: undefined })).toMatchObject({ kind: 'malformed' });
  });

  it('accepts a complete, cleanly-typed card', () => {
    expect(classifyNamecardCard(CLEAN_CARD)).toEqual({ kind: 'clean', declaredAtMs: 1000, nickname: 'a', oneLineIntro: '' });
  });

  it('blocks unknown field names (legacy payout spellings and anything else)', () => {
    expect(classifyNamecardCard({ ...CLEAN_CARD, payout_addresses_x: [] })).toEqual({
      kind: 'unowned',
      fields: ['payout_addresses_x'],
    });
    expect(classifyNamecardCard({ ...CLEAN_CARD, future_field: null })).toEqual({
      kind: 'unowned',
      fields: ['future_field'],
    });
  });

  it('blocks content in unowned-but-public fields, including payout addresses', () => {
    expect(classifyNamecardCard({ ...CLEAN_CARD, one_line_intro: 'hi' })).toEqual({ kind: 'unowned', fields: ['one_line_intro'] });
    expect(classifyNamecardCard({ ...CLEAN_CARD, taste_tags: ['x'] })).toEqual({ kind: 'unowned', fields: ['taste_tags'] });
    expect(classifyNamecardCard({ ...CLEAN_CARD, role_persona: 'jester' })).toEqual({ kind: 'unowned', fields: ['role_persona'] });
    expect(classifyNamecardCard({ ...CLEAN_CARD, location_hint: 'earth' })).toEqual({ kind: 'unowned', fields: ['location_hint'] });
    expect(classifyNamecardCard({ ...CLEAN_CARD, avatar_uri: 'https://x/y.png' })).toEqual({ kind: 'unowned', fields: ['avatar_uri'] });
    expect(classifyNamecardCard({ ...CLEAN_CARD, payout_addresses: [{ chain: 'eip155:1', address: '0x1' }] })).toEqual({ kind: 'unowned', fields: ['payout_addresses'] });
  });

  it('treats wrong-typed values as malformed, never as empty', () => {
    expect(classifyNamecardCard({ ...CLEAN_CARD, one_line_intro: 42 }).kind).toBe('malformed');
    expect(classifyNamecardCard({ ...CLEAN_CARD, nickname: 42 }).kind).toBe('malformed');
    expect(classifyNamecardCard({ ...CLEAN_CARD, declared_at_ms: '123' }).kind).toBe('malformed');
    expect(classifyNamecardCard({ ...CLEAN_CARD, declared_at_ms: Number.POSITIVE_INFINITY }).kind).toBe('malformed');
    expect(classifyNamecardCard({ ...CLEAN_CARD, taste_tags: [1] }).kind).toBe('malformed');
    expect(classifyNamecardCard({ ...CLEAN_CARD, taste_tags: 'x' }).kind).toBe('malformed');
    expect(classifyNamecardCard({ ...CLEAN_CARD, avatar_uri: null }).kind).toBe('malformed');
    expect(classifyNamecardCard({ ...CLEAN_CARD, location_hint: {} }).kind).toBe('malformed');
    expect(classifyNamecardCard({ ...CLEAN_CARD, payout_addresses: 'none' }).kind).toBe('malformed');
    expect(classifyNamecardCard({ ...CLEAN_CARD, payout_addresses: [null] }).kind).toBe('malformed');
    expect(classifyNamecardCard({ ...CLEAN_CARD, payout_addresses: [{ chain: 1, address: '0x1' }] }).kind).toBe('malformed');
  });
});

describe('readHouseProfileEvidence', () => {
  const deps = (fetchImpl: typeof globalThis.fetch) => ({ fetch: fetchImpl });

  it('returns no-card only for a COMPLETE contract match with the card key omitted', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(completeBody()));
    await expect(readHouseProfileEvidence('https://h.example', ID, deps(fetchMock as unknown as typeof globalThis.fetch))).resolves.toEqual({ status: 'no-card' });
  });

  it('rejects an omitted card when other required members are missing (profiles.rs: six always-serialized fields)', async () => {
    for (const drop of ['sigil', 'profiles', 'house_follower_count', 'house_post_count', 'house_reply_received_count']) {
      const body = completeBody();
      delete (body as Record<string, unknown>)[drop];
      const fetchMock = vi.fn(async () => jsonResponse(body));
      const evidence = await readHouseProfileEvidence('https://h.example', ID, deps(fetchMock as unknown as typeof globalThis.fetch));
      expect(evidence).toMatchObject({ status: 'blocked', kind: 'unreadable' });
    }
  });

  it('rejects profiles[] that is not conformant ProfileEntry content (e.g. [null])', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(completeBody().profiles !== undefined
      ? { ...completeBody(), profiles: [null] }
      : completeBody()));
    const evidence = await readHouseProfileEvidence('https://h.example', ID, deps(fetchMock as unknown as typeof globalThis.fetch));
    expect(evidence).toMatchObject({ status: 'blocked', kind: 'unreadable', detail: expect.stringContaining('ProfileEntry') });
  });

  it('returns clean-card for a complete clean card', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(completeBody(CLEAN_CARD)));
    await expect(readHouseProfileEvidence('https://h.example', ID, deps(fetchMock as unknown as typeof globalThis.fetch))).resolves.toEqual({ status: 'clean-card', declaredAtMs: 1000, nickname: 'a', oneLineIntro: '' });
  });

  it('fails closed on 404 (review negative: route 404)', async () => {
    const fetchMock = vi.fn(async () => new Response('not found', { status: 404 }));
    await expect(readHouseProfileEvidence('https://h.example', ID, deps(fetchMock as unknown as typeof globalThis.fetch))).resolves.toMatchObject({ status: 'blocked', kind: 'unreadable', detail: 'HTTP 404' });
  });
});

describe('guardNamecardWrite', () => {
  const deps = (fetchImpl?: typeof globalThis.fetch) => ({
    popclawId: ID,
    houseOrigins: ['https://house.example'],
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  });

  it('accepts the complete contract no-card answer', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(completeBody()));
    await expect(guardNamecardWrite(deps(fetchMock as unknown as typeof globalThis.fetch))).resolves.toEqual({ ok: true });
  });

  it('accepts a complete clean card', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(completeBody(CLEAN_CARD)));
    await expect(guardNamecardWrite(deps(fetchMock as unknown as typeof globalThis.fetch))).resolves.toEqual({ ok: true });
  });

  it('blocks partial cards (review negatives: {}, nickname-only, nickname+declaredAt)', async () => {
    for (const card of [{}, { nickname: 'old' }, { nickname: 'old', declared_at_ms: 1000 }]) {
      const fetchMock = vi.fn(async () => jsonResponse(completeBody(card)));
      const check = await guardNamecardWrite(deps(fetchMock as unknown as typeof globalThis.fetch));
      expect(check).toMatchObject({ ok: false, kind: 'unreadable' });
    }
  });

  it('fails closed on 404, 5xx and transport failures', async () => {
    for (const fetchImpl of [
      vi.fn(async () => new Response('x', { status: 404 })),
      vi.fn(async () => new Response('x', { status: 503 })),
      vi.fn(async () => { throw new Error('boom'); }),
    ]) {
      const check = await guardNamecardWrite(deps(fetchImpl as unknown as typeof globalThis.fetch));
      expect(check).toMatchObject({ ok: false, kind: 'unreadable' });
    }
  });

  it('fails closed on invalid JSON, non-object bodies and wrong identities', async () => {
    for (const body of ['{trunc', '[1,2,3]', '{"popclaw_id":"other","card":null}']) {
      const fetchMock = vi.fn(async () => new Response(body, { status: 200 }));
      const check = await guardNamecardWrite(deps(fetchMock as unknown as typeof globalThis.fetch));
      expect(check).toMatchObject({ ok: false, kind: 'unreadable' });
    }
  });

  it('fails closed on a null card (review negative: false/null card)', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ...completeBody(), card: null }));
    const check = await guardNamecardWrite(deps(fetchMock as unknown as typeof globalThis.fetch));
    expect(check).toMatchObject({ ok: false, kind: 'unreadable' });
  });

  it('blocks a card carrying legacy payout fields or unowned content', async () => {
    for (const card of [
      { ...CLEAN_CARD, payout_addresses: [{ chain: 'eip155:1', address: '0x1' }] },
      { ...CLEAN_CARD, one_line_intro: 'kept elsewhere' },
    ]) {
      const fetchMock = vi.fn(async () => jsonResponse(completeBody(card)));
      const check = await guardNamecardWrite(deps(fetchMock as unknown as typeof globalThis.fetch));
      expect(check).toMatchObject({ ok: false, kind: 'unowned' });
    }
  });

  it('sends redirect: error — a redirect must not launder another origin in', async () => {
    const fetchMock = vi.fn(async (_input?: RequestInfo | URL, _init?: RequestInit) => jsonResponse(completeBody()));
    await guardNamecardWrite(deps(fetchMock as unknown as typeof globalThis.fetch));
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(init?.redirect).toBe('error');
  });

  it('fails closed on an oversized body', async () => {
    const big = 'x'.repeat(300 * 1024);
    const fetchMock = vi.fn(async () => new Response(big, { status: 200 }));
    const check = await guardNamecardWrite(deps(fetchMock as unknown as typeof globalThis.fetch));
    expect(check).toMatchObject({ ok: false, kind: 'unreadable' });
    expect(check.ok ? '' : check.detail).toContain('exceeds');
  });

  it('names the exact house that blocked a multi-house write', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) =>
      String(input).includes('second.example')
        ? new Response('not found', { status: 404 })
        : jsonResponse(completeBody()));
    const check = await guardNamecardWrite({
      popclawId: ID,
      houseOrigins: ['https://first.example', 'https://second.example'],
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    });
    expect(check).toMatchObject({ ok: false, kind: 'unreadable', house: 'https://second.example' });
  });

  it('passes only when every house answers affirmatively', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(completeBody()));
    const check = await guardNamecardWrite({
      popclawId: ID,
      houseOrigins: ['https://first.example', 'https://second.example'],
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    });
    expect(check).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
