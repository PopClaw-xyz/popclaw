import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearPerProcess, getOrCreatePerProcess } from '../../../src/runtime/once.js';
import { adoptOrRebootRuntime, isClosedRuntime } from '../../../src/runtime/stale-runtime-memo.js';

/**
 * Upgrade gap (issue #582, second half): the memo is only cleared on shutdown
 * by a build that HAS that fix. When the instance being shut down is an older
 * build, its shutdown leaves the memo parked on globalThis and the new build's
 * registration adopts a runtime whose sqlite handles are already closed
 * ("The database connection is not open" / HOUSE_RUNTIME_STOPPED). The
 * accessor therefore has to recognise a corpse on adoption — using state the
 * OLD object already carries, since no flag we add now exists on it.
 */

const KEY = 'stale-memo-test-runtime';

afterEach(() => clearPerProcess(KEY));

describe('isClosedRuntime', () => {
  it('says nothing is wrong with a live runtime', () => {
    expect(isClosedRuntime({ host: { db: { open: true } } })).toBe(false);
    expect(isClosedRuntime({ host: { db: { closed: false, handle: { open: true } } } })).toBe(false);
  });

  it('recognises a closed better-sqlite3 handle in every shape the host db takes', () => {
    expect(isClosedRuntime({ host: { db: { open: false } } })).toBe(true);
    // LocalHostDb's own bookkeeping, and the better-sqlite3 Database it wraps.
    expect(isClosedRuntime({ host: { db: { closed: true } } })).toBe(true);
    expect(isClosedRuntime({ host: { db: { handle: { open: false } } } })).toBe(true);
  });

  it('never condemns a runtime it cannot read (no host db, no flags)', () => {
    expect(isClosedRuntime({ host: { db: {} } })).toBe(false);
    expect(isClosedRuntime({ host: {} })).toBe(false);
    expect(isClosedRuntime({})).toBe(false);
    expect(isClosedRuntime(undefined)).toBe(false);
  });
});

describe('adoptOrRebootRuntime', () => {
  it('adopts the memoized runtime when it is still open', async () => {
    const first = { host: { db: { open: true } } };
    const factory = vi.fn(async () => first);
    const onStale = vi.fn();

    expect(await adoptOrRebootRuntime(KEY, factory, onStale)).toBe(first);
    expect(await adoptOrRebootRuntime(KEY, factory, onStale)).toBe(first);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(onStale).not.toHaveBeenCalled();
  });

  it('reboots when an older build left a closed runtime in the memo', async () => {
    const dead = { host: { db: { open: false } } };
    const fresh = { host: { db: { open: true } } };
    getOrCreatePerProcess(KEY, () => Promise.resolve(dead));
    const factory = vi.fn(async () => fresh);
    const onStale = vi.fn();

    expect(await adoptOrRebootRuntime(KEY, factory, onStale)).toBe(fresh);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(onStale).toHaveBeenCalledTimes(1);
    // The corpse is gone: the next caller gets the rebooted runtime straight
    // from the memo, and nobody announces staleness twice.
    expect(await adoptOrRebootRuntime(KEY, factory, onStale)).toBe(fresh);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(onStale).toHaveBeenCalledTimes(1);
  });
});
