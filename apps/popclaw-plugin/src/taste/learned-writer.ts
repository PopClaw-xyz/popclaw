/**
 * S4-T4 spec 5 — learned taste writer.
 *
 * Quick-glance feedback (① expand / ② save / ③ no reaction) gets appended one entry at a time
 * into `<tasteRoot>/learned/picks.jsonl` — same root as TasteLoader
 * (tasteRoot = PopclawPaths.tasteDir(), the same path as index.ts's
 * /popclaw feedback picksFile).
 *
 * ADR-0011 local-private-domain: taste is never uploaded, never signed, never sent to the server.
 * Appending is a single-line appendFile (JSONL single-line append atomicity is enough, no need
 * for tmp+rename).
 *
 * The row shape `{ts, eventId, signal, summaryLine}` differs from pick-recorder's PickRecord —
 * loadRecentPicks is designed to skip rows missing itemId/handle/score, so the two kinds of
 * records coexist in the same audit file (see learned-writer.test.ts).
 */
// The taste learned layer writes to a local-private-domain file; HostAdapter has no general fs
// write surface, so this uses node:fs/promises and node:path directly (same exemption as
// taste-writer.ts).
/* eslint-disable no-restricted-imports */
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
/* eslint-enable no-restricted-imports */
import { splitFrontmatter } from './taste-loader.js';
import { ensureManifestEnabled } from './taste-writer.js';

export type LearnedSignal = 'expanded' | 'saved' | 'meh';

export interface LearnedPick {
  /** Unix seconds (clock supplied by the caller — the orchestrator uses host.clock). */
  readonly ts: number;
  readonly eventId: string;
  readonly signal: LearnedSignal;
  /** The line shown to the owner on the quick-glance card (linkage matches ContextItem.summaryLine). */
  readonly summaryLine: string;
}

export interface LearnedWriterOptions {
  /** The taste root directory: PopclawPaths.tasteDir() (same root as TasteLoader's tasteDir). */
  readonly tasteRoot: string;
}

export async function appendPick(opts: LearnedWriterOptions, pick: LearnedPick): Promise<void> {
  const file = resolve(opts.tasteRoot, 'learned', 'picks.jsonl');
  await mkdir(dirname(file), { recursive: true });
  await appendFile(file, JSON.stringify(pick) + '\n', 'utf-8');
}

// ---------------------------------------------------------------------------
// learned/ —— the machine-inferred taste suggestion layer (spec Appendix A.3/A.4)
//
// **Two files, two evidence sources, never overwriting each other**:
//   `dreamed.md`      Written by the night digest — the evidence is the social log + the world
//                     stream, i.e. "who and what he genuinely reacts to out in the world".
//                     Cheap, runs every night, long-run truth.
//   `from-memory.md`  Mined from the historical conversations between me and the owner — i.e.
//                     "what kind of person he is, what he's been up to lately". **This is the
//                     half popclaw can never see on its own** (the owner cares about literacy
//                     games, Flutter, contracts — all of this happens entirely outside the
//                     social world). Expensive (hundreds of thousands of tokens per run), so
//                     it's only harvested once when the owner brings it up.
//
// Memory is the sprint start; the social log is the marathon. The reason for splitting into
// separate files: the owner can overturn just one of the two paths, and the night digest's
// overwrite-write can never touch the other path.
// ---------------------------------------------------------------------------

/** Taste inferred by the night digest. tags/mute are for local machine matching, summary is for humans to read. */
export interface LearnedTaste {
  readonly tags: readonly string[];
  readonly mute: readonly string[];
  readonly summary: string;
}

/** The path written by the night digest (social log + world stream). */
export const LEARNED_DREAMED = 'learned/dreamed.md';
/** The path mined from historical conversation (only harvested when the owner brings it up). */
export const LEARNED_FROM_MEMORY = 'learned/from-memory.md';

/**
 * Picks an inline array out of the frontmatter. **No YAML library, no generic parsing** — this
 * file is only ever written by writeLearnedTaste, and its shape is our own definition; pulling
 * in a YAML dependency just to read back two lines we ourselves just wrote is paying for
 * generality that doesn't exist here (memory: same decision as the taste-seed P-002 shape).
 * If the owner hand-edits it into a multi-line YAML list → it reads back as empty, and the next
 * night digest rebuilds from empty; the body is unaffected.
 */
export function parseTagLine(frontmatter: string, key: string): string[] {
  const m = new RegExp(`^${key}:\\s*\\[(.*)\\]\\s*$`, 'm').exec(frontmatter);
  if (!m) return [];
  return m[1]!
    .split(',')
    .map((s) => s.trim().replace(/^["']|["']$/g, ''))
    .filter((s) => s.length > 0);
}

/**
 * Reads back the taste written by the last night digest run. **The night digest must read
 * before writing** — each run only looks at one time window, and without carrying forward the
 * existing tags it would clobber the previous round's conclusions (same reasoning as bond
 * tags' MERGE). File doesn't exist = everything empty.
 */
export async function readLearnedTaste(
  opts: LearnedWriterOptions,
  file: string = LEARNED_DREAMED,
): Promise<LearnedTaste> {
  let raw: string;
  try {
    raw = await readFile(resolve(opts.tasteRoot, file), 'utf-8');
  } catch {
    return { tags: [], mute: [], summary: '' };
  }
  const { frontmatter, body } = splitFrontmatter(raw);
  return {
    tags: parseTagLine(frontmatter, 'tags'),
    mute: parseTagLine(frontmatter, 'mute'),
    summary: body.trim(),
  };
}

/**
 * Overwrites the learned layer. **Overwrite, not append**: learned is a derived asset (the raw
 * evidence lives in the social log, which is never deleted); every night digest run hands over
 * the best current full picture — appending would just make the tag lines pile up longer and
 * contradict each other. The owner's core layer isn't touched by a single character (A.4: the
 * sovereign layer outranks the suggestion layer, manifest weight 0.5).
 */
export async function writeLearnedTaste(
  opts: LearnedWriterOptions,
  taste: LearnedTaste,
  file: string = LEARNED_DREAMED,
): Promise<void> {
  const path = resolve(opts.tasteRoot, file);
  await mkdir(dirname(path), { recursive: true });
  const fm = `---\ntags: [${taste.tags.join(', ')}]\nmute: [${taste.mute.join(', ')}]\n---`;
  const next = `${fm}\n\n${taste.summary.trim()}\n`;
  await writeFile(`${path}.tmp`, next, 'utf-8');
  await rename(`${path}.tmp`, path);
  // respectOwnerDisable=true: if the owner has ever turned learned off, don't secretly flip it back on every night (A.4).
  await ensureManifestEnabled(opts.tasteRoot, file, 0.5, true);
}

/** Enough of the taste to choose by; the profile is prose and a runaway one would crowd out the day. */
const TASTE_PROFILE_MAX = 4_000;

/**
 * The owner's taste **as prose**, for whoever has to make a judgement with it: their own
 * layer first, then what dreaming and memory harvested.
 *
 * This is the half an LLM reads. The tag list beside it is the half a string matcher reads,
 * and on real hardware that one scored zero hits out of fifty-one — Chinese tags against an
 * English feed — which is why choosing what goes in the paper is a judgement now and not an
 * `includes()`.
 */
export async function readTasteProfile(opts: LearnedWriterOptions): Promise<string> {
  const [core, dreamed, memory] = await Promise.all([
    readFile(resolve(opts.tasteRoot, 'core/private.md'), 'utf-8').catch(() => ''),
    readLearnedTaste(opts, LEARNED_DREAMED).catch(() => ({ tags: [], mute: [], summary: '' })),
    readLearnedTaste(opts, LEARNED_FROM_MEMORY).catch(() => ({ tags: [], mute: [], summary: '' })),
  ]);
  const tags = [...new Set([...dreamed.tags, ...memory.tags])];
  const mute = [...new Set([...dreamed.mute, ...memory.mute])];
  return [
    splitFrontmatter(core).body.trim(),
    tags.length ? `tags: ${tags.join(', ')}` : '',
    mute.length ? `mute: ${mute.join(', ')}` : '',
    dreamed.summary,
    memory.summary,
  ]
    .filter(Boolean)
    .join('\n\n')
    .slice(0, TASTE_PROFILE_MAX);
}

