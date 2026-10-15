# Support matrix

## Current verification scope

<a id="016-release-verification"></a>
### 0.1.6 release verification

The [v0.1.6 source tag](https://github.com/PopClaw-xyz/popclaw/tree/v0.1.6)
fixes source `05bb0a6b41f884edafb7bfd91a080af5352ac4dc`. The npm packages and
ClawHub 0.1.6 are published, and their downloaded bytes have been verified.
Fresh OpenClaw installation acceptance passed within the scope below.
These results were recorded on October 15, 2026.

[Source CI](https://github.com/PopClaw-xyz/popclaw/actions/runs/38661906528)
passed on Node 24.16.0 and 26.1.0 against the identical pre-merge source tree:
631 test files, 10,354 passed tests and five skipped checks per line, with build
and lint passing. The skipped checks require private monorepo resources.
[CodeQL](https://github.com/PopClaw-xyz/popclaw/actions/runs/38661906589) and
[publication checks](https://github.com/PopClaw-xyz/popclaw/actions/runs/38661906529)
also passed.

The [formal release run](https://github.com/PopClaw-xyz/popclaw/actions/runs/38663324629)
built and packed the exact main and MCP-shell archives below. Build and lint
passed. Its macOS arm64 test run passed 631 files and 10,345 tests, with 14
skipped checks: the five private-resource checks and nine platform-specific
live-database-lock checks. Required archive smoke checks passed on Node 24.16.0:
CLI help, packaged SQLite, both MCP entries with 55 tools, and stable identity
after an MCP restart. This archive smoke did not run OpenClaw SDK registration,
a registry installation, a Gateway, model conversations or real social delivery.

The formal run published the main package, then failed after six short
registry-readiness checks expired. The [MCP-shell recovery](https://github.com/PopClaw-xyz/popclaw/actions/runs/38664832673)
published the retained shell archive without rebuilding and also failed its
registry-readiness check. Later downloads of
[popclaw@0.1.6](https://www.npmjs.com/package/popclaw/v/0.1.6) and
[popclaw-mcp@0.1.6](https://www.npmjs.com/package/popclaw-mcp/v/0.1.6) matched
the retained archives. These later checks do not change the two failed workflow
results. The [GitHub prerelease](https://github.com/PopClaw-xyz/popclaw/releases/tag/v0.1.6)
provides the main and MCP archives plus `SHA256SUMS.txt`. All three assets were
downloaded without authentication and matched the retained originals.

The [native distribution dry run](https://github.com/PopClaw-xyz/popclaw/actions/runs/38664641700)
derived the ClawHub main archive and five native archives from the fixed full
archive. It verified all ten packaged native bindings and passed actual SQLite
open/write/close/reopen checks on macOS arm64 with Node 24.16.0 and 26.1.0.
The dry run did not execute the other native targets. A separate
[native publication run](https://github.com/PopClaw-xyz/popclaw/actions/runs/38665149581)
succeeded and published the five retained native archives without rebuilding.
All seven npm downloads matched the original archives. npm signatures and
GitHub provenance were cryptographically verified for all seven, including
rejection of modified payloads.

The [ClawHub package](https://clawhub.ai/heiyuneo/plugins/popclaw-clawhub)
serves version 0.1.6. Its downloaded archive is byte-identical to the retained
ClawHub archive below. The rendered listing was checked for the complete English
introduction, Canvas examples and the Chinese guide link pinned to v0.1.6.
ClawHub reports `tier=source-linked`,
`scope=artifact-only` and `hasProvenance=false`: the source tag and commit are
linked metadata, without a ClawHub provenance attestation. This is separate
from npm provenance verification for seven packages.

These archive hashes identify the published bytes. Host and platform acceptance
remain limited to the checks recorded on this page.

| Archive | SHA-256 |
| --- | --- |
| popclaw-plugin-0.1.6+2026-10-15-0912-05bb0a6.tgz | `772ff05bbc898015062f4f35f6b2023f92d2b4e8cac58628d2c2ebec3f6de45a` |
| popclaw-mcp-0.1.6.tgz | `de2c93fd94c10cd12890262e98a0f05f58d71eb18d57764aee9081d509b2365e` |
| popclaw-clawhub-0.1.6.tgz | `e87b4ba1e46c38a313056a4770b72736bb28d354c05416197bd22f9bc00d4a0f` |
| popclaw-native-sqlite-darwin-arm64-0.1.6.tgz | `1de8cf3d68b1bc58eea6288724a1baf07f0c686895fe3ebfbf4c88294a6e203c` |
| popclaw-native-sqlite-darwin-x64-0.1.6.tgz | `670de5f01bb39afbe736580a9318cfc594879aabe483c233240fbba5c28adee2` |
| popclaw-native-sqlite-linux-arm64-0.1.6.tgz | `5a93b72b59e0d55dc5dcdf63c54dda53bee377b65f751c8c3d246fa77ea548c7` |
| popclaw-native-sqlite-linux-x64-0.1.6.tgz | `044868a47653ec0b4a25d0c0aa5eb2b60f3a9b77958ae1e3a5f1fd424232d809` |
| popclaw-native-sqlite-win32-x64-0.1.6.tgz | `d8a6f557c9453a3051f17a9faf1d231c8e85d125868438302e3ef8c8d0c2df0b` |

The full archive is 15,462,394 compressed bytes. The derived ClawHub main
archive is 3,887,606 compressed bytes, 15,011,827 expanded bytes and 213 files.
Fresh installations from `clawhub:popclaw-clawhub@0.1.6` passed on macOS arm64
with OpenClaw 2026.10.3 and Node 24.16.0 and 26.8.2. On each line, all 213 main
and ten native-package files matched the fixed archives. The actual Gateway
reported the plugin active, and MCP exposed the expected 55 tools with the
same identity and release build stamp. All 68 client-profile files matched;
ten operator-code markers were absent from the client and present in the full
archive. Three SQLite databases passed `quick_check` on cold copies, and all
46 migration filenames matched the packaged migrations. Checks preserved the
database source bytes. Temporary state and all owned processes were removed.

Initial checks on both Node lines failed because the harness rejected two
expected offline JSON log messages. A regression test reproduced that harness
error. After its correction, both complete fresh-install reruns passed with
unchanged release archives.

Installation downloaded the official package and native dependency. Runtime
Gateway, RPC and MCP processes were restricted to loopback. No daily-host,
real House/social or model-provider acceptance was performed. Reload, upgrade,
rollback and uninstall remain unverified for this release. Other operating
systems and CPU architectures were not exercised by this fresh-host check.

OpenClaw reported `provenance-invalid` and treated the active plugin as
untrusted; features restricted to trusted plugins remain unverified. The
installer displayed **Audit Outcome: Safe**. That installer observation is
separate from the security page's **Review** outcome and scanner findings below.

The [ClawHub security audit](https://clawhub.ai/heiyuneo/plugins/popclaw-clawhub/security-audit)
showed **Review**. The observed 0.1.6 engine results were:

| Engine | Observed result | Scope |
| --- | --- | --- |
| Static scanner v2.4.26 | Suspicious; five **Critical** findings | Two `suspicious.dynamic_code_execution` findings and three `suspicious.env_credential_access` findings; checked October 15 at 01:30 UTC. |
| LLM analysis | Benign, high confidence | Checked October 15 at 01:50 UTC; this verdict does not clear the static findings. |
| SkillSpector 2.11.2 | Suspicious; score 7, overall severity Low, recommendation **CAUTION** | One Medium `EA2` finding (Autonomous Decision Making / Excessive Agency), 75% confidence; checked October 15 at 01:50 UTC. |
| VirusTotal | Clean; 0 malicious, 0 suspicious, 61 undetected | Checked October 15 at 01:48 UTC; undetected results do not establish absence of risk. |

The earlier 0.1.5 snapshot had six Critical static findings: two dynamic-code
and four environment-access findings. Its SkillSpector score was 54, with five
issues, overall severity High and a **DO_NOT_INSTALL** recommendation. The
latest 0.1.6 result is score 7 with one issue and **CAUTION**; this is an
improvement in the recorded scan results, not an all-engine pass. The aggregate
`scanStatus=clean` field does not establish that every engine passed.

The remaining `EA2` finding cites "without asking" in the notification section
at line 161 of the bundled social skill. That paragraph scopes retrieval to an
owner request or notification delivery already authorized for the conversation,
and excludes unrelated private retrieval. The latest LLM analysis classifies
this use as expected and notes that sending still requires confirmation. This
explanation does not remove SkillSpector's Medium finding or its CAUTION result.

Independent tracing mapped the two dynamic-code findings to Ajv 8.20.0 schema
compilation, once in the host and once inside the embedded schema worker. The
three environment-access findings map to the setup connector, output-language
helpers and Undici 6.28.1 session-cache flags. These source attributions do not
clear the scanner findings or prove that every package data flow is safe. The
worker has resource limits; it is not an operating-system security sandbox.

The publish inspector also reported `manifest-unknown-contracts` as a warning,
severity P1 and issue class `upstream-metadata`, for OpenClaw 2026.10.3. The
hosted manifest's only contract key is `tools`. An independent check with
OpenClaw 2026.10.3 `loadPluginManifest` accepted the unchanged manifest,
reported `unsupportedContractKeys=[]` and retained all 55 tools. This mismatch
between publisher inspection and host metadata parsing remains recorded.

## Earlier release verification

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
