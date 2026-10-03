import { describe, it, expect, beforeEach } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { InMemoryHostDb } from '../../../src/host/in-memory-host-db.js';
import { runMigrations } from '../../../src/host/migrations.js';
import { OnboardingStateRepository } from '../../../src/onboarding/state-repository.js';
import type { HostDb } from '../../../src/host/host-db.js';

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../migrations');

describe('OnboardingStateRepository', () => {
  let db: HostDb;
  let repo: OnboardingStateRepository;
  const POPCLAW_ID = '11111111111111111111111111111111';

  beforeEach(() => {
    db = new InMemoryHostDb();
    runMigrations(db, MIGRATIONS_DIR);
    repo = new OnboardingStateRepository(db, () => 1700000000);
  });

  it('get returns null when no row', () => {
    expect(repo.get(POPCLAW_ID)).toBeNull();
  });

  it('create inserts initial idle state', () => {
    const created = repo.create(POPCLAW_ID);
    expect(created.popclaw_id).toBe(POPCLAW_ID);
    expect(created.stage).toBe('idle');
    expect(created.started_at).toBe(1700000000);
    expect(created.completed_at).toBeNull();
    expect(created.drafts_json).toBeNull();
  });

  it('create then get round-trips', () => {
    repo.create(POPCLAW_ID);
    const got = repo.get(POPCLAW_ID);
    expect(got?.stage).toBe('idle');
  });

  it('create twice for same popclaw_id throws', () => {
    repo.create(POPCLAW_ID);
    expect(() => repo.create(POPCLAW_ID)).toThrow();
  });

  it('updateStage transitions stage', () => {
    repo.create(POPCLAW_ID);
    repo.updateStage(POPCLAW_ID, 'arrival');
    expect(repo.get(POPCLAW_ID)?.stage).toBe('arrival');
  });

  it('updateStage with drafts overwrites drafts_json', () => {
    repo.create(POPCLAW_ID);
    repo.updateStage(POPCLAW_ID, 'lantern', { drafts: { taste_draft: ['ai-agents'] } });
    expect(repo.get(POPCLAW_ID)?.drafts_json).toBe('{"taste_draft":["ai-agents"]}');
  });

  it('markCompleted sets stage=completed and completed_at', () => {
    repo.create(POPCLAW_ID);
    repo.markCompleted(POPCLAW_ID);
    const got = repo.get(POPCLAW_ID);
    expect(got?.stage).toBe('completed');
    expect(got?.completed_at).toBe(1700000000);
  });

  it('updateStage on missing row throws', () => {
    expect(() => repo.updateStage(POPCLAW_ID, 'arrival')).toThrow();
  });

  it('normalizes legacy stage values on read, persists the fix, and clears stale work state', () => {
    repo.create('pid-legacy');
    db.execute(
      "UPDATE onboarding_state SET stage = 'discovering-taste', drafts_json = '{\"old\":1}', pending_card_id = 'card-9' WHERE popclaw_id = ?",
      ['pid-legacy'],
    );
    const state = repo.get('pid-legacy');
    expect(state?.stage).toBe('idle');
    expect(state?.drafts_json).toBeNull();
    // 真验写回：绕过 DAO 读裸行（区分"持久化修正"与"每次读都重新归一化"）
    // pending_card_id column kept (NULL) but no longer exposed on OnboardingState.
    const raw = db.queryOne<{ stage: string; drafts_json: string | null; pending_card_id: string | null }>(
      'SELECT stage, drafts_json, pending_card_id FROM onboarding_state WHERE popclaw_id = ?',
      ['pid-legacy'],
    );
    expect(raw?.stage).toBe('idle');
    expect(raw?.drafts_json).toBeNull();
    expect(raw?.pending_card_id).toBeNull();
  });

  it('keeps legacy completed as completed', () => {
    repo.create('pid-done');
    db.execute("UPDATE onboarding_state SET stage = 'completed' WHERE popclaw_id = ?", ['pid-done']);
    expect(repo.get('pid-done')?.stage).toBe('completed');
  });

  // spec §1 7 天兜底：判定挂在读路径上（零新定时器，ADR-0035）。
  describe('7 天兜底', () => {
    const WEEK = 7 * 24 * 60 * 60;

    it('开了头七天没走完 → 下次读就落 completed，并写回持久层', () => {
      const late = new OnboardingStateRepository(db, () => 1700000000 + WEEK);
      repo.create('pid-stale');
      repo.updateStage('pid-stale', 'lantern');
      const state = late.get('pid-stale');
      expect(state?.stage).toBe('completed');
      expect(state?.completed_at).toBe(1700000000 + WEEK);
      const raw = db.queryOne<{ stage: string }>(
        'SELECT stage FROM onboarding_state WHERE popclaw_id = ?',
        ['pid-stale'],
      );
      expect(raw?.stage).toBe('completed');
    });

    it('还没到七天 → 原样返回', () => {
      const soon = new OnboardingStateRepository(db, () => 1700000000 + WEEK - 1);
      repo.create('pid-fresh');
      repo.updateStage('pid-fresh', 'lantern');
      expect(soon.get('pid-fresh')?.stage).toBe('lantern');
    });

    it('idle 不算开了头（从没 /popclaw start 过的人不该被判毕业）', () => {
      const late = new OnboardingStateRepository(db, () => 1700000000 + WEEK);
      repo.create('pid-idle');
      expect(late.get('pid-idle')?.stage).toBe('idle');
    });
  });

  // S3-T4: drafts_json as 幕内子状态 — write without touching stage.
  describe('setDrafts', () => {
    it('writes drafts_json leaving stage untouched', () => {
      repo.create(POPCLAW_ID);
      repo.updateStage(POPCLAW_ID, 'arrival');
      repo.setDrafts(POPCLAW_ID, { arrival: { candidates: ['白驹'], blind: false } });
      const state = repo.get(POPCLAW_ID);
      expect(state?.stage).toBe('arrival');
      expect(JSON.parse(state?.drafts_json ?? '{}')).toEqual({
        arrival: { candidates: ['白驹'], blind: false },
      });
    });

    it('overwrites previous drafts', () => {
      repo.create(POPCLAW_ID);
      repo.setDrafts(POPCLAW_ID, { a: 1 });
      repo.setDrafts(POPCLAW_ID, {});
      expect(JSON.parse(repo.get(POPCLAW_ID)?.drafts_json ?? 'null')).toEqual({});
    });

    it('throws on missing row', () => {
      expect(() => repo.setDrafts(POPCLAW_ID, {})).toThrow();
    });
  });
});
