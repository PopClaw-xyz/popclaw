import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * A release ships TWO packages from one workflow, and the order is the whole
 * design: `popclaw-mcp` is a shell whose only dependency is `popclaw` at an
 * exact version, so publishing it first would put a package on the registry
 * that cannot install. Nothing in the workflow fails when the order is wrong —
 * it just publishes a broken shell, once, permanently, because a version
 * number cannot be reused. This file is the check.
 *
 * It reads the workflow as text on purpose: there is no YAML parser in this
 * package's dependencies, and adding one to assert five facts would be a new
 * runtime dependency for a test. The step splitter below is enough because the
 * file it splits is ours.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../../../..');
const RELEASE = resolve(ROOT, '.github/workflows/release.yml');
const CI = resolve(ROOT, '.github/workflows/ci.yml');
const JUSTFILE = resolve(ROOT, 'Justfile');
const SELFCHECK = resolve(ROOT, 'scripts/selfcheck-pack-mcp-shell.sh');

/** One entry per `- name:`/`- uses:` step, in file order, text included. */
interface Step {
  index: number;
  text: string;
}

const steps = (yaml: string): Step[] =>
  yaml
    .split(/^ {6}- /m)
    .slice(1)
    .map((text, index) => ({ index, text }));

const stepContaining = (all: Step[], needle: string): Step => {
  const hits = all.filter((s) => s.text.includes(needle));
  expect(hits, `exactly one step should contain ${JSON.stringify(needle)}`).toHaveLength(1);
  return hits[0]!;
};

/**
 * Private-repo checkouts do not carry release.yml (it is a public-repo file),
 * and the export script generates the public ci.yml rather than copying it.
 * Skip rather than fail there; in the repository that actually publishes, both
 * files exist and every assertion below runs.
 */
const describeRelease = existsSync(RELEASE) ? describe : describe.skip;

describe('Justfile packs the two packages with two different guards', () => {
  const justfile = readFileSync(JUSTFILE, 'utf8');

  it('has a recipe for each package', () => {
    expect(justfile).toMatch(/^pack-plugin:/m);
    expect(justfile).toMatch(/^pack-mcp-shell /m);
  });

  it('keeps the native-binding floor on the plugin and off the shell', () => {
    // A recipe is its header line plus every indented line that follows it.
    const recipe = (name: string): string => {
      const lines = justfile.split('\n');
      const start = lines.findIndex((line) => line.startsWith(`${name}:`) || line.startsWith(`${name} `));
      expect(start, `no recipe found for ${name}`).toBeGreaterThanOrEqual(0);
      const body: string[] = [];
      for (const line of lines.slice(start + 1)) {
        if (line.trim() !== '' && !/^\s/.test(line)) break;
        body.push(line);
      }
      expect(body.join('\n').trim(), `${name} has an empty body`).not.toBe('');
      return body.join('\n');
    };
    // The floor is a promise about the IMPLEMENTATION package. Weakening it to
    // make one recipe serve both packages is the failure this pins shut.
    expect(recipe('pack-plugin')).toContain('-lt 11');
    // The shell must fail the opposite test: no runtime inside it at all.
    const shell = recipe('pack-mcp-shell');
    expect(shell).not.toContain('-lt 11');
    expect(shell).toContain('wallet-migrations');
  });
});

describeRelease('release.yml ships both packages in one fixed order', () => {
  const yaml = readFileSync(RELEASE, 'utf8');
  const all = steps(yaml);

  it('packs with the project recipes rather than re-implementing packing', () => {
    expect(yaml).toContain('just pack-plugin');
    expect(yaml).toContain('just pack-mcp-shell');
    // `pnpm pack` in the workflow would bypass both recipes' guards.
    expect(yaml).not.toMatch(/^\s*pnpm pack/m);
  });

  it('publishes popclaw before popclaw-mcp', () => {
    const main = stepContaining(all, 'npm publish "$MAIN_TGZ" --provenance');
    const shell = stepContaining(all, 'npm publish "$SHELL_TGZ" --provenance');
    expect(main.index).toBeLessThan(shell.index);
  });

  it('gates the shell publish on the main package being VERIFIED, not published', () => {
    const shell = stepContaining(all, 'npm publish "$SHELL_TGZ" --provenance');
    const condition = /if: >-\n([\s\S]*?)\n {8}\w/.exec(shell.text)?.[1] ?? '';
    // Publishing is not proof; the verification step is what compares the
    // registry's bytes with the tarball this run tested.
    expect(condition).toContain('steps.verify_main.outcome');
    expect(condition).toContain('steps.verify_retained_main.outcome');
    expect(condition).not.toContain('steps.publish_main.outcome');
    // Both verification steps exist and both call the same verifier.
    expect(yaml).toContain('id: verify_main');
    expect(yaml).toContain('id: verify_retained_main');
    expect(yaml).toContain('scripts/verify-published-package.sh popclaw "$VERSION" "$MAIN_TGZ"');
    expect(yaml).toContain('scripts/verify-published-package.sh popclaw-mcp "$VERSION" "$SHELL_TGZ"');
  });

  it('delegates both dangerous comparisons to scripts a test can execute', () => {
    // What these scripts DO is proved by tests/unit/release-scripts.test.ts,
    // which runs them against a fake registry and real tarballs. All that is
    // left to pin here is that the workflow still calls them and that the
    // logic has not crept back into YAML — where a test can only grep it, and
    // a grep stays green while the comparison underneath is deleted.
    for (const script of [
      'scripts/verify-published-package.sh',
      'scripts/verify-retained-artefacts.sh',
    ]) {
      expect(existsSync(resolve(ROOT, script)), `${script} must exist`).toBe(true);
      expect(yaml).toContain(script);
    }
    expect(yaml).not.toContain('dist.integrity');
    expect(yaml).not.toContain('dist.attestations');
  });

  it('carries --provenance on both real publishes and on neither dry run', () => {
    const publishes = (flag: string): RegExpMatchArray[] => [
      ...yaml.matchAll(
        new RegExp(`^\\s*(?:run: )?npm publish "\\$(?:MAIN|SHELL)_TGZ" ${flag} --access public$`, 'gm'),
      ),
    ];
    expect(publishes('--provenance')).toHaveLength(2);
    expect(publishes('--dry-run')).toHaveLength(2);
    // No third form: a publish without one of those two flags would be a
    // publish with no attestation and no warning.
    expect([...yaml.matchAll(/^\s*(?:run: )?npm publish /gm)]).toHaveLength(4);
  });

  it('never unpublishes, never overwrites, never deprecates', () => {
    for (const forbidden of ['npm unpublish', 'npm deprecate', '--force']) {
      expect(yaml, `release.yml must not contain ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('retains both artefacts long enough to resume', () => {
    expect(yaml).toMatch(/ARTEFACT_RETENTION_DAYS: "90"/);
    expect(yaml).toContain('retention-days: ${{ env.ARTEFACT_RETENTION_DAYS }}');
    expect(yaml).toContain('if-no-files-found: error');
    // The retained set is both tarballs plus the manifest a resume checks them
    // against; the upload and the download must name the same artefact.
    const names = [...yaml.matchAll(/name: release-artefacts-\$\{\{ steps\.target\.outputs\.tag \}\}/g)];
    expect(names).toHaveLength(2);
  });

  it('records the tag and the source commit with the artefacts, and checks both on resume', () => {
    // The artefact's NAME carries the tag, but a name is a label anyone can
    // reuse and a tag can be moved after a failed release. The binding has to
    // be a recorded value, compared against the dispatch.
    const pack = stepContaining(all, 'just pack-mcp-shell');
    expect(pack.text).toContain('release-metadata.json');
    expect(pack.text).toContain('COMMIT="$(git rev-parse HEAD)"');
    const check = stepContaining(all, 'scripts/verify-retained-artefacts.sh');
    expect(check.text).toContain('"$TAG" "$(git rev-parse HEAD)"');
    // The checkout used `ref: <tag>`, so HEAD is that tag's commit.
    expect(yaml).toContain('ref: ${{ steps.target.outputs.tag }}');
  });

  it('resumes from retained artefacts without rebuilding', () => {
    expect(yaml).toContain('resume_from_run_id:');
    expect(yaml).toMatch(/only:\n\s+description:/);
    // Every build and pack step is fresh-mode only, so a resume run cannot
    // rebuild the bundle — which embeds a timestamp and would not reproduce
    // the tested bytes anyway.
    for (const command of ['just install', 'just build', 'just test', 'just lint']) {
      const step = stepContaining(all, `run: ${command}\n`);
      expect(step.text, `${command} must not run on resume`).toContain(
        "if: steps.target.outputs.mode == 'fresh'",
      );
    }
    const pack = stepContaining(all, 'just pack-mcp-shell');
    expect(pack.text).toContain("if: steps.target.outputs.mode == 'fresh'");
    // Resume reads another run's artefacts with the run's own token; this is
    // the permission that makes that possible and the only reason it is here.
    expect(yaml).toContain('actions: read');
    expect(yaml).toContain('github-token: ${{ github.token }}');
  });

  it('reads the repository gate from both PACKED manifests', () => {
    const gate = stepContaining(all, 'Both packed manifests are publishable');
    expect(gate.text).toContain('tar -xzOf "$tgz" package/package.json');
    expect(gate.text).toContain('"popclaw:${MAIN_TGZ}"');
    expect(gate.text).toContain('"popclaw-mcp:${SHELL_TGZ}"');
    // The shell has no prepack, but its exact dependency is what makes the
    // alias safe, so the tarball is where it gets checked.
    expect(gate.text).toContain('packed popclaw-mcp depends on');
  });

  it('says out loud what a half-finished release left on the registry', () => {
    const report = stepContaining(all, 'What is on the registry right now');
    expect(report.text).toContain("if: failure() && steps.target.outputs.dry_run != 'true'");
    expect(report.text).toContain('npm view "$1@${VERSION}" version');
    expect(report.text).toContain('resume_from_run_id=');
  });
});

describe('CI watches pack-mcp-shell refuse', () => {
  it('runs the self-check script', () => {
    expect(existsSync(SELFCHECK)).toBe(true);
    expect(readFileSync(CI, 'utf8')).toContain('scripts/selfcheck-pack-mcp-shell.sh');
  });
});
