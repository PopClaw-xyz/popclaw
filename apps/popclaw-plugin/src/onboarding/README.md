# Onboarding responsibilities

`orchestrator.ts` owns the six-act lifecycle, legal stage transitions, the done
and gap ledger, passport issuance, errands and cadence. It composes one
`OnboardingDiscovery` per orchestrator instance.

`arrival-answer.ts` owns the synchronous naming answer policy: candidate picks,
confirmation, denial, replacement and retries. It reuses `name-answer.ts`, the
keyword tables and shared nickname validation; free text requires confirmation.
It returns a finite decision and whether the old pending name must be cleared.
The orchestrator reads persisted drafts, derives blind candidates in the current
answer language and executes the decision. Clearing old pending and writing its
replacement remain two separate writes with separate failure boundaries. Name
persistence, timestamps, signing, permissions and stage transitions stay in the
orchestrator and existing identity/namecard modules.

`discovery.ts` owns the material interaction shared by lantern and attune:
fetching and ranking a glimpse of the world, its capped and numbered batch,
Canvas presentation, expand/mark/meh feedback, taste persistence and reranking.
Changing a selection limit or a feedback rule belongs here. Copy and HTML
continue to use the existing briefing, lexicon and Canvas builders.

The state machine's drafts are the sole authority for answers. Discovery reads
and writes them through a narrow port; a lantern continuation carries the same
batch for the orchestrator to persist while entering attune. Discovery never
transitions the state machine. Its in-memory caches only re-narrate what this
instance has shown, with no I/O. Stopping and starting the same orchestrator
retains these caches; a new instance starts with empty caches.

Effect order is part of the interface contract:

- Lantern registers references before reading house facts and uploading Canvas;
  then it caches presentation, records done, persists drafts and presents.
- Attune persists taste, caches it and records done before reading the persisted
  batch. It caches the rerank and registers its new numbering before awaiting
  presentation. Its narrow `presentNext` continuation lets the orchestrator
  advance and present errand in the same reaction, with no extra await between
  successful presentation and the transition. The continuation never runs on
  presentation failure.
- Graduation taste cache hits return synchronously; only a cache miss is awaited.
  These scheduling boundaries matter when the next answer is already queued.
- Canvas and learned-write failures degrade locally. Taste persistence and
  presenter failures propagate, preserving effects already performed.

`discovery.test.ts` exercises this interface without a state machine or host.
`discovery-characterization.test.ts` exercises the orchestrator with real
persistent drafts and writes full replay evidence when `ONBOARDING_TRACE_DIR`
is set. The existing orchestrator tests cover the rest of the spine and passport.

`arrival-answer.test.ts` covers the naming decisions directly.
`arrival-characterization.test.ts` exercises `handleAdvance` and the registered
onboarding tool with real persisted drafts, including restart confirmation,
pending replacement failures and blind candidate language changes. Set
`ONBOARDING_TRACE_DIR` to capture complete text, draft JSON and ordered effects
for a baseline/candidate comparison.
