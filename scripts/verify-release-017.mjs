// Verification only for the already published 0.1.7 archives. No build or publish.
import assert from 'node:assert/strict';
import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

export const RELEASE = Object.freeze({
  repository: 'PopClaw-xyz/popclaw', tag: 'v0.1.7', version: '0.1.7',
  commit: '801f5d76162de7f0a1ff66cdb89780a650586768',
  sourceRun: 38683082034, artifactId: 11949243158,
  artifactDigest: 'sha256:85be9e24bca5e8d9ca952dedd23f9ed0d13820152ccc4d7927675efb70d7411b',
  main: 'popclaw-plugin-0.1.7+2026-10-15-1303-801f5d7.tgz', shell: 'popclaw-mcp-0.1.7.tgz',
  sums: '99b19d8a0f7c0c6690f6eb0047eb4f41f64ef79cdb7d8deb2170aa2add17b325',
  packages: [
    { name: 'popclaw', role: 'main', sha256: 'b25a597f9daca99b837e260253f18febe3140bfdc430f23e88c39785ba33bac4', run: 38683082034, event: 'push' },
    { name: 'popclaw-mcp', role: 'shell', sha256: '55093da09955c2b4656c995535f0d0cf91ee33d757d23f7705bf0d090abd54d7', run: 38685413921, event: 'workflow_dispatch' },
  ],
});
const REGISTRY = 'https://registry.npmjs.org';
const PROVENANCE = 'https://slsa.dev/provenance/v1';
const PUBLISH = 'https://github.com/npm/attestation/tree/main/specs/publish/v0.1';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const hash = (bytes, algorithm = 'sha256', encoding = 'hex') => createHash(algorithm).update(bytes).digest(encoding);

export function verifyArchiveSet(directory) {
  const meta = JSON.parse(readFileSync(join(directory, 'release-metadata.json'), 'utf8'));
  assert.deepEqual(meta, { tag: RELEASE.tag, commit: RELEASE.commit, version: RELEASE.version, main: RELEASE.main, shell: RELEASE.shell }, 'original release metadata mismatch');
  for (const pkg of RELEASE.packages) assert.equal(hash(readFileSync(join(directory, RELEASE[pkg.role]))), pkg.sha256, pkg.name + ': original archive SHA-256 mismatch');
  assert.equal(hash(readFileSync(join(directory, 'SHA256SUMS.txt'))), RELEASE.sums, 'original checksum file mismatch');
}

export function verifySource(run, artifact, ref, annotatedTag) {
  assert.equal(run.id, RELEASE.sourceRun);
  assert.equal(run.head_sha, RELEASE.commit, 'original run source mismatch');
  assert.equal(run.head_branch, RELEASE.tag);
  assert.equal(run.path, '.github/workflows/release.yml');
  assert.equal(run.run_attempt, 1);
  assert.equal(run.status, 'completed');
  assert.equal(run.repository?.full_name, RELEASE.repository);
  assert.equal(artifact.id, RELEASE.artifactId);
  assert.equal(artifact.name, 'release-artefacts-' + RELEASE.tag);
  assert.equal(artifact.digest, RELEASE.artifactDigest, 'original retained artifact digest mismatch');
  assert.equal(artifact.expired, false, 'original retained artifact expired');
  assert.equal(artifact.workflow_run?.id, RELEASE.sourceRun);
  assert.equal(artifact.workflow_run?.head_sha, RELEASE.commit);
  let target = ref.object;
  if (target?.type === 'tag') {
    assert.equal(annotatedTag?.sha, target.sha, 'annotated tag identity mismatch');
    assert.equal(annotatedTag.tag, RELEASE.tag);
    target = annotatedTag.object;
  }
  assert.equal(target?.type, 'commit', 'release tag must resolve to a commit');
  assert.equal(target.sha, RELEASE.commit, 'release tag moved');
}

export function verifyStatement(statement, pkg, sha512, type) {
  assert.equal(statement.predicateType, type);
  assert.deepEqual(statement.subject, [{ name: `pkg:npm/${pkg.name}@${RELEASE.version}`, digest: { sha512 } }], 'attestation archive subject mismatch');
  if (type === PUBLISH) {
    assert.deepEqual(statement.predicate, { name: pkg.name, version: RELEASE.version, registry: REGISTRY });
    return;
  }
  const definition = statement.predicate?.buildDefinition;
  assert.equal(definition?.buildType, 'https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1');
  assert.deepEqual(definition.externalParameters?.workflow, {
    ref: 'refs/tags/' + RELEASE.tag, repository: 'https://github.com/' + RELEASE.repository, path: '.github/workflows/release.yml',
  }, 'provenance workflow mismatch');
  assert.deepEqual(definition.resolvedDependencies, [{
    uri: `git+https://github.com/${RELEASE.repository}@refs/tags/${RELEASE.tag}`, digest: { gitCommit: RELEASE.commit },
  }], 'provenance source mismatch');
  assert.equal(definition.internalParameters?.github?.event_name, pkg.event);
  assert.equal(definition.internalParameters?.github?.repository_id, '1402869531');
  assert.equal(definition.internalParameters?.github?.repository_owner_id, '278164688');
  assert.equal(statement.predicate.runDetails?.builder?.id, 'https://github.com/actions/runner/github-hosted');
  assert.equal(statement.predicate.runDetails?.metadata?.invocationId,
    `https://github.com/${RELEASE.repository}/actions/runs/${pkg.run}/attempts/1`, 'provenance publish run mismatch');
}

function registryKey(keys, id) {
  const key = keys.find(row => row.keyid === id);
  assert.ok(key && (!key.expires || Date.parse(key.expires) > Date.now()), 'missing or expired registry signing key');
  return createPublicKey({ key: Buffer.from(key.key, 'base64'), format: 'der', type: 'spki' });
}

export async function verifyPackage(pkg, metadata, bytes, keys, attestations, sigstore, tufCachePath) {
  assert.equal(metadata.name, pkg.name);
  assert.equal(metadata.version, RELEASE.version);
  assert.equal(hash(bytes), pkg.sha256, 'downloaded registry bytes differ from the original archive');
  const integrity = 'sha512-' + hash(bytes, 'sha512', 'base64');
  assert.equal(metadata.dist?.integrity, integrity, 'registry integrity mismatch');
  assert.ok(Array.isArray(metadata.dist.signatures) && metadata.dist.signatures.length, 'missing registry signatures');
  for (const signature of metadata.dist.signatures) {
    assert.ok(verifySignature('sha256', Buffer.from(`${pkg.name}@${RELEASE.version}:${integrity}`), registryKey(keys, signature.keyid), Buffer.from(signature.sig, 'base64')), 'invalid registry signature');
  }
  for (const type of [PUBLISH, PROVENANCE]) {
    const matches = attestations.attestations?.filter(row => row.predicateType === type);
    assert.equal(matches?.length, 1, 'missing or ambiguous ' + type);
    const bundle = matches[0].bundle;
    const statement = JSON.parse(Buffer.from(bundle.dsseEnvelope.payload, 'base64').toString('utf8'));
    verifyStatement(statement, pkg, hash(bytes, 'sha512'), type);
    const options = type === PROVENANCE ? {
      certificateIdentityURI: `https://github.com/${RELEASE.repository}/.github/workflows/release.yml@refs/tags/${RELEASE.tag}`,
      certificateIssuer: 'https://token.actions.githubusercontent.com',
    } : {
      keySelector: id => registryKey(keys, id).export({ type: 'spki', format: 'pem' }),
    };
    await sigstore.verify(bundle, { ...options, ...(tufCachePath ? { tufCachePath } : {}) });
  }
  return { name: pkg.name, version: RELEASE.version, sha256: pkg.sha256, publishRun: pkg.run, signatures: 'VERIFIED', provenance: 'VERIFIED' };
}

async function get(url, json = true) {
  // Only reads. No install lifecycle, registry mutation or GitHub write API.
  const headers = { 'User-Agent': 'PopClaw-release-verification' };
  if (url.startsWith('https://api.github.com/') && process.env.GH_TOKEN) headers.Authorization = 'Bearer ' + process.env.GH_TOKEN;
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(15000), redirect: 'error' });
      assert.ok(response.ok, `GET ${url}: HTTP ${response.status}`);
      return json ? await response.json() : Buffer.from(await response.arrayBuffer());
    } catch (error) {
      console.error(`read attempt ${attempt}/4: ${error.message}`);
      if (attempt === 4) throw error;
      await new Promise(done => setTimeout(done, 2000));
    }
  }
}

async function main() {
  assert.equal(process.argv.length, 4, 'usage: node scripts/verify-release-017.mjs ORIGINAL_ARTIFACT_DIRECTORY NEW_REPORT_DIRECTORY');
  const directory = resolve(process.argv[2]);
  const output = resolve(process.argv[3]);
  mkdirSync(output); // Do not overwrite earlier evidence or the original archives.
  const receipt = { status: 'FAIL', version: RELEASE.version, sourceCommit: RELEASE.commit, packages: [], node: process.version, scope: 'Verification only; no build, publish, tag or dist-tag mutation.' };
  try {
    verifyArchiveSet(directory);
    const api = `https://api.github.com/repos/${RELEASE.repository}`;
    const run = await get(`${api}/actions/runs/${RELEASE.sourceRun}`);
    const artifact = await get(`${api}/actions/artifacts/${RELEASE.artifactId}`);
    const ref = await get(`${api}/git/ref/tags/${RELEASE.tag}`);
    const annotatedTag = ref.object?.type === 'tag' ? await get(`${api}/git/tags/${ref.object.sha}`) : undefined;
    verifySource(run, artifact, ref, annotatedTag);
    writeFileSync(join(output, 'original-source.json'), JSON.stringify({ run, artifact, ref, annotatedTag }, null, 2));
    execFileSync('bash', [join(ROOT, 'scripts/verify-retained-artefacts.sh'), directory, RELEASE.tag, RELEASE.commit, RELEASE.version], { stdio: 'inherit' });
    const npmRoot = process.env.NPM_MODULE_ROOT;
    assert.ok(npmRoot, 'NPM_MODULE_ROOT must point to the pinned npm CLI installation');
    const require = createRequire(join(resolve(npmRoot), 'package.json'));
    const sigstore = require('sigstore');
    assert.equal(require('sigstore/package.json').version, '4.1.1', 'unexpected Sigstore verifier');
    receipt.sigstore = '4.1.1';
    receipt.npm = JSON.parse(readFileSync(join(npmRoot, 'package.json'), 'utf8')).version;
    assert.equal(receipt.npm, '11.19.1', 'unexpected npm verifier installation');
    assert.equal(execFileSync('npm', ['--version'], { encoding: 'utf8' }).trim(), receipt.npm, 'npm reader and verifier installation differ');
    const keys = await get(`${REGISTRY}/-/npm/v1/keys`);
    writeFileSync(join(output, 'registry-keys.json'), JSON.stringify(keys, null, 2));
    for (const pkg of RELEASE.packages) {
      execFileSync('bash', [join(ROOT, 'scripts/verify-published-package.sh'), pkg.name, RELEASE.version, join(directory, RELEASE[pkg.role])], { stdio: 'inherit' });
      const metadata = await get(`${REGISTRY}/${pkg.name}/${RELEASE.version}`);
      const tarball = `${REGISTRY}/${pkg.name}/-/${pkg.name}-${RELEASE.version}.tgz`;
      const attestationUrl = `${REGISTRY}/-/npm/v1/attestations/${pkg.name}@${RELEASE.version}`;
      assert.equal(metadata.dist?.tarball, tarball, 'unexpected registry tarball URL');
      assert.equal(metadata.dist?.attestations?.url, attestationUrl, 'unexpected attestation URL');
      const bytes = await get(tarball, false);
      const attestations = await get(attestationUrl);
      writeFileSync(join(output, pkg.name + '-metadata.json'), JSON.stringify(metadata, null, 2));
      writeFileSync(join(output, pkg.name + '-attestations.json'), JSON.stringify(attestations, null, 2));
      receipt.packages.push(await verifyPackage(pkg, metadata, bytes, keys.keys, attestations, sigstore, join(output, 'tuf')));
    }
    receipt.status = 'PASS';
    console.log('Both published 0.1.7 packages match the original tested archives; registry signatures and source/run-bound provenance verified.');
  } catch (error) {
    receipt.error = error.message;
    throw error;
  } finally {
    receipt.observedAt = new Date().toISOString();
    writeFileSync(join(output, 'verification.json'), JSON.stringify(receipt, null, 2) + '\n');
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}
