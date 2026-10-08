/**
 * High-level Social-Graph API for the popclaw plugin. Composes:
 *   - FollowEventStore: the append-only follow/revoke log in the social DB
 *     `follow_events` table.
 *   - state-projection for the materialized following state
 *   - the ordered relation producer, which owns every relation WRITE: it
 *     resolves the house, proves the binding, reserves the seq, signs,
 *     journals and pushes. This module signs nothing itself.
 *
 * PUBLIC follow / revoke only.
 */

import { RelationRefusedError, type RelationOutcome, type RelationProducer } from './relation-producer.js';
import type { Signer } from '../identity/signer.js';
import type { HostDb } from '../host/host-db.js';
import { activeRelationHouses, type ActiveRelationHouses } from './relation-active-houses.js';
import { FollowEventStore } from './follow-event-store.js';
import {
  projectState,
  followsInHouse,
  type DeclaredEvent,
  type SocialGraphState,
  type FollowingEntry,
} from './state-projection.js';

export interface SocialGraphLogger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export interface SocialGraphOptions {
  /**
   * The ordered-relation producer: the ONLY way this build writes a relation.
   *
   * Absent, a write is unavailable — see RelationWriteUnavailableError; reads
   * are unaffected. Present, the write goes through it, and there is no other
   * branch. A missing dependency is unavailability, never a licence for the
   * older shape, and "a producer is installed" must not be able to mean
   * "sign the old format after all".
   */
  readonly relationProducer?: RelationProducer;
  /** The social DB handle. The follow/revoke log lives in `follow_events`. */
  readonly db: HostDb;
  readonly signer: Signer;
  /** `houseSlug` = the target house (spec B slice③); undefined = the home house. */
  /**
   * NOT the relation path any more — the producer owns signing and transport.
   * Kept, and optional, because construction sites still pass it; nothing in
   * this module reads it. FOLLOW-UP: delete it once no caller supplies it.
   */
  readonly egressPush?: (signedBytes: Uint8Array, houseSlug?: string) => Promise<void> | void;
  /**
   * Spec B slice③: which house this person was discovered in (the one they
   * showed up in, in the world-stream cache).
   * Not injected (single house / dev CLI) → everything falls to the home
   * house, matching pre-refactor behavior bit-for-bit.
   * Routing is consolidated in SocialGraph rather than in each command: every
   * follow path (slash command / agent tool) goes through here, so one wiring
   * point keeps every route correct.
   */
  readonly houseOf?: (popclawId: string) => string | undefined;
  /**
   * The home house's slug. Both legacy rows (pre-migration-014) and the case
   * of "the person wasn't in any house's cache at follow time" route their
   * events through `pushRouted(…, undefined, …)`, which **actually lands on
   * the home house** — so an empty house_slug literally means "the home
   * house," not "origin unknown" (ADR-0037's literal wording).
   * Once injected, this is normalized right at the projection entry point, so downstream only ever sees real house names.
   */
  readonly primaryHouse?: string;
  readonly logger?: SocialGraphLogger;
}

const NOOP_LOGGER: SocialGraphLogger = {
  info: () => {}, warn: () => {}, error: () => {},
};

/**
 * A relation WRITE was asked for and this build cannot make one.
 *
 * Every follow and unfollow is now an ordered relation action: it carries a
 * per-edge `seq` and the House key it is scoped to, both inside the author's
 * signature. Producing one needs the ordered producer — the allocator that
 * reserves the seq, the scope resolver that proves which House the action
 * belongs to, and the refusal journal. Without it, the only shape this code
 * could emit is the pre-ordering one.
 *
 * Emitting that shape instead is not a smaller version of the feature. An
 * original signed without `seq` cannot have one added later while keeping its
 * signature and CID, and no trustworthy past order can be reconstructed after
 * the fact. (The edge itself is not lost: a later ordered original may adopt
 * an edge whose applied seq is still null, and the older originals are kept as
 * superseded evidence rather than deleted.) So the honest answer while the
 * producer is not installed is that this action is unavailable — stated
 * before anything is written, signed or sent.
 */
export class RelationWriteUnavailableError extends Error {
  constructor(readonly action: 'declare' | 'revoke', readonly followee: string) {
    super(`RELATION_WRITE_UNAVAILABLE: no ordered relation producer is installed, so ${action} ${followee} cannot be signed`);
    this.name = 'RelationWriteUnavailableError';
  }
}

/**
 * Which sentence a refused relation write earns.
 *
 * Two different facts used to share one. "This build has no ordered producer
 * installed" is the error above. "The producer ran, and the HOUSE declares no
 * ordered relations" is a refusal outcome — and it was told to the owner as
 * *"following is unavailable in this build: ordered relations are not wired
 * up yet"*, which is false. The build follows fine on a house that declares
 * the capability; it was this house that offers no follow. Blaming the build
 * sends the owner off to wait for a release that already shipped.
 *
 * Only that one reason is split out here. The rest of `RelationRefusalReason`
 * (unreachable, unproven binding, seq trouble) still shares the old sentence —
 * the same defect, unfixed, named rather than papered over.
 */
export function relationRefusalCopyKey(reason: string | undefined): string {
  if (reason === 'HOUSE_SELECTION_REQUIRED') return 'relation.houseSelectionRequired';
  if (reason === 'RELATION_NOT_FOLLOWING') return 'relation.notFollowing';
  return reason === 'HOUSE_ORDERED_RELATIONS_UNSUPPORTED'
    ? 'relation.houseNoFollow'
    : 'relation.writeUnavailable';
}

export class SocialGraph {
  private readonly declaredStore: FollowEventStore;
  private readonly logger: SocialGraphLogger;
  private state: SocialGraphState | null = null;
  private observedRevision = -1;

  constructor(private readonly opts: SocialGraphOptions) {
    this.declaredStore = new FollowEventStore(opts.db);
    this.logger = opts.logger ?? NOOP_LOGGER;
  }

  /**
   * Empty house_slug → the home house (ADR-0037). Normalization happens in
   * this one spot at the projection entry point, so downstream code like
   * `followsInHouse` doesn't need its own special case for empty strings:
   * someone followed in the "me" house won't also get follow weighting in the
   * "world" house just because of an empty string (that's exactly the
   * cross-house noise ADR-0037 exists to eliminate).
   * No home-house name injected (single house / dev CLI) → returned as-is, matching pre-refactor behavior bit-for-bit.
   */
  private normalizeHouse(declared: readonly DeclaredEvent[]): readonly DeclaredEvent[] {
    const primary = this.opts.primaryHouse;
    if (!primary) return declared;
    return declared.map((ev) => (ev.houseSlug ? ev : { ...ev, houseSlug: primary }));
  }

  /** A different host can follow/unfollow on this same root between arrivals. */
  private refreshFromSharedRoot(): void {
    if (!this.state) return;
    const revision = this.declaredStore.revision();
    if (revision === this.observedRevision) return;
    this.state = projectState(this.state.popclawId, this.normalizeHouse(this.declaredStore.readAllSync()));
    this.observedRevision = revision;
  }

  async start(): Promise<void> {
    const popclawId = await this.opts.signer.popclawId();
    const declared = await this.declaredStore.readAll();
    this.state = projectState(popclawId, this.normalizeHouse(declared));
  }

  /** Read-only per-house intent including signed tails and this owner's
   * verified consumer evidence, even when the local ledger is incomplete. */
  async activeFollowHouses(followee: string): Promise<ActiveRelationHouses> {
    return activeRelationHouses(this.opts.db, followee, await this.opts.signer.popclawId());
  }

  /**
   * Person-level union (ADR-0037 tier 2): one entry per person, present if
   * followed in any house. Used by the DM closeness gate / bond book /
   * identity resolution / status counts — "who I know" carries no house.
   */
  following(): readonly FollowingEntry[] {
    this.refreshFromSharedRoot();
    return this.state?.following ?? [];
  }

  /** House-level view (ADR-0037 tier 1): key = house_slug (an empty key is already normalized to the home house at the projection entry point). Used for per-house status display. */
  followingByHouse(): ReadonlyMap<string, readonly FollowingEntry[]> {
    this.refreshFromSharedRoot();
    return this.state?.followingByHouse ?? new Map();
  }

  /**
   * Person-level check (ADR-0037 tier 2): does the owner follow this person in
   * ANY house? The same union `following()` exposes, asked about one person.
   *
   * This — NOT `followsIn(id)` — is what a relationship question must call.
   * `followsIn` with no house argument looks up the `''` bucket, and that
   * bucket is always empty in a real install: `normalizeHouse` rewrites every
   * empty `house_slug` to `primaryHouse` at the projection entry point, and
   * events written since migration 014 carry a real slug anyway. So
   * `followsIn(id)` is a constant `false` in production, silently. The follow
   * doorbell's already-followed check was wired that way and let every
   * already-followed author through as a fresh pending intent.
   */
  follows(popclawId: string): boolean {
    this.refreshFromSharedRoot();
    if (!popclawId) return false;
    return (this.state?.following ?? []).some((e) => e.popclawId === popclawId);
  }

  /** House-level check: used by feed attention / daily-paper weighting / recommend — "content attention is house-scoped." Pass a house: with none, see `follows`. */
  followsIn(popclawId: string, houseSlug?: string): boolean {
    this.refreshFromSharedRoot();
    return this.state ? followsInHouse(this.state, popclawId, houseSlug) : false;
  }

  /**
   * Reading the graph stays available with no producer; only WRITING a
   * relation does not. A build that cannot produce an ordered original has
   * nothing legitimate to write.
   */
  private requireProducer(action: 'declare' | 'revoke', followee: string): RelationProducer {
    const producer = this.opts.relationProducer;
    if (producer === undefined) throw new RelationWriteUnavailableError(action, followee);
    return producer;
  }

  /**
   * The producer answered. A refusal is thrown rather than returned as "no
   * house", because the two are not the same fact and a caller that cannot
   * tell them apart reports a refusal as a quiet success.
   */
  private static houseSlugOf(outcome: RelationOutcome): string | undefined {
    if (outcome.mode === 'none') throw new RelationRefusedError(outcome);
    return outcome.houseSlug;
  }

  /**
   * Declare a public follow. The producer does the work; this collapses its
   * outcome to the house it landed on, and throws when it was refused.
   * Signing or egress failures propagate after the local event is committed;
   * the local relationship remains, while callers cannot claim public success.
   * @returns which house it landed on (undefined = the home house). Routing
   *   is resolved right here, so the caller (the social-log collection point,
   *   ADR-0037's "facts carry a house") gets the same value without resolving it a second time.
   */
  async declareFollow(followee: string, opts?: { tasteSubscribed?: boolean }): Promise<string | undefined> {
    return SocialGraph.houseSlugOf(await this.declareFollowWithOutcome(followee, opts));
  }

  /**
   * Follow, reported honestly.
   *
   * The producer owns the whole write: it resolves the house, proves the
   * binding, reserves the seq, signs the ordered original, journals it into
   * `follow_events` and pushes. This method adds no second ledger row and no
   * second signature — a local declaration written here as well would be a
   * duplicate of the producer's, under a different id.
   *
   * The outcome distinguishes what the collapsed `declareFollow` cannot:
   * refused before signing, signed and queued, and accepted by the house. None
   * of the three means the other end has applied it.
   */
  async declareFollowWithOutcome(
    followee: string,
    opts?: { tasteSubscribed?: boolean; house?: string },
  ): Promise<RelationOutcome> {
    const producer = this.requireProducer('declare', followee);
    const outcome = await producer.declare(followee, opts ?? {});
    await this.refresh(); // the producer wrote the ledger; re-project from it
    return outcome;
  }

  /**
   * @returns which house the revocation landed on (undefined = the home house).
   * Signing or egress failures propagate without rolling back the local revoke.
   */
  async revokeFollow(followee: string): Promise<string | undefined> {
    return SocialGraph.houseSlugOf(await this.revokeFollowWithOutcome(followee));
  }

  /** Unfollow, reported honestly. The counterpart of declareFollowWithOutcome. */
  async revokeFollowWithOutcome(followee: string, opts?: { house?: string }): Promise<RelationOutcome> {
    const producer = this.requireProducer('revoke', followee);
    const outcome = await producer.revoke(followee, opts);
    await this.refresh();
    return outcome;
  }

  private async refresh(): Promise<void> {
    const popclawId = await this.opts.signer.popclawId();
    const declared = await this.declaredStore.readAll();
    this.state = projectState(popclawId, this.normalizeHouse(declared));
  }
}
