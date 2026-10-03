/**
 * Session context index (spec 2026-06-11 §2) — registers items shown in acts
 * two/three, backing the owner's references ("that post from just now" /
 * "reply to number 2" / "follow Elon"). S2 provides deterministic resolution
 * (ordinal / hint substring); the LLM fallback for free-language → item
 * resolution is in S5.
 */
export interface ContextItem {
  readonly eventId: string;
  readonly authorPopclawId: string;
  readonly authorNickname: string;
  /** The one-line summary shown to the owner (matches card rendering; linkage relies on it). */
  readonly summaryLine: string;
  readonly source: 'summary' | 'hottest' | 'latest' | 'thread';
}

export class SessionContextIndex {
  private items: ContextItem[] = [];   // newest first
  private batch: ContextItem[] = [];

  constructor(private readonly capacity = 50) {}

  /** Registers a batch of just-shown items; they become the "current batch" for
   *  ordinal resolution. Deduped by eventId within the ring (when the same post
   *  reappears across batches, the newest is kept), but the current batch itself
   *  is not deduped. */
  register(batch: ContextItem[]): void {
    this.batch = [...batch];
    const incoming = [...batch].reverse();
    const incomingIds = new Set(incoming.map((i) => i.eventId));
    this.items = [
      ...incoming,
      ...this.items.filter((i) => !incomingIds.has(i.eventId)),
    ].slice(0, this.capacity);
  }

  lastBatch(): ContextItem[] {
    return [...this.batch];
  }

  /** 1-based ordinal into the "current batch" (the number shown on the card). Returns null if out of range. */
  byOrdinal(n: number): ContextItem | null {
    if (!Number.isInteger(n) || n < 1 || n > this.batch.length) return null;
    return this.batch[n - 1] ?? null;
  }

  /** Substring hint matching (nickname or summary line), newest first. */
  findByHint(hint: string): ContextItem[] {
    const h = hint.trim().toLowerCase();
    if (!h) return [];
    return this.items.filter(
      (i) =>
        i.authorNickname.toLowerCase().includes(h) ||
        i.summaryLine.toLowerCase().includes(h),
    );
  }

  recent(n = 10): ContextItem[] {
    return this.items.slice(0, n);
  }
}
