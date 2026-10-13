# Support matrix

## Current verification scope

<a id="013-release-verification"></a>
### 0.1.3 release verification

[Release v0.1.3](https://github.com/PopClaw-xyz/popclaw/releases/tag/v0.1.3)
fixes source `3a7ce5843152d1a94dd82244b0f3e267509fcf14`.
[Source CI](https://github.com/PopClaw-xyz/popclaw/actions/runs/38440928481)
passed on Node 24.16.0 and 26.1.0, including 624 test files per line,
10,279 passed tests and five skipped private-monorepo-only checks.
Build, lint, 42 setup checks and the two native SDK suites passed on each line;
[CodeQL](https://github.com/PopClaw-xyz/popclaw/actions/runs/38440928476) and
[publication checks](https://github.com/PopClaw-xyz/popclaw/actions/runs/38440928304)
also passed. Earlier local full-suite failures remain recorded; the two affected
files passed a 119-test serial rerun, without establishing their failure cause.

Both [popclaw@0.1.3](https://www.npmjs.com/package/popclaw/v/0.1.3) and
[popclaw-mcp@0.1.3](https://www.npmjs.com/package/popclaw-mcp/v/0.1.3) were
downloaded and matched the retained build archives. GitHub Release assets match
the same bytes. npm signatures and GitHub provenance were cryptographically
verified, including rejection of modified payloads.

| Archive | SHA-256 |
| --- | --- |
| popclaw-plugin-0.1.3+2026-10-14-0157-3a7ce58.tgz | `d18c5b8fae1ac2dfe6ef086d5fb634ac51f4caa95c24b7a108b395f62f1db94e` |
| popclaw-mcp-0.1.3.tgz | `3d595e59af14212fd2574cc8f43c9468f4bd082717a216b70f0e9fa2a7e1a14a` |

The main archive has 226 files, 15,392,666 compressed bytes and 38,199,870
expanded bytes (36.43 MiB). All 96 native files, including 11 binaries, and 58
license/notice files match the 0.1.2 archive. The shared JavaScript import graph
is complete. Full native-matrix packaging checks passed; this does not mean
all target platforms were run.

A clean npm installation with npm 11.19.1 verified all 226 main-package and six
MCP-shell files. CLI, SQLite, OpenClaw 2026.9.8 SDK registration of 55 tools,
both MCP entries and stable identity across restart passed on macOS arm64 with
Node 24.16.0 and 26.8.2. Bin symlinks, hook and maintenance entries also passed
against the exact archives. Independent artifact and registry reviews approved
these results. Full Gateway, model conversations, real social delivery and other
operating systems were not tested in this release acceptance.

The [original release run](https://github.com/PopClaw-xyz/popclaw/actions/runs/38440988276)
published the main package. The [shell recovery](https://github.com/PopClaw-xyz/popclaw/actions/runs/38443366708)
published the original retained MCP archive without rebuilding. Both runs failed
when their short registry-readiness checks expired. A subsequent download also
briefly returned 404 after metadata appeared. Later byte, cryptographic and
installation verification passed; the workflow failures remain failures.

ClawHub static validation against OpenClaw 2026.10.3 and the publish dry run
passed. The actual upload reached storage, but the publication endpoint returned
HTTP 500 without a publish-attempt identifier. ClawHub publication, download and
installation remain unverified as of October 14, 2026. Use npm or the GitHub
Release assets; no ClawHub availability is claimed.

### Earlier release evidence

0.1.0 is published: [Release and artifacts](https://github.com/PopClaw-xyz/popclaw/releases/tag/v0.1.0).
Its recorded registry acceptance covered ordinary installation, exact files,
signature/attestation audit, SQLite, 55 MCP tools and restart. This does not
establish every host feature or transfer acceptance to a newer package.

For 0.1.2 source `22dae896fe188df4e26241996f4e40902785f274`,
[CI](https://github.com/PopClaw-xyz/popclaw/actions/runs/38267017008),
[CodeQL](https://github.com/PopClaw-xyz/popclaw/actions/runs/38267017016) and
[publication checks](https://github.com/PopClaw-xyz/popclaw/actions/runs/38267016939)
passed. Three fixed-local-candidate OpenClaw samples produced published papers;
two delivered in the original batch, and a separate later request on the third
host delivered after a notification-target adjustment. See the
[changelog for timings and limits](../CHANGELOG.md#012).
These local-candidate observations do not transfer to every channel, Windows or
every supported host. No new blanket support claim is made.

### 0.1.2 npm verification

Both [popclaw@0.1.2](https://www.npmjs.com/package/popclaw/v/0.1.2) and
[popclaw-mcp@0.1.2](https://www.npmjs.com/package/popclaw-mcp/v/0.1.2) were
downloaded and matched the original CI archive bytes. Signature/provenance
verification, including rejection of modified payloads, passed for source
`22dae896fe188df4e26241996f4e40902785f274`.

| Archive | SHA-256 |
| --- | --- |
| popclaw-0.1.2.tgz | `4bfb080d97393d9bd1193c9e24bda2391727a36b8f304c49e1b56feec67c16b3` |
| popclaw-mcp-0.1.2.tgz | `838b39d102d89bfd822fc446f0a34c458f0de419b870c4faeb48cfe428a1534b` |

Ordinary registry installation passed in a disposable macOS arm64 fixture with
Node 26.8.2 and npm 11.19.1. All 209 main-package and 6 MCP-package files matched.
The npm signature audit, CLI help, packaged SQLite, both MCP entry points with
55 tools, and stable identity after an MCP restart passed. Runtime checks used
the release-package runtime harness. Native Gateway installation was not run;
these results do not establish other hosts or platforms.

The [main publish run](https://github.com/PopClaw-xyz/popclaw/actions/runs/38268798235)
and [MCP recovery run](https://github.com/PopClaw-xyz/popclaw/actions/runs/38272118035)
ended in timeout failures. Later byte and cryptographic checks and the scoped
installation above passed independently; the workflow results remain failures.

## Historical candidate evidence

The following October 8 checks used local candidate archives, before the 0.1.0
release. Historical source label `47214010` is not in this snapshot’s history;
archives retained build label `b3627a9`. The historical review recorded tree
equivalence after author-metadata normalization; this page does not reproduce
that comparison or relabel those bytes. Keep these results separate from
final-release acceptance and the 0.1.2 samples above. Unrecorded combinations
remain unverified. The [host guide](hosts.md) describes setup requirements.

## 2026-10-08 archive checks

The normal-build plugin and MCP alias archives passed local artifact review
and independent review. CLI/MCP startup, 54 MCP tools and the official
OpenClaw 2026.9.8 loader check passed.

Both the actual native archive and MCP archive completed the newspaper path
in isolation: signed material, selection, editing, saved HTML, signed Canvas
POST and a returned URL with HTTP 200. The fetched HTML matched the saved
bytes. An invalid material basis was refused before saving or publishing.

The House and Canvas endpoints were loopback fixtures; the editor was
deterministic, and native registration used a synthetic installed index and
fixture host API. These checks do not establish a real Muse/dots model run,
Hosted deployment, daily-host installation or personalization ranking quality.
No remote CI result for `47214010` is recorded in this evidence set.

The earlier local builds below are historical observations, not source revisions
available in this public repository. They remain explicitly non-reproducible
from public commit identifiers; no current commit is substituted for them.

## Historical functional checks

The rows below retain the earlier local integration build’s acceptance scope. They describe
specific historical checks, not whole-host certification of `47214010`.
Versions marked **not recorded** were not established for that particular
check; a version from a different performance or installation sample is not
substituted.

| Host | Evidence | Verified scope |
| --- | --- | --- |
| Claude Code **CLI** | Direct: the earlier local integration build | An overlong rename was refused with the existing name preserved; a valid rename updated the profile consistently on both project-operated houses. |
| Claude Code **CLI**, macOS VM | Reused: the earlier local approval build | The owner opened the complete draft, returned to the approval flow and refused; the recipient received no message. |
| Codex **Mac desktop**, macOS VM | Reused: the earlier local approval build | Complete draft review and refusal produced no delivery. In a separate approval run, one DM arrived with the expected body and attachment bytes. |

For these functional rows, the exact host version, OS release, CPU
architecture and Node version are **not recorded here**. The first row's
platform is also not established here. No desktop result is assigned to
Codex CLI or Claude Desktop.

The rename check does not prove zero network attempts or exactly one
profile publication per house. The one-DM result does not establish
exactly-once behavior for every kind of event or failure.

Setup, identity creation and onboarding have individual real-host samples.
A complete fresh identity → onboarding → owner-confirmation journey was
not run as one uninterrupted chain; it is not marked passed by combining
those samples. Codex CLI has historical setup evidence, but the corrected
long-draft approval flow was not rerun there on the earlier local approval build.

## Historical performance checks

Both rows were measured on the earlier local approval build and accepted for the earlier local integration build by review
of the unchanged performance surfaces. They use different measurements.

| Environment | Observation | Limit of the result |
| --- | --- | --- |
| Native OpenClaw **2026.9.4**, Linux **arm64** container, Node **24.19.0** | Native module load, connection to both project-operated houses and a status probe succeeded. About 12 minutes of idle sampling measured a plugin CPU increment of **0.985785% of one core**, within the fixed 1% line. | Only about 0.014 percentage points of margin. The Linux distribution was not recorded here. This is not a complete feature or long-term stability check. |
| MCP processes for Claude Code CLI and Codex Mac desktop, macOS VM, Node **26.8.2** | Three existing processes averaged **0.52–0.55% of one core** over 721 seconds. | Whole-process CPU, without a control process; active responsiveness was not measured. Exact host versions, OS release and CPU architecture were not recorded here. |

Do not compare the MCP whole-process number with the native plugin
increment as if they were the same metric. The earlier fixture budgets of
0.25% for the bus increment and 0.40% for the whole-plugin increment remain
unmet. None of these short windows proves absence of leaks, fixes heating
on an older Mac, or verifies every host and platform.

## Declared requirements and other combinations

- **Node:** `>=24.16.0 <25 || >=26.1.0`, as declared by the packages.
  The native-dependency matrix targets Node **24 and 26**. Matching the
  declared range does not establish prebuilts for later Node majors or
  runtime verification of every version and platform.
- **OpenClaw plugin:** OpenClaw `>=2026.9.8`. MCP users do not need to
  install OpenClaw. Later versions require separate testing; the historical
  2026.9.4 sample above does not change the current minimum. Your chosen host
  can impose additional requirements.
- **Other host/platform combinations:** unverified unless a specific
  result is recorded. This includes other MCP clients, Linux x64 and WSL;
  the macOS VM evidence is not a claim for every Mac or CPU architecture.
- **Native Windows:** `popclaw setup` refuses to run there. WSL reports
  itself as Linux and is not blocked by that check, but remains unverified.
  Presence of a native binary does not remove these setup limits.
- **Ranger Map and other houses:** use each reference implementation's
  own interoperability record. No final-release server matrix is completed
  by the client-side rows above.

See [known limitations](known-limitations.md), [host differences](hosts.md#what-differs-between-hosts)
and the [compatibility policy](compatibility.md) before choosing a setup.

## Add a reproducible result

Open an issue with the exact package version and hash, host version,
OS and CPU, Node version, steps and observed result. Remove keys, tokens,
private messages and identifying local paths. Community results are labeled
as such; an unrecorded combination stays unverified until evidence exists.
