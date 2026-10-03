#!/usr/bin/env bash
#
# Self-check for `just pack-mcp-shell`.
#
# The recipe's job is to REFUSE, and a guard that has never been seen refusing
# is a guard nobody has tested. This script builds three deliberately broken
# copies of packages/popclaw-mcp in a scratch directory, points the recipe at
# each, and asserts a non-zero exit and the message that explains it — then
# asserts the unmodified shell still packs.
#
# It is here rather than in vitest because the thing under test is a just
# recipe: vitest would be spawning `just` and diffing stderr either way, and
# this way the same script is what CI runs and what a maintainer runs by hand.
#
# Usage: scripts/selfcheck-pack-mcp-shell.sh      (from the repository root)
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$root"

scratch=$(mktemp -d "${TMPDIR:-/tmp}/popclaw-mcp-selfcheck.XXXXXX")
trap 'rm -rf "$scratch"' EXIT
echo "scratch: $scratch"

failures=0

# Run the recipe against a copy of the shell, expect failure, and expect the
# message to say why. $1 = case name, $2 = expected substring of stderr,
# $3.. = a node expression applied to the copy before packing (optional).
expect_refusal() {
  local name="$1" expected="$2" mutate="$3"
  local dir="$scratch/$name"
  mkdir -p "$dir"
  cp -R packages/popclaw-mcp/. "$dir/"
  node -e "$mutate" "$dir"
  local out=""
  local rc=0
  out=$(just pack-mcp-shell "$dir" "$scratch/out-$name" 2>&1) || rc=$?
  echo "--- $name (exit $rc) ---"
  printf '%s\n' "$out"
  if [ "$rc" -eq 0 ]; then
    echo "SELF-CHECK FAILED: $name packed successfully; the guard did not fire."
    failures=$((failures + 1))
    return
  fi
  if ! printf '%s' "$out" | grep -qF "$expected"; then
    echo "SELF-CHECK FAILED: $name refused, but without the message a maintainer needs."
    echo "  expected to find: $expected"
    failures=$((failures + 1))
  fi
}

# 1. The shell claims a version popclaw does not have.
expect_refusal version-mismatch \
  "the shell publishes in lock step with the package it aliases" \
  'const fs=require("node:fs"),p=process.argv[1]+"/package.json",m=JSON.parse(fs.readFileSync(p,"utf8"));m.version="0.1.1";fs.writeFileSync(p,JSON.stringify(m,null,2));'

# 2. The dependency is a range. Resolves today, drifts tomorrow.
expect_refusal caret-dependency \
  "a range (^ ~ >=) lets the alias resolve to a build it was never tested against" \
  'const fs=require("node:fs"),p=process.argv[1]+"/package.json",m=JSON.parse(fs.readFileSync(p,"utf8"));m.dependencies.popclaw="^"+m.version;fs.writeFileSync(p,JSON.stringify(m,null,2));'

# 3. A copy of the runtime sneaks in. Note the `files` entry is a PATH, not the
#    bare string "dist": the manifest-level test in
#    apps/popclaw-plugin/tests/unit/mcp-shell-lockstep.test.ts compares against
#    "dist" and would let this through. Only the tarball knows.
expect_refusal stray-dist \
  "the shell must not carry a second copy of the runtime" \
  'const fs=require("node:fs"),d=process.argv[1],p=d+"/package.json",m=JSON.parse(fs.readFileSync(p,"utf8"));fs.mkdirSync(d+"/dist/bundled",{recursive:true});fs.writeFileSync(d+"/dist/bundled/index.js","// a second copy of the runtime\n");m.files.push("dist/bundled/index.js");fs.writeFileSync(p,JSON.stringify(m,null,2));'

# The stray-dist case must also have deleted the tarball it refused, or the
# release job would find a rejected artefact sitting in the destination.
if compgen -G "$scratch/out-stray-dist/*.tgz" >/dev/null; then
  echo "SELF-CHECK FAILED: a refused tarball was left in $scratch/out-stray-dist"
  failures=$((failures + 1))
fi

# 4. The real thing still packs.
echo "--- unmodified shell ---"
if ! just pack-mcp-shell packages/popclaw-mcp "$scratch/out-ok"; then
  echo "SELF-CHECK FAILED: the unmodified shell does not pack."
  failures=$((failures + 1))
fi

if [ "$failures" -ne 0 ]; then
  echo "pack-mcp-shell self-check: ${failures} case(s) failed"
  exit 1
fi
echo "pack-mcp-shell self-check: all four cases behaved"
