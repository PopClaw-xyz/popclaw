import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CadenceLoader, defaultCadence, writeCadenceDelivery } from '../../../src/cadence/cadence-loader';

function tmpRoot(): string { return mkdtempSync(join(tmpdir(), 'cad-')); }

describe('CadenceLoader', () => {
  it.each([null, [], 'bad', 42])('ignores non-object config %j without throwing', async (raw) => {
    const dir = tmpRoot();
    writeFileSync(join(dir, 'cadence.json'), JSON.stringify(raw));
    const warnings: string[] = [];
    const cfg = await new CadenceLoader({ cadenceDir: dir, logger: { warn: (s) => warnings.push(s) } }).load();
    expect(cfg).toEqual(defaultCadence());
    expect(warnings.length).toBeGreaterThan(0);
  });

  it('validates section values without treating an invalid language as explicitly chosen', async () => {
    const dir = tmpRoot();
    writeFileSync(join(dir, 'cadence.json'), JSON.stringify({
      delivery: { primaryLanguage: null, tone: 'terse', channels: [42], summaryStyle: 'invalid', includeLineage: 'yes' },
      filtering: { minScore: 0.7, maxItemsPerDigest: 'ten' },
      notifications: [],
    }));
    const warnings: string[] = [];
    const cfg = await new CadenceLoader({ cadenceDir: dir, logger: { warn: (s) => warnings.push(s) } }).load();
    expect(cfg.delivery).toEqual({ ...defaultCadence().delivery, tone: 'terse' });
    expect(cfg.explicitDelivery).toEqual(['tone']);
    expect(cfg.filtering).toEqual({ minScore: 0.7, maxItemsPerDigest: 10 });
    expect(cfg.notifications).toEqual(defaultCadence().notifications);
    expect(warnings.length).toBeGreaterThan(0);
  });

  it('returns defaults when no cadence/ directory exists', async () => {
    const loader = new CadenceLoader({ cadenceDir: join(tmpRoot(), 'cadence') });
    const cfg = await loader.load();
    expect(cfg).toEqual(defaultCadence());
  });

  it('reads and merges partial cadence.json with defaults', async () => {
    const root = tmpRoot();
    mkdirSync(join(root, 'cadence'), { recursive: true });
    writeFileSync(join(root, 'cadence', 'cadence.json'), JSON.stringify({
      schemaVersion: 1,
      delivery: { primaryLanguage: 'zh-CN', tone: 'casual' },
    }));
    const loader = new CadenceLoader({ cadenceDir: join(root, 'cadence') });
    const cfg = await loader.load();
    expect(cfg.delivery.primaryLanguage).toBe('zh-CN');
    expect(cfg.delivery.tone).toBe('casual');
    expect(cfg.delivery.summaryStyle).toBe(defaultCadence().delivery.summaryStyle);
  });

  it('carries delivery.timezone through when set; leaves it unset otherwise', async () => {
    const root = tmpRoot();
    mkdirSync(join(root, 'cadence'), { recursive: true });
    writeFileSync(join(root, 'cadence', 'cadence.json'), JSON.stringify({
      delivery: { timezone: 'America/New_York' },
    }));
    const cfg = await new CadenceLoader({ cadenceDir: join(root, 'cadence') }).load();
    expect(cfg.delivery.timezone).toBe('America/New_York');
    // Unset stays empty; runtime falls back to the system timezone, never a hardcoded default.
    expect(defaultCadence().delivery.timezone).toBeUndefined();
  });

  // S1 language chain: "explicitly configured" has to be distinguishable from
  // "defaulted", or a guess could quietly override what the owner wrote down.
  it('records which delivery keys the file spelled out', async () => {
    const root = tmpRoot();
    mkdirSync(join(root, 'cadence'), { recursive: true });
    writeFileSync(join(root, 'cadence', 'cadence.json'), JSON.stringify({
      delivery: { tone: 'terse' },
    }));
    const cfg = await new CadenceLoader({ cadenceDir: join(root, 'cadence') }).load();
    expect(cfg.explicitDelivery).toEqual(['tone']);
    // The default en-US is present but was never spelled out — it must not
    // count as the owner having chosen a language.
    expect(cfg.delivery.primaryLanguage).toBe('en-US');
    expect(cfg.explicitDelivery).not.toContain('primaryLanguage');
  });

  it('leaves explicitDelivery unset when there is no cadence.json at all', async () => {
    const cfg = await new CadenceLoader({ cadenceDir: join(tmpRoot(), 'cadence') }).load();
    expect(cfg.explicitDelivery).toBeUndefined();
  });

  it('reads optional prompt-overrides.md when present', async () => {
    const root = tmpRoot();
    mkdirSync(join(root, 'cadence'), { recursive: true });
    writeFileSync(join(root, 'cadence', 'cadence.json'), '{}');
    writeFileSync(join(root, 'cadence', 'prompt-overrides.md'), 'Be terse.');
    const loader = new CadenceLoader({ cadenceDir: join(root, 'cadence') });
    const cfg = await loader.load();
    expect(cfg.promptOverrides).toBe('Be terse.');
  });
});

describe('writeCadenceDelivery', () => {
  it('merges into delivery and preserves fields it does not know about', async () => {
    const root = tmpRoot();
    const dir = join(root, 'cadence');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'cadence.json'), JSON.stringify({
      schemaVersion: 1,
      delivery: { tone: 'terse', someFutureKnob: 42 },
      filtering: { minScore: 0.9 },
      handWrittenTopLevel: 'keep me',
    }));

    writeCadenceDelivery(dir, { primaryLanguage: 'ja-JP' });

    const raw = JSON.parse(readFileSync(join(dir, 'cadence.json'), 'utf-8'));
    expect(raw.delivery.primaryLanguage).toBe('ja-JP');
    expect(raw.delivery.tone).toBe('terse');
    expect(raw.delivery.someFutureKnob).toBe(42);
    expect(raw.filtering.minScore).toBe(0.9);
    expect(raw.handWrittenTopLevel).toBe('keep me');

    // …and the loader sees the write as explicit.
    const cfg = await new CadenceLoader({ cadenceDir: dir }).load();
    expect(cfg.delivery.primaryLanguage).toBe('ja-JP');
    expect(cfg.explicitDelivery).toContain('primaryLanguage');
  });

  it('creates the file (and directory) when none exists', () => {
    const dir = join(tmpRoot(), 'cadence');
    writeCadenceDelivery(dir, { timezone: 'Asia/Shanghai' });
    const raw = JSON.parse(readFileSync(join(dir, 'cadence.json'), 'utf-8'));
    expect(raw).toEqual({ schemaVersion: 1, delivery: { timezone: 'Asia/Shanghai' } });
  });

  it('throws rather than clobbering a malformed cadence.json', () => {
    const dir = join(tmpRoot(), 'cadence');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'cadence.json'), '{ this is not json');
    expect(() => writeCadenceDelivery(dir, { timezone: 'UTC' })).toThrow();
    expect(readFileSync(join(dir, 'cadence.json'), 'utf-8')).toBe('{ this is not json');
  });
});
