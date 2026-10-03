# Relation reception ownership

`social-graph/relation-house-registry.ts` owns one complete reception policy:
trusted attachment, source-to-slug attribution, held FIFO frames, retry debt,
resume/reset handling, departure reconciliation and terminal lifecycle state.
Change a frame-before-trust or per-House departure rule here and test the
registry directly. It has no timer, transport constructor or business drain.

`relation-host.ts` supplies the single schedule and retains this order:

1. Reconcile departures, then flush/retry held frames.
2. Drain all live sources together through `RelationWiring`.
3. Recover the DM ledger.
4. Start the relation resend sweep.
5. Start the follower announcement pass.
6. Start at most one snapshot recovery.

Each host-wide asynchronous sweep retains its own single-flight flag. The
optional duty-lease API still governs the same host lifecycle and sweep tokens.
`relation-reception.ts` remains the adapter used by resident roots; it does not
implement a second reception path.

## Boundary and state lifetimes

The registry takes concrete DB, wiring, fetch, clock and logger dependencies,
transport serial lookups, and a synchronous departure port. Its queries return
handles or captured recovery candidates, never mutable maps. The factory is synchronous, preserving the immediate
initial tick of an empty configuration. Legacy startup awaits each confirmation
of configured origins before the host constructs transports, then binds
each transport-assigned slug to that original confirmed handle. The follower
bridge and DM handover resolve attribution through `slugForHouseKey` after the
registry has been constructed.

The state deliberately has several lifetimes:

- Successful attachment installs handle, origin and reverse alias together,
  using the generation returned by trust confirmation.
- A requested origin survives refusal so held frames can cause a later retry.
  No held debt means no retry. Retry is single-flight per slug and uses the
  transport's existing reauthorization ladder.
- Held frames outrank a newly attached handle. A thrown commit keeps the head;
  a returned refusal consumes it. A 101st held frame throws to the transport's
  replay boundary. Direct attach flushes before returning; an asynchronous
  retry flushes after its confirmation settles.
- Retry success clears its failure streak and deadline. Direct attach success
  clears the refusal report and flushes, retaining the old streak/deadline.
- Explicit leave calls `handle.leave()`, removes the active handle, stops that
  stream and notifies listeners. Origin, reverse alias and pending/retry
  metadata remain. Observed trust loss removes the handle and active origin,
  without another durable logout. Neither path erases the registry wholesale.
- An observed departure callback can stop the host synchronously. Maintenance
  returns false immediately, before processing other departures or held debt.
  Explicit leave retains its existing captured-listener notification behavior.
- Stop is terminal for scheduling, attach and reset. Historical cached handles
  and queries retain their prior semantics; stopping is not a durable logout.

## Reset and recovery authority

A reset first checks terminal state and the current connection serial. An
external serial supplier returning `undefined` means there is no live
connection and rejects the reset. Without an external supplier, the legacy
owned-stream lookup may be absent and retains its compatibility behavior.
The pin/participation checks and durable gap write remain in one transaction.
An open gap suppresses resume even when a cursor still exists.

`recoveryTarget` selects the first matching handle/origin and checks current
trust. It is a candidate, not a permission token. The host still captures the
duty token and then the expected pin at the original sweep-start locations;
snapshot completion rechecks the captured generation and pin identity inside
its transaction. A later attached handle cannot replace the source of an
already running sweep. The gap store, ingress commit boundary and lifecycle
manager keep their existing protocols.

## Focused evidence

- `relation-house-registry.test.ts`: direct rules with real trust confirmation,
  wiring and SQLite; controlled commit outcomes and fetch delays.
- `relation-host-reception-characterization.test.ts`: fixed baseline snapshots
  of real host entry points, state, logging and host-wide effect order. Transport,
  trust confirmation and host-wide sweeps are controlled at their boundaries.
- `relation-host-recovery-capture.test.ts`: real host and snapshot recovery with
  the final page held across a generation/pin/reset/stop change, compared with
  baseline snapshots.

The existing reception, deferred-frame, recovery credential/visibility,
follower bridge, vertical chain and root assembly suites cover integration.
These are bounded structural-equivalence checks, not a full lifecycle security
audit or a change to existing leave/lease behavior.
