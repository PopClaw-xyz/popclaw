/**
 * Namecard self-heal under the fail-closed write-evidence rules.
 *
 * The self-heal loop performs the same whole-row profile upsert (ADR-0008)
 * as a manual rename, so it pushes only on AFFIRMATIVE evidence:
 *   - a conformant body whose `card` key is omitted (the fixed server's
 *     explicit "no Profile yet" — profiles.rs skip_serializing_if);
 *   - a complete, cleanly-typed card older than ours.
 * Everything else — 404, partial/`{}`/null/false cards, wrong identity,
 * incomplete bodies, 5xx, network failure — produces ZERO pushes.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  ensureNamecardOnHouse,
  announceNamecardToHouses,
} from '../../../src/messaging/announce-namecard.js';
import type { MyNamecard } from '../../../src/messaging/my-namecard.js';

const CARD: MyNamecard = { nickname: 'BlackFeather', declaredAt: 1_700_000_000 };
const BYTES = new Uint8Array([1, 2, 3]);
const POPCLAW_ID = 'aaaaaaaaaa';

/** A complete card with every unowned field empty — what a clean public row looks like. */
const CLEAN_CARD = {
  nickname: 'BlackFeather',
  one_line_intro: '',
  taste_tags: [],
  role_persona: '',
  location_hint: '',
  avatar_uri: '',
  declared_at_ms: (CARD.declaredAt - 100) * 1000,
  payout_addresses: [],
};

function completeBody(extra: Record<string, unknown> = {}, withCard: Record<string, unknown> | null = null): Record<string, unknown> {
  return {
    popclaw_id: POPCLAW_ID,
    sigil: 'abc234',
    profiles: [],
    house_follower_count: 0,
    house_post_count: 0,
    house_reply_received_count: 0,
    ...extra,
    ...(withCard === null ? {} : { card: withCard }),
  };
}

function fetchReturning(status: number, body?: unknown): typeof fetch {
  return vi.fn(async () =>
    new Response(body === undefined ? 'x' : JSON.stringify(body), { status }),
  ) as unknown as typeof fetch;
}

function throwingFetch(): typeof fetch {
  return vi.fn(async () => {
    throw new Error('ECONNREFUSED');
  }) as unknown as typeof fetch;
}

describe('ensureNamecardOnHouse', () => {
  it('pushes on the conformant no-card answer (complete body, card key omitted)', async () => {
    const pushTo = vi.fn(async () => ({ status: 200 }));
    const pushed = await ensureNamecardOnHouse('https://house.example', {
      card: CARD,
      signedBytes: BYTES,
      popclawId: POPCLAW_ID,
      pushTo,
      fetch: fetchReturning(200, completeBody()),
    });
    expect(pushed).toBe(true);
    expect(pushTo).toHaveBeenCalledTimes(1);
    expect(pushTo).toHaveBeenCalledWith('house-example', BYTES);
  });

  it('ZERO pushes on 404 — an unimplemented route is not proof of no profile', async () => {
    const pushTo = vi.fn(async () => ({ status: 200 }));
    const logger = { info: vi.fn(), warn: vi.fn() };
    const pushed = await ensureNamecardOnHouse('https://house.example', {
      card: CARD,
      signedBytes: BYTES,
      popclawId: POPCLAW_ID,
      pushTo,
      logger,
      fetch: fetchReturning(404),
    });
    expect(pushed).toBe(false);
    expect(pushTo).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledTimes(1);
  });

  it('pushes when a complete clean house card is older than the local one', async () => {
    const pushTo = vi.fn(async () => ({ status: 200 }));
    const pushed = await ensureNamecardOnHouse('https://house.example', {
      card: CARD,
      signedBytes: BYTES,
      popclawId: POPCLAW_ID,
      pushTo,
      fetch: fetchReturning(200, completeBody({}, CLEAN_CARD)),
    });
    expect(pushed).toBe(true);
    expect(pushTo).toHaveBeenCalledTimes(1);
  });

  it('does nothing when the house card is equal or newer', async () => {
    const pushTo = vi.fn(async () => ({ status: 200 }));
    const pushed = await ensureNamecardOnHouse('https://house.example', {
      card: CARD,
      signedBytes: BYTES,
      popclawId: POPCLAW_ID,
      pushTo,
      fetch: fetchReturning(200, completeBody({}, { ...CLEAN_CARD, declared_at_ms: CARD.declaredAt * 1000 })),
    });
    expect(pushed).toBe(false);
    expect(pushTo).not.toHaveBeenCalled();
  });

  it('ZERO pushes on a card carrying unowned content — warn, leave the row untouched', async () => {
    const pushTo = vi.fn(async () => ({ status: 200 }));
    const logger = { info: vi.fn(), warn: vi.fn() };
    const pushed = await ensureNamecardOnHouse('https://house.example', {
      card: CARD,
      signedBytes: BYTES,
      popclawId: POPCLAW_ID,
      pushTo,
      logger,
      fetch: fetchReturning(200, completeBody({}, { ...CLEAN_CARD, one_line_intro: 'kept elsewhere' })),
    });
    expect(pushed).toBe(false);
    expect(pushTo).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('ZERO pushes on a card with declared payout addresses', async () => {
    const pushTo = vi.fn(async () => ({ status: 200 }));
    const logger = { info: vi.fn(), warn: vi.fn() };
    const pushed = await ensureNamecardOnHouse('https://house.example', {
      card: CARD,
      signedBytes: BYTES,
      popclawId: POPCLAW_ID,
      pushTo,
      logger,
      fetch: fetchReturning(200, completeBody({}, { ...CLEAN_CARD, payout_addresses: [{ chain: 'eip155:1', address: '0x1' }] })),
    });
    expect(pushed).toBe(false);
    expect(pushTo).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('ZERO pushes on an empty/partial card object — {} is not a complete Profile', async () => {
    const pushTo = vi.fn(async () => ({ status: 200 }));
    const pushed = await ensureNamecardOnHouse('https://house.example', {
      card: CARD,
      signedBytes: BYTES,
      popclawId: POPCLAW_ID,
      pushTo,
      fetch: fetchReturning(200, completeBody({}, { nickname: 'old' })),
    });
    expect(pushed).toBe(false);
    expect(pushTo).not.toHaveBeenCalled();
  });

  it('ZERO pushes on a null or false card — the conformant server never sends those', async () => {
    const pushTo = vi.fn(async () => ({ status: 200 }));
    for (const bad of [null, false]) {
      const pushed = await ensureNamecardOnHouse('https://house.example', {
        card: CARD,
        signedBytes: BYTES,
        popclawId: POPCLAW_ID,
        pushTo,
        fetch: fetchReturning(200, { ...completeBody(), card: bad }),
      });
      expect(pushed).toBe(false);
    }
    expect(pushTo).not.toHaveBeenCalled();
  });

  it('ZERO pushes when the body speaks about another identity', async () => {
    const pushTo = vi.fn(async () => ({ status: 200 }));
    const pushed = await ensureNamecardOnHouse('https://house.example', {
      card: CARD,
      signedBytes: BYTES,
      popclawId: POPCLAW_ID,
      pushTo,
      fetch: fetchReturning(200, completeBody({ popclaw_id: 'someone-else' }, CLEAN_CARD)),
    });
    expect(pushed).toBe(false);
    expect(pushTo).not.toHaveBeenCalled();
  });

  it('ZERO pushes on an incomplete response body (missing sigil/profiles/house_follower_count)', async () => {
    const pushTo = vi.fn(async () => ({ status: 200 }));
    const pushed = await ensureNamecardOnHouse('https://house.example', {
      card: CARD,
      signedBytes: BYTES,
      popclawId: POPCLAW_ID,
      pushTo,
      fetch: fetchReturning(200, { popclaw_id: POPCLAW_ID }),
    });
    expect(pushed).toBe(false);
    expect(pushTo).not.toHaveBeenCalled();
  });

  it('does nothing on 5xx — does not guess, logs one info line', async () => {
    const pushTo = vi.fn(async () => ({ status: 200 }));
    const logger = { info: vi.fn(), warn: vi.fn() };
    const pushed = await ensureNamecardOnHouse('https://house.example', {
      card: CARD,
      signedBytes: BYTES,
      popclawId: POPCLAW_ID,
      pushTo,
      logger,
      fetch: fetchReturning(503),
    });
    expect(pushed).toBe(false);
    expect(pushTo).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledTimes(1);
  });

  it('never throws on a network failure, and does not push', async () => {
    const pushTo = vi.fn(async () => ({ status: 200 }));
    const logger = { info: vi.fn(), warn: vi.fn() };
    await expect(
      ensureNamecardOnHouse('https://house.example', {
        card: CARD,
        signedBytes: BYTES,
        popclawId: POPCLAW_ID,
        pushTo,
        logger,
        fetch: throwingFetch(),
      }),
    ).resolves.toBe(false);
    expect(pushTo).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledTimes(1);
  });

  it('never throws even if pushTo itself rejects', async () => {
    const pushTo = vi.fn(async () => {
      throw new Error('house down');
    });
    await expect(
      ensureNamecardOnHouse('https://house.example', {
        card: CARD,
        signedBytes: BYTES,
        popclawId: POPCLAW_ID,
        pushTo,
        fetch: fetchReturning(200, completeBody()),
      }),
    ).resolves.toBe(true); // we did decide to push; the attempt failing is logged, not thrown
  });

  it('sends redirect: error on its profile read', async () => {
    const pushTo = vi.fn(async () => ({ status: 200 }));
    const fetchMock = vi.fn(async (_input?: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify(completeBody()), { status: 200 }));
    await ensureNamecardOnHouse('https://house.example', {
      card: CARD,
      signedBytes: BYTES,
      popclawId: POPCLAW_ID,
      pushTo,
      fetch: fetchMock as unknown as typeof fetch,
    });
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(init?.redirect).toBe('error');
  });
});

describe('announceNamecardToHouses', () => {
  it('skips the entire loop for a placeholder/absent card — zero requests', async () => {
    const fetchMock = vi.fn();
    const pushTo = vi.fn();
    await announceNamecardToHouses(['https://a.example', 'https://b.example'], {
      card: null,
      signedBytes: BYTES,
      popclawId: POPCLAW_ID,
      pushTo,
      fetch: fetchMock as unknown as typeof fetch,
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(pushTo).not.toHaveBeenCalled();
  });

  it('is best-effort per house — one house 5xx does not stop the others from being checked', async () => {
    const pushTo = vi.fn(async () => ({ status: 200 }));
    let call = 0;
    const fetchMock = vi.fn(async () => {
      call += 1;
      return call === 1
        ? new Response('x', { status: 503 })
        : new Response(JSON.stringify(completeBody()), { status: 200 });
    }) as unknown as typeof fetch;

    await announceNamecardToHouses(['https://a.example', 'https://b.example'], {
      card: CARD,
      signedBytes: BYTES,
      popclawId: POPCLAW_ID,
      pushTo,
      fetch: fetchMock,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(pushTo).toHaveBeenCalledTimes(1); // only the conformant no-card house gets pushed
  });
});
