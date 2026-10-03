import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

const NODE_MODULES = `${sep}node_modules${sep}`;
const LICENSE_FILE = /^(licen[cs]e|copying)([.-].*)?$/i;
const NOTICE_FILE = /^notice([.-].*)?$/i;

/**
 * The package directory an inlined input belongs to: the path segment(s)
 * right after its LAST `node_modules/` (pnpm nests `.pnpm/<id>/node_modules/`),
 * or undefined for inputs that are not third-party code.
 */
function packageDirOf(abs) {
  const at = abs.lastIndexOf(NODE_MODULES);
  if (at < 0) return undefined;
  const rest = abs.slice(at + NODE_MODULES.length).split(sep);
  const depth = rest[0].startsWith('@') ? 2 : 1;
  return abs.slice(0, at + NODE_MODULES.length) + rest.slice(0, depth).join(sep);
}

/**
 * Ship the full license text of every third-party package inlined into ANY of
 * the given esbuild metafiles (one per distributed entry, plus any code
 * embedded into them), deduplicated by name@version.
 *
 * `licensesDir` is recreated from scratch so a license left there by an older
 * build can neither mask a missing one nor ship for a package no longer
 * inlined. A package that cannot be identified, or that has no license file,
 * fails the whole step: this throws after listing every problem.
 *
 * Returns the collected packages as `{ label, dir, files }`.
 */
export function collectBundleLicenses({ metafiles, baseDir, licensesDir, vendored = [] }) {
  const packages = new Map();
  const problems = [];
  const seenDirs = new Set();
  for (const metafile of metafiles) {
    for (const input of Object.keys(metafile.inputs)) {
      const dir = packageDirOf(resolve(baseDir, input));
      if (!dir || seenDirs.has(dir)) continue;
      seenDirs.add(dir);
      const manifest = join(dir, 'package.json');
      const meta = existsSync(manifest) ? JSON.parse(readFileSync(manifest, 'utf-8')) : {};
      if (typeof meta.name !== 'string' || typeof meta.version !== 'string') {
        problems.push(`cannot identify the package that ships ${input} (no name/version in ${manifest})`);
        continue;
      }
      const label = `${meta.name}@${meta.version}`;
      if (packages.has(label)) continue;
      // NOTICE rides along where an upstream has one (Apache-2.0 section 4d).
      const files = readdirSync(dir).filter((n) => LICENSE_FILE.test(n) || NOTICE_FILE.test(n)).sort();
      if (!files.some((n) => LICENSE_FILE.test(n))) {
        problems.push(`${label} is inlined but ships no license file in ${dir}`);
        continue;
      }
      packages.set(label, { label, dir, files });
    }
  }

  rmSync(licensesDir, { recursive: true, force: true });
  if (problems.length > 0) {
    throw new Error(`bundle licenses: ${problems.length} problem(s):\n  ${problems.join('\n  ')}`);
  }
  for (const { label, dir, files } of packages.values()) {
    const out = join(licensesDir, label.replace(/[^A-Za-z0-9._@-]/g, '_'));
    mkdirSync(out, { recursive: true });
    for (const name of files) copyFileSync(join(dir, name), join(out, name));
  }
  for (const { label, file } of vendored) {
    mkdirSync(join(licensesDir, label), { recursive: true });
    copyFileSync(file, join(licensesDir, label, 'LICENSE'));
  }
  return [...packages.values()];
}
