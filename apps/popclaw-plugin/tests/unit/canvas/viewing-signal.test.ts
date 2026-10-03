/**
 * The in-process "a browser of mine is open NOW" signal: the one seam between
 * the page-state sync loop that learns it and the follow doorbell that paces
 * off it.
 */
import { describe, it, expect } from 'vitest';
import { createViewingSignal } from '../../../src/canvas/viewing-signal.js';

describe('createViewingSignal', () => {
  it('starts with nothing to report', () => {
    expect(createViewingSignal(() => 1_000).lastAnswerAtMs()).toBeNull();
  });

  it('records the answer time from its own clock and notifies listeners', () => {
    let now = 1_000;
    const s = createViewingSignal(() => now);
    const seen: number[] = [];
    s.onAnswer(() => void seen.push(now));
    s.noteAnswer();
    expect(s.lastAnswerAtMs()).toBe(1_000);
    now = 5_000;
    s.noteAnswer();
    expect(s.lastAnswerAtMs()).toBe(5_000);
    expect(seen).toEqual([1_000, 5_000]);
  });

  it('unsubscribing stops the notifications and is idempotent', () => {
    const s = createViewingSignal(() => 1_000);
    let calls = 0;
    const off = s.onAnswer(() => void (calls += 1));
    s.noteAnswer();
    off();
    off();
    s.noteAnswer();
    expect(calls).toBe(1);
    expect(s.lastAnswerAtMs()).toBe(1_000); // the fact itself is still recorded
  });

  it('a throwing listener neither stops the others nor breaks the recording', () => {
    const s = createViewingSignal(() => 1_000);
    let reached = 0;
    s.onAnswer(() => {
      throw new Error('a stopped loop that forgot to unsubscribe');
    });
    s.onAnswer(() => void (reached += 1));
    expect(() => s.noteAnswer()).not.toThrow();
    expect(reached).toBe(1);
    expect(s.lastAnswerAtMs()).toBe(1_000);
  });
});
