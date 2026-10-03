import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  runOncePerProcess,
  resetOnceForTest,
  getOrCreatePerProcess,
  clearPerProcess,
  resetSingletonForTest,
} from '../../../src/runtime/once.js';

describe('getOrCreatePerProcess', () => {
  afterEach(() => resetSingletonForTest('rt'));

  it('creates the value once and returns the SAME instance on later calls', () => {
    const factory = vi.fn(() => ({ id: Math.random() }));
    const a = getOrCreatePerProcess('rt', factory);
    const b = getOrCreatePerProcess('rt', factory);
    expect(b).toBe(a); // same instance across "register() invocations"
    expect(factory).toHaveBeenCalledOnce(); // no second build → follow-propagation guaranteed
  });

  it('a mutation through one handle is visible through another (shared socialGraph)', () => {
    const following = new Set<string>();
    getOrCreatePerProcess('rt', () => ({ following }));
    // a later "register()" load gets the same object and mutates it…
    getOrCreatePerProcess('rt', () => ({ following: new Set<string>() })).following.add('alice');
    // …the first holder sees it (this is exactly the gate-sees-the-follow case)
    expect(getOrCreatePerProcess('rt', () => ({ following: new Set<string>() })).following.has('alice')).toBe(true);
  });

  it('caches falsy/undefined-returning factories too (keyed on presence, not truthiness)', () => {
    const factory = vi.fn(() => undefined);
    getOrCreatePerProcess('rt', factory);
    getOrCreatePerProcess('rt', factory);
    expect(factory).toHaveBeenCalledOnce();
  });
});

describe('clearPerProcess', () => {
  afterEach(() => clearPerProcess('rt'));

  it('drops the cached value so the next call builds a fresh one', () => {
    const factory = vi.fn(() => ({ id: factory.mock.calls.length }));
    const first = getOrCreatePerProcess('rt', factory);
    clearPerProcess('rt');
    const second = getOrCreatePerProcess('rt', factory);
    // The owner of the value (its shutdown) has released it: what the next
    // register() gets must be a new value, never the released one.
    expect(second).not.toBe(first);
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it('only clears the named key', () => {
    const other = getOrCreatePerProcess('other', () => ({}));
    getOrCreatePerProcess('rt', () => ({}));
    clearPerProcess('rt');
    expect(getOrCreatePerProcess('other', () => ({}))).toBe(other);
    clearPerProcess('other');
  });

  it('clearing a key that was never created is a no-op', () => {
    expect(() => clearPerProcess('never-created')).not.toThrow();
  });

  it('resetSingletonForTest is the same function (tests keep their name)', () => {
    expect(resetSingletonForTest).toBe(clearPerProcess);
  });
});

describe('runOncePerProcess', () => {
  afterEach(() => {
    resetOnceForTest('t');
    resetOnceForTest('other');
  });

  it('runs fn the first time and returns "ran"', () => {
    const fn = vi.fn();
    expect(runOncePerProcess('t', fn)).toBe('ran');
    expect(fn).toHaveBeenCalledOnce();
  });

  it('skips fn on every subsequent call for the same key', () => {
    const fn = vi.fn();
    runOncePerProcess('t', fn);
    expect(runOncePerProcess('t', fn)).toBe('skipped');
    expect(runOncePerProcess('t', fn)).toBe('skipped');
    expect(fn).toHaveBeenCalledOnce(); // the duplicate-subscription bug, prevented
  });

  it('different keys are independent', () => {
    const a = vi.fn();
    const b = vi.fn();
    runOncePerProcess('t', a);
    expect(runOncePerProcess('other', b)).toBe('ran');
    expect(b).toHaveBeenCalledOnce();
  });

  it('resetOnceForTest lets fn run again', () => {
    const fn = vi.fn();
    runOncePerProcess('t', fn);
    resetOnceForTest('t');
    expect(runOncePerProcess('t', fn)).toBe('ran');
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
