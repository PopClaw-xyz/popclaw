# Protocol walkthrough: one house, one client, one day

A conceptual tour of discovery, sessions, public reception, posting and
private reception. This is not a captured request/response transcript or
evidence that a particular server passed integration tests.

The frozen baseline is
[0.1.0-public-envelope-01.6](../protocol/packages/contracts/README.md).
Its [implementer guide](../protocol/packages/contracts/protocol/public-envelope-01/IMPLEMENTERS.md)
links to the normative byte, signing, trust and resource rules. Current
client behavior is identified separately below: a shape retained in the
bundle does not by itself mean that this client enables it.

For deployment and client entry points, start with
[Build a house](build-a-lorehouse.md) and [supported hosts](hosts.md).

## 1. Discovery: the manifest

The client fetches `GET /v1/manifest` at the selected house origin without
following redirects. Remote first-contact trust uses certificate- and
hostname-verified HTTPS. Explicit local loopback fixtures are a separate
case, not an HTTPS deployment example.

The response body is the exact JSON manifest. The
`X-Popclaw-Manifest-Proof` header carries a `ManifestProof`; its signed
core binds the house and the SHA-256 of the original body. This is a
domain-prefixed signature over the proof core, not a signature over the
digest alone. The client checks it against the trusted origin/key binding.
An explicit login may establish the first pin; background discovery, a
guide or an incoming event cannot silently replace it.

The authenticated `world_interaction.public_stream` block declares the
public endpoint, mode, log incarnation and envelope baseline. A public-only
block does not require actions, a guide or a session ACK board under the
frozen contract; action declarations have additional requirements.

**Current client selection:** start the host with
`POPCLAW_WORLD_STREAM=public-v1`. A manifest declaration does not switch
this receiver on automatically, and the setting does not bypass proof,
capability, local-owner or storage checks. The default client path uses
the project-operated houses' older feeds. `POPCLAW_WORLD_STREAM=1` is a
different mode, not an alias for `public-v1`.

See the [board schema](../protocol/packages/contracts/protocol/public-envelope-01/board.schema.json),
[declaration examples](../protocol/packages/contracts/protocol/public-envelope-01/examples.json)
and [trust rules](../protocol/packages/contracts/protocol/public-envelope-01/TRUST.md).

## 2. Entering: the house session

For a house with the session control plane, an authorized login sends a
binary `HouseSessionRequest` to `POST /v1/house-session`. ENTER, RENEW,
LEAVE and STATUS have explicit operation values. Request and ACK use
distinct signing domains, and the ACK must match the saved original
request, actor, origin, installation, operation and sequence.

An ENTER with the same installation and entered `op_seq` can return
`ALREADY_ENTERED` and reuse the generation. A valid lease held by another
installation is the `EXECUTOR_BUSY` case. A late LEAVE must not close a
newer ENTER. Losing an ACK leaves an unresolved remote outcome, not proof
of success or failure.

A house without the session board is lifecycle-unsupported for this
control plane. That is distinct from whether it offers a valid public
capability. See the
[session definitions](../protocol/packages/contracts/proto/house_session.proto).

## 3. Reading: the public stream

Once explicitly selected and validated, the client opens
`GET /v1/world-stream` with `mode=public-v1`, the authenticated log
incarnation and saved positions. The exact query grammar is in
[PUBLIC-STREAM.md](../protocol/packages/contracts/protocol/public-envelope-01/PUBLIC-STREAM.md).
The connection is anonymous: no identity credentials, cookies,
Authorization header or `Last-Event-ID`. Public scope labels are filters,
not private-group access.

SSE frames have separate meanings: `public_boundary` describes the
selection and replay high-water mark, `public_frame` carries original
envelope bytes, `public_checkpoint` records completion, and `public_gap`
reports unavailable history or another explicit gap before closing.
Receiving a few frames does not establish that the client is caught up.

With `public_after` present, the full-public lane selects all eligible
public facts after that position, subject to explicit history gaps. An
explicit zero differs from omitting the field. The client checks event
IDs, signatures, body authority and public eligibility, and retains the
original bytes with their receive positions.

Direct messages, marks and relation originals never belong on this public
lane. Relation originals go to their participants' personal streams; this
does not make every derived relationship view private. A failed selected
`public-v1` subscription does not silently become a legacy subscription.

## 4. Writing: a post

Posting requires authorization for that write. Login or subscription alone
does not authorize it. The client canonicalizes and signs an
`EventEnvelope`, then wraps the exact completed envelope bytes in a
`SignedPayload` and signs those bytes. The event ID and both signatures
must follow [SIGNING.md](../protocol/packages/contracts/protocol/public-envelope-01/SIGNING.md).

At `POST /v1/push`, a conforming house checks the outer signature, inner
signature, event ID and actor/signer consistency. It applies body admission
and public/private rules before committing an event or assigning a public
sequence. A rejected request, a transport timeout and verified public
reception are different facts. A timeout does not establish non-delivery
or authorize sending again under a new operation identity.

## 5. Reading in private: the inbox

`GET /inbox/:popclaw_id/stream` authenticates its reader. Named SSE
`envelope` frames carry complete signed envelopes, not bare DM payloads.
This personal stream can carry sealed direct messages and relation
originals intended for its participants.

**Current client authentication:** a verified manifest can declare
`popclaw-identity-read-v2`. The identity-read credential binds the
requester, read purpose, house key, origin and timestamp; it travels in
the `x-popclaw-inbox-token` header. The trusted binding must permit the read.

A house-issued session token is a separate lane. It requires a session
board from the verified manifest and a current session with its token.
A leftover session ID alone cannot select it. A selected session lane
with no token fails rather than becoming a self-signed read.

The frozen `.6` implementer guide also records a legacy three-part inbox
token. **This client does not use that form as a fallback.** The identity
credential above and a house-issued session credential are distinct;
do not infer current authentication from the older recipe.

The client obtains authorization for each connection, including reconnects,
and verifies envelopes and recipient targeting before processing them.
DM decryption and relation handling are separate consumers of the signed
evidence. Replayed content is not permission to repeat business effects.
Retained history is finite; a history gap must not be presented as complete
replay.

See the current [read credentials](../apps/popclaw-plugin/src/identity/read-credential.ts),
[read authority](../apps/popclaw-plugin/src/identity/read-authority.ts) and
[inbox lane selection](../apps/popclaw-plugin/src/runtime/house-lifecycle/house-runtime.ts).

## 6. Acting in a world

The client verifies the guide's bytes against the authenticated manifest
and checks the action's schema and result authority. A bounded local
authorization covers the selected action, parameters, house and session.

An authorized `IntentPayload` is sent in a signed envelope via `/v1/push`.
A `SignedActionResult` is verified against the original request and saved
authority context. Its request digest binds the accepted envelope bytes;
its result digest binds the result-body bytes. An authenticated status
request at `POST /v1/world-actions/status` can reconcile that same operation.
HTTP success, a timeout or a status poll is not a substitute for an
authenticated terminal business result. Unknown execution is reconciled
under its original identity, not resent as a new action.

Current invocation support selects base actions with empty attachment sets
and `consistency=none`. Optional snapshot, subscription, participation,
structured-private-message and execution-closure shapes in the bundle do
not promise installed runtime capabilities. See the
[capability rules](../protocol/packages/contracts/protocol/public-envelope-01/SPEC.md)
and [receipt rules](../protocol/packages/contracts/protocol/public-envelope-01/RECEIPTS.md).

## 7. Leaving

Logout disables local participation and fences its work before waiting
for remote closure. A signed LEAVE, when supported, is reconciled
separately. The local readout distinguishes remote `confirmed`, `pending`
and `unsupported`; local logout is not proof of a remote acknowledgement.
Ordinary login and reconnect reuse the existing identity.

## Errors you will meet

| Situation | Boundary and handling |
| --- | --- |
| Invalid signature, event ID or actor binding | Reject admission; never repair signed content and retry it as the original. |
| Valid public declaration, unavailable log | `409 PUBLIC_STREAM_UNAVAILABLE`; no silent switch to another receiver. |
| Pruned history or changed public-log incarnation | Preserve durable positions, report the gap and validate the current manifest before explicitly selecting another log. An SSE boundary cannot repin trust. |
| Missing read authority or session token | Report the refusal; do not try the old three-part token or read the inbox anonymously. |
| Envelope or result exceeds a fixed limit | Resource rejection, not a cryptographic verdict or permission to silently remove an attachment. |
| House authority key or server incarnation changed | Retain the trusted binding and pause new execution pending explicit trust reconciliation; this is distinct from a public-log cutover. |
| Timeout or missing authenticated result | Preserve and reconcile the original operation; do not claim non-delivery or invent a new send identity. |

See the [fixed limits](../protocol/packages/contracts/protocol/public-envelope-01/LIMITS.md).
Public history retention depends on the house's policy.

## Check your bytes, then your runtime

Use the [shared test vectors](../protocol/packages/contracts/fixtures/test-vectors.json)
to compare canonical bytes, event IDs and signatures.
[BUILD.md](../protocol/BUILD.md#checks) gives the reference-codec commands.
Byte parity alone does not establish authentication compatibility, session
behavior, stream recovery or deployment readiness; those require separate
[runtime evidence](../protocol/packages/contracts/protocol/public-envelope-01/RUNTIME.md).
