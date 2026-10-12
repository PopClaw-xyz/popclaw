# Declared summary read ownership

`src/world/declared-summary-read.ts` owns the foreground primary-House
summary workflow: read its guide, determine the summary declaration, and
prepare a normalized summary read only when that declaration is supported.
It uses the existing injected clients and the fixed endpoint rules in
`summaryDeclaration`; guide content supplies data, not permission to act.

`prepareDeclaredSummaryRead(guideClient, summaryClient)` returns one of:

| Status | Read facts |
| --- | --- |
| `supported` | The guide text and `read(windowHours?)`, returning `WorldSummaryResult`. Preparation does not fetch summary. |
| `unsupported` | The readable guide text, without a summary read operation. |
| `unknown` | No summary read operation. An unreadable guide retains its `HouseReadFailure`; malformed declaration data has no invented remote failure. |

Typed client methods take precedence over nullable methods, and are invoked
on their original client objects. A nullable read failure becomes
`HOUSE_REMOTE_UNKNOWN`. Rejected reads preserve local refusal and remote
failure classifications through `houseReadFailure`. Guide method throws are
classified too. A synchronous summary method throw still propagates before
companion reads start, matching the existing foreground entries.

The registered `popclaw_world_summary` tool, onboarding's
`OnboardingDiscovery.presentLantern`, and the newspaper's optional summary
reference use this operation. The tool wraps its summary read in request and
connection-scoped `SummaryReadReuse`, retains the complete published snapshot,
and does not fetch a companion sampled feed. It preserves the shared ten-second
read budget, cache freshness metadata, explicit retry policy and final source
and input-currentness checks.

Onboarding still invokes summary before snapshot in the same `Promise.all`, so
neither read waits for the other. Snapshot rejection falls back to an empty
sample. On summary failure it presents the existing retry notice and persists
`degraded`, retaining its previous card cache. Unsupported onboarding still
presents the House guide and persists `unsupported`.

The newspaper captures its source generation before preparation and rechecks it
before and after summary and rendering. Preparation and reading share the
optional 1.5-second budget. A failed or unsupported reference remains absent;
it does not block signed article collection. Its frozen snapshot identity and
statistical times remain separate from the cached-read freshness times.
Formatting, ranking, drafts and stage transitions retain their existing owners.

Preparation retains declaration evidence for that operation. It adds no
result cache, deduplication, retry or authorization snapshot: every `read`
invokes the injected summary client again. Client transport, timeout and
current read gates remain in their existing owners. This workflow does not
implement ETag or conditional requests; the separate House Guide lifecycle
and transport ownership is described in
[runtime architecture](runtime-architecture.md).

Focused domain tests cover declared-read availability, typed and nullable
clients, method binding and failure facts. Registered tool and onboarding
orchestrator tests retain the real entry behavior, deferred read barriers,
complete presentation, cache replay and ordered effects. See
[focused checks](../../../CONTRIBUTING-details.md).
