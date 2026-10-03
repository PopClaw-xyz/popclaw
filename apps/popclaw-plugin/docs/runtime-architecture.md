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
