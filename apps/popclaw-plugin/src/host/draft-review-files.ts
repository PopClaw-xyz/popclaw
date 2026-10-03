/**
 * The filesystem behind draft review copies (`src/tools/draft-review.ts`).
 *
 * A storage host adapter, like `execution-store.ts`: owning a directory is its
 * whole job, so it may use node:fs, node:path and node:crypto, and business
 * code reaches it only through the `DraftReviewFiles` interface a composition
 * root injects (today only the MCP root, `src/mcp.ts`).
 *
 * PRIVATE BY CONSTRUCTION. The directory is 0700 and every file 0600, set
 * explicitly after creation so a permissive umask cannot widen them. Files are
 * created exclusively (`wx`): a name that already exists is an error, never an
 * overwrite.
 *
 * STALE FILES. A review copy lives as long as its draft, which is at most the
 * draft TTL. Every file older than that is removed at construction (the
 * root's first draft) and again before every write, so an orphan a previous process left
 * behind cannot outlive the TTL by more than the time to the next draft.
 * Younger files are left alone on purpose: another root sharing this data
 * root may still have live drafts pointing at them.
 */
import { chmodSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { DraftReviewFiles } from '../tools/draft-store.js';

export function createDraftReviewFiles(dir: string, options: {
  readonly staleAfterMs: number;
  readonly now?: () => number;
  /** Where `note` reports; absent = silent. */
  readonly warn?: (message: string) => void;
}): DraftReviewFiles {
  const now = options.now ?? Date.now;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const sweep = (): void => {
    let names: string[] = [];
    try { names = readdirSync(dir); } catch { return; }
    for (const name of names) {
      const path = join(dir, name);
      try {
        if (now() - statSync(path).mtimeMs > options.staleAfterMs) rmSync(path, { force: true });
      } catch { /* gone already, or unreadable: left for the next sweep */ }
    }
  };
  sweep();
  const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
  return {
    dir,
    write(name: string, text: string) {
      if (name.includes('/') || name.includes('\\') || name.startsWith('.')) throw new Error('review file name is not a plain name');
      sweep();
      const path = join(dir, name);
      const bytes = Buffer.from(text, 'utf8');
      writeFileSync(path, bytes, { mode: 0o600, flag: 'wx' });
      chmodSync(path, 0o600);
      return { path, sha256: sha256(bytes) };
    },
    sha256(path: string) {
      try { return sha256(readFileSync(path)); } catch { return null; }
    },
    remove(path: string) {
      try { rmSync(path, { force: true }); } catch { /* the draft is gone either way */ }
    },
    note(reason: string) {
      try { options.warn?.(`popclaw: draft review copies not used (${reason}) — long drafts keep the whole-text dialog`); } catch { /* a log line is lost */ }
    },
  };
}
