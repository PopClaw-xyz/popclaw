/**
 * Getting a house's manifest in a way that can carry trust.
 *
 * `manifest-client.ts`'s `conditionalGet` is the lenient path: never throws,
 * returns text, and a house going down must not knock over startup. That is
 * right for a guide. It is not enough for a binding, which needs the EXACT
 * bytes (a digest over a re-encode proves something about our own decoder), the
 * proof header from the SAME response, a refusal to follow a redirect somewhere
 * else entirely, and a read that stops at a limit rather than reporting one
 * afterwards.
 *
 * So this is a second, stricter fetch rather than a loosening of the first.
 *
 * **The two entry points are different acts and must stay different.**
 * `establishHouseTrust` is the owner adding a house: it may pin where nothing
 * was pinned. `confirmHouseTrust` is every reconnect, refresh and resume: it can
 * only agree or refuse. If a reconnect could pin, every outage would be an
 * opportunity to become the house.
 *
 * **No conditional request on this path.** A 304 says the BODY you hold is
 * current; it says nothing about the binding, because the proof is response
 * metadata and a house can change its incarnation without changing a byte of
 * the manifest. So an ETag here would buy a little bandwidth and a stale
 * answer to the only question being asked. Content caching is
 * `conditionalGet`'s job and stays there.
 *
 * **Prepare, then commit against what we expected.** Everything above happens
 * before any write. The commit is ONE transaction that re-checks everything
 * the decision was made about — the pin still at the revision it was read at,
 * and the owner's participation still the generation it was — and only then
 * writes. A network result that arrives after the world moved must not
 * establish trust, block a newer pin, or speak for an owner who moved on.
 */
import {
  ManifestProofError,
  verifyManifestProof,
  type VerifiedHouseBinding,
} from './house-binding.js';
import {
  confirmBindingInTx,
  establishTrustInTx,
  pinnedBinding,
  type BindingRefusal,
  type PinSource,
} from './house-binding-pin.js';
import { projectReadDeclarationInTx } from './house-read-declaration.js';
import { retainVerifiedManifestObservation } from './world-capabilities.js';
import type { HostDb } from '../host/host-db.js';
import { bumpParticipationInTx } from '../ingress/inbound-commit.js';
import { popclaw } from '@popclaw/contracts';
import { takeConfiguredFirstPin, FirstPinRefusal, type ConfiguredFirstPinAttempt } from '../runtime/house-lifecycle/configured-first-pin.js';

/** The header the house carries its proof in. */
export const MANIFEST_PROOF_HEADER = 'x-popclaw-manifest-proof';

/** A manifest is a small document. Anything this size is not one. */
const MAX_MANIFEST_BYTES = 1024 * 1024;

const TIMEOUT_MS = 10_000;

export type TrustedFetch =
  | { readonly status: 'ok'; readonly rawBytes: Uint8Array; readonly proofHeader: string }
  | { readonly status: 'unavailable'; readonly reason: string };

export interface TrustedFetchOptions {
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
  /**
   * Allow a plain-HTTP origin. Off by default and meant for a local test house:
   * first contact over http is first contact with whoever is on the wire.
   */
  readonly allowInsecureOrigin?: boolean;
}

/**
 * Fetch a manifest along with the proof that belongs to it.
 *
 * `redirect: 'error'` on purpose: a redirect means the bytes came from
 * somewhere other than the origin we are about to bind them to, and following
 * it silently is how an origin check stops meaning anything.
 *
 * The read stops AT the limit. Reading the whole body and then measuring it is
 * a rejection threshold, not a bound — a hostile or broken origin can stream
 * for as long as we are willing to allocate, and `content-length` is its word
 * for how much that will be.
 */
export async function fetchTrustedManifest(
  origin: string,
  opts: TrustedFetchOptions = {},
): Promise<TrustedFetch> {
  const scheme = safeScheme(origin);
  if (scheme !== 'https:' && !(scheme === 'http:' && opts.allowInsecureOrigin)) {
    return { status: 'unavailable', reason: `refusing to trust a binding over ${scheme || 'an unparseable origin'}` };
  }
  const fetchFn = opts.fetch ?? globalThis.fetch;
  try {
    const res = await fetchFn(`${origin.replace(/\/$/, '')}/v1/manifest`, {
      redirect: 'error',
      signal: AbortSignal.timeout(opts.timeoutMs ?? TIMEOUT_MS),
    });
    if (!res.ok) return { status: 'unavailable', reason: `HTTP ${res.status}` };

    const declared = Number(res.headers.get('content-length') ?? '0');
    if (declared > MAX_MANIFEST_BYTES) {
      return { status: 'unavailable', reason: 'manifest declares more bytes than a manifest has' };
    }
    const rawBytes = await readBounded(res, MAX_MANIFEST_BYTES);
    if (rawBytes === undefined) {
      return { status: 'unavailable', reason: 'manifest is larger than a manifest has any need to be' };
    }

    return { status: 'ok', rawBytes, proofHeader: res.headers.get(MANIFEST_PROOF_HEADER) ?? '' };
  } catch (err) {
    return { status: 'unavailable', reason: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Read at most `limit` bytes, then stop and cancel.
 *
 * Returns undefined when the body exceeds the limit, so the caller refuses
 * rather than acting on a truncated document. Falls back to `arrayBuffer()`
 * only where there is no readable stream to pull from, and says so.
 */
async function readBounded(res: Response, limit: number): Promise<Uint8Array | undefined> {
  const body = res.body;
  if (!body || typeof body.getReader !== 'function') {
    // No stream to bound (a test double, an older runtime). The declared length
    // was already checked; this is the weaker path and is named as such.
    const bytes = new Uint8Array(await res.arrayBuffer());
    return bytes.length > limit ? undefined : bytes;
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.length;
      if (total > limit) {
        await reader.cancel();
        return undefined;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock?.();
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

export type TrustOutcome =
  | { readonly ok: true; readonly binding: VerifiedHouseBinding }
  | { readonly ok: false; readonly refusal: BindingRefusal | string };

export interface EstablishOptions extends TrustedFetchOptions {
  /**
   * The key the OWNER configured for this origin, when there is one.
   *
   * Supplying it makes this a configured trust: the proof is verified against
   * this key, and a house serving anything else is refused. Without it this is
   * a first-contact TOFU, which is a weaker thing and should not be able to
   * call itself configured — the source label alone used to decide that, while
   * the key still came out of the response either way.
   */
  readonly configuredHouseKey?: string;
  /**
   * The owner's say-so for this add, from `beginHouseAdd`. Required for the
   * two-phase API — nothing recorded anywhere counts as an authorization —
   * and supplied automatically by the one-breath wrapper.
   */
  readonly attempt?: HouseAddAttempt;
  readonly now?: () => number;
}

/**
 * An explicit add, in flight. Zero fields on purpose: the attempt's facts —
 * which db handle and origin it authorizes, and the participation table as it
 * stood the moment the owner acted — live in a module-private registry no
 * caller can write or read. `new HouseAddAttempt()` mints an inert handle
 * that authorizes nothing, so "unknown" can never quietly equal
 * "authorized", and nothing can be assembled into an authorization from
 * outside this module.
 */
export class HouseAddAttempt {}

interface AttemptRecord {
  /** The one handle this add may prepare and commit through. */
  readonly db: HostDb;
  /** Canonical spelling of the one origin this add is for. */
  readonly origin: string;
  /** The participation table, read once, before any network. */
  readonly participation: ReadonlyMap<string, ParticipationTuple>;
}

const attemptRecords = new WeakMap<HouseAddAttempt, AttemptRecord>();

/** What the participation of one house was when the attempt began. */
interface ParticipationTuple {
  readonly generation: number;
  readonly active: boolean;
}

/** One origin, one spelling, for binding checks only. */
function canonicalOrigin(origin: string): string {
  return origin.replace(/\/+$/, '');
}

/**
 * The owner is adding this house. The returned attempt authorizes ONE commit,
 * through the db handle it was begun on, for that origin only — and it
 * carries the participation table as it stood RIGHT NOW, before any network:
 * that snapshot, not anything read after the house answers, is the world the
 * owner's decision was made about.
 *
 * The participation table is small house-keyed metadata, not the relation
 * graph; reading it locally is not an upload or a traversal.
 */
export function beginHouseAdd(db: HostDb, origin: string): HouseAddAttempt {
  const attempt = new HouseAddAttempt();
  const rows = db.queryAll<{ house_key: string; owner_generation: number; active: number }>(
    'SELECT house_key, owner_generation, active FROM relation_participation',
  );
  const participation = new Map<string, ParticipationTuple>();
  for (const row of rows) {
    participation.set(row.house_key, { generation: row.owner_generation, active: row.active === 1 });
  }
  attemptRecords.set(attempt, { db, origin: canonicalOrigin(origin), participation });
  return attempt;
}

/** The owner changed their mind. A cancelled add commits nothing, ever. */
export function cancelHouseAdd(attempt: HouseAddAttempt): void {
  attemptRecords.delete(attempt);
}

/** What a commit consumes. Frozen copies, never caller-held references. */
type PreparedData =
  | {
      readonly intent: 'establish';
      readonly binding: Readonly<VerifiedHouseBinding>;
      readonly source: PinSource;
      readonly expectedRevision: number;
      readonly expectedParticipation: ParticipationExpectation;
      readonly attempt: HouseAddAttempt;
      readonly manifestBytes: Uint8Array;
    }
  | {
      readonly intent: 'confirm';
      readonly binding: Readonly<VerifiedHouseBinding>;
      readonly expectedRevision: number;
      readonly expectedParticipation: ParticipationExpectation;
      readonly manifestBytes: Uint8Array;
    };

/** The one key a commit re-checks, and what it must still be. */
interface ParticipationExpectation {
  readonly houseKey: string;
  readonly tuple: ParticipationTuple | undefined;
}

/**
 * An immutable snapshot of a verified trust decision, issued by this module
 * and only by it. The handle carries nothing; the frozen facts live in a
 * module-private registry. There is deliberately no public way to issue one
 * or to read what is inside: minting a fact and verifying a fact are the same
 * act in this module, and a structurally identical clone is refused with zero
 * side effects. (Local code already running in this process is a different
 * threat model, and not this class's problem.)
 */
export class PreparedHouseTrust {}

interface PreparedRecord {
  /** The db handle this prepared was issued on; commits go to it or nowhere. */
  readonly db: HostDb;
  readonly data: Readonly<PreparedData>;
}

const preparedRecords = new WeakMap<PreparedHouseTrust, PreparedRecord>();

function issuePrepared(db: HostDb, data: PreparedData): PreparedHouseTrust {
  const prepared = new PreparedHouseTrust();
  // Copies, then frozen: nothing the caller holds a reference to — the
  // verified binding, the expectation — can change what this commit will act
  // on, and nothing handed back out is the mutable interior.
  const frozen = Object.freeze({
    ...data,
    binding: Object.freeze({ ...data.binding }),
    expectedParticipation: Object.freeze({
      houseKey: data.expectedParticipation.houseKey,
      tuple: data.expectedParticipation.tuple
        ? Object.freeze({ ...data.expectedParticipation.tuple })
        : undefined,
    }),
  }) as PreparedData;
  preparedRecords.set(prepared, { db, data: frozen });
  return prepared;
}

/**
 * The exact manifest bytes this prepared's proof was verified over — the SAME
 * original a consumer composing onto this boundary (the relation capability
 * contract) must parse, so its answer can never come from a body this
 * module did not verify. Only a handle this module issued answers.
 */
export function verifiedManifestBytes(prepared: PreparedHouseTrust): Uint8Array | undefined {
  return preparedRecords.get(prepared)?.data.manifestBytes;
}

export type PreparedOutcome =
  | { readonly ok: true; readonly prepared: PreparedHouseTrust }
  | { readonly ok: false; readonly refusal: string };

/**
 * Fetch and verify, and freeze what the commit may rely on. Writes nothing.
 *
 * The configured key is read ONCE, before anything async: `readonly` on the
 * options is a compile-time thing, and a field that appears while the house
 * is answering must not turn a first contact into a "configured" pin it was
 * never verified as. The participation expectation is NEVER sampled after
 * the network: it is the attempt's pre-network snapshot, looked up for the
 * key the response named. What the owner's world was when they asked is what
 * the commit will require it to still be — a logout-and-relogin inside the
 * fetch changes the generation, and the snapshot does not.
 */
export async function prepareHouseTrust(
  db: HostDb,
  origin: string,
  opts: EstablishOptions = {},
): Promise<PreparedOutcome> {
  const attempt = opts.attempt;
  const record = attempt !== undefined ? attemptRecords.get(attempt) : undefined;
  if (attempt === undefined || record === undefined) {
    return { ok: false, refusal: 'HOUSE_ADD_NOT_AUTHORIZED' };
  }
  if (record.db !== db || record.origin !== canonicalOrigin(origin)) {
    return { ok: false, refusal: 'HOUSE_ATTEMPT_MISMATCH' };
  }
  const configuredHouseKey = opts.configuredHouseKey;
  const before = pinnedBinding(db, origin);
  const verified = await prepare(origin, opts, configuredHouseKey);
  if (!verified.ok) return verified;

  return {
    ok: true,
    prepared: issuePrepared(db, {
      intent: 'establish',
      binding: verified.binding,
      source: configuredHouseKey !== undefined ? 'configured' : 'tofu',
      expectedRevision: before?.revision ?? 0,
      expectedParticipation: {
        houseKey: verified.binding.houseKey,
        tuple: record.participation.get(verified.binding.houseKey),
      },
      attempt,
      manifestBytes: verified.manifestBytes!,
    }),
  };
}

/**
 * The same, for every reconnect, refresh and resume: verified against the
 * pinned key, and refused outright when nothing is trusted here. No add
 * attempt is involved — this path never pins — and the prepared record it
 * returns may only be committed as a confirm.
 *
 * A confirm speaks for a live session, so it requires one: the participation
 * at the pinned key must be ACTIVE before the fetch, and its generation is
 * the expectation the commit re-checks. Never-joined and logged-out houses
 * get no background refresh of confirmed_at — the pin stands, but nobody is
 * home to confirm it.
 */
export async function prepareConfirmHouseTrust(
  db: HostDb,
  origin: string,
  opts: TrustedFetchOptions & {
    readonly now?: () => number;
    /**
     * Accept a participation that has ENDED (or was never started) instead of
     * refusing. For the one caller that is not speaking for a live session: an
     * explicit login, which is how a house someone LEFT is joined again.
     *
     * Without it a rejoin is impossible. The pin outlives a leave by design,
     * so the login takes this path, and this path used to require an active
     * participation — the one thing a rejoin does not have yet. The owner was
     * refused for ever, at the house they had personally asked to return to.
     *
     * It does NOT weaken what a confirm is. The intent stays `confirm`, so no
     * key can be pinned and no block can be cleared; the fetch is still
     * verified against the key already pinned here; and the tuple recorded
     * below is whatever was actually observed, so the commit's re-check is as
     * strict as ever. The only thing that changes is which tuples are allowed
     * to be the starting point.
     */
    readonly allowEndedParticipation?: boolean;
  } = {},
): Promise<PreparedOutcome> {
  const before = pinnedBinding(db, origin);
  if (before === undefined || before.blockedReason !== undefined) {
    return { ok: false, refusal: 'HOUSE_NOT_TRUSTED' };
  }
  const row = db.queryOne<{ owner_generation: number; active: number }>(
    'SELECT owner_generation, active FROM relation_participation WHERE house_key = ?',
    [before.houseKey],
  );
  const live = row !== null && row.active === 1;
  if (!live && opts.allowEndedParticipation !== true) {
    return { ok: false, refusal: 'HOUSE_OWNER_MOVED_ON' };
  }
  const verified = await prepare(origin, opts, before.houseKey);
  if (!verified.ok) return verified;
  return {
    ok: true,
    prepared: issuePrepared(db, {
      intent: 'confirm',
      binding: verified.binding,
      expectedRevision: before.revision,
      expectedParticipation: {
        houseKey: before.houseKey,
        // Whatever is really there — absent, ended, or live. The commit
        // compares against this exact tuple, so recording the truth is what
        // keeps the re-check meaningful.
        tuple: row === null ? undefined : { generation: row.owner_generation, active: row.active === 1 },
      },
      manifestBytes: verified.manifestBytes!,
    }),
  };
}

/**
 * Commit a prepared trust: ONE transaction that re-checks everything the
 * decision was made about — the pin still at the revision it was read at, and
 * the participation of the named house still the exact tuple it was when the
 * owner authorized the add (or the exact active generation a confirm began
 * under) — and only then writes.
 *
 * The tuple comparison is by generation, not by timestamp: participation
 * generations only move forward (begin and end both bump them, rows are
 * never deleted), so a logout-and-relogin during the fetch — even in the
 * same second, even with `updated_at` skewed — produces a different tuple
 * than the one the attempt snapshotted, and a stale authorization is
 * refused. Only the NAMED house's tuple is compared: another house coming
 * and going is not this add's business. An add may begin from `none`,
 * `active`, or `inactive` alike; what it may not do is commit into a world
 * that moved after its authorization — a fresh attempt after a logout sees
 * the new tuple and succeeds, so leaving is never a permanent ban.
 *
 * Wrong-scope inputs — a forged handle, a prepared on another db, a
 * cancelled or spent attempt — are refused BEFORE anything else, without
 * touching other authorizations. An attempt is consumed the moment its
 * commit passes scope and enters the guards, success or refusal alike: one
 * authorization, one commit attempt. Guard refusals write nothing — no pin,
 * no block, no confirmed_at; the explicit block semantics of a verified
 * key/incarnation disagreement are a security outcome, not a guard, and stay.
 */
export function commitHouseTrust(
  db: HostDb,
  prepared: PreparedHouseTrust,
  opts: { readonly now?: () => number } = {},
): TrustOutcome {
  const scoped = scopeChecks(db, prepared);
  if (scoped.refusal !== undefined) return { ok: false as const, refusal: scoped.refusal };
  const at = opts.now?.() ?? Math.floor(Date.now() / 1000);
  return db.transaction((tx) => commitPreparedInTx(tx, scoped.data, at));
}

/** The wrong-shape inputs, refused before anything else touches state. */
function scopeChecks(
  db: HostDb,
  prepared: PreparedHouseTrust,
): { readonly data: PreparedData; readonly refusal?: undefined } | { readonly refusal: string } {
  const record = preparedRecords.get(prepared);
  if (record === undefined) {
    return { refusal: 'HOUSE_PREPARED_NOT_OURS' };
  }
  if (record.db !== db) {
    return { refusal: 'HOUSE_PREPARED_MISMATCH' };
  }
  const facts = record.data;
  if (facts.intent === 'establish') {
    const attemptRecord = attemptRecords.get(facts.attempt);
    if (attemptRecord === undefined) {
      return { refusal: 'HOUSE_ADD_CANCELLED' };
    }
    // Consumed on entry, not on success: a refused guard downstream does not
    // buy the same authorization a second try.
    attemptRecords.delete(facts.attempt);
  }
  return { data: facts };
}

/** The guards and the writes, in whatever transaction the caller holds. */
function commitPreparedInTx(
  tx: HostDb,
  facts: PreparedData,
  at: number,
): TrustOutcome {
  const pin = pinnedBinding(tx, facts.binding.origin);
  if ((pin?.revision ?? 0) !== facts.expectedRevision) {
    return { ok: false as const, refusal: 'HOUSE_PIN_MOVED_WHILE_FETCHING' as const };
  }
  const expected = facts.expectedParticipation;
  const row = tx.queryOne<{ owner_generation: number; active: number }>(
    'SELECT owner_generation, active FROM relation_participation WHERE house_key = ?',
    [expected.houseKey],
  );
  const nowTuple = row === null ? undefined : { generation: row.owner_generation, active: row.active === 1 };
  const wanted = expected.tuple;
  const sameTuple =
    (nowTuple === undefined && wanted === undefined) ||
    (nowTuple !== undefined &&
      wanted !== undefined &&
      nowTuple.generation === wanted.generation &&
      nowTuple.active === wanted.active);
  if (!sameTuple) {
    return { ok: false as const, refusal: 'HOUSE_OWNER_MOVED_ON' as const };
  }
  if (facts.intent === 'establish') {
    establishTrustInTx(tx, facts.binding, facts.source, at);
  }
  const confirmed = confirmBindingInTx(tx, facts.binding, at);
  if (!confirmed.ok) return { ok: false as const, refusal: confirmed.refusal };
  // What this house says it accepts, out of the SAME bytes the proof above was
  // checked over, in the SAME transaction as the binding. Every commit path
  // reaches here, so the explicit add, the login's relation binding and every
  // confirm all leave one projection behind rather than three answers from
  // three responses. A refusal above returned already and wrote nothing.
  projectReadDeclarationInTx(tx, facts.binding, facts.manifestBytes, at);
  retainVerifiedManifestObservation(tx, facts.binding, facts.manifestBytes, facts.intent === 'confirm' ? 'persisted_pin'
    : facts.source === 'configured' ? 'configured_pin'
      : facts.binding.origin.startsWith('https:') ? 'https_tofu' : 'loopback_fixture');
  return { ok: true as const, binding: facts.binding };
}

/** A trust established and an owner activated, or neither. */
export type ActivateOutcome =
  | { readonly ok: true; readonly binding: VerifiedHouseBinding; readonly ownerGeneration: number }
  | { readonly ok: false; readonly refusal: BindingRefusal | string };

/**
 * The explicit add's second half: establish the pin AND begin the
 * participation in ONE commit boundary, and hand back the generation THAT
 * commit wrote — never a value re-read afterwards.
 *
 * The gap this closes is the seam between trusting a house and joining it:
 * as two writes, another process's logout could land between them, and a
 * flow that had already passed its checks would activate a participation the
 * owner had just ended. As one transaction, the tuple the attempt
 * snapshotted is still the tuple at the write, or nothing happens at all.
 *
 * Only an establish intent may activate — a confirm never moves the
 * participation. The handle built from the returned generation is the
 * caller's to construct (see `RelationWiring`); this module owns the commit,
 * not the connections.
 */
/**
 * Commit a prepared binding inside a transaction the CALLER owns, and
 * materialise the participation without disturbing one that is already live.
 *
 * Two things make this different from `commitEstablishAndActivate`.
 *
 * It takes the caller's `tx` so the pin and the participation land together
 * — never a pin with no participation behind it, or the reverse. It does NOT
 * share a transaction with the rest of the login: `commitLocalLogin` has
 * already committed by the time the manager reaches this, so a login whose
 * later stages fail still leaves this binding standing. That is the intended
 * outcome, not an accident — what this house IS does not depend on whether a
 * session was obtained from it.
 *
 * And it will not bump a live participation. `bumpParticipationInTx` always
 * advances the generation, and every mounted relation handle dies when it
 * does — `handleStillTrusted` compares against the generation it captured.
 * A house whose gate reopens, a repeated login, an owner takeover: all of
 * those reach here, and none of them is the owner leaving and coming back.
 * Only an absent or ended participation starts a new generation; an existing
 * one is left exactly where it is.
 */
export function commitRelationBindingInTx(
  db: HostDb,
  tx: HostDb,
  prepared: PreparedHouseTrust,
  opts: { readonly now?: () => number } = {},
): ActivateOutcome {
  const scoped = scopeChecks(db, prepared);
  if (scoped.refusal !== undefined) return { ok: false as const, refusal: scoped.refusal };
  const facts = scoped.data;
  const at = opts.now?.() ?? Math.floor(Date.now() / 1000);
  const committed = commitPreparedInTx(tx, facts, at);
  if (!committed.ok) return committed;
  const live = tx.queryOne<{ owner_generation: number; active: number }>(
    'SELECT owner_generation, active FROM relation_participation WHERE house_key = ?',
    [facts.binding.houseKey],
  );
  const ownerGeneration = live !== null && live.active === 1
    ? live.owner_generation
    : bumpParticipationInTx(tx, facts.binding.houseKey, true, () => at);
  return { ok: true as const, binding: facts.binding, ownerGeneration };
}

export function commitEstablishAndActivate(
  db: HostDb,
  prepared: PreparedHouseTrust,
  opts: { readonly now?: () => number; readonly firstPin?: ConfiguredFirstPinAttempt } = {},
): ActivateOutcome {
  // Only these finite configured first-trust paths rolls every combined refusal
  // back. Other trust paths retain their existing durable security outcomes.
  try {
    const participant = opts.firstPin ? takeConfiguredFirstPin(db, preparedRecords.get(prepared)?.data.binding.origin ?? '', opts.firstPin) : undefined;
    const scoped = scopeChecks(db, prepared);
    if (scoped.refusal !== undefined) return { ok: false as const, refusal: scoped.refusal };
    const facts = scoped.data;
    if (facts.intent !== 'establish') return { ok: false as const, refusal: 'HOUSE_PREPARED_MISMATCH' };
    const at = opts.now?.() ?? Math.floor(Date.now() / 1000);
    return db.transaction((tx) => {
      participant?.guard(tx);
      const committed = commitPreparedInTx(tx, facts, at);
      if (!committed.ok) {
        if (participant) throw new FirstPinRefusal(committed.refusal);
        return committed;
      }
      const ownerGeneration = bumpParticipationInTx(tx, facts.binding.houseKey, true, () => at);
      participant?.advance?.(tx);
      return { ok: true as const, binding: facts.binding, ownerGeneration };
    });
  } catch (error) {
    if (error instanceof FirstPinRefusal) return { ok: false as const, refusal: error.refusal };
    throw error;
  }
}

/**
 * The owner is adding this house. The one place a pin may come into existence.
 *
 * With a configured key this verifies against the owner's word. Without one it
 * is first contact: the key is taken from the response and that same response's
 * proof is verified under it, which proves possession and that these exact bytes
 * are bound to that key — it does NOT make the response an independent source of
 * its own authority. What carries the trust is the validated HTTPS fetch and the
 * owner's decision to add this origin.
 *
 * Nothing is written until the proof verifies, so a failed first contact leaves
 * no trace to clean up. For an add the owner can CANCEL, use `beginHouseAdd`
 * and the prepare/commit pair directly: the attempt handle is the cancellation
 * seam, and a prepared trust that is never committed is exactly a cancelled
 * add, with nothing to clean up.
 */
export async function establishHouseTrust(
  db: HostDb,
  origin: string,
  opts: EstablishOptions = {},
): Promise<TrustOutcome> {
  const attempt = opts.attempt ?? beginHouseAdd(db, origin);
  const p = await prepareHouseTrust(db, origin, { ...opts, attempt });
  return p.ok ? commitHouseTrust(db, p.prepared, opts) : p;
}

/**
 * Every reconnect, refresh and resume. Agrees or refuses; never pins.
 *
 * An origin nothing has trusted is refused here rather than adopted — that is
 * the whole difference between a first-trust step and everything after it.
 * The pin and the owner's generation are re-checked inside the commit's own
 * transaction: a slow house answering while the world moves is the case the
 * re-check exists for. A house the owner has LEFT is refused here too — the
 * pin stands, but nobody is home to confirm it.
 */
export async function confirmHouseTrust(
  db: HostDb,
  origin: string,
  opts: TrustedFetchOptions & { readonly now?: () => number } = {},
): Promise<TrustOutcome> {
  const p = await prepareConfirmHouseTrust(db, origin, opts);
  return p.ok ? commitHouseTrust(db, p.prepared, opts) : p;
}

export type SessionConfirmOutcome =
  | { readonly ok: true; readonly binding: VerifiedHouseBinding; readonly ownerGeneration: number }
  | { readonly ok: false; readonly refusal: BindingRefusal | string };

/**
 * A confirm that answers for a session: the binding AND the live owner
 * generation it verified, read in the SAME transaction as the pin check —
 * so a handle built from this result cannot be a splice of an old
 * confirmation onto a newer login.
 *
 * The gap this closes is the startup seam: confirm, then attach, read the
 * generation "now" — between those, another process's logout/relogin moves
 * the world, and the old flow would build a connection carrying the old
 * incarnation under the new generation. Here the generation comes out of
 * the verifying transaction itself; if the world moves between this commit
 * and the connection, `handleAt` on the returned generation finds nothing
 * to hand out, and the caller attaches no chain rather than a spliced one.
 */
export async function confirmHouseTrustForSession(
  db: HostDb,
  origin: string,
  opts: TrustedFetchOptions & { readonly now?: () => number } = {},
): Promise<SessionConfirmOutcome> {
  const p = await prepareConfirmHouseTrust(db, origin, opts);
  if (!p.ok) return { ok: false as const, refusal: p.refusal };
  const record = preparedRecords.get(p.prepared);
  if (record === undefined || record.db !== db) {
    return { ok: false as const, refusal: 'HOUSE_PREPARED_MISMATCH' };
  }
  const facts = record.data;
  const at = opts.now?.() ?? Math.floor(Date.now() / 1000);
  return db.transaction((tx) => {
    const committed = commitPreparedInTx(tx, facts, at);
    if (!committed.ok) return { ok: false as const, refusal: committed.refusal };
    const row = tx.queryOne<{ owner_generation: number }>(
      'SELECT owner_generation FROM relation_participation WHERE house_key = ? AND active = 1',
      [facts.binding.houseKey],
    );
    if (row === null) {
      // The tuple check above passed against the pre-network snapshot; an
      // inactive-or-absent row here means the world moved inside this very
      // commit window — refused, not spliced.
      return { ok: false as const, refusal: 'HOUSE_OWNER_MOVED_ON' as const };
    }
    return { ok: true as const, binding: facts.binding, ownerGeneration: row.owner_generation };
  });
}

/** Fetch and verify. Writes nothing; the caller decides whether to commit. */
async function prepare(
  origin: string,
  opts: TrustedFetchOptions,
  againstKey: string | undefined,
): Promise<TrustOutcome & { readonly manifestBytes?: Uint8Array }> {
  const fetched = await fetchTrustedManifest(origin, opts);
  if (fetched.status !== 'ok') return { ok: false, refusal: fetched.reason };

  const key = againstKey ?? claimedHouseKey(fetched.proofHeader);
  if (key === undefined) return { ok: false, refusal: 'MANIFEST_PROOF_MALFORMED' };

  try {
    return {
      ok: true,
      binding: verifyManifestProof({
        origin,
        rawBytes: fetched.rawBytes,
        proofHeader: fetched.proofHeader,
        pinnedHouseKey: key,
      }),
      // The exact bytes the proof was checked over, so a consumer composing
      // onto this boundary (the relation capability contract) parses the SAME
      // verified original rather than re-fetching its own.
      manifestBytes: fetched.rawBytes,
    };
  } catch (err) {
    return { ok: false, refusal: err instanceof ManifestProofError ? err.code : String(err) };
  }
}

function safeScheme(origin: string): string {
  try {
    return new URL(origin).protocol;
  } catch {
    return '';
  }
}

/**
 * The key a proof claims, read WITHOUT verifying anything.
 *
 * Only first contact may call this, and only to have something to verify the
 * same response against. Named so a future reader cannot mistake it for a
 * source of truth.
 */
function claimedHouseKey(proofHeader: string): string | undefined {
  if (!proofHeader) return undefined;
  try {
    const bytes =
      typeof Buffer !== 'undefined'
        ? new Uint8Array(Buffer.from(proofHeader, 'base64'))
        : Uint8Array.from(atob(proofHeader), (c) => c.charCodeAt(0));
    const key = popclaw.world.ManifestProof.decode(bytes).house?.houseKey;
    return key ? key : undefined;
  } catch {
    return undefined;
  }
}
