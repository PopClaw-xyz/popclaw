#!/usr/bin/env bash
#
# Usage: verify-retained-artefacts.sh <directory> <tag> <commit> <version>
#
# A resume run publishes bytes an EARLIER run packed and tested. Before it may
# do that, the retained set has to prove it belongs to this release:
#
#   1. every file still hashes to what that run recorded (SHA256SUMS.txt);
#   2. release-metadata.json names this tag AND the commit this tag points at.
#      The artefact's name containing the tag is not that proof: a name is a
#      label anyone can reuse, and a tag can be moved to a different commit
#      after a release fails. Both are checked against the dispatch, by value;
#   3. the version agrees, and the shell tarball inside still declares the
#      exact `popclaw` dependency the alias is only safe with.
#
# On success it prints the two absolute tarball paths as KEY=value lines, ready
# for $GITHUB_ENV. It writes nothing and touches no network.
set -uo pipefail

if [ "$#" -ne 4 ]; then
  echo "usage: $0 <directory> <tag> <commit> <version>" >&2
  exit 2
fi
dir="$1"
expected_tag="$2"
expected_commit="$3"
expected_version="$4"

if [ ! -d "$dir" ]; then
  echo "::error::no such directory: ${dir}" >&2
  exit 1
fi
cd "$dir" || exit 1
dir_abs=$(pwd)

for required in SHA256SUMS.txt release-metadata.json; do
  if [ ! -f "$required" ]; then
    echo "::error::the retained artefacts have no ${required}; they were produced before this workflow recorded one, and cannot be resumed from"
    exit 1
  fi
done

cat SHA256SUMS.txt
if command -v sha256sum >/dev/null 2>&1; then
  sha256sum --check --strict SHA256SUMS.txt || exit 1
else
  shasum -a 256 --check --strict SHA256SUMS.txt || exit 1
fi

metadata=$(cat release-metadata.json)
printf '%s\n' "$metadata"
printf '%s' "$metadata" | node -e '
  let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
    const meta = JSON.parse(s);
    const [tag, commit, version] = process.argv.slice(1);
    const fail = (m) => { console.error("::error::" + m); process.exit(1); };
    if (meta.tag !== tag) {
      fail("the retained artefacts were packed for tag " + meta.tag + ", this run was dispatched for " + tag + ". Resume the run that packed the tag you are publishing.");
    }
    if (meta.commit !== commit) {
      fail("the retained artefacts were packed from commit " + meta.commit + ", but " + tag + " now points at " + commit + ". Either the tag moved or these artefacts belong to another run; publishing them would ship bytes no one can trace back to this tag.");
    }
    if (meta.version !== version) {
      fail("the retained artefacts are version " + meta.version + ", this run was dispatched for " + version + ".");
    }
    console.log("retained artefacts belong to " + tag + " at " + commit);
  });
' "$expected_tag" "$expected_commit" "$expected_version" || exit 1

main_tgz=$(node -e 'process.stdout.write(JSON.parse(require("node:fs").readFileSync("release-metadata.json","utf8")).main || "")')
shell_tgz=$(node -e 'process.stdout.write(JSON.parse(require("node:fs").readFileSync("release-metadata.json","utf8")).shell || "")')
for named in "$main_tgz" "$shell_tgz"; do
  if [ -z "$named" ] || [ ! -f "$named" ]; then
    echo "::error::release-metadata.json names ${named:-(nothing)}, which is not in the retained set"
    exit 1
  fi
  # Exact field comparison, not a regex: these names carry `+` and `.`.
  if ! awk -v want="$named" '{ n = $2; sub(/^\*/, "", n); sub(/^\.\//, "", n); if (n == want) found = 1 } END { exit !found }' SHA256SUMS.txt; then
    echo "::error::${named} is not listed in SHA256SUMS.txt, so its bytes were never checked"
    exit 1
  fi
done

tar -xzOf "$shell_tgz" package/package.json > ./retained-shell-manifest.json || exit 1
node -e '
  const pkg = JSON.parse(require("node:fs").readFileSync("./retained-shell-manifest.json", "utf8"));
  const version = process.argv[1];
  const fail = (m) => { console.error("::error::" + m); process.exit(1); };
  if (pkg.name !== "popclaw-mcp") fail("the retained shell tarball declares name " + pkg.name);
  if (pkg.version !== version) fail("the retained shell tarball is version " + pkg.version + ", expected " + version);
  const deps = JSON.stringify(pkg.dependencies);
  const wanted = JSON.stringify({ popclaw: version });
  if (deps !== wanted) fail("the retained shell tarball depends on " + deps + ", expected exactly " + wanted);
  console.log("retained shell manifest ok:", pkg.name, pkg.version);
' "$expected_version" || exit 1
rm -f ./retained-shell-manifest.json

echo "MAIN_TGZ=${dir_abs}/${main_tgz}"
echo "SHELL_TGZ=${dir_abs}/${shell_tgz}"
