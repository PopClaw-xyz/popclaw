import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { submitInvite, type InviteSubmissionDeps } from '../../../src/invite/submit-invite.js';
import type { InviteInitiateOpts, InviteInitiateResult } from '../../../src/invite/invite-initiator.js';
import { setOwnerLang } from '../../../src/lexicon/owner-language.js';

beforeEach(() => setOwnerLang('en', 'config'));
afterEach(() => setOwnerLang('zh-CN', 'config'));

const opts: InviteInitiateOpts = {
  platform: 'x', handle: 'blackfeather', nickname: 'Owner', replace: true,
  proofUrl: 'https://x.com/blackfeather/status/1234567890', mirrorOptin: true,
};
function depsFor(result: InviteInitiateResult) {
  const recordPending = vi.fn();
  const watch = vi.fn(() => new Promise<void>(() => {}));
  const onWatchError = vi.fn();
  const deps: InviteSubmissionDeps = {
    initiate: vi.fn(async () => result), recordPending, watch, onWatchError,
    webBaseUrl: 'https://popclaw.me',
  };
  return { deps, recordPending, watch, onWatchError };
}

describe('submitInvite capability contract', () => {
  it('passes the validated request intact and tracks any nonempty receipt task id before watching', async () => {
    const fx = depsFor({ expectedSigil: 'abcdef', pushedEventId: 'event-1',
      push: { status: 429, taskId: 'task-even-on-rejection', detail: 'pending invite' } });
    fx.watch.mockImplementation((...args) => {
      expect(fx.recordPending).toHaveBeenCalledWith({ taskId: 'task-even-on-rejection',
        platform: opts.platform, handle: opts.handle, sigil: 'abcdef', proofUrl: opts.proofUrl });
      expect(args).toEqual(['task-even-on-rejection']);
      return new Promise<void>(() => {});
    });
    const receipt = await submitInvite(fx.deps, opts);
    expect(fx.deps.initiate).toHaveBeenCalledWith(opts);
    expect(vi.mocked(fx.deps.initiate).mock.calls[0]?.[0]).toBe(opts);
    expect(receipt.text).toBe('⚠️ invite push rejected (HTTP 429): pending invite; lore-house reachable but refused the payload');
    expect(fx.onWatchError).not.toHaveBeenCalled();
  });

  it('an empty task id has no tracking side effects and still returns the receipt', async () => {
    const fx = depsFor({ expectedSigil: 'abcdef', pushedEventId: 'event-1', push: { status: 200, taskId: '' } });
    const receipt = await submitInvite(fx.deps, opts);
    expect(receipt.text).toContain(opts.proofUrl);
    expect(fx.recordPending).not.toHaveBeenCalled();
    expect(fx.watch).not.toHaveBeenCalled();
  });

  it('reports a rejected background watcher without failing the receipt', async () => {
    const fx = depsFor({ expectedSigil: 'abcdef', pushedEventId: 'event-1', push: { status: 200, taskId: 'task-1' } });
    fx.watch.mockRejectedValueOnce(new Error('watch unavailable'));
    expect((await submitInvite(fx.deps, opts)).text).toContain('event-1');
    expect(fx.onWatchError).toHaveBeenCalledTimes(1);
    expect(fx.onWatchError).toHaveBeenCalledWith('popclaw: invite poll failed — Error: watch unavailable');
  });
});
