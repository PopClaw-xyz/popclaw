# OpenClaw prompt hooks

`registerOpenClawPromptHooks` owns the complete `model_call_started` and
`before_prompt_build` sequence. It accepts only the typed `on` surface, the
visible logger, lazy paths/configuration and current L2 slot readers. Registration
returns a routing verdict; the prompt handler returns host context fields or
`undefined`. These are different outputs.

## Sequence and failure boundary

1. Record the routing fire and read the current notifier without booting runtime.
2. Observe owner language, lazily resolve routing paths, load the house lexicon,
   read current routing configuration and build routing injection.
3. Find recent inbound attachments and compose their notice. Turning routing off
   still permits attachment notices and owner notifications.
4. Log routing outcomes and format the optional trace.
5. Determine owner-turn scope and read the current proposal, name and pending
   follow slots. All these readers run before drain.
6. Call `deliverOwnerTurnL2`: drain, render/requeue and claim remain synchronous.
   Non-owner turns leave the queue alone.
7. Call `pendingFollowsBlock`, whose independent catch preserves the L2 result if
   the pending read fails. Compose notice, L2, pending and routing context in that
   order, plus routing's system context.

Never insert an await between drain, render and claim. A new throwing passenger
belongs before drain: a transactional drain has already marked rows delivered.
The root assigns and clears optional slots as runtime enters and leaves its
lifecycle; the adapter must read them on the current turn, never at registration.
Only routing paths and per-registration announcement state are cached here.

## Current tool entry

The standing routing block explains how to reach a named capability through the
current host surface before presenting tool recipes. Direct tools remain direct.
OpenClaw code mode uses its existing JavaScript exec catalog and callable handles;
search mode uses the host's returned tool-call schema. The shipped social skill
uses the same entry and does not diagnose a missing plugin from flat names alone.
This changes guidance only: registration, tool policy, SDK owner context and the
ordinary manuscript confirmation path remain unchanged.

## Host rationale

The typed hook surface is `api.on`, not the host's internal `registerHook` table.
The historical #374 failure attached to the latter table, reported ready and
never fired. Language observation and attachment notices silently disappeared
with routing. Keep the registration verdict, fire counters and visible logger
lines so registration and actual calls can be distinguished. The adapter retains
partial registration: if prompt registration fails after budget registration,
the earlier budget handler remains attached, while routing becomes unavailable.

Budgets are synchronized by the host's verbatim session key. The default bucket
is the empty key; a dedicated newspaper workshop may use a different model from
the parent chat. A process-wide budget once let the last caller retune the other
session's trimming. Announcements are deduplicated by session and capped at 64;
budget synchronization continues beyond that cap. See
[`host-budget.ts`](../src/newspaper/host-budget.ts) for cap policy and diagnostics.

Trace formatting stays lazy. Counts and constants exclude attachment names and
third-party content. Optional owner-text sampling retains the existing
`POPCLAW_TRACE_TEXT` switch and truncation policy in
[`routing/trace.ts`](../src/routing/trace.ts).

## Checks

Run the real-root `prompt-build-hook-characterization.test.ts` for complete
context ordering, notification consumption, render/claim failures, routing off,
and slot freshness before/during/after boot. `openclaw-prompt-hooks.test.ts` covers
the new capability seam, registration failures and bounded budget announcements.
Root assembly/order tests continue to own startup, slot reset and shutdown proof.
