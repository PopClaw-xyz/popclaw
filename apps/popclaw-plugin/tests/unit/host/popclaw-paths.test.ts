import { describe, it, expect } from 'vitest';
import { PopclawPaths } from '../../../src/host/popclaw-paths.js';

const R = '/x/.openclaw/popclaw';
const p = new PopclawPaths(R);

describe('PopclawPaths', () => {
  it('resolveRoot prefers POPCLAW_DATA_ROOT, else <stateDir>/popclaw', () => {
    expect(PopclawPaths.resolveRoot({ POPCLAW_DATA_ROOT: '/override' }, '/s')).toBe('/override');
    expect(PopclawPaths.resolveRoot({}, '/home/u/.openclaw')).toBe('/home/u/.openclaw/popclaw');
  });
  it('config bucket', () => {
    expect(p.config()).toBe(`${R}/config`);
    expect(p.configFile('plugin')).toBe(`${R}/config/plugin.json`);
    expect(p.configFile('llm')).toBe(`${R}/config/llm.json`);
    expect(p.cadenceDir()).toBe(`${R}/config/cadence`);
  });
  it('data bucket (public / regenerable)', () => {
    expect(p.data()).toBe(`${R}/data`);
    expect(p.lorehousesDir()).toBe(`${R}/data/lorehouses`);
    expect(p.lorehouseDb('x-com')).toBe(`${R}/data/lorehouses/x-com.db`);
    expect(p.scoreCacheFile()).toBe(`${R}/data/score-cache.json`);
    expect(p.newspaperDir()).toBe(`${R}/data/newspaper`);
    expect(p.lastNewspaperHtml()).toBe(`${R}/data/newspaper/last-newspaper.html`);
    // Only the legacy migration path remains; active canvas-style.md moved to vault/ (see below).
    expect(p.legacyCanvasStyleFile()).toBe(`${R}/data/canvas-style.md`);
    expect(p.dreamerStateFile()).toBe(`${R}/data/dreamer-state.json`);
    expect(p.lastBuildFile()).toBe(`${R}/data/last-build.json`);
  });
  it('vault bucket (precious)', () => {
    expect(p.vaultSocialDir()).toBe(`${R}/vault/social`);
    expect(p.socialDb()).toBe(`${R}/vault/social/my-social-assets.db`);
    expect(p.identityDir()).toBe(`${R}/vault/social/identity`);
    expect(p.inboxDir()).toBe(`${R}/vault/social/inbox`);
    expect(p.socialGraphDir()).toBe(`${R}/vault/social/social-graph`);
    // Social logs are durable assets and must never live under disposable data/.
    expect(p.socialLogDir()).toBe(`${R}/vault/social/log`);
    expect(p.backupsDir()).toBe(`${R}/vault/social/backups`);
    expect(p.walletDir()).toBe(`${R}/vault/wallet`);
    expect(p.walletDb()).toBe(`${R}/vault/wallet/wallet.db`);
    expect(p.tasteDir()).toBe(`${R}/vault/taste`);
    // Owner-provided layout preferences (--feedback) are durable assets and must never live under disposable data/.
    expect(p.canvasStyleFile()).toBe(`${R}/vault/taste/canvas-style.md`);
  });
});
