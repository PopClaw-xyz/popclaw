import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve as pathResolve } from 'node:path';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { popclaw } from '@popclaw/contracts';
import { InMemoryHostDb } from '../../../src/host/in-memory-host-db.js';
import { runMigrations } from '../../../src/host/migrations.js';
import { MarksStore } from '../../../src/marks/marks-store.js';
import { MarkService } from '../../../src/marks/mark-service.js';
import { makeTestSigner } from '../../helpers/test-signer.js';
import type { CachedFeedItem } from '../../../src/ingress/world-feed-cache.js';

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../migrations');

// A real 64-hex event_id for tests (signMark validates this)
const VALID_EVENT_ID = 'a'.repeat(64);

function freshStore(): MarksStore {
  const db = new InMemoryHostDb();
  runMigrations(db, MIGRATIONS_DIR);
  return new MarksStore(db);
}

function tmpTasteRoot(): string {
  return mkdtempSync(join(tmpdir(), 'mark-svc-taste-'));
}

function makeItem(over: Partial<CachedFeedItem> = {}): CachedFeedItem {
  return {
    platform: 'x',
    platformPostId: '1234567890',
    eventId: VALID_EVENT_ID,
    platformPostCreatedAt: 1_700_000_000,
    authorPopclawId: 'AUTH123',
    handle: 'testhandle',
    originalUrl: 'https://x.com/testhandle/status/1234567890',
    textPreview: 'hello world this is a test post',
    ...over,
  };
}

describe('MarkService', () => {
  it.each([409, 403, 503, 200])('mark() and unmark() report a resolved HTTP %i receipt', async status => {
    const store = freshStore();
    const tasteRoot = tmpTasteRoot();
    const egress = { push: async () => ({ status, detail: 'synthetic refusal', deduplicated: true }) };
    const svc = new MarkService({ store, signer: makeTestSigner('BlackFeather'), egress, nickname: 'Owner', taste: { tasteRoot } });
    const marked = await svc.mark(makeItem());
    const revoked = await svc.unmark(VALID_EVENT_ID);
    expect(store.has(VALID_EVENT_ID)).toBe(false);
    expect(readFileSync(join(tasteRoot, 'learned', 'picks.jsonl'), 'utf8')).toContain('"signal":"saved"');
    expect(revoked.wasMarked).toBe(true);
    for (const result of [marked, revoked]) {
      expect(result.pushed).toBe(status === 200);
      if (status !== 200) {
        expect(result.error).toContain(String(status));
        expect(result.error).toContain('synthetic refusal');
      } else expect(result.error).toBeUndefined();
    }
  });

  it('mark() stores row, appends taste pick, calls egress, returns pushed:true', async () => {
    const store = freshStore();
    const signer = makeTestSigner('BlackFeather');
    const receivedBytes: Uint8Array[] = [];
    const egress = { push: async (b: Uint8Array) => { receivedBytes.push(b); } };
    const tasteRoot = tmpTasteRoot();
    const fixedNow = 1_700_050_000_000; // ms

    const svc = new MarkService({ store, signer, egress, nickname: 'BlackFeather', taste: { tasteRoot }, now: () => fixedNow });
    const item = makeItem();
    const result = await svc.mark(item);

    expect(result.pushed).toBe(true);
    expect(result.error).toBeUndefined();

    // Store row present
    expect(store.has(VALID_EVENT_ID)).toBe(true);
    const rows = store.listActive(10);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.eventId).toBe(VALID_EVENT_ID);
    expect(rows[0]!.handle).toBe('testhandle');
    expect(rows[0]!.summaryLine).toBe('hello world this is a test post');

    // Egress got bytes
    expect(receivedBytes).toHaveLength(1);
    expect(receivedBytes[0]!.length).toBeGreaterThan(0);

    // picks.jsonl appended with correct shape
    const picksFile = pathResolve(tasteRoot, 'learned', 'picks.jsonl');
    const line = readFileSync(picksFile, 'utf-8').trim();
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(parsed.ts).toBe(Math.floor(fixedNow / 1000));
    expect(parsed.eventId).toBe(VALID_EVENT_ID);
    expect(parsed.signal).toBe('saved');
    expect(parsed.summaryLine).toBe('hello world this is a test post');
  });

  it('mark() upsert happens before egress push (ordering)', async () => {
    const signer = makeTestSigner('BlackFeather');
    const tasteRoot = tmpTasteRoot();
    const callLog: string[] = [];

    // Wrap via subclass to intercept upsert without spreading prototype
    class SpyStore extends MarksStore {
      override upsert(row: Parameters<MarksStore['upsert']>[0]): void {
        callLog.push('upsert');
        super.upsert(row);
      }
    }
    const db = new InMemoryHostDb();
    runMigrations(db, MIGRATIONS_DIR);
    const spyStore = new SpyStore(db);

    const egress = {
      push: async (b: Uint8Array) => {
        callLog.push('push');
        return b;
      },
    };

    const svc = new MarkService({ store: spyStore, signer, egress, nickname: 'BlackFeather', taste: { tasteRoot } });
    await svc.mark(makeItem());

    expect(callLog.indexOf('upsert')).toBeLessThan(callLog.indexOf('push'));
  });

  it('mark() uses injected now for markedAt', async () => {
    const store = freshStore();
    const signer = makeTestSigner('BlackFeather');
    const egress = { push: async () => {} };
    const tasteRoot = tmpTasteRoot();
    const fixedNow = 1_700_100_000_000; // ms

    const svc = new MarkService({
      store, signer, egress, nickname: 'BlackFeather',
      taste: { tasteRoot }, now: () => fixedNow,
    });
    const item = makeItem();
    await svc.mark(item);

    const rows = store.listActive(10);
    expect(rows[0]!.markedAt).toBe(Math.floor(fixedNow / 1000));
  });

  it('mark(): egress.push reject → pushed:false + error string, store row still present', async () => {
    const store = freshStore();
    const signer = makeTestSigner('BlackFeather');
    const egress = { push: async (_b: Uint8Array) => { throw new Error('network down'); } };
    const tasteRoot = tmpTasteRoot();

    const svc = new MarkService({ store, signer, egress, nickname: 'BlackFeather', taste: { tasteRoot } });
    const item = makeItem();
    const result = await svc.mark(item);

    expect(result.pushed).toBe(false);
    expect(result.error).toContain('network down');

    // Row still saved locally
    expect(store.has(VALID_EVENT_ID)).toBe(true);
  });

  it('unmark() deletes row, egress gets revoke bytes, wasMarked:true', async () => {
    const store = freshStore();
    const signer = makeTestSigner('BlackFeather');
    const receivedBytes: Uint8Array[] = [];
    const egress = { push: async (b: Uint8Array) => { receivedBytes.push(b); } };
    const tasteRoot = tmpTasteRoot();

    const svc = new MarkService({ store, signer, egress, nickname: 'BlackFeather', taste: { tasteRoot } });
    const item = makeItem();

    // First mark
    await svc.mark(item);
    receivedBytes.length = 0; // reset

    // Then unmark
    const result = await svc.unmark(VALID_EVENT_ID);

    expect(result.pushed).toBe(true);
    expect(result.wasMarked).toBe(true);
    expect(store.has(VALID_EVENT_ID)).toBe(false);
    expect(receivedBytes).toHaveLength(1);
    expect(receivedBytes[0]!.length).toBeGreaterThan(0);
  });

  it('unmark() uses injected now for envelope timestamp', async () => {
    const store = freshStore();
    const signer = makeTestSigner('BlackFeather');
    const receivedBytes: Uint8Array[] = [];
    const egress = { push: async (b: Uint8Array) => { receivedBytes.push(b); } };
    const tasteRoot = tmpTasteRoot();
    const fixedNow = 1_700_200_000_000; // ms

    const svc = new MarkService({
      store, signer, egress, nickname: 'BlackFeather',
      taste: { tasteRoot }, now: () => fixedNow,
    });
    await svc.unmark(VALID_EVENT_ID);

    expect(receivedBytes).toHaveLength(1);
    const sp = popclaw.identity.SignedPayload.decode(receivedBytes[0]!);
    const env = popclaw.event.EventEnvelope.decode(sp.payload);
    expect(Number(env.timestamp)).toBe(Math.floor(fixedNow / 1000));
  });

  it('unmark() on non-existent id → wasMarked:false, still pushes', async () => {
    const store = freshStore();
    const signer = makeTestSigner('BlackFeather');
    const receivedBytes: Uint8Array[] = [];
    const egress = { push: async (b: Uint8Array) => { receivedBytes.push(b); } };
    const tasteRoot = tmpTasteRoot();

    const svc = new MarkService({ store, signer, egress, nickname: 'BlackFeather', taste: { tasteRoot } });
    const result = await svc.unmark(VALID_EVENT_ID);

    expect(result.wasMarked).toBe(false);
    expect(result.pushed).toBe(true);
    expect(receivedBytes).toHaveLength(1);
  });

  it('unmark(): egress reject → pushed:false + error, wasMarked still correct', async () => {
    const store = freshStore();
    const signer = makeTestSigner('BlackFeather');
    const egress = { push: async (_b: Uint8Array) => { throw new Error('timeout'); } };
    const tasteRoot = tmpTasteRoot();

    const svc = new MarkService({ store, signer, egress, nickname: 'BlackFeather', taste: { tasteRoot } });

    // Mark first so wasMarked is true
    const item = makeItem();
    // Temporarily replace egress for the mark call
    const successEgress = { push: async () => {} };
    const svc2 = new MarkService({ store, signer, egress: successEgress, nickname: 'BlackFeather', taste: { tasteRoot } });
    await svc2.mark(item);

    // Now unmark with failing egress
    const result = await svc.unmark(VALID_EVENT_ID);
    expect(result.wasMarked).toBe(true);
    expect(result.pushed).toBe(false);
    expect(result.error).toContain('timeout');
  });
});
