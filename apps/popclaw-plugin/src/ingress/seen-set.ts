/**
 * Bounded recently-seen event_id cache. Simple FIFO eviction; good enough
 * for MVP where duplicates typically cluster within the last few hundred
 * events.
 */
export class SeenSet {
  private readonly order: string[] = [];
  private readonly set = new Set<string>();

  constructor(private readonly capacity: number = 2048) {}

  has(id: string): boolean {
    return this.set.has(id);
  }

  add(id: string): void {
    if (this.set.has(id)) return;
    this.set.add(id);
    this.order.push(id);
    if (this.order.length > this.capacity) {
      const evicted = this.order.shift()!;
      this.set.delete(evicted);
    }
  }

  get size(): number {
    return this.set.size;
  }
}
