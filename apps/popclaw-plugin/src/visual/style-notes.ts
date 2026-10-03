/**
 * The owner's accumulated style notes on "what does it look like, does it read well" for
 * visual/text reports, stored at PopclawPaths.canvasStyleFile() (vault/taste/, the precious
 * layer). The `--feedback` layout-coaching channel shares this same file across: the daily
 * paper (canonical), the brief alias, and recommend (#137).
 * Content-taste learning doesn't live here (that's the taste pipeline's job).
 *
 * P-004: this is a preference-choice signal given by the owner's **own hand** — the same
 * category as red-packet 1/2/3, mute — and must live in the precious layer that's never
 * deleted. Before 2026-07-27 it lived in data/ (public/regenerable/disposable), which was a
 * violation; migrateStyleNotesToVault is responsible for moving legacy users' copy over.
 */
import { appendFileSync, readFileSync, existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { renderCopy } from '../lexicon/index.js';
import { ownerLang } from '../lexicon/owner-language.js';

export function readStyleNotes(styleFile: string): string {
  if (!existsSync(styleFile)) return '';
  return readFileSync(styleFile, 'utf-8');
}

export function appendStyleNote(styleFile: string, note: string, now: () => number = Date.now): void {
  const trimmed = note.trim();
  if (!trimmed) return;
  mkdirSync(dirname(styleFile), { recursive: true });
  const ts = new Date(now()).toISOString();
  appendFileSync(styleFile, `- [${ts}] ${trimmed}\n`, 'utf-8');
}

/**
 * A one-time move from data/canvas-style.md → vault/taste/canvas-style.md (P-006: changing a
 * path must never orphan old data). Runs at startup, idempotent — once the old file has been
 * moved it's gone, so running again is a no-op.
 *
 * New location doesn't exist → a plain rename (a single atomic operation, never leaves half-
 * moved data in two places); new location already has content (machine swap / a rollback
 * happened) → the old content is merged in first, no entry lost from either side.
 * @returns Whether this run actually moved anything.
 */
export function migrateStyleNotesToVault(legacyFile: string, styleFile: string): boolean {
  if (!existsSync(legacyFile)) return false;
  mkdirSync(dirname(styleFile), { recursive: true });
  if (!existsSync(styleFile)) {
    renameSync(legacyFile, styleFile);
    return true;
  }
  const old = readFileSync(legacyFile, 'utf-8');
  const head = old.length > 0 && !old.endsWith('\n') ? old + '\n' : old;
  writeFileSync(styleFile, head + readFileSync(styleFile, 'utf-8'), 'utf-8');
  renameSync(legacyFile, legacyFile + '.migrated');
  return true;
}

/**
 * If flags carries --feedback, record it and return an ack message (the command shouldn't go
 * on to generate a report in this case); otherwise return null (the command proceeds to
 * generate its report as normal). Shared by the daily paper / brief / recommend.
 */
export function handleStyleFeedback(
  flags: Record<string, string>,
  styleFile: string,
  now: () => number = Date.now,
): { text: string } | null {
  const raw = flags['feedback'];
  if (raw === undefined) return null;
  const trimmed = String(raw).trim();
  // Bare `--feedback` arrives as the literal 'true' (parseArgs boolean
  // sentinel) — treat it like empty instead of recording "true" as a note.
  if (!trimmed || trimmed === 'true') {
    return { text: renderCopy(ownerLang(), 'visual.styleFeedback.missing') };
  }
  appendStyleNote(styleFile, trimmed, now);
  return { text: renderCopy(ownerLang(), 'visual.styleFeedback.recorded', { note: trimmed }) };
}
