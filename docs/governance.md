# Governance and protocol proposals

PopClaw is small and led by its creator. This page says how decisions get
made now, and how the wire protocol changes without breaking anyone's signed
history. It is deliberately light; it will grow when there are more people
to govern.

## Roles

- **Lead maintainer** decides. See [MAINTAINERS.md](../MAINTAINERS.md).
- **Maintainers** review and merge in their areas and can sponsor proposals.
- **Contributors** are everyone who opens an issue, a PR, a Discussion or a
  proposal. No membership, no agreement to sign.

## Everyday changes

Bug fixes, documentation, host adapters, tooling and user-facing features
in the client go through ordinary pull requests, reviewed by a maintainer.
[CONTRIBUTING.md](../CONTRIBUTING.md) covers expectations.

## Protocol changes: PopClaw Improvement Proposals

A change is **protocol-facing** if it touches anything in the pinned bundle
under `protocol/`: protobuf definitions, canonical encoding, signing
domains, stream membership, session semantics, fixed limits, or the vectors.
Those changes do not go through a pull request. They go through a proposal.

### Rules that are not up for proposal

1. **Additive only, in the precise sense of the
   [compatibility promise](compatibility.md).** Within a baseline: new house
   event kinds, endpoints and documents. Changing accepted envelope structure
   is a new baseline. Existing field numbers are never reused or
   reinterpreted; existing signed events stay valid forever.
2. **No wire version handshake.** A house declares the baseline it serves in
   its signed manifest and a client selects; unknown structure is rejected,
   not guessed.
3. **Vectors or it did not happen.** A proposal ships with test vectors that
   the TypeScript, Rust and Python reference codecs all pass.

### Process

1. **Discuss.** Open a Discussion in the Protocol category describing the
   problem. Not the field you want; the situation you cannot handle today.
2. **Draft.** Open an issue titled `PIP: <short name>` with these sections:
   motivation; exact wire changes (field numbers, kinds, domains); why it is
   additive; compatibility for old senders and old receivers; new or changed
   vectors; privacy and public-stream membership impact; a reference
   implementation plan.
3. **Implement.** The proposer or a sponsor implements it in the reference
   client and in at least one server. The reference server, PopClaw Ranger
   Map, counts as one; a server the project does not operate counts double
   in the argument.
4. **Accept.** The lead maintainer accepts when the rules above hold, the
   vectors pass in all three codecs, and two implementations interoperate on
   the change. Acceptance is recorded on the issue.
5. **Ship.** The change lands as a new pinned bundle version with an entry in
   the bundle's `CHANGES.md`. Clients pick it up on their next release.

A proposal can be declined for being non-additive, for adding privacy
exposure to the public lane, for lacking vectors, or because nobody needs it
yet. Declined proposals stay readable; the reasoning is the point.

## If the lead maintainer stops

The bundle, the client and the reference server are Apache-2.0. The last
published baseline stays valid forever: any signed event verifies without
the project's help, and anyone may continue the protocol from the bundle
and its vectors. The lead maintainer will name a successor or hand the
organization to the maintainers before stepping away; if that does not
happen, a fork carrying the bundle forward is the intended outcome, and the
trademark policy allows it to say so.

## Things this page does not cover

Trademarks and the licensing of the project's own code are decided by the
project's steward, not by proposal. The
[trademark policy](../TRADEMARK.md) says what everyone may do without asking.

## Changes to this page

By pull request, like any document. If the change alters who decides what,
the lead maintainer's approval is required.
