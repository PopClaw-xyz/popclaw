# Invitation submission ownership

`submit-invite.ts` owns the submission transaction used by the slash command
and the confirmed `popclaw_invite` tool: initiate, record a task-id receipt,
launch its watcher without awaiting verification, then render the receipt.
The pending entry must exist before the watcher starts. A receipt without a
task id still renders and relies on the existing SSE notification path.
Watcher failures use the entry's logger callback (slash warn, tool info).

The interface accepts only the capabilities it consumes. Adapters keep method
receivers intact; do not pass a complete gateway or plugin runtime. Submission
errors propagate to the entry's existing error handling. Tracking follows the
receipt's task id independently of HTTP status, matching the existing paths.

Entries own platform/handle/proof validation, nickname defaults and sync or
replacement flags. Native preparation binds the latest account to the current
owner conversation. An ordinary posting acknowledgement submits once without
another preview; sync, replacement and nickname changes retain confirmation.
Preview must never resolve the runtime; nickname defaults are read at submission.

Native invite results always use the host's `content` array, including local
preparation, previews, errors and posted receipts. Skipping notice decoration
must not skip this conversion. Preserve `owner_action_required` until the outer
notification-route adapter has consumed it so a local preview cannot boot the
runtime. `invite-native-posted.test.ts` checks the actual pinned OpenClaw result
schema and the preparation-to-result-notification path with a simulated House.

`commands/invite.ts`, called by the public dev CLI, retains a separate protocol:
it logs CLI-specific instructions and awaits `/v1/profile` verification or a
poll timeout. It does not use the pending ledger, background task watcher or
formatted slash/tool receipt. Sharing that lifecycle would change its output,
completion timing and argument semantics.

Focused checks from `apps/popclaw-plugin`:

```sh
pnpm exec vitest run --no-cache tests/unit/invite/submit-invite.test.ts tests/unit/invite/submission-characterization.test.ts tests/unit/tools/invite-tools.test.ts tests/unit/tools/invite-native-posted.test.ts tests/unit/commands/invite.test.ts
pnpm exec tsc --noEmit -p tsconfig.json
```

The characterization snapshots were captured from both real entries and the
CLI command before extraction. They retain full receipt text and side-effect
order; only the process-global tool token counter is normalized. The watcher
launch is observed with an unresolved or rejected promise, while
`pending-invites.test.ts` exercises the real watcher and notification ledger.
