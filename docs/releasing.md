# Releasing

How a release reaches npm, and what only a maintainer with registry access can
do. The machinery is `.github/workflows/release.yml`.

See the [current release verification scope](support-matrix.md#018-release-verification)
for recorded checks, channel status and remaining acceptance limits.

The standard npm release is **two packages**, published in one workflow run, in one order:

| package | what it is | packed by |
|---|---|---|
| `popclaw` | the implementation: bundle, native bindings, migrations | `just pack-plugin` |
| `popclaw-mcp` | two bin aliases and `"dependencies": {"popclaw": "<same version>"}` | `just pack-mcp-shell` |

`popclaw-mcp` cannot install until `popclaw` is on the registry at exactly its
version. So `popclaw` goes first, is verified on the registry, and only then
does the shell go out. The two recipes carry opposite guards on purpose:
`pack-plugin` checks every declared native binding inside the tarball by name,
binary platform/architecture header and Node ABI initializer. `pack-mcp-shell` aborts
if the shell tarball contains any `dist/`, `native-deps`, `migrations` or
`wallet-migrations` — or if its version and its `popclaw` dependency are not the
exact same string as the plugin's version. Neither guard may be loosened to let
one recipe serve both packages.

The five JavaScript entries share ESM chunks in `dist/bundled/`. Always ship
that whole directory: copying only an entry file drops required imports. Every
chunk stays beside the entries so native bindings and resource paths keep their
existing layout. The build removes obsolete JavaScript chunks, preserves the
pinned protocol notices, and collects licenses from all entries, shared chunks,
and both embedded workers. Whitespace and identifiers are compressed in the entries, shared chunks and
embedded workers; function names remain intact. The bundle regression suite
enforces a 4.5 MiB JavaScript budget for the full runtime graph in `dist/bundled/`
and exercises the CLI and MCP entries outside the source checkout. This budget
does not include the separately staged client graph or the complete archive size.

The complete npm/GitHub archive keeps all ten native bindings and the SQLite
fallback sources. ClawHub has a separate distribution because its hosted upload
path has rejected archives below the documented 50 MiB expanded-file limit.
The complete archive now also carries a separately built client graph under
`dist/client-bundled/`. Its `POPCLAW-BUNDLE-PROFILE.json` records the source inputs,
capabilities and every file's size, SHA-256 and mode. The full runtime remains in
`dist/bundled/` with Ranger execution and optional persona-file naming intact.
The main ClawHub archive promotes the exact client graph to `dist/bundled/`,
removes the original full graph and the extra staging directory, and retains the
SQLite fallback sources and required notices. `publishConfig.executableFiles`
explicitly retains the four executable entry modes in each graph through
`pnpm pack`; the prepack hook preserves only this packaging setting. A real
pack/derive fixture verifies these modes, since a raw tar fixture cannot detect
pnpm's default normalization to 0644. Native bindings still come from
five exact-version optional npm packages. The MCP shell keeps its exact
`popclaw` dependency.

The client graph omits Ranger verification/scraping/watch implementations,
provider-key discovery and missing-provider-credential warnings. It also omits
local persona-file input for naming. Ordinary social tools, house streams, local
identity/storage and the CLI daemon's consumer services remain available.
Verification requests still go to the house and its available Rangers. These
capabilities are selected at build time, not by an environment setting. Use the
full `popclaw` package for an operator Ranger.

These changes describe builds from this checkout; publishing and host acceptance
require their own release evidence.

Derive this profile only from a fixed, verified complete archive:

```sh
just pack-plugin clawhub /absolute/path/popclaw-plugin-VERSION+BUILD.tgz /absolute/output
```

The output directory contains `popclaw-clawhub-VERSION.tgz`, five
`popclaw-native-sqlite-PLATFORM-ARCH-VERSION.tgz` archives, and `receipt.json`.
The directory suffix is the first twelve characters of the complete archive's
SHA-256, not a Git commit. Existing output directories cannot be overwritten.
The receipt pins every archive, binding, version and preserved file inventory,
including each promoted client file's original path and SHA-256/mode. The builder
audits archive paths and types before extraction, reruns the complete-package
guard, verifies the client inventory and checks the actual derived archives after
packing. Derivation never compiles source. A complete archive without the new
prebuilt client graph must be rebuilt before deriving this profile. The read-only
retained-archive verifier still validates older releases against their original
full-graph preservation contract.

Run the focused distribution regressions before packing:

```sh
pnpm --filter popclaw exec vitest run tests/unit/client-bundle-profile.test.ts tests/unit/runtime/build-scraper.test.ts tests/unit/quest/verify-invite
node --test apps/popclaw-plugin/scripts/tests/clawhub-platform-package.fixture.mjs
python3 -B -m unittest discover -s scripts/tests -p test_verify_retained_clawhub.py
```

The first command tests actual full/client bundles, including a positive full
provider control, OpenClaw assembly with synthetic local state and the client
CLI daemon's clean shutdown. Package fixtures and the independent verifier
reject changed, extra or incorrectly mapped client files. The native matrix
checks and final retained-archive SQLite smoke remain separate requirements.

Each platform package carries both Node 24 and Node 26 bindings. The supported
ClawHub targets are macOS arm64/x64, Linux glibc arm64/x64 and Windows x64.
This list describes package selection, not runtime acceptance on every target.
Keep optional dependencies enabled. Missing, incompatible or modified bindings
fail before plugin registration; they do not silently trigger a download or
rebuild. The complete distribution keeps its existing source-build fallback.

The package name is `popclaw-clawhub`; the plugin ID remains `popclaw`, so data
paths, configuration keys, the SQLite driver and migrations stay the same.
Publish and verify all five native dependencies before uploading the exact
main archive to ClawHub. Attach the public source tag and commit as source
metadata, run validation and a dry run, then verify ClawHub's downloadable
digest. A new npm package must be bootstrapped before its trusted publisher can be bound;
the existing two npm bindings do not authorize these five package names.

Record fresh-install acceptance only after installing the published
`clawhub:popclaw-clawhub@VERSION` into a clean, isolated OpenClaw instance and
checking registration, SQLite write/reopen and identity persistence. An installer
exit status alone is insufficient: OpenClaw can defer runtime loading until the
Gateway starts. Verify reload, upgrade, rollback and uninstall separately;
a fresh install does not establish maintenance acceptance. Record the actual
publication, download, host and audit results in the
[current verification scope](support-matrix.md#017-release-verification),
including any remaining scanner or manifest warnings. Source-linked metadata
on ClawHub is not a provenance attestation; keep it separate from npm signature
and provenance verification.

Full packing requires Darwin. The release job uses GitHub-hosted `macos-15`
(arm64): clang builds `darwin-arm64` and `darwin-x64`; official better-sqlite3
release assets supply `linux-arm64`, `linux-x64` and `win32-x64`. Each target
ships Node 24 (ABI 137) and Node 26 (ABI 147): ten named bindings. The
upstream unsuffixed file remains a source-build fallback, not an extra packed copy. This matrix is fixed, independent of the verification machine.
`POPCLAW_NATIVE_DEPS_MINIMAL=1` is for development bundles only and cannot
produce a releasable tarball. Do not lower a binding count to accept a missing
platform.

[npm trusted publishing](https://docs.npmjs.com/trusted-publishers/) supports
GitHub-hosted runners, including the [hosted macOS runner](https://docs.github.com/en/actions/reference/runners/github-hosted-runners).
It does not support self-hosted runners. The workflow filename, repository,
environment and `id-token: write` remain the trusted-publisher identity; moving
the job from Ubuntu to hosted macOS does not change those fields. Checksums use
`shasum -a 256`, available on macOS, with the same retained checksum format.

## Verify the already published 0.1.7 packages

The `Verify published 0.1.7` workflow is a verification-only follow-up to the
failed post-publication reads in runs `38683082034` and `38685413921`. Both npm
uploads completed. The old reader discarded npm stderr, so those logs do not
establish that registry propagation caused the failures. Keep those failed runs;
a later successful verification does not change their result.

After this workflow is available on the approved default branch, run it from
Actions, or use:

```sh
gh workflow run verify-release-017.yml --repo PopClaw-xyz/popclaw --ref main
```

This entry has no release inputs and no publishing credentials. It reads artifact
`11949243158` from original run `38683082034`, checks its recorded digest and
source commit `801f5d76162de7f0a1ff66cdb89780a650586768`, and checks that `v0.1.7`
still points to that commit. The original metadata, checksum file and both
archives must match the recorded 0.1.7 bytes. It reuses
`verify-retained-artefacts.sh` and `verify-published-package.sh`, then downloads
each fixed npm version and verifies its bytes, registry signatures, npm publish
attestation and Sigstore provenance. Provenance must identify the original
source, tag, workflow and respective publication run, not this verification run.
The npm publish proof must use registry public-key material with matching DSSE
key identifiers. Certificate material is only accepted for provenance, with the
GitHub workflow identity and issuer policy applied. A key lookup callback alone
is not a restriction on the kind of signing material.
The verifier uses Sigstore 4.1.1 from npm 11.19.1. Its token only needs
`contents: read` and `actions: read`; it does not enter `npm-release` or request
an OIDC signing token.

The workflow performs no build, package publication, tag move, release edit or
npm label change. It does not invoke installation lifecycle scripts. It retains
its JSON evidence even when verification fails. A green run proves published
artifact identity and signatures, not fresh-install or social acceptance.

The shared registry reader now makes up to 24 reads with 10 seconds between
unsuccessful reads. Each npm request uses the public registry, prefers online
metadata, disables npm's nested fetch retries and has a 15-second fetch timeout.
The actual npm exit status and stderr remain visible. Incomplete JSON, missing
hashes or an attestation that has not appeared can be read again within that
budget. An archive hash mismatch stops immediately. Exhaustion reports failure
without asserting an unproven cause or attempting publication again.

Run the focused regression checks locally before changing either verifier:

```sh
python3 -B scripts/tests/test_published_verification.py
node --test scripts/tests/verify-release-017.test.mjs
```

The deterministic tests cover read recovery, retained error details, bounded
requests, source/run bindings and invalid registry signatures. Their Sigstore
adapter test checks policy routing; an actual verification run is still required
to establish the real bundles' cryptographic validity.

## Separate ClawHub native publication

Use `.github/workflows/release-clawhub-native.yml` to publish the five native
packages and attest the retained ClawHub main archive. It never publishes
`popclaw`, `popclaw-mcp` or the ClawHub main archive, and does not alter the
standard release workflow.

Dispatch a dry run first with these fixed inputs:

| input | required value |
|---|---|
| `tag` | The complete release tag, such as `v0.1.4` |
| `source_run_id` | The `release.yml` run that retained and successfully smoke-tested the complete archive |
| `expected_source_commit` | Its full 40-character commit, also the tag target |
| `expected_full_sha256` | The retained complete archive's lowercase SHA-256 |
| `dry_run` | `true` for preparation; `false` for native publication |
| `auth_mode` | `oidc` by default; `bootstrap-token` only for the first publication of the five real platform packages |
| `resume_from_run_id` | Empty initially; the prior native workflow run for exact-byte reuse |

The source run must use event `push` or `workflow_dispatch`, have `head_branch`
equal to the exact tag and `head_sha` equal to `expected_source_commit`, and
finish with conclusion `success` or `failure`. Its actual run attempt must have
a successful package-smoke step. Dispatch the complete release on the tag,
not on `main`. A later registry publication failure does not discard valid
retained bytes. The verifier checks the repository, workflow, tag, commit,
artifact identity, expiry and retained hashes before deriving anything. The
retained context records the source archive identity; GitHub run metadata
records the native workflow revision that performed preparation/publication.
The native workflow may run from a later reviewed `main` revision while the
source run, release tag, source commit and archive digest stay fixed. Record
both identities, and verify publication provenance against the actual native
workflow revision/ref. Do not move the release tag to update release tooling.

Preparation derives all six archives through the explicit ClawHub pack
profile, independently compares them with the complete archive, and runs real
SQLite write/close/reopen checks on both supported Node lines. The six exact
archives, derivation receipt, source context and validation result are retained
for 90 days. A dry run checks registry state and publication requests; it does
not prove that OIDC bindings work.

For a package name's first publication, use `auth_mode: bootstrap-token` to
publish the real, verified target archive. Do not create an empty placeholder
or an extra bootstrap version. Prepare a short-lived npm token with only the
creation/publishing access needed for these five names, and store it as the
`NPM_BOOTSTRAP_TOKEN` secret in the GitHub `npm-release` environment. The release
owner must authorize any npm permissions needed to create new names and any
required non-interactive 2FA setting. Do not place the token in workflow inputs,
repository files, shared npm configuration, or logs.

The secret is supplied only to the final publication step in explicit
`bootstrap-token` mode, and only real `npm publish` subprocesses receive it.
Preparation, builds, SQLite smoke checks, dry runs, and registry verification
do not receive the token. npm uses isolated configuration, and OIDC mode
rejects nonempty npm credential environment variables instead of falling back
to token authentication. Token publication still requests `--provenance` and
uses the job's `id-token: write` permission to sign it; npm registry
authentication and provenance signing are separate operations.

After reviewing the retained dry-run artifacts, dispatch with `dry_run: false`
and `resume_from_run_id` set to that native run. The workflow downloads those
same six archives without repacking, rechecks the complete source and both
Node runtimes, and preflights all five registry names before any publication.
A missing name in default OIDC mode stops the run with `BOOTSTRAP_REQUIRED`.
Bootstrap mode accepts only a new name or a name whose sole version is the
target version from a partial first release. A name containing any other
version, or an unknown registry response, stops the run before publication.
Every existing target version must first
match the retained archive digest and carry an attestation. The shared verifier
uses SHA-512 integrity, or its existing SHA-1 shasum fallback when integrity is
absent. Only missing versions are published using the selected authentication
mode with provenance, and each is verified before the next begins.
Dry runs also verify existing target versions and check publication requests
only for missing versions; npm rejects even a dry-run republish of a version.
On partial failure, resume from the run retaining those exact bytes; never
rebuild or replace a published version. The original complete-source artifact
must also remain available and unexpired.

npm accepts an upload before its publish-time scan makes the version readable.
The native publication step allows 91 reads with 10 seconds between reads:
up to 15 minutes of polling sleeps per package, plus request time. Its 95-minute
job limit accommodates five sequential windows and setup. These settings apply
only to this final native step; the shared verifier defaults are unchanged.
An unavailable version still stops the run when the window expires. Preserve
the retained bytes, check registry state and provenance, then resume after the
state is understood. Do not blindly publish the same version again. npm reports
typical scanning delays of about five minutes and peak delays of 15 minutes or
longer; neither the service nor this workflow guarantees completion in 15 minutes.
See [npm's publish-time scanning announcement](https://github.blog/changelog/2026-07-28-npm-publish-time-malware-scanning-and-dual-use-metadata/).

The first `popclaw-native-sqlite-darwin-arm64@0.1.4` upload in
[run 38547070940](https://github.com/PopClaw-xyz/popclaw/actions/runs/38547070940)
was accepted at 10:06:47 UTC on 2026-10-14 and became public at 10:09:27 UTC,
after the former six-read verification window had expired. During processing,
npm created a public `0.0.0-stage` entry with `stub: true`; that entry remained
after the real version became available automatically. This is an observed
registry behavior, not an instruction to publish an empty package. A release
owner may remove that exact system-created stub only after verifying the real
target version's bytes and provenance and authorizing the cleanup. Use
version-specific removal, never whole-package removal or `--force`, and then
recheck the target version and `latest`. The bootstrap version guard remains
strict: any other version, including a remaining stub, blocks a resumed run.
Do not assume that another authentication method or dist-tag prevents registry
stubs. See [npm's single-version removal procedure](https://docs.npmjs.com/unpublishing-packages-from-the-registry/#unpublishing-a-single-version-of-a-package).

After all five first versions are verified, revoke the bootstrap token and
remove its environment secret. Bind each package's trusted publisher to
repository `PopClaw-xyz/popclaw`, workflow `release-clawhub-native.yml`, and
environment `npm-release`, then use the default `oidc` mode for later releases.
An OIDC run against the already published target versions verifies those bytes
and attestations without republishing them. It does not exercise OIDC publish
authentication. Record that limit explicitly; do not publish an extra version
solely to test authentication. The next authorized release that actually
publishes new versions supplies that evidence.

New trusted-publisher configurations expire unless their first successful
publish completes within two days. Coordinate new bindings with the next
authorized release of a new version. Verifying existing versions, running a
dry run, or saving the configuration does not satisfy this requirement or
validate the binding. If it expires, delete and recreate it before that
release, then complete its first publish within two days. Do not report a
saved configuration as permanently verified. See
[npm's configuration expiry rules](https://docs.npmjs.com/trusted-publishers/#trusted-publisher-configuration-expiry).

Only after all five native versions and the main archive's GitHub attestation
are verified may the retained main archive be uploaded to ClawHub. Record the
hosted download digest and perform the clean `clawhub:` installation described
above. Optional-dependency failures can
leave an OpenClaw archive installation in `installed-start-deferred`; a later
`POPCLAW_PLATFORM_DEPENDENCY_MISSING` error means runtime acceptance failed.
Restore the verified complete distribution through the normal maintenance
procedure and verify the same identity and database records after restart.

### Verify the ClawHub archive attestation

A real `release-clawhub-native.yml` run signs the retained main archive only
after `prepare` and `publish-native` succeed. The separate `attest-main` job
resolves the original full-source run again, downloads exact artifact IDs,
verifies the full archive and every derived byte, and signs three subjects:
`popclaw-clawhub-<version>.tgz`, `receipt.json` and `release-context.json`.
It does not rebuild packages. Only this job has `attestations: write`; its
OIDC signing identity does not require an npm or ClawHub token.

`dry_run: true` creates no attestation. A resumed real run verifies the same
retained bytes and signs them in the resumed run. The SLSA provenance identifies
the workflow revision and run that verified and signed the archive. The signed
release context and derivation receipt identify the original source commit,
full-source run and archive digest. These identities may differ when release
tooling has advanced. Do not describe a resumed signature as a signature made
by the original build run.

Download `clawhub-attestation-<tag>-<run-attempt>` from the successful native
workflow, retain it alongside the main archive, and attach those evidence files
to the public release. It contains the Sigstore bundle, the two signed JSON
subjects and `attestation-subjects.sha256`; Actions retains it for 90 days.
From the directory containing those files and the main archive, verify each
subject against the reviewed **attesting workflow commit**, not an assumed
release-tag commit:

```sh
version=VERSION
attesting_commit=FULL_REVIEWED_WORKFLOW_COMMIT
for subject in "popclaw-clawhub-${version}.tgz" receipt.json release-context.json; do
  gh attestation verify "$subject" \
    --repo PopClaw-xyz/popclaw \
    --signer-workflow PopClaw-xyz/popclaw/.github/workflows/release-clawhub-native.yml \
    --source-digest "$attesting_commit" \
    --bundle bundle.json
done
shasum -a 256 -c attestation-subjects.sha256
```

Set `version` and `attesting_commit` before running these commands. Inspect
the verified statement's run identity, compare `release-context.json` with the
approved source tuple, and confirm the main archive's digest matches its row
in `receipt.json`. After upload, repeat archive verification on the bytes
actually downloaded from ClawHub. A workflow file, dry run or successful
upload alone does not prove a valid signature. If signing or verification
fails, retain the existing artifacts and resume; do not rebuild or replace the
same version to obtain an attestation. See the official
[GitHub attestation action](https://github.com/actions/attest) and
[verification command](https://cli.github.com/manual/gh_attestation_verify).

GitHub artifact attestation, ClawHub source metadata and OpenClaw runtime trust
are separate checks. At the 2026-10-15 investigation, ClawHub CLI 0.23.3 exposes
source attribution and OIDC publishing authentication but no build-attestation
upload option. The public ClawHub source at
[`6a58bbf`](https://github.com/openclaw/clawhub/blob/6a58bbfafae4a0d59e34ec4d14dcf5c26a4519b9/convex/lib/packageRegistry.ts#L534)
sets source-linked verification to `hasProvenance: false`; its public publish
schema has no attestation input. The deployed revision has not been established,
so check the actual release response rather than assuming how the service is
implemented. An independent GitHub signature does not change that ClawHub field.

OpenClaw 2026.10.3 grants restricted runtime trust to bundled plugins and
matching entries in its official plugin catalog. A community PopClaw install
can therefore report `provenance-invalid` even when downloaded bytes and GitHub
signatures verify. Neither source metadata, `plugins.allow`, a publisher OIDC
binding nor this attestation adds PopClaw to that catalog. Do not claim that
these steps enable trusted-only capabilities or remove the warning. See
[OpenClaw runtime trust](https://docs.openclaw.ai/tools/plugin#plugin-runtime-trust-refused).

The same investigation reproduced a `manifest-unknown-contracts` warning with
Plugin Inspector 0.3.27 and the OpenClaw 2026.10.3 package: the inspector reads
object-literal declaration fields, while that host declares its contracts as
`Partial<Record<...>>`. It consequently finds no contract keys, although the
host's actual manifest loader accepts `contracts.tools`. This local reproduction
does not establish the deployed inspector version. Keep the required tool
ownership list, record the exact release's inspection result, and recheck after
an upstream inspector fix. Do not delete valid tool declarations to suppress
this warning. The [host contract documentation](https://docs.openclaw.ai/plugins/manifest/capabilities#contracts-reference)
explains their role in discovery.

## Order on the day

Least reversible last, with a check between each step.

1. The repository is public. Walk the README paths logged out; confirm CI is
   green on public runners.
2. Tag: `git tag v0.1.0 && git push origin v0.1.0`. The push triggers
   `release.yml`, which runs `just install/build/test/lint` once, verifies the
   pinned protocol bundle, packs **both** tarballs, checks both packed
   manifests, uploads both plus `SHA256SUMS.txt` as the `release-artefacts-v0.1.0`
   artefact, then:
   `publish popclaw` → verify on the registry → `publish popclaw-mcp` → verify.
3. Verify by hand: both npm pages show a provenance attestation linking back to
   the tagged commit; on a clean machine `npm install popclaw` gets to a first
   post and `npx -y popclaw-mcp@0.1.0` starts an MCP server. **If this fails,
   stop here** — a public repository with nothing announced is a fine place to
   sit for a day.
4. GitHub Release, using the tarball names and sha256 sums from the workflow's
   job summary. 5. Registry listings. 6. Announce.

## What each check proves, and what it does not

- **The workflow's registry verification** (`scripts/verify-published-package.sh`)
  asks the registry for `<package>@<version>`'s `dist` and fails unless it
  carries `dist.attestations` **and** its `dist.integrity` (sha512) equals the
  hash of the tarball this run packed and tested. A matching version string
  alone would also match a package published by hand from a different tree;
  that is the failure this check exists for. It is a script rather than a block
  of YAML so that `apps/popclaw-plugin/tests/unit/release-scripts.test.ts` can
  run the same bytes the release runs, against a fake registry.
- **A green `npm publish` step proves nothing about provenance.** The
  attestation is created by the registry, after the upload. Only the step above
  proves it exists.
- **A dry run does not verify a trusted-publisher binding.** `dry_run: true`
  runs everything and stops at `npm publish --dry-run` for both tarballs. It
  proves the build, the version gate, the repository gate and both tarballs.
  The binding is only exercised by a real, authenticated publish, so **the first
  real publish of each package is the first test of that package's binding** —
  and the two bindings are separate, so `popclaw` succeeding tells you nothing
  about `popclaw-mcp`.
- **`just test` runs on the source tree, not on the tarballs.** What links them
  is `apps/popclaw-plugin/tests/unit/mcp-shell-lockstep.test.ts` (the two
  manifests agree) and `just pack-mcp-shell` (the tarball agrees with the
  manifest).

## When half of it is published

npm has no transaction across two packages. If `popclaw` is published and the
shell's publish or verification then fails, the workflow fails loudly and prints
what is and is not on the registry, asked at that moment. The rules:

1. **Stop announcing.** Nothing goes out until both packages are verified.
2. **Read the registry, not the logs.** The job summary already ran
   `npm view <pkg>@<version> version` for both.
3. **Never unpublish. Never republish a version.** A published version can never
   be replaced. If the artefact has to change, it needs a **new version number**
   for both packages, together.
4. **Resume from the retained artefacts, do not rebuild.** The bundle embeds a
   build timestamp, so rebuilding the same commit does not reproduce the same
   tarball; the retained bytes are the only copy of what was tested.

Resume with `workflow_dispatch`:

| input | value |
|---|---|
| `tag` | the same tag, e.g. `v0.1.0` |
| `dry_run` | `false` |
| `only` | `shell` |
| `resume_from_run_id` | the failed run's ID (printed in its job summary) |

The resume run downloads `release-artefacts-<tag>` from that run and then, in
`scripts/verify-retained-artefacts.sh`:

- checks every retained file against the retained `SHA256SUMS.txt`;
- checks the retained `release-metadata.json` — which the packing run wrote —
  records **this tag and the commit that tag points at right now**. The artefact
  name also contains the tag, but a name is a label anyone can reuse and a tag
  can be moved to another commit after a failed release, so both are compared by
  value and a mismatch names both sides;
- checks the retained shell tarball still declares the exact `popclaw`
  dependency.

Then it checks that `popclaw@<version>` on the registry has the same integrity
as the retained `popclaw` tarball, publishes the shell and verifies it. It does
not install, build, test or pack anything. `only: shell` without
`resume_from_run_id` is refused. Combining `resume_from_run_id` with
`only: all` is refused except for the fixed first-release recovery below;
it never permits replacing a published version.

Artefacts are retained for **90 days**: long enough for the owner to decide
without a deadline, and the maximum GitHub allows for a public repository.

## Fixed first-release recovery: both retained packages

The original run `38074322285` completed packing and smoke checks but failed
publishing `popclaw` with npm E404; neither `0.1.0` package was published by
that run. Before dispatch, confirm that the reviewed recovery workflow
revision is present on the selected ref and that the npm account/publisher
problem has been resolved.

The sole `only: all` resume exception uses these exact dispatch inputs:

| input | value |
|---|---|
| `tag` | `v0.1.0` |
| `dry_run` | `false` |
| `only` | `all` |
| `resume_from_run_id` | `38074322285` |

The recovery must verify the original public repository/run identity and
unchanged tag commit `d9a849e177a2c760bc50a2b1bd2849b88abc723e`, plus
`release-metadata.json` and the retained checksums. Its fixed artifact is
`release-artefacts-v0.1.0`, ID `11677679013`, artifact digest
`sha256:41354d6ec1bd30e5b2f98548e063d495f39f60bedafd46675e448433b351ff5d`.
The package SHA-256 values are:

| retained file | SHA-256 |
|---|---|
| `popclaw-plugin-0.1.0+2026-10-11-0219-d9a849e.tgz` | `5b72e6f341f6eae0bf247100875bb7aa26c19c8362cf2e9f11c81baf4121ad2f` |
| `popclaw-mcp-0.1.0.tgz` | `b01e68c42ad007bf7517673aaa2f2991e408535ee8cdd0ae1bd629ca0e6d45f9` |

Nothing is rebuilt or repacked. For each exact registry version, verify an
existing package against the retained bytes and attestation requirements;
publish only a missing version. A mismatch stops recovery, never triggers an
overwrite. Verify `popclaw` before publishing its dependent shell, then verify
the shell. The ordinary shell-only recovery above remains available.

Keep the two records separate: `d9a849e` / run `38074322285` built and tested
these bytes; a later workflow commit/run performs publication. Inspect and
record that publication's actual provenance. Do not describe it as a successful
publish by the original run or assume provenance points to the build commit.

## One-time setup, maintainer only

Nothing below can be done from a pull request.

- **`repository` in both package.json files.** Provenance is refused unless it
  names the publishing repository exactly. The public repository is
  `PopClaw-xyz/popclaw`, and all three edits are in place:
  - `apps/popclaw-plugin/package.json` and `packages/popclaw-mcp/package.json`
    each have
    `"repository": { "type": "git", "url": "git+https://github.com/PopClaw-xyz/popclaw.git" },`
  - `apps/popclaw-plugin/scripts/prepack.mjs` carries `repository: pkg.repository,`
    in the `stripped` object, because that script rewrites the plugin manifest
    down to an allowlist before packing and would otherwise drop the field. The
    shell has no prepack.

  `release.yml` fails in its first two minutes if any of these is missing, and
  again after packing if the field did not survive into either tarball.
- **A trusted publisher per package, on npmjs.com.** Bindings are per package,
  not per repository. Do this for `popclaw` **and** for `popclaw-mcp`: package
  page → Settings → Trusted publisher → GitHub Actions, then organisation or
  user, repository name, workflow filename `release.yml`, environment
  `npm-release`. The filename is matched literally — renaming this workflow file
  breaks publishing for both packages until both bindings are updated.
  **After any repository switch — a rename, a move to a different organisation,
  a different repository going public — re-check both bindings.** A binding that
  still names the old repository fails at publish time, with one package
  possibly already out.
- **The `npm-release` environment.** Settings → Environments → New environment
  → `npm-release`. Empty, it changes nothing. Add a required reviewer and an
  accidental `git push --tags` becomes a request that waits for a human. Both
  bindings name this environment, which is why both publishes happen in the same
  job.

The workflow uses no npm token; authentication is OIDC, which npm supports from
npm CLI >= 11.5.1 on Node >= 22.14.0 — hence the pinned CLI version in the
workflow (docs.npmjs.com/trusted-publishers).

## `@popclaw/mcp`

The scoped name `@popclaw/mcp` is an unrelated placeholder. Leave it alone: do
not publish to it, do not deprecate it, do not delete it. The shipped alias is
the unscoped `popclaw-mcp`. Documentation that shows the hook command spells the
package out — `npx -y --package=popclaw-mcp@0.1.0 popclaw-mcp-hook UserPromptSubmit` —
so npm never goes looking for a third package.

## Rehearsing

A version number can be published once, so rehearse on something disposable.

- `workflow_dispatch` with `dry_run: true`. See "What each check proves" above
  for its limits.
- A full rehearsal needs scratch packages, and **a scratch package has to exist
  on the registry before you can bind a trusted publisher to it**: npm's own
  prerequisites for the trust commands say "the package must already exist on
  the npm registry" (docs.npmjs.com/cli/v12/commands/npm-trust). So publish
  `popclaw-release-rehearsal@0.0.1` by hand once, then bind it the same way as
  above.
- Provenance also requires the publishing repository to be **public**
  (docs.npmjs.com/trusted-publishers: provenance is not supported for private
  repositories). So a full rehearsal happens in a small public scratch
  repository, or it stops at `dry_run`.

## If the workflow fails on the day

If an exceptional manual publication is considered, first record which registry
integrity and provenance checks would be lost and obtain the release owner's
decision. Audit the current README, host guide, contribution guide and release
notes for claims about the actual publication path; do not rely on a quoted
sentence from an older revision. Record the exact artifact bytes and observed
registry result. A manual upload must not be described as workflow-attested.

## What cannot be undone

- **A version number is burned on first publish.** `0.1.0` published badly can
  never be republished; the next attempt is `0.1.1`, for both packages.
- **Unpublishing has a 72-hour window**, and only while nothing depends on it.
  `popclaw-mcp` depends on `popclaw`, so once the shell is out the main package
  is not unpublishable at all. After the window the tool is `npm deprecate`,
  which leaves the bad version visible.
- **A published tarball is public forever.** Anything in it — a stray file, a
  path, a comment — is out. `files` in each package.json is the allowlist that
  decides what goes in.
