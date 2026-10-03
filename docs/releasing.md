# Releasing

How a release reaches npm, and what only a maintainer with registry access can
do. The machinery is `.github/workflows/release.yml`.

A release is **two packages**, published in one workflow run, in one order:

| package | what it is | packed by |
|---|---|---|
| `popclaw` | the implementation: bundle, native bindings, migrations | `just pack-plugin` |
| `popclaw-mcp` | two bin aliases and `"dependencies": {"popclaw": "<same version>"}` | `just pack-mcp-shell` |

`popclaw-mcp` cannot install until `popclaw` is on the registry at exactly its
version. So `popclaw` goes first, is verified on the registry, and only then
does the shell go out. The two recipes carry opposite guards on purpose:
`pack-plugin` aborts below 11 prebuilt native bindings, `pack-mcp-shell` aborts
if the shell tarball contains any `dist/`, `native-deps`, `migrations` or
`wallet-migrations` — or if its version and its `popclaw` dependency are not the
exact same string as the plugin's version. Neither floor may be loosened to let
one recipe serve both packages.

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
`resume_from_run_id` is refused, and so is `resume_from_run_id` with
`only: all` — that would mean republishing `popclaw`.

Artefacts are retained for **90 days**: long enough for the owner to decide
without a deadline, and the maximum GitHub allows for a public repository.

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

Publishing by hand is a valid fallback and costs that version its provenance.
Take the cost explicitly: in the same change, remove the two sentences that
promise it — `CONTRIBUTING.md` (§"How releases are cut", the bullet beginning
"The package is built from a clean checkout") and `docs/hosts.md` (§"Before you
start", the sentence beginning "The real `popclaw` package is published"). Put
them back when the next version ships through the workflow. The docs and the
artefact say the same thing, or one of them is wrong.

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
