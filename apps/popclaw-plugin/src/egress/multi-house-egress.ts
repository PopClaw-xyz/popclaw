/**
 * MultiHouseEgress — write-side per-house routing (Spec B slice ③).
 *
 * The read side's `WorldFeedCatalog` tags every item with its source-house slug; this is its
 * write-side mirror: one `ServerPushEgress` per house, with `[0]` as the home house. Three entry points:
 *
 *   push(bytes)          → the home house. Zero changes for existing consumers = current behavior.
 *   pushTo(slug, bytes)  → a specific house; an omitted slug selects home; an unknown explicit slug is rejected.
 *   broadcast(bytes)     → pushes once to each house (for public artifacts like namecards; without broadcasting, secondary houses would carry a ghost id).
 *
 * The failure model for broadcast: **secondary houses are each independently best-effort, the
 * home house's success/failure is the command's success/failure.** If a secondary house can't
 * be reached, it just logs a warning line and doesn't drag down the rest (each house in the
 * federation is independent); if the home house can't be reached, it throws — the home house is
 * the identity anchor (symmetric with the read side's "if the home-house store can't open, hard
 * fail"), and reporting success when the namecard never actually landed on the home house would
 * be lying to the owner. A non-2xx from the home house still returns the home house's receipt
 * as normal, and the caller honestly reports the error based on the status code.
 */
import { hostDbSlug } from '../ingress/host-slug.js';
import type { EgressPlan, EventEgress, HouseBroadcastOutcome, PushResult } from './event-egress.js';
import { ServerPushEgress } from './server-push-egress.js';

/** The write side of one house: its slug (same measuring stick as the read-side cache's per-house DB split) + its push channel. */
export interface HouseEgress {
  readonly slug: string;
  readonly egress: EventEgress;
  /** The house's base URL, for reads that must cover exactly this target. */
  readonly origin?: string;
  /** Durable participation/owner check, evaluated at each send. */
  readonly isEnabled?: () => boolean;
}

export interface MultiHouseEgressOptions {
  /** A warning line when some house fails during broadcast. Not passed = silent. */
  readonly warn?: (msg: string) => void;
  /** A debug line when routing falls back to the home house (source house couldn't be determined). Not passed = silent. */
  readonly debug?: (msg: string) => void;
}

export class MultiHouseEgress implements EventEgress {
  private readonly houses: HouseEgress[];
  /** The config's `lore_houses` (order is priority, `[0]` is the home house) → one channel per house. */
  static fromUrls(
    urls: readonly string[],
    opts: MultiHouseEgressOptions = {},
  ): MultiHouseEgress {
    return new MultiHouseEgress(
      urls.map((baseUrl) => ({ slug: hostDbSlug(baseUrl), origin: baseUrl, egress: new ServerPushEgress({ baseUrl }) })),
      opts,
    );
  }

  constructor(
    houses: readonly HouseEgress[],
    private readonly opts: MultiHouseEgressOptions = {},
  ) {
    if (houses.length === 0) throw new Error('MultiHouseEgress needs at least one house');
    this.houses = [...houses];
  }

  /** Append a validated dynamic target without changing the configured home. */
  mount(house: HouseEgress): void {
    if (this.houses.some(existing => existing.slug === house.slug)) throw new Error(`HOUSE_SLUG_COLLISION: ${house.slug}`);
    this.houses.push(house);
  }

  /** The home house. */
  get home(): HouseEgress {
    return this.houses[0]!;
  }

  slugs(): readonly string[] {
    return this.houses.map((h) => h.slug);
  }

  /** The current houses, frozen for one write (see `EgressPlan`). */
  capturePlan(): EgressPlan {
    const houses = [...this.houses];
    return {
      targets: houses.map((h) => ({ slug: h.slug, ...(h.origin === undefined ? {} : { origin: h.origin }) })),
      egress: new MultiHouseEgress(houses, this.opts),
    };
  }

  push(bytes: Uint8Array): Promise<PushResult> {
    return this.pushHouse(this.home, bytes);
  }

  pushTo(houseSlug: string | undefined, bytes: Uint8Array): Promise<PushResult> {
    if (houseSlug === undefined) {
      this.opts.debug?.(`egress: no explicit target; using home house ${this.home.slug}`);
      return this.push(bytes);
    }
    const house = this.houses.find((h) => h.slug === houseSlug);
    if (!house) return Promise.reject(new Error(`INVALID_HOUSE: ${houseSlug}`));
    return this.pushHouse(house, bytes);
  }

  private async pushHouse(house: HouseEgress, bytes: Uint8Array): Promise<PushResult> {
    if (house.isEnabled && !house.isEnabled()) throw new Error(`HOUSE_DISABLED: ${house.slug}`);
    return house.egress.push(bytes);
  }

  /**
   * Pushes once to each house, with the receipt determined by the home house: home house
   * reject (network-level failure) → throws the home house's error; secondary houses still
   * get pushed to, and their failures still only get logged as warnings.
   */
  async broadcast(bytes: Uint8Array): Promise<PushResult> {
    const outcomes = await this.broadcastEach(bytes);
    // Secondary houses' success/failure ends here (best-effort, warning already logged); the home house has the final say.
    const home = outcomes[0]!;
    if (home.result === undefined) throw home.error;
    return home.result;
  }

  /** The per-house receipts for one broadcast (the data source for the passport's stamped-line entries). Never throws — failures land in the outcome instead. */
  async broadcastEach(bytes: Uint8Array): Promise<readonly HouseBroadcastOutcome[]> {
    const settled = await Promise.allSettled(this.houses.map((h) => this.pushHouse(h, bytes)));
    return settled.map((res, i) => {
      const slug = this.houses[i]!.slug;
      if (res.status === 'rejected') {
        this.opts.warn?.(`egress: broadcast to ${slug} failed — ${String(res.reason)}`);
        return { slug, error: res.reason };
      }
      if (res.value.status < 200 || res.value.status >= 300) {
        this.opts.warn?.(`egress: broadcast to ${slug} rejected — HTTP ${res.value.status}`);
      }
      return { slug, result: res.value };
    });
  }
}
