# Releasing

How a release reaches npm, and what only a maintainer with registry access can
do. The machinery is `.github/workflows/release.yml`.

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
enforces a 4.5 MiB JavaScript budget and exercises the CLI and MCP entries outside the source checkout.

The complete npm/GitHub archive keeps all ten native bindings and the SQLite
fallback sources. ClawHub has a separate distribution because its hosted upload
path has rejected archives below the documented 50 MiB expanded-file limit.
The main ClawHub archive retains the same JavaScript, source fallback and
notices, and obtains native bindings through five exact-version optional npm
packages. This profile does not change the standard npm package or MCP shell.

Derive this profile only from a fixed, verified complete archive:

```sh
just pack-plugin clawhub /absolute/path/popclaw-plugin-VERSION+BUILD.tgz /absolute/output
```

The output directory contains `popclaw-clawhub-VERSION.tgz`, five
`popclaw-native-sqlite-PLATFORM-ARCH-VERSION.tgz` archives, and `receipt.json`.
The directory suffix is the first twelve characters of the complete archive's
SHA-256, not a Git commit. Existing output directories cannot be overwritten.
The receipt pins every archive, binding, version and preserved file inventory.
The builder audits archive paths and types before extraction, reruns the
complete-package guard, and checks the actual derived archives after packing.

Each platform package carries both Node 24 and Node 26 bindings. The supported
ClawHub targets are macOS arm64/x64, Linux glibc arm64/x64 and Windows x64.
This list describes package selection, not runtime acceptance on every target.
Keep optional dependencies enabled. Missing, incompatible or modified bindings
fail before plugin registration; they do not silently trigger a download or
rebuild. The complete distribution keeps its existing source-build fallback.

The package name is `popclaw-clawhub`; the plugin ID remains `popclaw`, so data
paths, configuration keys, the SQLite driver and migrations stay the same.
Publish and verify all five native dependencies before uploading the exact
main archive to ClawHub. Use the public source tag and commit as provenance,
run validation and a dry run, then verify ClawHub's downloadable digest. A new
npm package must be bootstrapped before its trusted publisher can be bound;
the existing two npm bindings do not authorize these five package names.

Before declaring this channel available, install the published
`clawhub:popclaw-clawhub@VERSION` into a clean, isolated OpenClaw instance.
Check registration, SQLite write/reopen, identity persistence, and upgrades in
both directions. An installer exit status alone is insufficient: OpenClaw can
defer runtime loading until the Gateway starts. As of this candidate, ClawHub
publication and this final hosted-source installation remain pending.

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

## Separate ClawHub native publication

Use `.github/workflows/release-clawhub-native.yml` only for the five native
packages. It never publishes `popclaw`, `popclaw-mcp` or the ClawHub main
archive, and does not alter the standard release workflow.

Dispatch a dry run first with these fixed inputs:

| input | required value |
|---|---|
| `tag` | The complete release tag, such as `v0.1.4` |
| `source_run_id` | The `release.yml` run that retained and successfully smoke-tested the complete archive |
| `expected_source_commit` | Its full 40-character commit, also the tag target |
| `expected_full_sha256` | The retained complete archive's lowercase SHA-256 |
| `dry_run` | `true` for preparation; `false` for native publication |
| `resume_from_run_id` | Empty initially; the prior native workflow run for exact-byte reuse |

The source run must be complete and have a successful package-smoke step in
its actual run attempt. A later registry publication failure does not discard
valid retained bytes. The verifier checks the repository, workflow, tag,
commit, artifact identity, expiry and retained hashes before deriving anything.
It separately records the source archive commit and the workflow revision.

Preparation derives all six archives through the explicit ClawHub pack
profile, independently compares them with the complete archive, and runs real
SQLite write/close/reopen checks on both supported Node lines. The six exact
archives, derivation receipt, source context and validation result are retained
for 90 days. A dry run checks registry state and publication requests; it does
not prove that OIDC bindings work.

Before the first real run, every native package name must already exist and
have its own trusted publisher bound to repository `PopClaw-xyz/popclaw`,
workflow `release-clawhub-native.yml`, environment `npm-release`. Creating a
new package name requires an authorized npm account. Do not manually publish
the target release version as a bootstrap: later verification requires that
version's retained bytes and attestation. An exceptional bootstrap version or
manual provenance path requires the release owner's explicit decision.

After reviewing the retained dry-run artifacts, dispatch with `dry_run: false`
and `resume_from_run_id` set to that native run. The workflow downloads those
same six archives without repacking, rechecks the complete source and both
Node runtimes, and preflights all five registry names before any publication.
A missing name stops the run with `BOOTSTRAP_REQUIRED`. Existing versions must
match the retained SHA-512 and carry an attestation. Only missing versions are
published with OIDC/provenance, and each is verified before the next begins.
On partial failure, resume from the run retaining those exact bytes; never
rebuild or replace a published version. The original complete-source artifact
must also remain available and unexpired.

Only after all five native versions are verified may the retained main archive
be uploaded to ClawHub. Record the hosted download digest and perform the
clean `clawhub:` installation described above. Optional-dependency failures can
leave an OpenClaw archive installation in `installed-start-deferred`; a later
`POPCLAW_PLATFORM_DEPENDENCY_MISSING` error means runtime acceptance failed.
Restore the verified complete distribution through the normal maintenance
procedure and verify the same identity and database records after restart.

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
