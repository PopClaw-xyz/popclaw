#!/usr/bin/env bash
# Verify the fixed published version against the original tested archive.
# This is a read-only readiness check, not cryptographic provenance validation.
# verify-release-017.mjs performs the latter for the 0.1.7 verification-only run.
# REGISTRY_POLL_ATTEMPTS / REGISTRY_POLL_SLEEP allow fast deterministic tests.
set -euo pipefail

if [ "$#" -ne 3 ]; then
  echo "usage: $0 <package> <version> <tarball>" >&2
  exit 2
fi
pkg="$1"
version="$2"
tgz="$3"
attempts="${REGISTRY_POLL_ATTEMPTS:-24}"
sleep_seconds="${REGISTRY_POLL_SLEEP:-10}"
if ! [[ "$attempts" =~ ^[1-9][0-9]*$ ]] || [ "${#attempts}" -gt 3 ] || [ "$attempts" -gt 120 ]; then
  echo '::error::REGISTRY_POLL_ATTEMPTS must be an integer from 1 to 120' >&2
  exit 2
fi
if ! [[ "$sleep_seconds" =~ ^[0-9]+$ ]] || [ "${#sleep_seconds}" -gt 2 ] || [ "$sleep_seconds" -gt 60 ]; then
  echo '::error::REGISTRY_POLL_SLEEP must be an integer from 0 to 60' >&2
  exit 2
fi
if [ ! -f "$tgz" ]; then
  echo "::error::no such tarball: ${tgz}" >&2
  exit 1
fi
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
integrity="sha512-$(openssl dgst -sha512 -binary "$tgz" | openssl base64 -A)"
shasum_hex=$(openssl dgst -sha1 -hex "$tgz" | awk '{print $NF}')
state=unreadable
for ((attempt = 1; attempt <= attempts; attempt++)); do
  echo "checking ${pkg}@${version} (attempt ${attempt} of ${attempts})"
  if npm view "${pkg}@${version}" dist --json --registry=https://registry.npmjs.org \
      --prefer-online --fetch-retries=0 --fetch-timeout=15000 \
      >"$scratch/dist.json" 2>"$scratch/npm.stderr"; then
    rc=0
  else
    rc=$?
  fi
  # Prefix external output so it cannot become an Actions workflow command.
  if [ -s "$scratch/npm.stderr" ]; then sed 's/^/npm read stderr: /' "$scratch/npm.stderr" >&2; fi
  if [ "$rc" -eq 0 ] && [ -s "$scratch/dist.json" ]; then
    state=pending
    if node - "$scratch/dist.json" "$pkg" "$version" "$integrity" "$shasum_hex" <<'NODE'
const fs = require('node:fs');
const [file, pkg, version, integrity, shasum] = process.argv.slice(2);
const id = pkg + '@' + version;
const stop = (message, code) => { console.error(message); process.exit(code); };
let dist;
try { dist = JSON.parse(fs.readFileSync(file, 'utf8')); }
catch { stop(id + ': invalid registry JSON; retrying the read', 10); }
if (!dist || typeof dist !== 'object' || Array.isArray(dist)) stop(id + ': invalid dist metadata', 10);
if (dist.integrity) {
  if (dist.integrity !== integrity) stop('::error::' + id + ' on the registry has integrity ' + dist.integrity + ', but the tarball this run tested hashes to ' + integrity + '. The registry is serving bytes that were never tested here.', 1);
} else if (dist.shasum) {
  if (dist.shasum !== shasum) stop('::error::' + id + ' on the registry has shasum ' + dist.shasum + ', the tested tarball has ' + shasum + '.', 1);
} else stop(id + ' reports neither dist.integrity nor dist.shasum; retrying the read', 10);
if (!dist.attestations || typeof dist.attestations.url !== 'string' || !dist.attestations.url) {
  stop(id + ' is on the registry WITHOUT a provenance attestation; retrying the read. Do not republish this version.', 10);
}
console.log(id + ': attestation present, registry bytes match the tested tarball');
NODE
    then
      exit 0
    else
      rc=$?
      # Bytes must never be retried until a different archive appears to match.
      if [ "$rc" -ne 10 ]; then exit "$rc"; fi
    fi
  else
    state=unreadable
    echo "registry read failed for ${pkg}@${version}: npm exit ${rc}, response bytes $(wc -c < "$scratch/dist.json" | tr -d ' ')" >&2
  fi
  if [ "$attempt" -lt "$attempts" ]; then sleep "$sleep_seconds"; fi
done
if [ "$state" = unreadable ]; then
  echo "::error::${pkg}@${version} is not readable from the registry after ${attempts} attempts; see the npm errors above. The cause is not established." >&2
else
  echo "::error::${pkg}@${version} metadata did not become verifiable after ${attempts} attempts. Keep the original archives and failure logs; do not republish this version." >&2
fi
exit 1
