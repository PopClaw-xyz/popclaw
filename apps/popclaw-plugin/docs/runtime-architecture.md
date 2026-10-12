# Client runtime ownership

The composition roots are [`index.ts`](../src/index.ts) for OpenClaw,
[`mcp.ts`](../src/mcp.ts) for stdio MCP, and [`main.ts`](../src/main.ts) for the
source CLI. `mcp-hook.ts` is a process entry, not a runtime assembly root.

## Shared resources

`assembleRuntime` in `runtime/assembly/index.ts` visibly sequences the private
core, feeds, relations, notifications, DM, onboarding and loops builders.
`runtime/assembly/ports.ts` declares their narrow host capabilities.
`gatewayRuntimePorts` and `mcpRuntimePorts` provide host-specific IO and policy.
`runtime/gateway-runtime.ts` remains the authoritative gateway slot/type surface.

To add a shared resource, change its domain builder, explicit assembly wiring
and success/failure cleanup. Add a port only if the host supplies a new capability;
then wire both host implementations. Check gateway and MCP assembly/root tests.
Do not reproduce resource construction independently in both entry points.

The OpenClaw root retains lazy ignition, process singleton adoption, slot
assignment/reset, full-only services, backup work sets and host shutdown.
Gateway and MCP intentionally differ in duty participation, service startup and
failure cleanup. Review `runtime/assembly/core.ts` and the root lifecycle tests
before changing cleanup order; do not unify these policies implicitly.

## Host adapters and domain owners

`host/openclaw-prompt-hooks.ts` owns the complete native prompt sequence; see
[the sequence and failure boundary](openclaw-prompt-hooks.md).
`notifier/owner-turn-context.ts` owns L2 delivery/pending presentation and context
composition. `host/openclaw-owner-approval-hooks.ts` registers native approval
hooks; grants and authorization remain in the existing approval seam.

MCP keeps a coherent protocol adapter in `mcp.ts`: stdio dispatch, lazy runtime
access, tool results and confirmation handling. Both hosts reuse
`registerPopclawTools`. A normal domain change does not require changing MCP
protocol dispatch or either composition root.

Different participation, generation, reader capture, public-read pins, renewal
settlement and transaction CAS checks remain separate policies. Legacy read
recovery captures configured trust once and rechecks it at recovery and CAS
boundaries. Sessionless queued actions retain their versioned capture envelope;
same-root mixed-version upgrade/downgrade constraints are not removed by this
ownership map.

## House login execution

`runtime/house-lifecycle/login-execution.ts` owns complete login operations:
connected-manifest refresh, discovery and intent capture, legacy restoration,
sessionless admission, and session ENTER/receipt application. Synchronous
history capture, pin rejection and receipt application keep their separate
checks; the IO awaits remain in their original sequence.

`HouseLifecycleManager` owns authority, logout fences, gates, renewal, leave
workers and shutdown. Login execution owns the current login flights and offers
synchronous cancellation. A flight only identifies the current cancellable
operation; it is not the set of work that shutdown must drain. The manager
tracks every unfinished login result alongside renewal and leave work, including
superseded operations. Old flight cleanup removes only its own identity.

The owner epoch is captured for each login. Stop/pause signals are read at the
original transport stages, so ownership reacquisition can use the new pause
signal without granting old work a new epoch. Fence release still checks the
captured fence identity and current authority. Login execution receives these
manager capabilities, not the manager or its mutable maps.

Sessionless binding, participation, Guide pointer and receipt commit in one
SQLite transaction. After commit, fence release and gate publication happen
synchronously, before settlement is awaited. The final availability result reads
the current gate after settlement. Ordinary relation refusal preserves any
security block written by its commit; sessionless refusal rolls back the join.
These policies remain separate.

Explicit owner login can also refresh a selected sessionless manifest without
changing its durable participation tuple. Its existing transaction rechecks the
captured participation, trust, configured pin, storage generation and path
permissions before committing the prepared binding. Background confirmation
only reuses that selection.

Persisted command results still participate in the strict sessionless retry
proof in `legacy-history.ts`. A new result field or error classification is not
merely a presentation change: review command persistence and history validation
together. Keep public-entry tests through the manager, runtime and command bus;
do not replace them with tests of private login stages.

## House Guide lifecycle

`world/house-guide-context.ts` owns declared Guide pointers, historical joined
backfill, body caching, pending contexts and recognition of actual complete
agent input. Reading or emitting a Guide grants no join or action authority.
`HouseRuntime` captures the public-read gate once and supplies transport at the
original read stages; its Guide methods remain compatible host facades.

Login execution records a joined Guide synchronously inside the existing
binding/participation/receipt transaction. Join replaces the pointer and clears
old body/delivery state; historical backfill only inserts a missing pointer.
Invalid JSON or URL parsing keeps the original transaction rollback and read
catch behavior. Delivery requires the exact current origin, operation sequence,
binding digest, Guide digest and complete body observed in actual host output.

## Configured first trust

`HouseRuntime` selects a typed configured-pinning policy before boot loops
start. Static mode issues a one-use attempt only for an untouched, configured
`op_seq=0` sessionless lane with readable local history and no existing pin.
`configured-first-pin.ts` snapshots the database, origin, configured key,
participation tuple and local cancellation epoch before fetching proof.
The proof/pin, read declaration, relation activation and conditional lifecycle
advance commit in one SQLite transaction. A refused advance rolls all writes
back. Old read and queued push captures remain stale; only independent new work
can capture the advanced generation.

Public-v1 mode issues a separate guarded proof/pin attempt. It neither seeds nor
advances lifecycle participation. Static refusal never selects this policy as a
fallback. The post-commit callback requests a rescan only; existing owner polling
and acquisition recover missed callbacks without receiving new authority.
Their existing sync observes durable tuple changes and emits a permission-free
hint through `HouseRuntime.observeParticipation`. The doorbell uses that hint
for at most one independent bootstrap pass when its startup pass was blocked or
canceled. It captures the current gate again; completed startup, stop, inactive
permission and network backoff suppress the wake. No new poller is added, and
the viewing signal's ordinary pacing remains unchanged.

A logout closes the local gate before persistence. Failed persistence keeps that
local fence active. Background recovery cannot clear it; a successful authorized
login can. The monotonic cancellation epoch still invalidates attempts captured
before the logout, even when the new login leaves the durable tuple unchanged.
Unbound managers retain their direct-login compatibility.

For domain owners and focused commands, start with [Contributing](../../../CONTRIBUTING.md).

## Ordinary social drafts

`tools/social-draft-lifecycle.ts` owns ordinary DM, external reply, native post
and feedback manuscripts: freezing, preview/output records, optional review
copies, retention, loading, checks, one-use consumption and submission. Tool
entries resolve their source and recipient, render the existing preview, then
complete the manuscript through one handle. `draft-send-plan.ts` builds the
ordinary send command once from that frozen material. Chat confirmation remains
with the agent in the original conversation; an ID conveys no authorization.

Installed local roots use `DurableSocialDrafts` in the private host database.
These manuscripts have no expiry or capacity eviction and never enter the
volatile callback table, including during a refused send. Persist only after
recording the final tool output. The conversation binding is captured after
awaiting ID allocation, and re-read after both send-time runtime awaits; this
preserves the existing Hosted scope boundaries. Loading verifies stored material; sending checks
the current conversation/invocation and the saved review copy directly. The
SQLite compare-and-set consumes before transport and removes the review copy
only for the winner. Unknown outcomes remain spent. A refusal before consumption
retains the manuscript and its review copy. The durable send uses the current
process signer, frozen nickname/route, and pinned House origin plus durable
operation/session/installation tuple.

Compatibility contexts keep the existing in-memory expiry, capacity, captured
House/action authority and egress. Entries capture the egress at the original
source-read boundary, before attachment validation or other awaits. Ordinary
compatibility sends resolve the current runtime and nickname later. Creating a
compatibility manuscript does not read boot data or invent a stored nickname;
durable save/load requires the pinned nickname to be present. Feedback
alone retains the callback from its command: that legacy primary-contact path
reads the contact's latest inbox relay at send time, whereas durable feedback
pins the declared House. This adapter preserves established behavior without
changing the DM command kernel. Invitation and House-entry confirmation remain
separate protocols in `draft-store.ts`.

Encapsulating only durable send would leave duplicate command builders and the
creation-time volatile bridge in place. A new root-injected store port would add
assembly changes without a new host capability. The lifecycle instead uses the
existing runtime/database and review-file dependencies; no root wiring changes
are required. Focused evidence includes the registered tool tests, real SQLite
restart/CAS/unknown-outcome tests and real stdio MCP draft/send tests. These do
not prove packaged installation or live-host delivery.
