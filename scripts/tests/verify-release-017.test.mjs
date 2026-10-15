import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { RELEASE, verifyArchiveSet, verifySource, verifyStatement, verifyPackage } from '../verify-release-017.mjs';

const PROVENANCE = 'https://slsa.dev/provenance/v1';
const PUBLISH = 'https://github.com/npm/attestation/tree/main/specs/publish/v0.1';
const bytes = Buffer.from('synthetic original archive');
const sha = (algorithm, encoding = 'hex') => createHash(algorithm).update(bytes).digest(encoding);
const pkg = { ...RELEASE.packages[0], sha256: sha('sha256') };
const statement = (type = PROVENANCE) => ({
  predicateType: type, subject: [{ name: 'pkg:npm/popclaw@0.1.7', digest: { sha512: sha('sha512') } }],
  predicate: type === PUBLISH ? { name: 'popclaw', version: '0.1.7', registry: 'https://registry.npmjs.org' } : {
    buildDefinition: {
      buildType: 'https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1',
      externalParameters: { workflow: { ref: 'refs/tags/v0.1.7', repository: 'https://github.com/PopClaw-xyz/popclaw', path: '.github/workflows/release.yml' } },
      resolvedDependencies: [{ uri: 'git+https://github.com/PopClaw-xyz/popclaw@refs/tags/v0.1.7', digest: { gitCommit: RELEASE.commit } }],
      internalParameters: { github: { event_name: 'push', repository_id: '1402869531', repository_owner_id: '278164688' } },
    },
    runDetails: { builder: { id: 'https://github.com/actions/runner/github-hosted' }, metadata: { invocationId: `https://github.com/PopClaw-xyz/popclaw/actions/runs/${pkg.run}/attempts/1` } },
  },
});

test('fixed source accepts the original run/artifact/tag and rejects each changed binding', () => {
  const original = () => [{ id: RELEASE.sourceRun, head_sha: RELEASE.commit, head_branch: RELEASE.tag, path: '.github/workflows/release.yml', run_attempt: 1, status: 'completed', repository: { full_name: RELEASE.repository } },
    { id: RELEASE.artifactId, name: 'release-artefacts-v0.1.7', digest: RELEASE.artifactDigest, expired: false, workflow_run: { id: RELEASE.sourceRun, head_sha: RELEASE.commit } },
    { object: { type: 'commit', sha: RELEASE.commit } }];
  verifySource(...original());
  const annotated = original();
  annotated[2].object = { type: 'tag', sha: 'a'.repeat(40) };
  const annotation = { sha: 'a'.repeat(40), tag: RELEASE.tag, object: { type: 'commit', sha: RELEASE.commit } };
  verifySource(...annotated, annotation);
  assert.throws(() => verifySource(...annotated, { ...annotation, sha: 'b'.repeat(40) }));
  assert.throws(() => verifySource(...annotated, { ...annotation, object: { type: 'commit', sha: 'f'.repeat(40) } }));
  for (const mutate of [a => a[0].head_sha = 'f'.repeat(40), a => a[0].run_attempt = 2, a => a[0].path = 'other.yml', a => a[1].digest = 'sha256:other', a => a[1].expired = true, a => a[1].workflow_run.id = 1, a => a[2].object.sha = 'f'.repeat(40)]) {
    const fixture = original(); mutate(fixture); assert.throws(() => verifySource(...fixture));
  }
});

test('original release metadata refuses a changed source before archive access', () => {
  const temp = mkdtempSync(join(tmpdir(), 'release-017-negative-'));
  try {
    writeFileSync(join(temp, 'release-metadata.json'), JSON.stringify({ tag: RELEASE.tag, commit: 'f'.repeat(40), version: RELEASE.version, main: RELEASE.main, shell: RELEASE.shell }));
    assert.throws(() => verifyArchiveSet(temp), /metadata mismatch/);
  } finally { rmSync(temp, { recursive: true }); }
});

test('provenance accepts exact original identity and rejects source/run/subject changes', () => {
  verifyStatement(statement(), pkg, sha('sha512'), PROVENANCE);
  for (const mutate of [s => s.subject[0].digest.sha512 = 'bad', s => s.subject[0].name = 'pkg:npm/other@0.1.7', s => s.predicate.buildDefinition.resolvedDependencies[0].digest.gitCommit = 'f'.repeat(40), s => s.predicate.buildDefinition.externalParameters.workflow.ref = 'refs/heads/main', s => s.predicate.runDetails.metadata.invocationId += '0', s => s.predicate.buildDefinition.internalParameters.github.event_name = 'pull_request']) {
    const fixture = statement(); mutate(fixture); assert.throws(() => verifyStatement(fixture, pkg, sha('sha512'), PROVENANCE));
  }
});

function fixture() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const integrity = 'sha512-' + sha('sha512', 'base64');
  const metadata = { name: 'popclaw', version: '0.1.7', dist: { integrity,
    signatures: [{ keyid: 'fixture', sig: sign('sha256', Buffer.from('popclaw@0.1.7:' + integrity), privateKey).toString('base64') }] } };
  const keys = [{ keyid: 'fixture', key: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'), expires: null }];
  const attestations = { attestations: [PUBLISH, PROVENANCE].map(type => ({ predicateType: type, bundle: { dsseEnvelope: { payload: Buffer.from(JSON.stringify(statement(type))).toString('base64') } } })) };
  const calls = [];
  // Tests routing/policy only. A separate real Sigstore run verifies real bundles.
  const sigstore = { verify: async (bundle, options) => { calls.push(options); if (options.keySelector) assert.match(options.keySelector('fixture'), /PUBLIC KEY/); } };
  return { metadata, keys, attestations, sigstore, calls };
}

test('real registry signature and both attestation checks are required', async () => {
  const f = fixture();
  const result = await verifyPackage(pkg, f.metadata, bytes, f.keys, f.attestations, f.sigstore);
  assert.equal(result.provenance, 'VERIFIED'); assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].certificateIdentityURI, 'https://github.com/PopClaw-xyz/popclaw/.github/workflows/release.yml@refs/tags/v0.1.7');
  assert.equal(f.calls[1].certificateIssuer, 'https://token.actions.githubusercontent.com');
});

for (const [label, mutate] of [
  ['invalid registry signature', f => f.metadata.dist.signatures[0].sig = 'AAAA'],
  ['missing registry signature', f => f.metadata.dist.signatures = []],
  ['unknown registry key', f => f.keys = []],
  ['missing provenance', f => f.attestations.attestations.pop()],
  ['duplicate provenance', f => f.attestations.attestations.push(f.attestations.attestations[1])],
  ['invalid Sigstore bundle', f => f.sigstore = { verify: async () => { throw new Error('cryptographic rejection'); } }],
  ['registry bytes changed', f => f.bytes = Buffer.from('changed bytes')],
]) test(label + ' cannot pass verification', async () => {
  const f = fixture(); mutate(f);
  await assert.rejects(() => verifyPackage(pkg, f.metadata, f.bytes ?? bytes, f.keys, f.attestations, f.sigstore));
});

test('verification workflow has no publishing authority or mutable release selector', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/verify-release-017.yml', import.meta.url), 'utf8');
  assert.match(workflow, /workflow_dispatch:/);
  for (const forbidden of [/id-token:/, /contents: write/, /environment: npm-release/, /npm publish/, /dist-tag/, /just pack/, /push:/]) assert.doesNotMatch(workflow, forbidden);
  assert.match(workflow, /contents: read/); assert.match(workflow, /actions: read/);
  assert.match(workflow, /run-id: 38683082034/); assert.match(workflow, /artifact-ids: 11949243158/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /node scripts\/verify-release-017.mjs/);
  const source = readFileSync(new URL('../verify-release-017.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /fetch\([^\n]*method:\s*['"](?:POST|PUT|DELETE|PATCH)/);
  assert.doesNotMatch(source, /execFileSync\(['"](?:git|just)['"]/);
  const npmCalls = [...source.matchAll(/execFileSync\('npm', \[([^\]]*)\]/g)];
  assert.equal(npmCalls.length, 1); assert.equal(npmCalls[0][1], "'--version'");
});
