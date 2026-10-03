/**
 * /popclaw react up|down [<platform>:]<postId>
 *
 * Plan 11.4 — replaces the harness's simulated reactions with a real user
 * signal. Appends a `PickRecord` to the same `picks.jsonl` the learn loop
 * already reads. Latest-ts-wins dedup in `loadRecentPicks` means a manual
 * up overrides any earlier simulated down (or vice versa) without needing
 * to edit the file.
 *
 * Named `/popclaw feedback` until 2026-07-29. That word was wrong twice over:
 * this is a taste signal about ONE post, and "feedback" is what a user says
 * to the house's humans. `/popclaw feedback` now means the latter (see
 * `popclaw-feedback.ts`); `feedback up|down …` still routes here as a
 * deprecated alias.
 */

import { recordCyclePicks, type PickRecord, type Reaction } from '../recommend/pick-recorder.js';
import { renderCopy } from '../lexicon/index.js';
import { ownerLang } from '../lexicon/owner-language.js';

interface CacheLookupLike {
  lookup(
    platform: string,
    postId: string,
  ): { handle: string; textPreview: string } | null;
}

export interface PopclawReactArgs {
  positional: string[];
}

export interface PopclawReactDeps {
  cache: CacheLookupLike;
  picksFile: string;
  /** Test seam — defaults to `Date.now`. */
  now?: () => number;
}

const DEFAULT_PLATFORM = 'x';

export async function runPopclawReactCommand(
  args: PopclawReactArgs,
  deps: PopclawReactDeps,
): Promise<{ text: string }> {
  const usage =
    'usage: /popclaw react up|down [<platform>:]<postId>\n' +
    'examples:\n' +
    '  /popclaw react up 1234567890123456789\n' +
    '  /popclaw react down x:1234567890123456789';

  const reactionRaw = args.positional[0];
  const idArg = args.positional[1];

  if (!reactionRaw || !idArg) {
    return { text: usage };
  }
  if (reactionRaw !== 'up' && reactionRaw !== 'down') {
    return { text: `unknown reaction "${reactionRaw}"; use "up" or "down".\n${usage}` };
  }
  const reaction: Reaction = reactionRaw;

  let platform: string;
  let postId: string;
  const colon = idArg.indexOf(':');
  if (colon > 0) {
    platform = idArg.slice(0, colon);
    postId = idArg.slice(colon + 1);
  } else {
    platform = DEFAULT_PLATFORM;
    postId = idArg;
  }

  const item = deps.cache.lookup(platform, postId);
  if (!item) {
    return {
      text:
        `item not found in cache: ${platform}:${postId}\n` +
        `(tip: it must have been seen by the world-feed at least once before /popclaw react can resolve handle + textPreview)`,
    };
  }

  const ts = Math.floor((deps.now?.() ?? Date.now()) / 1000);
  const pick: PickRecord = {
    ts,
    itemId: `${platform}:${postId}`,
    handle: item.handle,
    textPreview: item.textPreview,
    score: 0, // not from a cycle; manual reaction. Score field unused by synthesizer.
    reaction,
  };
  recordCyclePicks(deps.picksFile, [pick]);

  const arrow = reaction === 'up' ? '↑' : '↓';
  const preview = item.textPreview.replace(/\s+/g, ' ').slice(0, 90);
  return { text: renderCopy(ownerLang(), 'react.cli.recorded', { arrow, handle: item.handle, preview }) };
}
