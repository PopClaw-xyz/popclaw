import { describe, expect, it, vi } from 'vitest';
import { actionFetch, assertActionActive, ActionInactiveError, questAction, runAction, withAction } from '../../../src/runtime/house-lifecycle/action-context.js';
import { buildScraperRegistryFor } from '../../../src/runtime/ranger.js';
function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; }
function gate() { const controller = new AbortController(); return { signal: controller.signal, isActive: () => !controller.signal.aborted, close: () => controller.abort() }; }
describe('captured action context', () => {
  it('preserves values and errors and composes the parent stop scope', async () => {
    const parent = gate(); const child = gate();
    expect(withAction(parent, () => 123)).toBe(123);
    const error = new Error('ordinary');
    expect(() => withAction(parent, () => { throw error; })).toThrow(error);
    await withAction(parent, async () => withAction(child, async () => {
      await Promise.resolve(); parent.close(); expect(() => assertActionActive()).toThrow(ActionInactiveError);
    }));
  });
  it.each([undefined, 0, -1, '1.5', '18446744073709551616', Number.MAX_SAFE_INTEGER + 1])('rejects invalid session quest expiry %s', (expiry) => {
    expect(questAction(gate(), expiry, () => 0)?.isActive()).toBe(false);
  });
  it('supports uint64 Long/string deadlines without rounding and preserves ungated legacy', () => {
    expect(questAction(gate(), { toString: () => '18446744073709551615' }, () => 2000)?.isActive()).toBe(true);
    expect(questAction(gate(), '2', () => 2000)?.isActive()).toBe(false);
    expect(questAction(undefined, 0)).toBeUndefined();
  });
  it('does not call a leaf HTTP fetch after the enclosing quest expires', async () => {
    let now = 1000; const fetch = vi.fn(); const scoped = actionFetch(gate(), fetch);
    await withAction(questAction(gate(), '2', () => now), async () => {
      await Promise.resolve(); now = 2000;
      await expect(scoped('https://provider.invalid')).rejects.toBeInstanceOf(ActionInactiveError);
    });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('keeps an uncancellable operation in the drain after abort', async () => {
    const g = gate(); const pending = deferred<void>(); let settled = false;
    const work = runAction(g, async () => { await pending.promise; assertActionActive(); }).then(() => { settled = true; });
    g.close(); await Promise.resolve(); expect(settled).toBe(false);
    pending.resolve(); await work; expect(settled).toBe(true);
  });
  it('prevents provider retry and cross-provider fallback after logout', async () => {
    const g = gate(); const sleeping = deferred<void>(); const retryEntered = deferred<void>();
    const fetch = vi.fn().mockResolvedValue(new Response('', { status: 500 }));
    const registry = await buildScraperRegistryFor({ backendOverride: undefined, twitterApiIoKey: 'fake', apifyToken: 'fake', youtubeApiKey: undefined, gate: g, fetch, sleep: async (ms) => { if (ms > 0) { retryEntered.resolve(); await sleeping.promise; } } });
    const work = withAction(g, () => registry.get('x')!.scrapeTimeline('tester', new Date(0), 5));
    const rejected = expect(work).rejects.toBeInstanceOf(ActionInactiveError);
    await retryEntered.promise; g.close(); sleeping.resolve(); await rejected;
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
