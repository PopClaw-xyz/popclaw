import { describe, it, expect, vi } from 'vitest';
import { visibleLogger } from '../../../src/runtime/visible-logger.js';

// This is the diagnostic instrument (host warn/error -> stderr -> /dev/null).
// It needs a self-check: a broken instrument produces no visible output and otherwise goes unnoticed.
describe('visibleLogger', () => {
  function bed() {
    const host = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    return { host, log: visibleLogger(host) };
  }

  it('warn / error 走 info 通道（stderr 是黑洞），级别语义留在前缀里', () => {
    const { host, log } = bed();

    log.warn('popclaw: 图 staging 失败');
    log.error('popclaw: ranger crashed');

    expect(host.warn).not.toHaveBeenCalled();
    expect(host.error).not.toHaveBeenCalled();
    expect(host.info.mock.calls.flat()).toEqual([
      'popclaw[warn]: popclaw: 图 staging 失败',
      'popclaw[error]: popclaw: ranger crashed',
    ]);
  });

  it('info / debug 原样透传，不加前缀', () => {
    const { host, log } = bed();

    log.info('popclaw: build 0.1.0');
    // SDK debug is optional (PluginLogger.debug?); call sites must tolerate its absence.
    log.debug?.('noisy');

    expect(host.info.mock.calls.flat()).toEqual(['popclaw: build 0.1.0']);
    expect(host.debug.mock.calls.flat()).toEqual(['noisy']);
  });

  it('宿主没有 debug 这一级也不炸', () => {
    const host = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    expect(() => visibleLogger(host).debug?.('noisy')).not.toThrow();
  });
});
