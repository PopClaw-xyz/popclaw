/**
 * Read taste/manifest.json + the enabled markdown source files.
 *
 * Plan 11.1: only `core/public.md` + `core/private.md` are typically present.
 * The loader is generic so that Phase 3+ can drop `learned/` and Phase 5+
 * can drop `imported/<id>.md` files into the same tree without code change.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface TasteLoaderLogger {
  warn(msg: string): void;
}

export interface TasteLoaderOptions {
  /** The taste directory itself (PopclawPaths.tasteDir()). */
  readonly tasteDir: string;
  readonly logger?: TasteLoaderLogger;
}

interface ManifestEntry {
  weight: number;
  enabled: boolean;
}

interface Manifest {
  schemaVersion: number;
  sources: Record<string, ManifestEntry>;
}

export interface EnabledTasteSource {
  path: string;        // e.g. "core/public.md"
  weight: number;      // 0..1
  content: string;     // markdown body (P-002 frontmatter already stripped)
}

const NOOP_LOGGER: TasteLoaderLogger = { warn: () => {} };

/**
 * P-002 shape (spec Appendix A.3): a taste file = frontmatter (for the machine: tags/mute)
 * + body (for the human). Split into two halves, both preserved as-is — even keys in the
 * frontmatter that nothing recognizes must not be dropped. No fence (an old file / hand-written
 * by the owner) → empty frontmatter string, the whole thing is body.
 */
export function splitFrontmatter(md: string): { frontmatter: string; body: string } {
  const fence = md.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  if (!fence) return { frontmatter: '', body: md };
  const raw = fence[0];
  return { frontmatter: raw, body: md.slice(raw.length) };
}

export class TasteLoader {
  private readonly tasteDir: string;
  private readonly logger: TasteLoaderLogger;

  constructor(opts: TasteLoaderOptions) {
    this.tasteDir = opts.tasteDir;
    this.logger = opts.logger ?? NOOP_LOGGER;
  }

  async enabledSources(): Promise<EnabledTasteSource[]> {
    const manifestPath = join(this.tasteDir, 'manifest.json');
    if (!existsSync(manifestPath)) return [];

    let manifest: Manifest;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as Manifest;
    } catch (err) {
      this.logger.warn(`taste-loader: malformed manifest.json: ${String(err)}`);
      return [];
    }

    const out: EnabledTasteSource[] = [];
    for (const [path, entry] of Object.entries(manifest.sources ?? {})) {
      if (!entry.enabled) continue;
      const full = join(this.tasteDir, path);
      if (!existsSync(full)) {
        this.logger.warn(`taste-loader: source file missing: ${path}`);
        continue;
      }
      // frontmatter is for the machine (step 4's tail matching reads it); only the body should be fed to the LLM.
      const content = splitFrontmatter(readFileSync(full, 'utf-8')).body.replace(/^\n+/, '');
      out.push({ path, weight: entry.weight, content });
    }
    return out;
  }
}
