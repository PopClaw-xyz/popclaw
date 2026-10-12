# Approval presentation contract

`host/approval-presentation.ts` is the side-effect-free home of the display
budget, finite draft content policies, layout metrics and shared terminal-width
measurement. It imports neither a backend nor a draft store.

The approval seam passes `ApprovalDialogProfile` to `descriptor.describe`.
`askOwnerApprovalBeforeDispatch` accepts a trusted backend profile; native hooks
and direct draft-description calls default to `NATIVE_APPROVAL_PROFILE`. Tool
parameters never select a profile. A descriptor's `displayBudget` replaces only
`profile.budget`: the backend's content policy and layout remain intact. In
particular, a world subject retains its native numeric cap when called over MCP.

| Policy | Existing behavior |
| --- | --- |
| `preview-or-transcript` | Prefer the whole draft; otherwise use its recorded preview or tool transcript. Preserve the optional folded alternative and seam screening. |
| `whole-or-bound-review` | Use an already-recorded bound review when needed; otherwise show the whole draft or refuse with the existing reason. Never create a review copy during description. |

Budget measures resource size (`descriptionMax`, `unit`, `maxLines`); it carries
no content-policy flag. The native preset retains 496 code points / 32 rows, and
MCP retains its rendered UTF-8 resource ceiling. Both initially use the existing
64-column rows, 72-column first line, 80-column confirmation description and
five-row transcript pointer. Changing these dimensions requires checking both
native and MCP output, including header wrapping and escaped body atoms.

## Review copies have a separate fixed compact policy

`needsReviewCopy` uses `COMPACT_DRAFT_REVIEW_POLICY`, independently of the asking
backend or a subject budget override. Mint (`withDraftReview`) and ask share that
predicate, and ask evaluates it in the language stored at mint. Changing this
compact policy is a behavior change, not a backend layout adjustment.

Description reads the frozen draft; it does not create files or re-hash them.
The existing `beforeAsk` guard verifies the recorded review copy immediately
before approval, and the send body checks again after approval. File contents
never replace the frozen draft. Digest versions, token/TTL/session rules, origin
guards and consent are outside this presentation contract.

## MCP request lifetime

`host/mcp-confirmation-lifecycle.ts` owns active request leases for both MCP
adapters. The MCP root constructs one owner, injects it into both adapters,
forwards protocol errors to it and stops it before draining the runtime.
Transport close also stops that owner. A tool cancellation ends only its lease;
an adapter stop ends its lane; root shutdown ends both lanes. Ending the general
adapter now cancels an already open form, rather than waiting for its deadline.
The general MCP wrapper also binds ledger consumption to its live request: an
answer accepted before cancellation cannot authorize a body that consumes it
after cancellation. Native records have no MCP lease and retain their existing
behavior. Completed SDK forms detach cancellation forwarding, so ending a later grant
lease does not send a cancellation for an answer already received.

The general adapter still describes its registered subject before asking and
records the answer in the subject ledger. World still captures the complete
input, performs its local duplicate lookup before building the form, and binds
its grant to that input and callback lifetime. Its subject remains native-only;
MCP World dispatch asks once inside its existing invocation adapter. Sharing
request ownership does not merge these domain authorization records.

The general dialog keeps its own deadline and the SDK backstop 60 seconds
later. World keeps the SDK deadline. Window settings, World grant TTL, display
budgets, strict literal `confirm === true`, refusal codes and rendering are
unchanged. Late-answer reporting retains its existing conservative attribution:
only the general adapter's own closed windows are remembered; an ambiguous or
unmatched orphan is unattributed and never grants authority.

## Verification

`tests/unit/host/approval-presentation.test.ts` exercises policy/size independence,
real MCP subject-budget resolution, ignored parameter spoofing, each layout
metric and mint-language boundaries. Existing owner-gate, native/MCP seam,
authorization and MCP integration tests remain the sending/consent evidence.
Full text/schema differential captures belong to the fixed-candidate evidence;
mock clients and local test relays do not establish live host rendering.
