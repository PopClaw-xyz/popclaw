# Code owners and focused checks

Start with [Contributing](CONTRIBUTING.md) for setup and required checks.
The checks below supplement the full project checks.

For focused plugin changes, start with the owner below. Source and test paths
in this table are relative to `apps/popclaw-plugin`; run each command from
that directory (`cd apps/popclaw-plugin`).

| Responsibility | Owner | Focused checks |
| --- | --- | --- |
| Material collection rules | `src/newspaper/collect-materials.ts` | `pnpm exec vitest run --no-cache tests/unit/newspaper/collect-materials.test.ts tests/unit/newspaper/gather-collection-baseline.test.ts` |
| Candidate ordering, trimming and numbering | `src/newspaper/gather-materials.ts`, `src/newspaper/pick-issue.ts` | `pnpm exec vitest run --no-cache tests/unit/newspaper/gather-materials.test.ts tests/unit/newspaper/pick-floor.test.ts tests/unit/newspaper/pick-topup-floor.test.ts tests/unit/newspaper/numbering-stability.test.ts tests/unit/newspaper/candidate-id-continuity.test.ts` |
| Person item display | `src/newspaper/person-item-renderer.ts`, `src/newspaper/newspaper-style.ts` | `pnpm exec vitest run --no-cache tests/unit/newspaper/person-item-renderer.test.ts tests/unit/newspaper/render-newspaper-baseline.test.ts` |
| Page selection and layout planning | `src/newspaper/render-plan.ts` | `pnpm exec vitest run --no-cache tests/unit/newspaper/render-plan.test.ts` |
| Status next-step suggestions | `src/commands/status-next-steps.ts` | `pnpm exec vitest run --no-cache tests/unit/commands/status-next-steps.test.ts` |
| Gateway runtime slots, ports and consumer types | `src/runtime/gateway-runtime.ts` | `pnpm exec tsc --noEmit -p tsconfig.json` (compile-time assertions), then `pnpm exec vitest run --no-cache tests/unit/types/gateway-runtime.test.ts tests/unit/runtime/assembly/assemble-runtime-gateway.test.ts tests/unit/runtime/root-assembly-gateway.test.ts tests/unit/runtime/root-order-gateway.test.ts tests/unit/commands/wiring.test.ts tests/unit/runtime-contract.test.ts` |
| Onboarding discovery materials, feedback and taste | `src/onboarding/discovery.ts`; lifecycle and transitions: `src/onboarding/orchestrator.ts` ([responsibilities](apps/popclaw-plugin/src/onboarding/README.md)) | `pnpm exec vitest run --no-cache tests/unit/onboarding/discovery.test.ts tests/unit/onboarding/discovery-characterization.test.ts tests/unit/onboarding/orchestrator.test.ts` |
| Routing status presentation | `src/routing/status-line.ts` | `pnpm exec vitest run --no-cache tests/unit/commands/status.test.ts tests/unit/diagnostics/bundle.test.ts` |
| Arrival answer decisions | `src/onboarding/arrival-answer.ts`; persisted drafts, stages and identity authority remain in `orchestrator.ts` and its existing identity writers | `pnpm exec vitest run --no-cache tests/unit/onboarding/arrival-answer.test.ts tests/unit/onboarding/arrival-characterization.test.ts` |
| Confirmed invitation submission and receipts | `src/invite/submit-invite.ts` ([responsibilities](apps/popclaw-plugin/src/invite/README.md)); validation and confirmation stay at the entries; CLI completion stays separate | `pnpm exec vitest run --no-cache tests/unit/invite/submit-invite.test.ts tests/unit/invite/submission-characterization.test.ts tests/unit/tools/invite-tools.test.ts tests/unit/commands/invite.test.ts` |
| House material display | `src/newspaper/house-material-renderer.ts`; page placement remains in `render-plan.ts` and `render-newspaper.ts` | `pnpm exec vitest run --no-cache tests/unit/newspaper/house-material-renderer.test.ts tests/unit/newspaper/render-newspaper-baseline.test.ts` |
| L1 notification content | `src/notifier/l1-content.ts`; claim, authorization, staging, send, settlement and retry remain in `owner-notifier.ts` | `pnpm exec vitest run --no-cache tests/unit/notifier/l1-content.test.ts tests/unit/notifier/deliver-l1.test.ts tests/unit/runtime/house-notification-delivery.test.ts` |
| Feed carrier and row projection | `src/ingress/feed-item-projection.ts`; SQL, scans, cursors and unreadable-row policy remain in `world-feed-cache.ts` | `pnpm exec vitest run --no-cache tests/unit/ingress/feed-item-projection.test.ts tests/unit/ingress/world-feed-cache.test.ts tests/unit/ingress/world-feed-cache-tolerant-read.test.ts` |
| Approval presentation policy and layout | `src/host/approval-presentation.ts` ([presentation contract](apps/popclaw-plugin/docs/approval-presentation.md)); grants, frozen drafts and review verification retain their existing authority | `pnpm exec vitest run --no-cache tests/unit/host/approval-presentation.test.ts tests/unit/tools/send-draft-owner-gate.test.ts tests/integration/mcp-send-draft-approval.test.ts` |
| Local newspaper artifact storage | `src/host/local-newspaper-artifacts.ts`, through the type-only `src/newspaper/newspaper-artifacts.ts` port; publication stays in `publish-newspaper.ts` | `pnpm exec vitest run --no-cache tests/unit/host/local-newspaper-artifacts.test.ts tests/unit/newspaper/publish-local-master.test.ts` |
| Per-house relation reception | `src/social-graph/relation-house-registry.ts`; transport, timer and global sweep remain in `relation-host.ts` ([ownership](apps/popclaw-plugin/docs/relation-reception-ownership.md)) | `pnpm exec vitest run --no-cache tests/unit/social-graph/relation-house-registry.test.ts tests/unit/social-graph/relation-host-reception-characterization.test.ts tests/unit/social-graph/relation-host-recovery-capture.test.ts` |
| Author history success display | `src/tools/author-history-view.ts`; source resolution, observed IDs and failure paths remain at the tool entry | `pnpm exec vitest run --no-cache tests/unit/tools/author-history-view.test.ts tests/unit/tools/world-tools.test.ts` |
| House Guide lifecycle | `src/world/house-guide-context.ts`; join keeps its synchronous caller-owned transaction, runtime keeps the captured read gate and transport ([ownership](apps/popclaw-plugin/docs/runtime-architecture.md)) | `pnpm exec vitest run --no-cache tests/unit/world/house-guide-context.test.ts tests/unit/runtime/participation-entry.test.ts tests/unit/runtime/sessionless-retry.test.ts` |

### Three common changes

- **Add a normal tool or command:** change its domain `src/tools/*-tools.ts` or
  `src/commands/` handler and `buildSubcommands` wiring. Tools must also appear in
  `openclaw.plugin.json`'s static `contracts.tools` list. Add a new registration
  domain to `REGISTER_STEPS` only when needed. MCP reuses that same registration;
  roots need edits only for a new host capability or dependency. Check tool-list
  parity, registration order, command wiring and the relevant handler tests.
- **Change prompt injection:** start with `registerOpenClawPromptHooks` in
  `src/host/openclaw-prompt-hooks.ts`, then the relevant routing or notification
  owner. Keep every new throwing step before drain and keep drain/render/claim
  synchronous. Root slot assignment/reset stays in `index.ts`. Run the real-root
  prompt characterization and the focused hook tests. See
  [prompt sequence](apps/popclaw-plugin/docs/openclaw-prompt-hooks.md).
- **Add a shared resource:** start with `assembleRuntime` and its domain builder
  under `src/runtime/assembly/`, add narrow ports if needed, and wire success and
  failure cleanup plus both host adapters. Check both root/assembly suites and
  gateway ordering; preserve their distinct shutdown policies. See
  [runtime ownership](apps/popclaw-plugin/docs/runtime-architecture.md).

Keep checks through the real entry points when changing read order, async
stage transitions, numbering references or complete HTML output. Direct rule
tests do not replace that evidence: retain the relevant gather, command and
full-render tests alongside focused interface checks.
