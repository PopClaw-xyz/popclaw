import { describe, it, expect, beforeEach } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { InMemoryHostDb } from '../../../src/host/in-memory-host-db.js';
import { runMigrations } from '../../../src/host/migrations.js';
import { OnboardingStateRepository } from '../../../src/onboarding/state-repository.js';
import { OnboardingStateMachine, IllegalTransitionError } from '../../../src/onboarding/state-machine.js';
import type { HostDb } from '../../../src/host/host-db.js';

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../migrations');

describe('OnboardingStateMachine', () => {
  const POPCLAW_ID = '11111111111111111111111111111111';
  let db: HostDb;
  let repo: OnboardingStateRepository;
  let sm: OnboardingStateMachine;

  beforeEach(() => {
    db = new InMemoryHostDb();
    runMigrations(db, MIGRATIONS_DIR);
    repo = new OnboardingStateRepository(db, () => 1700000000);
    sm = new OnboardingStateMachine(repo);
  });

  it('ensureStarted creates initial idle row if absent', () => {
    expect(repo.get(POPCLAW_ID)).toBeNull();
    sm.ensureStarted(POPCLAW_ID);
    expect(repo.get(POPCLAW_ID)?.stage).toBe('idle');
  });

  it('ensureStarted is idempotent', () => {
    sm.ensureStarted(POPCLAW_ID);
    sm.ensureStarted(POPCLAW_ID);
    expect(repo.get(POPCLAW_ID)?.stage).toBe('idle');
  });

  it('transition accepts legal next stage', () => {
    sm.ensureStarted(POPCLAW_ID);
    sm.transition(POPCLAW_ID, 'arrival');
    expect(repo.get(POPCLAW_ID)?.stage).toBe('arrival');
  });

  it('transition rejects illegal next stage', () => {
    sm.ensureStarted(POPCLAW_ID);
    // idle 只能去 arrival —— 直接 bail 到 completed 是非法的。
    expect(() => sm.transition(POPCLAW_ID, 'completed')).toThrow(IllegalTransitionError);
  });

  it('transition rejects from missing row', () => {
    expect(() => sm.transition(POPCLAW_ID, 'arrival')).toThrow();
  });

  it('六幕脊柱 idle → arrival → … → cadence → completed 走得通', () => {
    sm.ensureStarted(POPCLAW_ID);
    sm.transition(POPCLAW_ID, 'arrival');
    sm.transition(POPCLAW_ID, 'passport');
    sm.transition(POPCLAW_ID, 'lantern');
    sm.transition(POPCLAW_ID, 'attune');
    sm.transition(POPCLAW_ID, 'errand');
    sm.transition(POPCLAW_ID, 'cadence');
    sm.transition(POPCLAW_ID, 'completed');
    const final = repo.get(POPCLAW_ID);
    expect(final?.stage).toBe('completed');
    expect(final?.completed_at).toBe(1700000000);
  });

  it('transition to completed sets completed_at via markCompleted path', () => {
    sm.ensureStarted(POPCLAW_ID);
    sm.transition(POPCLAW_ID, 'arrival');
    // 任何进行中阶段都能直接 bail 到 completed（主人随时说「先这样」）。
    sm.transition(POPCLAW_ID, 'completed');
    expect(repo.get(POPCLAW_ID)?.completed_at).not.toBeNull();
  });

  it('current returns current stage', () => {
    sm.ensureStarted(POPCLAW_ID);
    expect(sm.current(POPCLAW_ID)).toBe('idle');
    sm.transition(POPCLAW_ID, 'arrival');
    expect(sm.current(POPCLAW_ID)).toBe('arrival');
  });

  it('current throws on missing row', () => {
    expect(() => sm.current(POPCLAW_ID)).toThrow();
  });

  // S3-T4: thin drafts façade so the orchestrator never touches the repo.
  describe('drafts / setDrafts', () => {
    it('drafts returns {} when nothing stored', () => {
      sm.ensureStarted(POPCLAW_ID);
      expect(sm.drafts(POPCLAW_ID)).toEqual({});
    });

    it('setDrafts → drafts round-trips through the repository', () => {
      sm.ensureStarted(POPCLAW_ID);
      sm.setDrafts(POPCLAW_ID, { passport: 'ok' });
      expect(sm.drafts(POPCLAW_ID)).toEqual({ passport: 'ok' });
    });

    it('drafts tolerates corrupt drafts_json (returns {})', () => {
      sm.ensureStarted(POPCLAW_ID);
      db.execute("UPDATE onboarding_state SET drafts_json = '{not json' WHERE popclaw_id = ?", [
        POPCLAW_ID,
      ]);
      expect(sm.drafts(POPCLAW_ID)).toEqual({});
    });

    it('transition with opts.drafts clears intra-act state on stage exit', () => {
      sm.ensureStarted(POPCLAW_ID);
      sm.transition(POPCLAW_ID, 'arrival', { drafts: { arrival: { candidates: ['白驹'], blind: false } } });
      expect(sm.drafts(POPCLAW_ID)).toEqual({ arrival: { candidates: ['白驹'], blind: false } });
      sm.transition(POPCLAW_ID, 'passport', { drafts: {} });
      expect(sm.drafts(POPCLAW_ID)).toEqual({});
    });

    it('（问题 4）transition 不带 opts → drafts 被默认清空', () => {
      sm.ensureStarted(POPCLAW_ID);
      sm.transition(POPCLAW_ID, 'arrival', { drafts: { arrival: { candidates: ['夜行'], blind: true } } });
      expect(sm.drafts(POPCLAW_ID)).toEqual({ arrival: { candidates: ['夜行'], blind: true } });
      // 不带 opts 转移——drafts 应被清空
      sm.transition(POPCLAW_ID, 'passport');
      expect(sm.drafts(POPCLAW_ID)).toEqual({});
    });
  });
});
