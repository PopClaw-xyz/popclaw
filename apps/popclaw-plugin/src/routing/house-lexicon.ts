/**
 * House-side routing entries (ADR-0043 §4 / slice 4) — the half that lets a
 * house **change the table without shipping a release**.
 *
 * A house declares them in the frontmatter of its own guide.md:
 *
 * ```yaml
 * lexicon:
 *   - tool: popclaw_world_guide
 *     say: postcard, send a postcard, group photo, what is it up to
 * ```
 *
 * The plugin only reads the `data/lorehouses/<slug>.guide.md` that the
 * **handshake already wrote to disk** (ADR-0041) — no new request, no asking the
 * agent to fetch it (a pull-based design is a dead loop for the very patient
 * whose symptom is "calls no tools at all"). Lazy: the first hook trigger reads
 * the disk, and the in-process cache is invalidated by file mtime (ADR-0035:
 * register() does zero IO).
 *
 * Expressiveness is capped at "phrase -> registered tool name": a house can add
 * routes, never prose instructions. Three gates:
 *  1. tool not in the **visible set** (registered - OPTIONAL_TOOLS, ADR-0044 §8)
 *     -> drop the whole entry — pointing at a tool the model cannot see is
 *     teaching it to make things up, exactly the disease ADR-0043 exists to kill;
 *  2. phrases are 2-24 chars and may not contain regex metacharacters (plain
 *     substring matching: no ReDoS, no injection surface);
 *  3. at most 12 entries per house; the rest is truncated.
 * A house that fails to parse takes down only itself (house-handshake.ts, second
 * discipline); nothing here ever throws.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import type { PopclawPaths } from '../host/popclaw-paths.js';
import { OPTIONAL_TOOLS } from '../tools/register-tools.js';
import { parseGuideFrontmatter } from '../world/guide.js';
import type { LexiconEntry } from './lexicon.js';
// The manifest is the authority on the tool set (register-tools.test.ts pins it
// byte-for-byte against the registerTool() calls), and it is a build-time
// constant — zero disk reads and zero path guessing at runtime.
import manifest from '../../openclaw.plugin.json';

const GUIDE_SUFFIX = '.guide.md';
const MAX_ENTRIES_PER_HOUSE = 12;
const MIN_PHRASE = 2;
const MAX_PHRASE = 24;
const METACHAR = /[\\^$.*+?()[\]{}|]/;

/** Visible set = registered - hidden tools (ADR-0044 §8). */
const VISIBLE_TOOLS = new Set(
  (manifest.contracts.tools as string[]).filter((t) => !OPTIONAL_TOOLS.includes(t)),
);

type CacheRow = { readonly mtimeMs: number; readonly entries: LexiconEntry[] };
const cache = new Map<string, CacheRow>();

/**
 * Every entry from the on-disk guides of the houses we have joined, flattened
 * into one table. Fed to `buildInjection(prompt, { extra })`.
 */
export function loadHouseLexicon(paths: PopclawPaths): LexiconEntry[] {
  let files: string[];
  try {
    files = readdirSync(paths.lorehousesDir());
  } catch {
    return []; // not joined to any house yet
  }

  const out: LexiconEntry[] = [];
  for (const name of files) {
    if (!name.endsWith(GUIDE_SUFFIX)) continue;
    const slug = name.slice(0, -GUIDE_SUFFIX.length);
    const file = paths.houseGuideFile(slug);
    try {
      const mtimeMs = statSync(file).mtimeMs;
      const hit = cache.get(file);
      const entries = hit?.mtimeMs === mtimeMs ? hit.entries : parseHouse(file, slug);
      cache.set(file, { mtimeMs, entries });
      out.push(...entries);
    } catch {
      continue; // one broken house takes down only itself
    }
  }
  return out;
}

function parseHouse(file: string, slug: string): LexiconEntry[] {
  const items = parseGuideFrontmatter(readFileSync(file, 'utf8')).frontmatter?.lexicon ?? [];
  const entries: LexiconEntry[] = [];
  for (const item of items) {
    if (entries.length >= MAX_ENTRIES_PER_HOUSE) break; // gate 3
    if (!VISIBLE_TOOLS.has(item.tool)) continue; // gate 1: drop the whole entry
    // Gate 2: a bad phrase drops itself, the rest still count; nothing left =
    // the entry is meaningless, drop it. Full-width commas count as separators
    // too — house owners write CJK docs, and one punctuation mark should not
    // cost them a whole route.
    const say = item.say
      .split(/[,，]/)
      .map((p) => p.trim())
      .filter((p) => p.length >= MIN_PHRASE && p.length <= MAX_PHRASE && !METACHAR.test(p));
    if (say.length === 0) continue;
    entries.push({ tool: item.tool, say, from: slug }); // `from` is required: the injection cites its source
  }
  return entries;
}
