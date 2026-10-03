import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOpenClawHostAdapter } from '../../../src/host/openclaw-host-adapter.js';

// 适配器只声明它真正读的那一格（见 openclaw-host-adapter.ts 的 StateDirHost），
// 所以假货也只造那一格 —— 全量 `OpenClawPluginApi` 造一遍纯属白干。
function fakeApi(stateDir: string) {
  return { runtime: { state: { resolveStateDir: () => stateDir } } };
}

describe('createOpenClawHostAdapter', () => {
  it('roots non-identity storage under <state-dir>/popclaw/data/<namespace>/<key>', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'popclaw-oc-'));
    try {
      const host = createOpenClawHostAdapter(fakeApi(tmp));
      await host.storage.write('social', 'foo.txt', new TextEncoder().encode('hi'));
      const expected = join(tmp, 'popclaw', 'data', 'social', 'foo.txt');
      expect(readFileSync(expected, 'utf-8')).toBe('hi');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('read/write/list round-trip across the social namespace', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'popclaw-oc-'));
    try {
      const host = createOpenClawHostAdapter(fakeApi(tmp));
      await host.storage.write('social', 'a.json', new TextEncoder().encode('{"x":1}'));
      await host.storage.write('social', 'b.json', new TextEncoder().encode('{"y":2}'));
      const keys = (await host.storage.list('social')).sort();
      expect(keys).toEqual(['a.json', 'b.json']);
      const a = await host.storage.read('social', 'a.json');
      expect(a && new TextDecoder().decode(a)).toBe('{"x":1}');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('exposes clock + timer + logger', () => {
    const host = createOpenClawHostAdapter(fakeApi('/tmp/popclaw-oc-never-used'));
    expect(host.clock.now()).toBeInstanceOf(Date);
    expect(typeof host.timer.schedule).toBe('function');
    expect(typeof host.logger.info).toBe('function');
  });
});
