import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearPerProcess, getOrCreatePerProcess, peekPerProcess } from '../../../src/runtime/once.js';
import { adoptOrRebootRuntime, isClosedRuntime, peekCurrentRuntime } from '../../../src/runtime/stale-runtime-memo.js';

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

describe('read-only runtime declaration lookup', () => {
  it('does not create a missing memo and suppresses a failed or closed memo without clearing it', async () => {
    expect(await peekCurrentRuntime(KEY)).toBeNull();
    expect(peekPerProcess(KEY)).toBeUndefined();
    const failed = Promise.reject(new Error('BOOT_FAILED'));
    failed.catch(() => {});
    getOrCreatePerProcess(KEY, () => failed);
    expect(await peekCurrentRuntime(KEY)).toBeNull();
    expect(peekPerProcess(KEY)).toBe(failed);
    clearPerProcess(KEY);
    const closed = Promise.resolve({ host: { db: { closed: true } } });
    getOrCreatePerProcess(KEY, () => closed);
    expect(await peekCurrentRuntime(KEY)).toBeNull();
    expect(peekPerProcess(KEY)).toBe(closed);
  });

  it('awaits only the existing pending promise and refuses one replaced during the read', async () => {
    let resolve!: (value: object) => void;
    const pending = new Promise<object>(r => { resolve = r; });
    getOrCreatePerProcess(KEY, () => pending);
    const reading = peekCurrentRuntime(KEY);
    clearPerProcess(KEY);
    const replacement = Promise.resolve({ fresh: true });
    getOrCreatePerProcess(KEY, () => replacement);
    resolve({ old: true });
    expect(await reading).toBeNull();
    expect(await peekCurrentRuntime(KEY)).toEqual({ fresh: true });
  });

  it('revokes a pending memo at shutdown entry, but still returns it to the lifecycle for draining', async () => {
    const closing = new AbortController();
    let resolve!: (value: object) => void;
    const factory = vi.fn(() => new Promise<object>(r => { resolve = r; }));
    const opening = adoptOrRebootRuntime(KEY, factory, vi.fn(), closing.signal);
    const reading = peekCurrentRuntime(KEY);
    closing.abort();
    expect(await peekCurrentRuntime(KEY)).toBeNull();
    const rt = { host: { db: { open: true } } };
    resolve(rt);
    expect(await opening).toBe(rt);
    expect(await reading).toBeNull();
    expect(await peekCurrentRuntime(KEY)).toBeNull();
    expect(factory).toHaveBeenCalledOnce();
  });

  it('an old lifecycle abort cannot revoke the replacement memo', async () => {
    const closing = new AbortController();
    await adoptOrRebootRuntime(KEY, async () => ({ old: true }), vi.fn(), closing.signal);
    clearPerProcess(KEY);
    const fresh = { fresh: true };
    getOrCreatePerProcess(KEY, () => Promise.resolve(fresh));
    closing.abort();
    expect(await peekCurrentRuntime(KEY)).toBe(fresh);
  });
});
