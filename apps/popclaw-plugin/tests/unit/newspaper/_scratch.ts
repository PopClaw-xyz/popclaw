/**
 * Per-suite scratch paths for the publish tests.
 *
 * Since the local HTML became the master copy, EVERY happy path writes files —
 * the archived issue plus `last-newspaper.html`. The rigs used to share one
 * fixed `/tmp/pcw-test/last-newspaper.html`, which under a parallel runner means
 * suites overwriting one another's paper and asserting on whichever one won.
 * One temp dir per suite, dropped afterwards.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export interface Scratch {
  /** The suite's own directory — also usable as a `manifestDir`. */
  root: string;
  issuesDir: string;
  lastNewspaperHtml: string;
}

export function makeScratch(label: string): Scratch {
  const root = mkdtempSync(join(tmpdir(), `popclaw-${label}-`));
  return {
    root,
    issuesDir: join(root, 'issues'),
    lastNewspaperHtml: join(root, 'last-newspaper.html'),
  };
}

export function dropScratch(s: Scratch | undefined): void {
  if (s) rmSync(s.root, { recursive: true, force: true });
}
