/**
 * S3 (three-act spec §3.3, the interest-self-description branch) — seeds the owner's own
 * self-description into the taste core layer. Appends, never overwrites (this is the owner's
 * sovereign layer, never lose existing content); creates the manifest if it's missing.
 * Shape matches taste-loader.ts's read convention (P-002: frontmatter + body).
 */
// taste core writes to the owner's sovereign layer (<dataRoot>/taste/core/private.md);
// HostAdapter has no general fs write surface, so this uses node:fs/promises and node:path
// directly (same exemption).
/* eslint-disable no-restricted-imports */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
/* eslint-enable no-restricted-imports */
import { splitFrontmatter } from './taste-loader.js';

/**
 * P-002 skeleton (spec Appendix A.3): establish the location first, leave the tags/mute
 * content for step 3's night digest to fill in — extracting tags from the owner's
 * self-description requires an LLM call, which the plugin can't invoke on a subscription-tier
 * machine.
 */
const DEFAULT_FRONTMATTER = '---\ntags: []\nmute: []\n---';

export interface TasteWriterOptions {
  /** The taste root directory: <dataRoot>/taste (parallel to TasteLoader's tasteDir). */
  readonly tasteRoot: string;
}

export async function appendCorePrivate(opts: TasteWriterOptions, text: string): Promise<void> {
  const trimmed = text.trim();
  if (!trimmed) return;

  const mdPath = resolve(opts.tasteRoot, 'core/private.md');
  await mkdir(dirname(mdPath), { recursive: true });

  let existing = '';
  try {
    existing = await readFile(mdPath, 'utf-8');
  } catch {
    // First creation — existing stays empty
  }

  // Carry the existing frontmatter over as-is (merge, not replace: this step doesn't write
  // tags, and what the night digest wrote must not be clobbered by this self-description
  // either); the body only gets appended to the tail, not a single character the owner wrote
  // is touched.
  const { frontmatter, body } = splitFrontmatter(existing);
  const head = frontmatter.trimEnd() || DEFAULT_FRONTMATTER;
  const kept = body.trim();
  const next = `${head}\n\n${kept ? `${kept}\n\n` : ''}${trimmed}\n`;
  const mdTmp = `${mdPath}.tmp`;
  await writeFile(mdTmp, next, 'utf-8');
  await rename(mdTmp, mdPath);

  await ensureManifestEnabled(opts.tasteRoot, 'core/private.md');
}

/**
 * Registers a source into the manifest and enables it. `defaultWeight` only takes effect on
 * **first** registration — a weight the owner has hand-tuned since must never be overwritten.
 * The core layer is weight 1, the learned layer is 0.5 (A.4: the sovereign layer always
 * outranks the suggestion layer).
 *
 * `respectOwnerDisable` separates two categories of writer:
 * - **Owner-written** (core, `appendCorePrivate`) → false. They just personally added a line,
 *   which means they want it used — re-enabling it along the way is their intent.
 * - **Machine-written** (learned, the night digest) → true. If the owner turned learned off,
 *   that's an explicit statement — **automatically flipping it back on every night would be
 *   letting the suggestion layer override the sovereign layer** (the exact opposite of A.4).
 */
export async function ensureManifestEnabled(
  tasteRoot: string,
  sourcePath: string,
  defaultWeight = 1,
  respectOwnerDisable = false,
): Promise<void> {
  const manifestPath = resolve(tasteRoot, 'manifest.json');

  let manifest: {
    schemaVersion?: number;
    sources: Record<string, { weight: number; enabled: boolean }>;
  } = { schemaVersion: 1, sources: {} };

  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf-8')) as typeof manifest;
  } catch {
    // First creation — manifest stays as default
  }

  manifest.sources ??= {};
  const existing = manifest.sources[sourcePath];
  manifest.sources[sourcePath] = {
    weight: existing?.weight ?? defaultWeight,
    enabled: respectOwnerDisable && existing ? existing.enabled : true,
  };

  const manifestTmp = `${manifestPath}.tmp`;
  await writeFile(manifestTmp, JSON.stringify(manifest, null, 2) + '\n', 'utf-8');
  await rename(manifestTmp, manifestPath);
}
