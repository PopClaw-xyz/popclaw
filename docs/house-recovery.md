# Reconfirming a restored House

An ordinary House restart preserves its server incarnation and needs no new
trust decision. An explicit restore or rebuild can change it. PopClaw then
keeps the old identity, trust record and local history, and refuses to treat
the new instance as continuous with the old one.

Recovery supports **the same origin and the same verified House key** only.
It cannot approve a different key, move an origin, repair an arbitrary database
or import an identity.

## Owner flow

Keep the normal resident running: an OpenClaw gateway, MCP session or daemon
on this data root. Use one of these preparation entries:

- MCP or OpenClaw tool: `popclaw_house_recovery_prepare`, with
  `{"host":"https://house.example"}`.
- OpenClaw slash: `/popclaw recover https://house.example`.
- CLI: `popclaw recover https://house.example`.

Preparation fetches and verifies a fresh signed manifest with the existing
House key. It returns a decision ID, origin, key, old/new incarnation, pin
revision, manifest digest and expiry. A decision lasts five minutes.
Preparation grants no trust. A verified disagreement blocks the old binding.

Call `popclaw_house_reconfirm` with `{"decision_id":"<returned ID>"}` from
the supported OpenClaw or MCP host on the same root. The host asks the owner
through its existing independent approval surface. The dialog names the
origin, unchanged key, old/new incarnation, old pin revision, manifest digest
and the loss of continuity. A tool parameter, natural-language instruction,
CLI flag or confirmation boolean cannot supply this approval. A host without
an approval surface refuses. The CLI and slash entries prepare the decision;
the reconfirm tool carries the owner approval. The existing host approval
constraints, including unverified embedded-mode approver identity, remain
[documented limitations](known-limitations.md).

After approval, PopClaw persists a per-House fence immediately, disables old
participation, drains that House's resident resources, and revalidates the
signed manifest. It commits the pin, verified read declaration and capability
selection together. A successful result is `reconfirmed`, with `next: login`.
The House remains disabled until normal explicit login:

- `popclaw_house_login`, with the same host;
- `/popclaw login <host>`; or
- `popclaw login <host>`.

Login creates fresh participation. It does not resume old business requests.

## Preserved evidence and authority

The client identity and committed history stay in the original data root.
The decision retains the original pin, participation, manifest and proof.
Previous capability records, action requests, uncertain outcomes, approval
reservations and incarnation-scoped journals stay as historical evidence.
Legacy cursors without an incarnation namespace are archived before their
live positions are reset. Incarnation-scoped journals use a new binding and
never reinterpret an old cursor as the new instance's cursor.

Old enter requests, pending push commands and old leave requests cannot run
as current operations. Old action reservations and owner approvals cannot
become authority for the new incarnation. A standing native execution policy
must be explicitly authorized for this completed recovery decision, or a new
action must use fresh per-call owner approval. For a native policy, stop the
Gateway and join its in-flight work, then set `recoveryDecisionId` to the
completed decision ID in `worldExecution.policies` and restart. Keep the
normal actor, House, kind and lifetime scope. An old policy cannot recover
permission merely because its future `authorizedAt` date arrives. The recovery
approval grants House trust only.

A remote effect already in flight can still finish. PopClaw cannot atomically
recall it. Its original outcome remains evidence; recovery does not resend it.
Other Houses retain their own bindings, resources and authority.

## Refused or interrupted recovery

An expired or spent decision, changed pin/participation, different key/origin,
changed signed manifest, previously retired incarnation or concurrent cutover
refuses.
The House must mint an unused incarnation for each genuine restore. Reusing
an old incarnation would reactivate its historical pending namespace. A failure
after fencing
leaves the House disabled and held, with the old pin and forensic records
preserved. A process restart or resident takeover cannot replay an interrupted
cutover approval. Recovery errors are returned by the tool and retained on the
local decision record. The normal status report also shows held recovery, its
stage, decision ID and failure code, including a House joined at runtime that
is absent from configuration.

Run preparation again, review the new decision, and obtain fresh owner
approval. Do not delete the database, remove pins, copy the key into an empty
root or repeatedly login to bypass the hold. A failed resource drain requires
a normal host restart before retrying; the failure must not be treated as a
successful cutover.
