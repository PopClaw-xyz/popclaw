# Contributing

PopClaw is a Developer Preview. The most valuable contributions right now are
reproducible bug reports, installation experience on hosts and platforms we
have not verified, documentation fixes, and worlds: LoreHouses you build and
show.

## Ways to help

| You want to | Do this |
| --- | --- |
| Report a bug | [Open an issue](https://github.com/PopClaw-xyz/popclaw/issues/new/choose) with host, OS, package version and the smallest steps that reproduce it. Remove keys, tokens, private messages and personal data from logs first. |
| Report a vulnerability | Follow [SECURITY.md](SECURITY.md). Not an issue. |
| Add a support-matrix row | Issue titled `Support matrix: <host> <os> <node>` with the package hash, versions, steps and result. See [docs/support-matrix.md](docs/support-matrix.md). |
| Fix docs or a small bug | Pull request. Pick a [good first issue](https://github.com/PopClaw-xyz/popclaw/labels/good%20first%20issue) if you want a known-good starting point. |
| Build a world | Start from [docs/build-a-lorehouse.md](docs/build-a-lorehouse.md), then show it in [Discussions](https://github.com/PopClaw-xyz/popclaw/discussions). Ranger Map application issues belong in [its repository](https://github.com/PopClaw-xyz/lorehouse-mvp/issues). |
| Change the protocol | Read [docs/governance.md](docs/governance.md) first. Wire-format changes go through a proposal, not a pull request. |
| Ask a question | [Discussions](https://github.com/PopClaw-xyz/popclaw/discussions), Q&A category. |

If you are not sure where something belongs, open it here and say so; we
will route it.

## Working on the code

For the available CLI, chat commands and agent tools, start with the
[command reference](docs/commands.md). It includes debugging steps, effects
and source entry points. Update both language versions when changing a command's contract.

```sh
just install    # pnpm install with a frozen lockfile, plus the pinned protocol toolchain
just build
just test
just lint
```

The plugin lives in `apps/popclaw-plugin`; its own README covers building a
bundle and packing a tarball for local install. The protocol bundle under
`protocol/` is pinned and digest-checked on every build: do not edit it, and
do not hand-edit generated code anywhere.

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

## Publication checks

The separate publication workflow checks private-source exclusions, unavailable
working-record references in Markdown, plugin TypeScript/SQL and workflow
YAML, tracked relative Markdown link targets and public commit links. Reproduce it from a full clone with Python 3.11 or newer:

```sh
python3 -B -m unittest discover -s scripts/tests -p 'test_publication.py' -v
python3 -B scripts/check-publication.py
python3 -B scripts/selfcheck-gitleaks.py --gitleaks /path/to/gitleaks
gitleaks git . --config .gitleaks.toml --log-opts=--all --redact=100 --no-banner
```

Use the Gitleaks version and official archive checksum pinned in
[the workflow](.github/workflows/publication.yml). Its exceptions cover exact
public test values at exact fixture paths. The self-check inserts synthetic new
secrets in every exception path and requires detection by two rules. Do not
replace those exceptions with exclusions for entire test or protocol trees.

These checks cover tracked content and fetched history. They do not check every
Markdown construct, anchors, live URLs, unpublished packages or the state of
remote repository settings. CodeQL results and Dependabot PRs arrive separately;
CODEOWNERS routes review but does not itself make review mandatory. Bundle
integrity and the existing release verification remain separate requirements.

## Pull requests

- Keep a change focused on one thing. Explain the problem and how you
  verified the fix; the PR template asks for both.
- Behavior changes come with a test. Put it next to the existing tests for
  that module.
- Match the surrounding style. Code, comments, commit messages and docs are
  in English. User-visible strings go through the lexicon, not hard-coded.
- Do not touch the pinned bundle under `protocol/` in a feature PR.
- If a check did not run, say so in the PR rather than guessing.

We welcome AI-assisted contributions. Say what you used, and include the
verification you ran yourself; a PR whose only evidence is "the model said it
works" will be sent back. Never paste a key, a token or a real direct message
into a PR, an issue or a test fixture.

Maintainers are few. Small, well-described PRs get reviewed first; large
unrequested rewrites may sit. If you plan something big, open a Discussion
before you start.

## Protocol-facing changes

Anything that changes bytes on the wire, signing, canonical encoding, stream
membership or session semantics is a protocol change. It is additive-only by
rule, it needs updated test vectors, and it ships as a new pinned bundle
version. [docs/governance.md](docs/governance.md) describes the proposal
process and the acceptance rule.

## How releases are cut

A release is a tag, an npm package and a GitHub Release, and it ships only
when its gate is met:

- The package is built from a clean checkout and published from a public
  workflow with npm provenance, so you can verify where a package came from.
- Installation and first-use results are recorded with their exact scope in
  the [support matrix](docs/support-matrix.md). Candidate checks, reused
  evidence and final-package checks are distinguished; missing coverage is
  not marked passed by combining separate runs.
- The protocol bundle digest is verified; generated code has no drift; the
  test vectors pass in all three reference codecs.
- The release notes list the package hash, the bundle version, the verified
  environments and the known limitations.

Patch releases (`0.1.x`) fix bugs and change no behavior you would notice.
Minor releases may change client-facing surfaces under the
[compatibility promise](docs/compatibility.md). The changelog notes, for
every entry, whether the wire protocol is affected.

## Licensing of contributions

By contributing you agree that your contribution is licensed under
[Apache-2.0](LICENSE), the same as the project. You keep your copyright. We
do not ask for a separate contributor agreement for this repository.

## Conduct

Be excellent to each other. [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) has the
short version and the reporting route.
