/**
 * "A paired browser of MINE is open on a paper right now."
 *
 * The one seam between the two canvas legs a resident root runs: the page-state
 * sync loop (`startPageStateSync`) learns the fact, the follow doorbell
 * (`startFollowDoorbell`) paces off it. They live in different modules and are
 * started independently by each root, so the hand-off is this object rather
 * than a wire through three call sites.
 *
 * Why the page-state answer is the evidence: the canvas only ever asks this
 * identity "which of these authors do you follow" because a browser holding
 * THIS identity's pass opened a page. Follow intents are credited to the
 * clicking reader (owner ruling 2026-09-13), so the reader about to press ➕ is
 * the identity that just answered — which is precisely the identity the
 * doorbell needs to poll fast for, and precisely the one the publish-derived
 * tier could not see.
 *
 * In-process by nature and deliberately not persisted: it means "a browser is
 * open NOW", and a process that just restarted knows nothing about any browser.
 * A restart therefore costs one slow tick, which is the cheap direction to be
 * wrong in — the alternative, a stored timestamp, would claim a reading session
 * that ended while the process was down.
 */
export interface ViewingSignal {
  /** A page-state question was answered for this identity, just now. */
  noteAnswer(): void;
  /** When the last answer was made (ms), or null if there has been none. */
  lastAnswerAtMs(): number | null;
  /**
   * Called on every `noteAnswer`, so a listener can shorten a sleep already in
   * progress rather than wait for its next scheduling decision. Returns its own
   * unsubscribe, which is idempotent — a loop's `stop()` must be able to call
   * it without knowing whether it already has.
   */
  onAnswer(listener: () => void): () => void;
}

export function createViewingSignal(clock: () => number = Date.now): ViewingSignal {
  let lastMs: number | null = null;
  const listeners = new Set<() => void>();
  return {
    noteAnswer(): void {
      lastMs = clock();
      for (const l of [...listeners]) {
        // One listener that throws must not cost the others their wake-up, nor
        // unwind into the page-state tick that is only reporting a fact.
        try {
          l();
        } catch {
          /* a listener's own problem; the fact above is already recorded */
        }
      }
    },
    lastAnswerAtMs: () => lastMs,
    onAnswer(listener: () => void): () => void {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}

/**
 * The one instance per process, which both starters default to.
 *
 * Not a global in the `globalThis` sense and not injected through the roots:
 * the fact it carries is per-process ("a browser of mine is open"), the two
 * loops that share it are the only code that may touch it, and every root
 * starts exactly one of each. Tests inject their own through the starters'
 * `viewing` dep rather than reaching for this.
 */
export const viewingSignal: ViewingSignal = createViewingSignal();
