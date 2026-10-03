/**
 * 装机/升级回音（issue #270）—— 决策纯函数全档位覆盖。见 src/runtime/install-notice.ts 头注释。
 */
import { describe, it, expect, beforeAll } from 'vitest';

import { decideInstallNotice, shortBuildStamp } from '../../../src/runtime/install-notice.js';
import { DEV_BUILD, type LastBuildRecord } from '../../../src/runtime/last-build.js';
import { setOwnerLang } from '../../../src/lexicon/owner-language.js';

// S13 slice: decideInstallNotice now renders in `ownerLang()` (default en-US)
// instead of hardcoded zh — pin zh-CN so the assertions below stay meaningful.
beforeAll(() => setOwnerLang('zh-CN', 'config'));

describe('decideInstallNotice — no record yet', () => {
  it('says nothing when record is null (nothing landed on disk to talk about)', () => {
    expect(
      decideInstallNotice({ record: null, identityGenerated: true, onboardingCompleted: false }),
    ).toBeNull();
  });
});

describe('decideInstallNotice — dev build', () => {
  it('skips entirely, even if a record somehow exists', () => {
    const record: LastBuildRecord = { build: DEV_BUILD, recordedAt: '2026-07-29T10:00:00.000Z' };
    expect(
      decideInstallNotice({ record, identityGenerated: true, onboardingCompleted: false }),
    ).toBeNull();
  });
});

describe('decideInstallNotice — fresh install', () => {
  it('no previous + identityGenerated=true → the install line, mentions "popclaw 插件"', () => {
    const record: LastBuildRecord = { build: 'abc123', recordedAt: '2026-07-29T10:00:00.000Z' };
    const text = decideInstallNotice({ record, identityGenerated: true, onboardingCompleted: false });
    expect(text).toBe('popclaw 插件装好了 ✅\nabc123\n现在开始：/popclaw start');
  });

  it('does not append the continue-onboarding tail (there is no wizard to continue yet)', () => {
    const record: LastBuildRecord = { build: 'abc123', recordedAt: '2026-07-29T10:00:00.000Z' };
    const text = decideInstallNotice({ record, identityGenerated: true, onboardingCompleted: true });
    expect(text).toBe('popclaw 插件装好了 ✅\nabc123\n现在开始：/popclaw start');
  });
});

describe('decideInstallNotice — no record but identity restored (pre-receipt-era machine)', () => {
  it('no previous + identityGenerated=false + onboarding completed → plain update line, no guessed "from"', () => {
    const record: LastBuildRecord = { build: 'zzz999', recordedAt: '2026-07-29T10:00:00.000Z' };
    const text = decideInstallNotice({ record, identityGenerated: false, onboardingCompleted: true });
    expect(text).toBe('popclaw 插件更新好了 ✅\nzzz999\n身份和资产都没动');
  });

  it('same, but onboarding incomplete → appends the continue hint with the real entry point', () => {
    const record: LastBuildRecord = { build: 'zzz999', recordedAt: '2026-07-29T10:00:00.000Z' };
    const text = decideInstallNotice({ record, identityGenerated: false, onboardingCompleted: false });
    expect(text).toBe('popclaw 插件更新好了 ✅\nzzz999\n身份和资产都没动\n还差一步：/popclaw start');
  });
});

describe('decideInstallNotice — upgrade (previous present)', () => {
  const record: LastBuildRecord = {
    build: '55695ac',
    recordedAt: '2026-07-29T14:15:00.000Z',
    previous: { build: '4aa6104', recordedAt: '2026-07-28T10:00:00.000Z' },
  };

  it('onboarding completed → upgrade line only, never re-invites the wizard', () => {
    const text = decideInstallNotice({ record, identityGenerated: false, onboardingCompleted: true });
    expect(text).toBe('popclaw 插件升级好了 ✅\n55695ac\n身份和资产都没动');
  });

  it('onboarding incomplete → upgrade line + continue (not restart) hint', () => {
    const text = decideInstallNotice({ record, identityGenerated: false, onboardingCompleted: false });
    expect(text).toBe('popclaw 插件升级好了 ✅\n55695ac\n身份和资产都没动\n还差一步：/popclaw start');
  });
});

describe('decideInstallNotice — once-only (already announced this build)', () => {
  it('zero action on a restart once announcedBuild matches the current build', () => {
    const record: LastBuildRecord = {
      build: 'abc123',
      recordedAt: '2026-07-29T10:00:00.000Z',
      announcedBuild: 'abc123',
    };
    expect(
      decideInstallNotice({ record, identityGenerated: true, onboardingCompleted: false }),
    ).toBeNull();
  });

  it('still fires when announcedBuild belongs to a stale (previous) build', () => {
    const record: LastBuildRecord = {
      build: '55695ac',
      recordedAt: '2026-07-29T14:15:00.000Z',
      previous: { build: '4aa6104', recordedAt: '2026-07-28T10:00:00.000Z' },
      announcedBuild: '4aa6104',
    };
    const text = decideInstallNotice({ record, identityGenerated: false, onboardingCompleted: true });
    expect(text).toBe('popclaw 插件升级好了 ✅\n55695ac\n身份和资产都没动');
  });
});

describe('decideInstallNotice — malformed record does not throw', () => {
  it('a record missing `build` (should never happen past readLastBuild, defensive anyway) → null', () => {
    const bad = { recordedAt: '2026-07-29T10:00:00.000Z' } as unknown as LastBuildRecord;
    expect(() =>
      decideInstallNotice({ record: bad, identityGenerated: true, onboardingCompleted: false }),
    ).not.toThrow();
    expect(
      decideInstallNotice({ record: bad, identityGenerated: true, onboardingCompleted: false }),
    ).toBeNull();
  });
});

describe('shortBuildStamp — 版本号在冲刺期区分不了包，戳才行', () => {
  it('keeps the version and the date-time, drops the year, the offset and the sha', () => {
    expect(shortBuildStamp('0.1.0 2026-08-26 12:21+08 c27aab30 (HEAD)')).toBe('0.1.0 · 8/26 12:21');
  });

  it('shows a build string it cannot split whole, rather than guessing at it', () => {
    expect(shortBuildStamp('zzz999')).toBe('zzz999');
    expect(shortBuildStamp('0.1.0 c27aab30')).toBe('0.1.0 c27aab30');
  });
});
