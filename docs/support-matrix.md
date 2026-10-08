# Support matrix

This page records evidence for the fixed 0.1.0 candidate, as of 2026-10-08.
It does not yet describe installation of the final public release package.
Current local checks and historical host samples are recorded separately.
Unrecorded combinations remain unverified.

## Candidate and final release

- **Fixed candidate source:** `b3627a91bf15249a7f9c7271b29d1df44a854f80`.
- **Current local check:** performed with the fixed candidate's actual archives.
- **Historical result:** retains its original build and acceptance scope. A
  result reused for `83185fa0` is not a new run or an equivalence claim for
  `b3627a9`.
- **Final release:** its source snapshot, archive hashes, registry-install
  results and publication provenance are not yet recorded here. Candidate
  archive checks must not be relabeled as final-release checks.

The installation samples used fixed local archives. They do not establish
that `openclaw plugins install popclaw` or the public-registry `npx` path
has passed with the final release. The [host guide](hosts.md) documents those
entry points and their identity, approval and timeout requirements.

## Current local checks

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
No remote CI result for `b3627a9` is recorded in this evidence set.

## Historical functional checks

The rows below retain the `83185fa0` acceptance scope. They describe
specific historical checks, not whole-host certification of `b3627a9`.
Versions marked **not recorded** were not established for that particular
check; a version from a different performance or installation sample is not
substituted.

| Host | Evidence | Verified scope |
| --- | --- | --- |
| Claude Code **CLI** | Direct: `83185fa0` | An overlong rename was refused with the existing name preserved; a valid rename updated the profile consistently on both project-operated houses. |
| Claude Code **CLI**, macOS VM | Reused: `d13b7d73` | The owner opened the complete draft, returned to the approval flow and refused; the recipient received no message. |
| Codex **Mac desktop**, macOS VM | Reused: `d13b7d73` | Complete draft review and refusal produced no delivery. In a separate approval run, one DM arrived with the expected body and attachment bytes. |

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
long-draft approval flow was not rerun there on `d13b7d73`.

## Historical performance checks

Both rows were measured on `d13b7d73` and accepted for `83185fa0` by review
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
