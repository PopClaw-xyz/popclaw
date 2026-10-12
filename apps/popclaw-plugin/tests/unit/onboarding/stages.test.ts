import { describe, it, expect } from 'vitest';
import {
  ALL_STAGES,
  legalNextStages,
  normalizeStage,
  type OnboardingStage,
} from '../../../src/onboarding/stages.js';

const SPINE: OnboardingStage[] = [
  'idle', 'arrival', 'passport', 'lantern', 'attune', 'errand', 'cadence', 'completed',
];

describe('六幕 stages', () => {
  it('spine is walkable start to finish', () => {
    for (let i = 0; i < SPINE.length - 1; i++) {
      expect(legalNextStages[SPINE[i]!]).toContain(SPINE[i + 1]!);
    }
  });

  it('每个进行中阶段都能随时 bail 到 completed', () => {
    for (const s of ALL_STAGES) {
      if (s === 'completed' || s === 'idle') continue;
      expect(legalNextStages[s]).toContain('completed');
    }
  });

  it('completed 是终点', () => {
    expect(legalNextStages['completed']).toHaveLength(0);
  });

  it('lantern 可直接到 errand（skip 连带跳过 attune），但脊柱后继仍是 attune', () => {
    expect(legalNextStages['lantern']).toContain('errand');
    // Order matters: spineNext selects the first non-completed target.
    expect(legalNextStages['lantern']![0]).toBe('attune');
  });

  it('passport 可回 arrival（「换个名字」），但脊柱后继仍是 lantern', () => {
    expect(legalNextStages['passport']).toContain('arrival');
    expect(legalNextStages['passport']![0]).toBe('lantern');
  });

  it('没有别的回头路', () => {
    expect(legalNextStages['lantern']).not.toContain('passport');
    expect(legalNextStages['errand']).not.toContain('lantern');
    expect(legalNextStages['completed']).not.toContain('arrival');
  });

  describe('normalizeStage（旧值迁移）', () => {
    it('新 enum 原样通过', () => {
      for (const s of ALL_STAGES) expect(normalizeStage(s)).toBe(s);
    });

    it('completed 保留（已毕业不重走）', () => {
      expect(normalizeStage('completed')).toBe('completed');
    });

    it('所有旧串名与未知值 → idle 重走', () => {
      const legacy = [
        // Three-scene sequence names.
        'act1-opening', 'act1-naming', 'act1-presence', 'act2-world', 'act2-summary',
        'act3-actions', 'graduating',
        // The earlier 11 stages.
        'bootstrapping', 'welcoming', 'discovering-taste', 'first-report', 'inviting',
        'cadence-aligning', 'bonus-platforms', 'nameplate', 'first-voice',
        'garbage-value', '',
      ];
      for (const s of legacy) expect(normalizeStage(s)).toBe('idle');
    });
  });
});
