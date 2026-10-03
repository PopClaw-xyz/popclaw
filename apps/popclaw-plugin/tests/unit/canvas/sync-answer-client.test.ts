/**
 * Answering a canvas about the page in front of the owner.
 *
 * The signature is what makes an answer the owner's, so the cases that matter
 * most here are the ones where nothing gets signed at all. Canvas builds its
 * questions from the page it stores, but this side cannot see that page — so
 * every refusal below has to hold on this side's own reading of the question,
 * not on the canvas having asked it properly.
 *
 * Strategy mirrors intent-pull-client.test.ts: fake HTTP seams capture the
 * wire, and the signature is verified against the twin's signing bytes rather
 * than compared to a recorded blob.
 */
import { describe, it, expect } from 'vitest';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import {
  makeSyncAnswerClient,
  SYNC_AUTHOR_CAP,
  SAME_PAGE_MIN_INTERVAL_MS,
} from '../../../src/canvas/sync-answer-client.js';
import { syncReplySigningBytes, type SyncReply, type SyncState } from '../../../src/canvas/canvas-signing.js';
import type { Signer } from '../../../src/identity/signer.js';

const kp = nacl.sign.keyPair();
const SELF = bs58.encode(kp.publicKey);
const OTHER = bs58.encode(nacl.sign.keyPair().publicKey);
const BASE = 'http://canvas.test';
const DIGEST = 'a'.repeat(64);

const signer = {
  popclawId: async () => SELF,
  publicKey: async () => kp.publicKey,
  sign: async (bytes: Uint8Array) => nacl.sign.detached(bytes, kp.secretKey),
} as unknown as Signer;

interface Question {
  request_id: string;
  canvas_id: string;
  page_digest: string;
  viewer: string;
  authors: string[];
  not_after: number;
}

const NOW = 1_789_722_919_000;
const question = (over: Partial<Question> = {}): Question => ({
  request_id: 'req-1',
  canvas_id: 'row-7',
  page_digest: DIGEST,
  viewer: SELF,
  authors: ['AAAuthor', 'BBBauthor'],
  not_after: NOW + 600_000,
  ...over,
});

/** A canvas that serves `questions` and records every reply posted to it. */
function fakeCanvas(questions: Question[], replyStatus = 200) {
  const posted: { reply: SyncReply; signature: string }[] = [];
  let pulls = 0;
  return {
    posted,
    pulls: () => pulls,
    fetchJson: async () => {
      pulls += 1;
      return { status: 200, text: JSON.stringify({ requests: questions }) };
    },
    postJson: async (_url: string, _headers: Record<string, string>, body: string) => {
      posted.push(JSON.parse(body) as { reply: SyncReply; signature: string });
      return { status: replyStatus, text: '{}' };
    },
  };
}

const client = (
  canvas: ReturnType<typeof fakeCanvas>,
  stateOf: (a: string) => SyncState = () => 'none',
  clock: () => number = () => NOW,
) => makeSyncAnswerClient({ baseUrl: BASE, signer, stateOf, fetchJson: canvas.fetchJson, postJson: canvas.postJson, clock });

describe('answering a page-state question', () => {
  it('signs exactly the bytes the canvas will rebuild', async () => {
    const canvas = fakeCanvas([question()]);
    expect(await client(canvas, (a) => (a === 'AAAuthor' ? 'follows' : 'none')).answerPending()).toBe(1);

    const { reply, signature } = canvas.posted[0]!;
    expect(
      nacl.sign.detached.verify(
        syncReplySigningBytes(reply),
        Buffer.from(signature, 'base64'),
        kp.publicKey,
      ),
    ).toBe(true);
    expect(reply.states).toEqual([['AAAuthor', 'follows'], ['BBBauthor', 'none']]);
    expect(reply.viewer).toBe(SELF);
    expect(reply.canvasOrigin).toBe(BASE);
  });

  it('claims a window a verifier will accept, centred on now', async () => {
    const canvas = fakeCanvas([question()]);
    await client(canvas).answerPending();
    const { reply } = canvas.posted[0]!;
    // The verifier refuses anything wider than its cap AND refuses a reply
    // whose window does not contain the CANVAS's clock. We build the window
    // from OURS, so half the width is the clock-skew tolerance: it has to be
    // both narrow enough and centred, not merely one of the two.
    expect(reply.notAfterMs - reply.notBeforeMs).toBeLessThanOrEqual(120_000);
    expect(reply.notBeforeMs).toBeLessThan(NOW);
    expect(reply.notAfterMs).toBeGreaterThan(NOW);
  });

  it('survives the clock skew the pull credential already tolerates', async () => {
    // A machine 59s out from the canvas used to fail EVERY reply, for good,
    // with no symptom but chips that never coloured — the window was ±30s
    // while the pull credential this same tick uses allows ±60s. The two
    // tolerances have to agree or the feature is off for anyone in between.
    const canvas = fakeCanvas([question()]);
    await client(canvas).answerPending();
    const { reply } = canvas.posted[0]!;
    for (const canvasClock of [NOW - 59_000, NOW + 59_000]) {
      expect(canvasClock).toBeGreaterThanOrEqual(reply.notBeforeMs);
      expect(canvasClock).toBeLessThanOrEqual(reply.notAfterMs);
    }
  });

  it('sorts and dedupes, because one set of answers has one encoding', async () => {
    const canvas = fakeCanvas([question({ authors: ['CCC', 'AAA', 'CCC', 'BBB'] })]);
    await client(canvas).answerPending();
    expect(canvas.posted[0]!.reply.states.map(([a]) => a)).toEqual(['AAA', 'BBB', 'CCC']);
  });
});

describe('refusing to sign', () => {
  const refuses = async (over: Partial<Question>) => {
    const canvas = fakeCanvas([question(over)]);
    expect(await client(canvas).answerPending()).toBe(0);
    expect(canvas.posted).toEqual([]);
  };

  it('an answer about somebody else', async () => {
    // The one unrecoverable move: our signature is the only thing that makes
    // an answer ours, and this one would be about a reader who is not us.
    await refuses({ viewer: OTHER });
  });

  it('a question that names more people than a page could', async () => {
    await refuses({ authors: Array.from({ length: SYNC_AUTHOR_CAP + 1 }, (_, i) => `a${i}`) });
  });

  it('a question that names nobody', async () => {
    await refuses({ authors: [] });
  });

  it('a question whose window has already closed', async () => {
    await refuses({ not_after: NOW - 1 });
  });

  it('a field carrying the separator the encoding depends on', async () => {
    const NUL = String.fromCharCode(0);
    await refuses({ canvas_id: `row${NUL}7` });
    await refuses({ page_digest: `${DIGEST}${NUL}` });
    await refuses({ authors: [`AAA${NUL}uthor`] });
  });

  it('a question with a missing or mistyped field', async () => {
    await refuses({ request_id: '' });
    await refuses({ viewer: undefined as unknown as string });
    await refuses({ authors: [42 as unknown as string] });
  });

  it('the same page twice in a row', async () => {
    const canvas = fakeCanvas([question()]);
    let now = NOW;
    const c = client(canvas, () => 'none', () => now);
    expect(await c.answerPending()).toBe(1);
    now += SAME_PAGE_MIN_INTERVAL_MS - 1;
    expect(await c.answerPending()).toBe(0);
    // ...and it is a brake, not a ban: past the interval the page is
    // answerable again, or a follow made in between would never show up.
    now += 2;
    expect(await c.answerPending()).toBe(1);
  });

  it('the same page again even when the canvas refused our last answer', async () => {
    // Otherwise a canvas that always answers 401 makes us re-sign forever.
    const canvas = fakeCanvas([question()], 401);
    const c = client(canvas);
    expect(await c.answerPending()).toBe(0);
    expect(canvas.posted).toHaveLength(1);
    expect(await c.answerPending()).toBe(0);
    expect(canvas.posted).toHaveLength(1);
  });

  it('but still answers the other questions in the same batch', async () => {
    // One bad question must not cost the reader the page they are looking at.
    const canvas = fakeCanvas([
      question({ request_id: 'bad', viewer: OTHER }),
      question({ request_id: 'good', page_digest: 'b'.repeat(64) }),
    ]);
    expect(await client(canvas).answerPending()).toBe(1);
    expect(canvas.posted.map((p) => p.reply.requestId)).toEqual(['good']);
  });
});

describe('when the canvas misbehaves', () => {
  it('a non-2xx pull throws rather than reading as "nothing to answer"', async () => {
    const c = makeSyncAnswerClient({
      baseUrl: BASE,
      signer,
      stateOf: () => 'none',
      fetchJson: async () => ({ status: 503, text: 'down' }),
      postJson: async () => ({ status: 200, text: '{}' }),
    });
    await expect(c.answerPending()).rejects.toThrow(/503/);
  });

  it('a malformed 200 throws rather than reading as an empty batch', async () => {
    for (const text of ['not json', '{"requests":"soon"}', '{}']) {
      const c = makeSyncAnswerClient({
        baseUrl: BASE,
        signer,
        stateOf: () => 'none',
        fetchJson: async () => ({ status: 200, text }),
        postJson: async () => ({ status: 200, text: '{}' }),
      });
      await expect(c.answerPending()).rejects.toThrow();
    }
  });

  it('a base url that is not a url costs this leg a tick, not the whole plugin', async () => {
    // canvas_base_url is plugin config and nothing validates it as a URL, so
    // one typo must not be able to throw inside register(). Building the
    // client is the part that has to stay safe (ADR-0035); the tick is where
    // the failure is allowed to surface, because a tick has a backoff.
    const build = () =>
      makeSyncAnswerClient({
        baseUrl: 'canvas.popclaw.me',
        signer,
        stateOf: () => 'none',
        fetchJson: async () => ({ status: 200, text: '{"requests":[]}' }),
        postJson: async () => ({ status: 200, text: '{}' }),
      });
    expect(build).not.toThrow();
    await expect(build().answerPending()).rejects.toThrow();
  });

  it('pulls under this signer’s own id and nobody else’s', async () => {
    let seen: { url: string; headers: Record<string, string> } | null = null;
    const c = makeSyncAnswerClient({
      baseUrl: BASE,
      signer,
      stateOf: () => 'none',
      fetchJson: async (url, headers) => {
        seen = { url, headers };
        return { status: 200, text: '{"requests":[]}' };
      },
      postJson: async () => ({ status: 200, text: '{}' }),
    });
    await c.answerPending();
    expect(seen!.url).toContain(`owner=${SELF}`);
    expect(seen!.headers['X-Popclaw-Id']).toBe(SELF);
  });
});

describe('the bytes both ends rebuild', () => {
  /** The SAME vector and the SAME hex the canvas suite pins
   *  (apps/popclaw-canvas/tests/signing-domains.test.ts). This file is the
   *  plugin's half of that pin: the two encoders are byte-identical twins in
   *  separate packages, neither can import the other, and a drift between them
   *  has no symptom — a signer and a verifier that disagree simply never
   *  agree, so every reply fails and the feature goes quiet with no error. A
   *  test that only checked this side against itself would stay green through
   *  exactly that. */
  it('is pinned to the vector the canvas pins', () => {
    const vector: SyncReply = {
      requestId: 'req-vector',
      canvasId: 'row-vector',
      pageDigest: 'a'.repeat(64),
      viewer: 'ViewerVectorId',
      notBeforeMs: 1_789_722_919_000,
      notAfterMs: 1_789_722_979_000,
      canvasOrigin: 'https://canvas.popclaw.me',
      states: [
        ['AAAuthor', 'follows'],
        ['BBBauthor', 'none'],
        ['CCCauthor', 'unknown'],
      ],
    };
    expect(Buffer.from(syncReplySigningBytes(vector)).toString('hex')).toBe(
      '63616e7661732d73796e632d7265706c792d7631007265712d766563746f7200726f772d766563746f72006161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616100566965776572566563746f724964003137383937323239313930303000313738393732323937393030300033004141417574686f723d666f6c6c6f777300424242617574686f723d6e6f6e6500434343617574686f723d756e6b6e6f776e0068747470733a2f2f63616e7661732e706f70636c61772e6d65',
    );
  });
});
