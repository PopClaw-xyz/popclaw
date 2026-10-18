# Releasing

Maintainer procedure for publishing fixed PopClaw artifacts. For the current
version's availability and tested scope, read the [support matrix](support-matrix.md#018-release-verification).

## Release order

1. Review the fixed source, attribution and required checks.
2. Pack and smoke-test the full package and MCP shell; retain the exact bytes.
3. Publish and verify `popclaw`, then its exact-version `popclaw-mcp` shell.
4. If ClawHub is in scope, derive its client/native archives, publish and verify
   all five native packages, verify the main archive's attestation, then upload it.
5. Verify public downloads and the authorized host checks. Publish the GitHub
   Release and update the support record with actual results before announcing.

GitHub Release and ClawHub are separate channels; an approved Release need not
wait for ClawHub. Keep unfinished channels explicit. Publishing does not authorize
a daily-host upgrade, deployment or announcement.

## Before a release

- Record the approved version, source commit/tree, tag, channels and artifact hashes.
  Audit the complete pending Git range: raw author, committer, full messages and
  trailers. PopClaw's own work belongs to heiyuneo; preserve real third-party
  attribution and add no AI authorship. Check platform-generated merge commits too.
- Check the public README paths, required source CI, CodeQL, publication checks,
  independent review and exact-package smoke. Source tests do not test the tarballs.
  Disclose skipped checks and their scope; retain failed results.
- Run the current [Justfile](../Justfile) and reviewed workflows. The standard
  [release workflow](../.github/workflows/release.yml) uses GitHub-hosted `macos-15`,
  Node 24.16.0 and npm 11.19.1. Full packing requires Darwin; self-hosted runners
  are not supported for npm trusted publishing.
- Confirm a trusted publisher for **each** package, the exact repository/workflow
  filename and `npm-release` environment. Recheck after a repository rename or move.
  Both standard manifests and the packed output must retain the public repository URL.
- A dry run checks builds and publication requests, not OIDC authentication.
  Only an actual publish exercises that package's binding. A public scratch
  repository and disposable packages are required for a full authorized rehearsal.

See [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/) for current
service requirements. New bindings must complete their first successful publish
within two days; verification of an existing version does not satisfy that gate.
The standard workflow uses OIDC, not an npm token. Environment reviewers can guard
publication; a pull request cannot create the account configuration.

## Package contracts

| Package | Contents and pack command |
| --- | --- |
| `popclaw` | Full implementation, migrations, notices and native bindings: `just pack-plugin`. |
| `popclaw-mcp` | Thin bin aliases with an exact same-version `popclaw` dependency: `just pack-mcp-shell`. No `dist/`, native bindings or migrations. |
| `popclaw-clawhub` | Client graph derived from the verified full archive, plus five exact-version optional native dependencies. Plugin ID stays `popclaw`. |

Keep the entire ESM chunk directory and its notices. The full archive carries
both `dist/bundled/` and the separately inventoried `dist/client-bundled/` graph.
Derivation promotes the latter without recompiling. It excludes operator Ranger,
scraping/watch, provider-key discovery and local persona-file naming; ordinary
social tools, identity/storage and consumer services remain. Operators use the full package.

The full native matrix is ten bindings: macOS arm64/x64, Linux glibc arm64/x64
and Windows x64, each for Node 24 (ABI 137) and 26 (ABI 147). The packer verifies
names, binary headers and ABIs. `POPCLAW_NATIVE_DEPS_MINIMAL=1` is development-only;
do not lower guards to accept a missing binding. The complete package retains its
source-build fallback. ClawHub requires optional dependencies and fails closed
on missing/incompatible/modified bindings, without silently downloading or rebuilding.

`@popclaw/mcp` is an unrelated placeholder: do not publish, deprecate or delete it.
The shipped shell uses `popclaw-mcp`. Spell hook invocations explicitly:
`npx -y --package=popclaw-mcp@VERSION popclaw-mcp-hook UserPromptSubmit`.

## Standard npm workflow

Pushing a new, approved `v*` tag triggers [release.yml](../.github/workflows/release.yml).
It runs install/build/test/lint, protocol checks, both packers and archive smoke;
retains both archives, metadata and `SHA256SUMS.txt`; then publishes and verifies
`popclaw` before `popclaw-mcp`. Never move a frozen tag to change release tooling.

For a manual dispatch, select the reviewed workflow revision and supply:

| Input | Fresh release | Shell recovery |
| --- | --- | --- |
| `tag` | Exact approved release tag | Same frozen tag |
| `dry_run` | `true` to rehearse; `false` to publish | `false` |
| `only` | `all` | `shell` |
| `resume_from_run_id` | Empty | Original run retaining the tested archives |

For a full run that will feed native derivation, dispatch on the tag, not `main`:
the native verifier requires the source run's branch and SHA to match the tag.
Retained artifacts expire after 90 days. Preserve approved evidence before expiry.

### Verification and recovery

1. Read exact registry versions, downloaded tarballs and attestations separately.
   An accepted upload can precede readable metadata or signatures. Preserve stderr,
   exit status and failed workflow conclusions; do not infer an unproven cause.
2. Compare actual downloaded bytes with the retained archives. Verify registry
   signatures, npm publish attestations and Sigstore provenance cryptographically,
   including the actual repository, source/ref, workflow, run/event and negative controls.
   Publish proofs require matching DSSE key IDs and registry public keys; certificates
   are accepted only for provenance under the GitHub identity/issuer policy.
   An attestation field or matching version string alone is insufficient.
3. If only the shell is missing, use the recovery inputs above. The
   [retained verifier](../scripts/verify-retained-artefacts.sh) checks checksums,
   current tag target, release metadata and exact shell dependency. It verifies the
   already published main package, then publishes and verifies the retained shell.
4. Never rebuild to resume: embedded timestamps change the archive. Never replace
   a published version or unpublish it to retry. Changed bytes require a new version
   for both standard packages. Resume provenance belongs to the actual recovery run.

The [registry reader](../scripts/verify-published-package.sh) makes at most 24
reads, ten seconds apart, with 15-second requests and nested npm retries disabled.
It stops immediately on a hash mismatch. Exhaustion is a failure, not permission
to publish again. Manual publication needs the release owner's decision after
recording the checks it would lose; it must not be described as workflow-attested.

## ClawHub preparation and native publication

Derive only from a fixed, verified full archive:

```sh
just pack-plugin clawhub /absolute/path/popclaw-plugin-VERSION+BUILD.tgz /absolute/output
```

This produces one client archive, five native archives and `receipt.json` in a
new directory suffixed with the full archive hash's first 12 characters. Existing
outputs cannot be overwritten. Paths, file types, client inventory, modes, licenses
and native bindings are checked; an older full archive without the client graph
cannot produce this profile. Retained older releases use their original verification contract.

Run focused distribution regressions before packing or changing the verifier:

```sh
pnpm --filter popclaw exec vitest run tests/unit/client-bundle-profile.test.ts tests/unit/runtime/build-scraper.test.ts tests/unit/quest/verify-invite
node --test apps/popclaw-plugin/scripts/tests/clawhub-platform-package.fixture.mjs
python3 -B -m unittest discover -s scripts/tests -p test_verify_retained_clawhub.py
python3 -B scripts/tests/test_published_verification.py
node --test scripts/tests/verify-release-017.test.mjs
```

These fixtures do not replace real retained-archive SQLite or signature checks.
Use [release-clawhub-native.yml](../.github/workflows/release-clawhub-native.yml):

| Input | Value |
| --- | --- |
| `tag` | Exact full release tag |
| `source_run_id` | `release.yml` run retaining the full archive with a successful package-smoke step |
| `expected_source_commit` | Full 40-character source commit, equal to the tag target and source run SHA |
| `expected_full_sha256` | Retained full archive's lowercase SHA-256 |
| `dry_run` | `true` first; `false` after artifact review |
| `auth_mode` | `oidc`; first-publication exception below |
| `resume_from_run_id` | Empty for preparation; prior native run for exact-byte publication/recovery |

The source run must be a completed `push` or `workflow_dispatch` on the exact tag,
with conclusion `success` or `failure` and a successful smoke step in its actual
attempt. The [verifier](../scripts/verify-retained-clawhub.py) checks repository,
workflow, artifact identity/expiry, hashes and source metadata. A later registry
failure does not discard valid bytes. The native workflow may use reviewed newer
`main` tooling; record that workflow revision separately from the frozen source.

Preparation verifies all six derived archives and real SQLite write/close/reopen
on both Node lines, retaining artifacts and context for 90 days. After review,
resume those same bytes with `dry_run: false`. All five names are preflighted;
existing target versions must match the retained digest and attestations before
missing versions are published and verified one by one. Unknown registry responses
stop the run. Neither `popclaw`, its MCP shell nor the ClawHub upload is published here.

The native step permits 91 reads ten seconds apart, within a 95-minute job limit.
This is a bounded wait, not a propagation guarantee. On timeout, inspect the original
run and exact registry version before resuming; keep both original and derived artifacts.

### First publication of native package names

A missing name in OIDC mode stops with `BOOTSTRAP_REQUIRED`. Only for an authorized
first publication, use `auth_mode: bootstrap-token` and a short-lived token stored
as `NPM_BOOTSTRAP_TOKEN` in `npm-release`. Publish the real reviewed archives,
never empty placeholders or extra test versions. Authorize account permissions
and any noninteractive 2FA change separately; keep tokens out of files, inputs and logs.

Only actual publish subprocesses receive that token; build, smoke, dry-run and
verification steps do not. Provenance still uses OIDC signing. Bootstrap accepts
new names or names containing only the target version from a partial first release;
any other version blocks it. Revoke the token and delete the secret after verification,
then bind each name to `release-clawhub-native.yml` and `npm-release` for later releases.

A registry-generated `0.0.0-stage` stub can block recovery. Only after checking
the real version's bytes/provenance and obtaining explicit cleanup authorization,
remove that exact stub version; never remove the whole package or use `--force`.
Recheck the target and `latest`. Keep the [recorded stub incident](https://github.com/PopClaw-xyz/popclaw/blob/5da0b2f8d5600637fa1e6fef4ec7b752d9b8fd37/docs/releasing.md#separate-clawhub-native-publication)
as history, not a reason to weaken the guard.

## Verify the ClawHub archive attestation

After real native publication succeeds, `attest-main` independently rechecks and
signs three retained subjects: the client archive, `receipt.json` and
`release-context.json`. A dry run creates no attestation. Download
`clawhub-attestation-<tag>-<run-attempt>` and keep its bundle, subjects and checksum
file with the archive; attach the evidence to the public release.

Set these values to the approved version and actual **attesting workflow commit**:

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

Also verify each subject with the exact certificate identity and GitHub issuer
from the reviewed attesting run, in a separate invocation as described by
[`gh attestation verify`](https://cli.github.com/manual/gh_attestation_verify).
Inspect the verified run identity and hosted runner; match signed context to the
approved source tuple and the archive to its receipt. Build and attesting identities
can differ. A successful upload or workflow file is not signature evidence.

## Upload, install and close out

- Recheck the current [ClawHub publishing procedure](https://docs.openclaw.ai/clawhub/publishing)
  and [CLI](https://docs.openclaw.ai/clawhub/cli). Validate the extracted package,
  dry-run the exact `.tgz`, then publish that same archive as `code-plugin` with
  explicit public source repository, commit and ref. Verify publisher identity.
- If waiting times out, inspect the original attempt before any retry. A pending
  upload is not a release. Download the public version, compare its bytes and
  inventory, and repeat both archive-signature verification modes.
- Check each scanner's actual result. `null` is not a pass. Record ClawHub source
  metadata separately from GitHub signatures and [OpenClaw runtime trust](https://docs.openclaw.ai/tools/plugin#plugin-runtime-trust-refused).
  `source-linked`, `plugins.allow` and OIDC do not grant official-plugin trust.
  Preserve required tool declarations when an inspector disputes manifest metadata.
- For authorized fresh-host acceptance, install `clawhub:popclaw-clawhub@VERSION`
  in an isolated supported host and start the real Gateway. Check registration,
  SQLite write/reopen and identity persistence. `installed-start-deferred` or an
  installer success alone is insufficient; `POPCLAW_PLATFORM_DEPENDENCY_MISSING`
  is a runtime failure. Use the normal maintenance procedure to restore the verified
  full distribution and recheck identity/data. Test reload/upgrade/rollback/uninstall separately.
- Create the authorized GitHub Release from the frozen tag and original assets.
  Read back body, tag, draft/prerelease/Latest flags and every anonymous asset download.
  Retain Developer Preview wording and actual scanner, host and failed-run limits.
- Check raw Git attribution, public Contributors UI and paginated API separately.
  A clean API cannot clear an AI name still visible in the UI. Do not hide the
  sidebar or rewrite old refs as part of release verification.
- Update this run's evidence and [support matrix](support-matrix.md); keep source
  tests, artifact checks, publication, installation and live social acceptance distinct.
  Public tarballs cannot be made private again. Do not promise rollback by unpublishing.

## Historical recovery procedures

Use these only for their fixed versions; they do not authorize a new publication:

- [0.1.7 read-only verification](https://github.com/PopClaw-xyz/popclaw/blob/5da0b2f8d5600637fa1e6fef4ec7b752d9b8fd37/docs/releasing.md#verify-the-already-published-017-packages): `gh workflow run verify-release-017.yml --repo PopClaw-xyz/popclaw --ref main`. It publishes nothing and retains its failed-run context.
- [Fixed first-release recovery](https://github.com/PopClaw-xyz/popclaw/blob/5da0b2f8d5600637fa1e6fef4ec7b752d9b8fd37/docs/releasing.md#fixed-first-release-recovery-both-retained-packages): the sole `only: all` retained-resume exception is `v0.1.0`, `dry_run: false`, `resume_from_run_id: 38074322285`. Its original artifact IDs, hashes and source checks remain mandatory.
- [Earlier packaging and trust investigation](https://github.com/PopClaw-xyz/popclaw/blob/5da0b2f8d5600637fa1e6fef4ec7b752d9b8fd37/docs/releasing.md#verify-the-clawhub-archive-attestation) preserves the inspector and source-metadata findings; check the current service before reusing them.
