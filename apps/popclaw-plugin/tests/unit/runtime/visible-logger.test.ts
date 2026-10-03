import { describe, it, expect, vi } from 'vitest';
import { visibleLogger } from '../../../src/runtime/visible-logger.js';

// 这层是整套故障诊断依赖的仪器（宿主 warn/error → stderr → /dev/null）。
// 仪器要有自检：坏了没人会发现，因为坏的表现就是"什么都看不见"。
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
    // SDK 的 `debug` 是可选面（`PluginLogger.debug?`），调用点得容它缺席。
    log.debug?.('noisy');

    expect(host.info.mock.calls.flat()).toEqual(['popclaw: build 0.1.0']);
    expect(host.debug.mock.calls.flat()).toEqual(['noisy']);
  });

  it('宿主没有 debug 这一级也不炸', () => {
    const host = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    expect(() => visibleLogger(host).debug?.('noisy')).not.toThrow();
  });
});
