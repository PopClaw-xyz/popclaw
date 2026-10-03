# World interaction core composition

This document describes the plugin core integration boundary. It does not attest
that a production host, tool entry point, background model turn, or DM egress has
been connected. The core uses the existing contracts, HostDb, signer, G0 session
capture, captured resource gate, and bus-backed egress.

## Resource identity and construction

Create one resource for one full HouseBinding and actor. Reuse its exact HostDb
handle and policy objects for its lifetime. WorldPolicyRegistry constructs and
retains one WorldParticipation per participation ID and durably lists those IDs.
Do not reconstruct a policy on every callback: a storage failure also installs an
in-memory execution fence in that instance. Factories check database, origin,
house key, incarnation, actor, and participation bindings where applicable.

Construct the scoped receiver first, with closures for onWorldEvent/onState that
will delegate to the result consumers after composition. Its constructor performs
no network operation. Construct WorldReadiness with receiver.journal; create the
WorldPolicyRegistry and WorldReadStateAuthorityStore with that same readiness.
Create WorldOwnerActionAuthorityStore for the trusted operator entry point when
manual actions are supported. CreateWorldResultConsumers takes these objects and
subscriptionReceiver() returning the actual receiver. The function is exported as
`createWorldResultConsumers` from `src/world/world-interaction-consumers.ts`.

Create WorldActionClient with onResult/onProgress from those consumers, then
createWorldActionResultDelivery with the client and captured business gate. The
latter binds the client's consumer lifetime, including a pass entered through an
explicit command's gate. A control-read gate can persist verified results while
the house is disabled; it cannot run attachment consumers.

Create PrivateWorldMessages with the real signer/decryptor, full capabilities,
recipient identity and captured gate. createPrivateWorldDelivery uses that cache,
the same readiness, policyFor(id) backed by the registry's cached policy(id), and
participationIds() from the registry. The production decryptor must expose original
plaintext bytes; a string-only decryptor cannot authorize structured private data.

## Required adapter behavior

| Core input | Actual host adapter responsibility |
| --- | --- |
| ActionClient.captureSession | G0 captureSessionCommandContext: sessionId, decimal fence, installationId, original leaseExpiresAt in epoch seconds and captured command gate. The fence is the accepted house revision, not a local operation sequence. |
| ActionClient.push | Existing durable bus/egress; return preserved signedActionResultBase64 when present. HTTP success is not business success. |
| ActionClient.controlRead/readStatus | Explicit known-local-request read authorization and same-origin status transport. Disabled state does not start streams or invoke actions. |
| Consumers.subscriptionReceiver | Actual scoped receiver, with assertBinding and installSubscription. Missing receiver throws and retains result pending. |
| Private delivery.onConversation | Actual private conversation consumer, using the full-tuple idempotency key. Await its durable effect and throw on failure. |
| Private delivery.onPlain | Recovery of a previously cached message that now requires ordinary processing. Preserve originalText exactly through the existing inbox path. |
| Private delivery.onReceipt/onState | Optional private UI/read-model consumers. Receipts and states do not automatically enter conversation or owner notification lanes. |
| Autonomous supportsBackgroundTurns | Detect a real host turn API. A tool call, timer, fixture, or MCP transport is not proof of background model capability. |

Initial private `receive(rawEnvelope)` returns plain results to the existing G0
inbox flow; G0 should pass `{originalText}` into its shared verified inbox helper
to avoid a second decryption or changing empty/BOM-prefixed text. Structured
results are consumed separately before ordinary InboxStore/social-log/L1 logic.
Storage failures remain retryable failures, not plain fallback.

## Startup, stopping, and recovery

After callbacks are installed, invoke resultDelivery.drain() and
privateDelivery.drain() before accepting new ingress/commands. Start the scoped
receiver through the one public receiver/Ranger ingress owner. Result recovery
reverifies saved original signed bytes, saved capabilities/key, request identity,
and fresh-query-bound publication evidence. Results finish before their progress
is acknowledged. Private recovery reverifies original envelopes and current
capabilities. Callbacks are at least once and require idempotent durable effects.

Stop synchronously fences each resource. Outside its own consumer callbacks,
await resultDelivery.whenIdle(), privateDelivery.whenIdle(), and
receiver.whenIdle() after receiver.stop(), before closing the database. A consumer
may trigger stop but must not await its own quiescence. Start resultDelivery.drain
before exposing the client: its whenIdle joins passes adopted by that lifecycle;
an independently started parent pass must also be joined by its owner.

Pending result/private/stream consumers have one bounded retry timer each only
while work remains. They do not poll an empty acknowledged queue or mint new
business requests. Unknown delivery retains the original SignedPayload and all
reservation charges. Explicit retry uses those exact bytes; expiry uses status
reconciliation instead of extending the original action context.

## Authorization paths

Authenticated descriptors, snapshots, source IDs, guides, and suggested limits
are facts. They do not create owner grants or background jobs.

For autonomous work, reserve the actual model turn before calling the host:

1. `policy.reserveTurn({ jobId, turnId, opportunityIds,
   expectedCapabilityRevision, contextValidUntil }, nowISO)` returns
   `{ created, ticket }`. Only the committed `created: true` caller may launch
   one model turn. Exact retries/reopen return `created: false`, including after
   finish or expiry; they never authorize another model call. The ticket captures
   candidates, their original grant epochs, revision and bounded expiry. It
   persists dedupe and one local turn charge, plus each referenced descriptor
   turn pool once. It checks but does not charge message/notice capacity.
2. After every asynchronous boundary before launching that one model call, use
   `policy.authorizeTurn({ turnReservationId, jobId, turnId }, nowISO)` alongside
   the actual captured HostGate, capabilities, and readiness. It returns only
   still-valid captured routes; at least one is required. It never enlarges the
   original candidate set or grants and does not itself permit a second launch.
   Its `candidates` are prospective routes, not submitted actions. Missing or
   failed commit acknowledgment is never evidence that it is safe to relaunch.
3. For each actual model-produced invocation that passes trusted input/egress
   classification, call `policy.reserveAttempt({ turnReservationId, jobId,
   turnId, attemptId, invocation }, nowISO)`. The stable attempt ID belongs to the
   trusted host adapter. Use the original candidate's expiry bound (or shorter),
   never extend it after the model returns. Each kind, grant epoch, source,
   takeover, capability/descriptor revision, channel and budget is rechecked.
   The already occupied turn is checked without another charge. A decision uses
   zero message units; an outbound message/DM or notice reserves its own units at
   this attempt's time. A shared one-use reply slot permits one route only.
4. `createParticipationActionAuthority` then rechecks the actual intent
   reservation, capabilities and guide, client binding, readiness and real host
   support before each signing/send boundary. Request association and original
   bytes share the same HostDb transaction. DM/notice use their own real egress
   adapters with `authorizeReservation`. Exact attempt retries return their
   original identity and still require those send-time checks; they do not grant
   a new request or changed parameters. Unknown requests keep their original
   bytes and reservations.
5. `policy.finishTurn({ turnReservationId, jobId, turnId, outcome }, nowISO)`
   closes the local model turn. Outcomes are `no_action`, `invalid_output`,
   `model_failed`, or `completed`; none creates an ActionResult. No action or
   invalid/model failure still spends the turn and retains dedupe. Closing stops
   new attempts while preserving recorded attempts for original-byte recovery.
   It never refunds any charged units.

The ticket exposes `turnReservationId`, `jobId`, `turnId`, `windowId`,
`descriptorRevision`, `capabilityRevision`, `contextValidUntil`, `status`, optional
`outcome`, and prospective `candidates: ParticipationInvocation[]`; these are
detached read data. Internally frozen alternatives may include multiple grant
identities; regranting never refreshes their captured epochs. Invalid siblings
can be rejected while independently valid siblings proceed.

Legacy `reserveBatch`/`reserveNotice` remain for already-known invocations. They
share turn/job/dedupe exclusions with model tickets and preserve all old rows,
charges and tombstones. They are not a model-launch API. No terminal, unknown,
closed or failed model outcome refunds reserved units.

Cross-process queues must carry the original factory's immutable
`WorldActionAuthority.executionReference` alongside the linked request. The
local-only discriminated union is:

```ts
type WorldActionExecutionReference =
  | Readonly<{ kind: 'owner_action'; reservationId: string }>
  | Readonly<{ kind: 'read_state'; reservationId: string; participationId: string }>
  | Readonly<{ kind: 'participation'; reservationId: string;
      jobId: string; participationId: string }>;
```

These are lookup identities, never permission. Participation reservation IDs may
be canonical JSON strings, not opaque IDs or hex. ActionClient persists the
reference in `world_action_client_requests.execution_reference` in the same
transaction as the original signed request and authority association. It passes
that exact frozen reference in `push(bytes, { gate, requestId,
executionReference })`, and rejects reference substitution across awaits, request
collisions and retries. Existing databases gain a nullable column without changing
original bytes. A legacy request without a reference can still reconcile status;
it cannot be resent by guessing a grant from its request ID.

The queue owner must persist this reference and, immediately before actual HTTP
and after asynchronous boundaries, resolve the original authority against the
same database and complete house/actor binding. Resolve owner/read-state by their
exact reservation row; for participation use the named policy and reservation,
verify the original job ID, and use the stored invocation. Then verify the linked
request, original bytes/digest, exact input where required, current grants,
readiness/capabilities and actual HostGate. Never scan alternative authority stores
for a currently permissive match. A missing reference fails closed for actual
world egress. This local core does not implement the bus or owner HTTP checker.

For a read-only state refresh, the trusted owner explicitly grants
WorldReadStateAuthorityStore permission for a participation, kind, capability
revision, expiry, rolling frequency, and total ceiling. `purpose=snapshot` only
selects a candidate. reserve() produces a bounded authority; its record links the
request to the original caught-up anchor. A later reconnect cannot rebind that
same attempt to a newer replay generation.

For an explicit manual action such as first join, only the trusted operator
CLI/slash handler holds WorldOwnerActionAuthorityStore.reserve. Each call names
one stable job, the exact WorldInvokeInput, and an expiry no more than five
minutes ahead. The authority binds canonical parameters, capability revision,
actual actor/full house/database, and one permanent request identity. Tool JSON,
callId, sessionKey, and model-generated text cannot create this permission. The
store does not grant autonomous participation or general read-state permission.
Pass the store as ownerActions to result consumers so linked terminal receipts
settle its attempt.

Direct messages and owner notices require their own trusted host adapters using
policy channel, source, takeover, shared-response-slot, and quota checks before
each actual side effect. The intent authority factory does not itself implement
those egress lanes. A real host model run and those adapters remain integration
acceptance work; manual-only behavior must remain explicit if unavailable.

## State and readiness

Action business status, publication progress, stream catch-up, and snapshot
freshness remain distinct. Subscription installation cannot establish current
state. A checkpoint cannot activate policy. Readiness requires authenticated
publication coverage for each scope, the actual local log/generation, and a
successful authorized refresh matching that anchor and subscription digest.
Process restart cannot inherit another receiver instance's caught-up state.

A valid unscoped private state may establish current facts; it cannot bypass an
installed scoped subscription's publication/replay gate. Old descriptors,
attachment-free ACCEPTED/EXECUTING results, and unsuccessful refresh receipts do
not clear invalidation. An authenticated conflicting publication observation
halts the affected readiness/policy. Unauthenticated bytes are rejected before
selecting a policy to invalidate. Failures invalidate outside the failed facts
transaction, and memory fences remain if writing that invalidation also fails.

## Validation boundary

The delivered core passed the world unit suite (513 tests before the final two
receiver quiescence cases) and the final receiver/journal suite (66 tests). Narrow
independent reviews used real signatures, SQLite reopen/fault injection, live
receiver callbacks, and original failed cases. All reported core findings were
closed. Relevant final source/test files have no TypeScript diagnostics. The
implementation clone still has unrelated existing root/test type errors; this is
not a claim that its whole plugin typecheck passed.

G0 owns shared roots, the four generic tools, CLI/operator authorization, public
lane selection, host adapters, and actual end-to-end implementation acceptance.
Do not enable structured-private feature readiness or claim I from these unit
results alone. The handoff receipt contains exact final file hashes and commits.
