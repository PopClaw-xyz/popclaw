import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The release workflow's two dangerous comparisons — "are the bytes on the
 * registry the bytes we tested" and "do these retained artefacts belong to
 * this tag and this commit" — used to live inside release.yml as strings. A
 * test that greps YAML for `dist.integrity` stays green while someone deletes
 * the comparison and leaves the word in a comment, which is exactly what a
 * review found. So both now live in scripts/, and this file RUNS them: a fake
 * `npm` first on PATH answers with fixtures, and the tarballs are real files
 * hashed here, independently, with node's own crypto.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../../../..');
const VERIFY_PUBLISHED = resolve(ROOT, 'scripts/verify-published-package.sh');
const VERIFY_RETAINED = resolve(ROOT, 'scripts/verify-retained-artefacts.sh');

let scratch: string;

/** A real gzipped tarball with a real `package/package.json` inside it. */
const makeTarball = (at: string, manifest: Record<string, unknown>): string => {
  const staging = mkdtempSync(join(scratch, 'stage-'));
  mkdirSync(join(staging, 'package'));
  writeFileSync(join(staging, 'package/package.json'), JSON.stringify(manifest, null, 2));
  execFileSync('tar', ['-czf', at, '-C', staging, 'package']);
  return at;
};

const sha256 = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex');
const sha512b64 = (file: string): string =>
  createHash('sha512').update(readFileSync(file)).digest('base64');
const sha1hex = (file: string): string => createHash('sha1').update(readFileSync(file)).digest('hex');

/**
 * A fake `npm` whose only trick is `npm view <spec> dist --json`. It prints the
 * JSON in $FAKE_NPM_DIST, or exits 1 when that variable is empty — the registry
 * "not there yet" case.
 */
const fakeNpmDir = (): string => {
  const dir = mkdtempSync(join(scratch, 'bin-'));
  const npm = join(dir, 'npm');
  writeFileSync(
    npm,
    [
      '#!/usr/bin/env bash',
      'if [ -z "${FAKE_NPM_DIST:-}" ]; then exit 1; fi',
      'printf "%s" "$FAKE_NPM_DIST"',
      '',
    ].join('\n'),
  );
  chmodSync(npm, 0o755);
  return dir;
};

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
}

const run = (script: string, args: string[], env: Record<string, string> = {}): Run => {
  const result = spawnSync('bash', [script, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
};

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'popclaw-release-scripts-'));
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe('verify-published-package.sh compares the registry with the tested tarball', () => {
  let tgz: string;
  let path: string;
  const VERSION = '0.1.0';
  // Two attempts, no sleeping: the "absent" case must fail fast, not hang.
  const fast = { REGISTRY_POLL_ATTEMPTS: '2', REGISTRY_POLL_SLEEP: '0' };

  beforeAll(() => {
    tgz = makeTarball(join(scratch, 'popclaw-mcp-0.1.0.tgz'), {
      name: 'popclaw-mcp',
      version: VERSION,
    });
    path = `${fakeNpmDir()}:${process.env.PATH}`;
  });

  const verify = (dist: unknown): Run =>
    run(VERIFY_PUBLISHED, ['popclaw-mcp', VERSION, tgz], {
      PATH: path,
      ...fast,
      ...(dist === undefined ? { FAKE_NPM_DIST: '' } : { FAKE_NPM_DIST: JSON.stringify(dist) }),
    });

  it('accepts matching integrity with an attestation', () => {
    const result = verify({
      integrity: `sha512-${sha512b64(tgz)}`,
      shasum: sha1hex(tgz),
      attestations: { url: 'https://registry.npmjs.org/-/npm/v1/attestations/popclaw-mcp@0.1.0' },
    });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('attestation present, registry bytes match the tested tarball');
  });

  it('refuses when the registry serves different bytes, naming both hashes', () => {
    const wrong = `sha512-${Buffer.from('not these bytes').toString('base64')}`;
    const result = verify({ integrity: wrong, attestations: { url: 'x' } });
    expect(result.status).not.toBe(0);
    // Both values, so whoever reads the log can tell which side moved.
    expect(result.stderr).toContain(wrong);
    expect(result.stderr).toContain(`sha512-${sha512b64(tgz)}`);
    expect(result.stderr).toContain('serving bytes that were never tested here');
  });

  it('refuses a mismatching shasum when the registry reports no integrity', () => {
    const result = verify({ shasum: '0'.repeat(40), attestations: { url: 'x' } });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('0'.repeat(40));
    expect(result.stderr).toContain(sha1hex(tgz));
  });

  it('accepts a matching shasum when the registry reports no integrity', () => {
    const result = verify({ shasum: sha1hex(tgz), attestations: { url: 'x' } });
    expect(result.status).toBe(0);
  });

  it('refuses when the bytes match but no attestation exists', () => {
    const result = verify({ integrity: `sha512-${sha512b64(tgz)}`, shasum: sha1hex(tgz) });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('WITHOUT a provenance attestation');
  });

  it('refuses when the registry can report neither hash', () => {
    const result = verify({ attestations: { url: 'x' } });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('neither dist.integrity nor dist.shasum');
  });

  it('gives up, rather than hanging, when the version never appears', () => {
    const result = verify(undefined);
    expect(result.status).not.toBe(0);
    expect(result.stderr + result.stdout).toContain('is not readable from the registry');
    expect(result.stdout).toContain('attempt 2 of 2');
  });
});

describe('verify-retained-artefacts.sh binds a resume to one tag and one commit', () => {
  const TAG = 'v0.1.0';
  const VERSION = '0.1.0';
  const COMMIT = 'a'.repeat(40);
  const MAIN = 'popclaw-plugin-0.1.0+2026-09-20-1200-3f48fd69.tgz';
  const SHELL = 'popclaw-mcp-0.1.0.tgz';

  /** A retained artefact directory exactly as the workflow uploads one. */
  const retained = (overrides: Record<string, unknown> = {}, tamper = false): string => {
    const dir = mkdtempSync(join(scratch, 'retained-'));
    const main = makeTarball(join(dir, MAIN), { name: 'popclaw', version: VERSION });
    const shell = makeTarball(join(dir, SHELL), {
      name: 'popclaw-mcp',
      version: VERSION,
      dependencies: { popclaw: VERSION },
    });
    writeFileSync(
      join(dir, 'SHA256SUMS.txt'),
      `${sha256(main)}  ./${MAIN}\n${sha256(shell)}  ./${SHELL}\n`,
    );
    writeFileSync(
      join(dir, 'release-metadata.json'),
      `${JSON.stringify(
        { tag: TAG, commit: COMMIT, version: VERSION, main: MAIN, shell: SHELL, ...overrides },
        null,
        2,
      )}\n`,
    );
    // After the sums were written, so the recorded hash no longer matches.
    if (tamper) writeFileSync(join(dir, MAIN), 'these are not the bytes that were tested');
    return dir;
  };

  it('accepts the run that packed this tag, and reports both tarball paths', () => {
    const dir = retained();
    const result = run(VERIFY_RETAINED, [dir, TAG, COMMIT, VERSION]);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`retained artefacts belong to ${TAG} at ${COMMIT}`);
    expect(result.stdout).toContain(`MAIN_TGZ=${dir}/${MAIN}`);
    expect(result.stdout).toContain(`SHELL_TGZ=${dir}/${SHELL}`);
  });

  it('refuses artefacts packed for another tag', () => {
    const result = run(VERIFY_RETAINED, [retained(), 'v0.2.0', COMMIT, '0.2.0']);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('packed for tag v0.1.0');
    expect(result.stderr).toContain('dispatched for v0.2.0');
  });

  it('refuses artefacts packed from another commit, even under the right tag', () => {
    // The case a name-based check cannot see: the tag was moved after the
    // failed release, so the retained bytes no longer trace back to it.
    const moved = 'b'.repeat(40);
    const result = run(VERIFY_RETAINED, [retained(), TAG, moved, VERSION]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`packed from commit ${COMMIT}`);
    expect(result.stderr).toContain(`now points at ${moved}`);
  });

  it('refuses a tarball whose bytes changed after the sums were written', () => {
    const result = run(VERIFY_RETAINED, [retained({}, true), TAG, COMMIT, VERSION]);
    expect(result.status).not.toBe(0);
    expect(result.stderr + result.stdout).toMatch(/FAILED/i);
  });

  it('refuses a set with no metadata at all', () => {
    const dir = retained();
    rmSync(join(dir, 'release-metadata.json'));
    const result = run(VERIFY_RETAINED, [dir, TAG, COMMIT, VERSION]);
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain('cannot be resumed from');
  });

  it('refuses when the metadata names a tarball that is not in the set', () => {
    const result = run(VERIFY_RETAINED, [retained({ shell: 'popclaw-mcp-9.9.9.tgz' }), TAG, COMMIT, VERSION]);
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain('which is not in the retained set');
  });
});
