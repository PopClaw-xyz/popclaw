#!/usr/bin/env bash
#
# Usage: verify-published-package.sh <package> <version> <local tarball>
#
# Proves three things about what the registry now holds:
#   1. the version is readable at all;
#   2. it carries a provenance attestation — a green `npm publish` step does
#      not prove one exists, the registry creates it after the upload;
#   3. its bytes are the bytes of the tarball this run tested, via
#      dist.integrity (sha512) or, failing that, dist.shasum (sha1). A matching
#      version string alone would also match a package someone published by
#      hand from a different tree, which is the failure this exists for.
#
# A file rather than a heredoc inside .github/workflows/release.yml so that
# apps/popclaw-plugin/tests/unit/release-scripts.test.ts can run these exact
# bytes against a fake registry. A comparison that only exists as a string
# inside YAML can be gutted without a single test going red.
#
# REGISTRY_POLL_ATTEMPTS / REGISTRY_POLL_SLEEP exist for that test. A release
# uses the defaults.
set -uo pipefail

if [ "$#" -ne 3 ]; then
  echo "usage: $0 <package> <version> <tarball>" >&2
  exit 2
fi
pkg="$1"
version="$2"
tgz="$3"
attempts="${REGISTRY_POLL_ATTEMPTS:-6}"
sleep_seconds="${REGISTRY_POLL_SLEEP:-10}"

if [ ! -f "$tgz" ]; then
  echo "::error::no such tarball: ${tgz}" >&2
  exit 1
fi

dist=""
attempt=1
while [ "$attempt" -le "$attempts" ]; do
  if dist=$(npm view "${pkg}@${version}" dist --json 2>/dev/null) && [ -n "$dist" ]; then
    break
  fi
  dist=""
  echo "registry not ready yet (attempt ${attempt} of ${attempts})"
  [ "$attempt" -lt "$attempts" ] && sleep "$sleep_seconds"
  attempt=$((attempt + 1))
done

if [ -z "$dist" ]; then
  echo "::error::${pkg}@${version} is not readable from the registry"
  exit 1
fi
printf '%s\n' "$dist"

integrity="sha512-$(openssl dgst -sha512 -binary "$tgz" | openssl base64 -A)"
shasum_hex=$(openssl dgst -sha1 -hex "$tgz" | awk '{print $NF}')

printf '%s' "$dist" | node -e '
  let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
    const dist = JSON.parse(s);
    const [pkg, version, integrity, shasum] = process.argv.slice(1);
    const id = pkg + "@" + version;
    const fail = (m) => { console.error("::error::" + m); process.exit(1); };
    if (!dist.attestations) {
      fail(id + " is on the registry WITHOUT a provenance attestation. The version number is burned: do not announce it, do not republish it. Check the trusted-publisher binding for " + pkg + " on npmjs.com (organisation, repository, workflow filename release.yml, environment npm-release) and docs/releasing.md.");
    }
    if (dist.integrity) {
      if (dist.integrity !== integrity) {
        fail(id + " on the registry has integrity " + dist.integrity + ", but the tarball this run tested hashes to " + integrity + ". The registry is serving bytes that were never tested here.");
      }
    } else if (dist.shasum) {
      if (dist.shasum !== shasum) {
        fail(id + " on the registry has shasum " + dist.shasum + ", the tested tarball has " + shasum + ".");
      }
    } else {
      fail(id + " reports neither dist.integrity nor dist.shasum, so its bytes cannot be checked against the tested tarball.");
    }
    console.log(id + ": attestation present, registry bytes match the tested tarball");
  });
' "$pkg" "$version" "$integrity" "$shasum_hex"
