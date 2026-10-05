# Tool-result notification offers

Approved minimal first-release improvement. Preserve the accepted 341 artifact; affected verification produces a new successor candidate.

A successful deliverable PopClaw tool result may carry one extra text block containing at most three eligible queued L1/L2 notices. The automatic block contains notification IDs, levels/kinds and safe actor sigils, never message/reply bodies, links, attachment names or private paths. Its line is at most 180 Unicode codepoints and its entire UTF-8 text is at most 2048 bytes. Empty, explicit notification/ack/pings, error and owner-action/pending results carry no extra block. Notification failure retains the original business result.

One core `offerToolNotice` interface selects and renders notices. Canonical results pass through unchanged except for the appended text block. Native registration, local MCP and the hosted gateway each use a thin final-result adapter. House guides, captured parameters, command guards, onboarding nudges and approval URLs retain their existing behavior. Queued notices take priority over nudges even when their automatic presentation is cooling down.

## Presentation accounting and timing

There is no trusted host turn ID. Automatic offers use a durable **60-second per-consumer cooldown**, not a once-per-turn guarantee. Already offered items can repeat after 1800 seconds. Within existing L1/L2 priority, never-offered items precede repeats. Only the at-most-three displayed IDs acquire `offered_at`; unseen backlog remains eligible at the next 60-second window. Explicit notification queries are not rate limited.

The store's existing consumer receipts and one additive `notification_notice_state` table are updated atomically in the existing immediate SQLite transaction. Selection and rendering happen before the displayed IDs and gate are recorded. Failure rolls back the offer. A lost response may defer a repeated offer but never implicitly acknowledges, retrieves, resolves, marks pings read or confirms native delivery.

Hosted consumers remain OAuth connection scoped. Local MCP retains the configured consumer or its existing cwd fallback, so clients sharing that fallback share receipts and cooldown. Native uses `native:<existing identity key>` within the installation's identity database, not a per-chat identity. Native automatic presentation excludes delivered/in-flight native items; a later native push can still repeat an offered summary. That accepted two-leg limitation is not hidden with implicit acknowledgement.

Hosted `notifications.offer` is internal presentation bookkeeping authorized by the existing trusted read scope. Its supervisor registration and executor invocation both use the existing `popclaw_notifications` read policy, independently of the original business tool's write/files policy. It only offers; it does not invoke explicit notification fetching. It is not pure read-only. It neither cold-starts a worker nor fetches network/starts a House, and has a 250ms deadline. Current authority, storage holds and cancellation are checked before accounting is committed.

The shared success guard also recognizes the existing localized `failureText` return contract, whose legacy catch arms lack an `isError` field. These original failures pass through unchanged and do not consume an offer or gate.

## Scope and release

No notification admission/level changes, new background hook or no-tool ordinary-chat behavior. No files-scope repair, session-capacity change or show_pings read-state redesign. Native gains the existing explicit notifications/ack tools; MCP does not register duplicates. Hosted deployment, plugin upgrade and local bundle distribution remain separately authorized operations. No new runtime/package dependencies.

## Verification and remaining acceptance

Focused tests cover backlog/timing, independent SQLite processes, connection receipts, presentation rollback, bounded copy, canonical JSON/media, native object/factory/array registration through the pinned SDK, gateway-only successful dispatch, and error/pending/timeout preservation. Dots actual business call and assistant rendering, Muse targeted compatibility, and installed native/local checks remain post-deployment acceptance, not local-test claims.
