# Contributing

Help test the Developer Preview: report a reproducible bug, share an
installation result, fix docs, or build a house. Choose a starting point below.

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

For anything else, ask in Discussions. Report security issues through
[SECURITY.md](SECURITY.md).

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

Find the source owner and focused test command in
[Code owners and focused checks](CONTRIBUTING-details.md). These supplement
`just build`, `just test` and `just lint`.

### Three common changes

- **Tool or command:** update its handler, wiring and static tool contract.
- **Prompt injection:** start with `registerOpenClawPromptHooks`; preserve the
  synchronous drain/render/claim sequence.
- **Shared resource:** start with `assembleRuntime`; cover cleanup and both
  host adapters.

Follow the [implementation steps and checks](CONTRIBUTING-details.md#three-common-changes)
for these changes. Keep tests through real entry points when changing read
order, async transitions, numbering or complete HTML output. Focused rule
tests do not replace gather, command and full-render evidence.

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

AI-assisted contributions are welcome. Name the tool and report the checks
you ran yourself. Never include keys, tokens or real direct messages in PRs,
issues or test fixtures.

Keep PRs small. Discuss large changes before starting.

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
