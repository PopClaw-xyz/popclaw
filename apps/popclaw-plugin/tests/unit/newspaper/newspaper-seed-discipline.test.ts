import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CURRENT_SEED_FINGERPRINTS,
  TEMPLATE_VERSION,
  readNewspaperContentRules,
} from '../../../src/newspaper/newspaper-files.js';
import { DEFAULT_CONTENT_EN } from '../../../src/newspaper/newspaper-files-en.js';
import { setOwnerLang } from '../../../src/lexicon/owner-language.js';

/**
 * **The template-editing ritual, as a test.**
 *
 * Changing a codex constant obliges the editor to (a) record the sha256 of the
 * text being replaced in `HISTORICAL_SEEDS` — the only proof left that the
 * outgoing text was ours, since its source is gone — and (b) bump
 * `TEMPLATE_VERSION`. Skip either and the machines still on the old template are
 * frozen on it forever (host-c, 2026-07-30). That used to be a comment asking
 * for human discipline; it is now these pins: touch a constant and this file
 * fails with the exact lines to paste.
 *
 * Update ONLY by following the failure message.
 */
const PINNED_VERSION = 'v11';
// v10 dropped `layout.md` entirely — the layout is code now — so there are two
// seeds where there were four. The v9 fingerprints of all four, including the two
// retired ones, are in HISTORICAL_SEEDS: a machine still carrying our v9 layout.md
// has to stay recognisable as ours, or `retiredLayoutRules` would mistake it for
// something the owner wrote and pester him about it forever.
const PINNED_FINGERPRINTS: Readonly<Record<string, string>> = {
  DEFAULT_CONTENT: '1de1ad44762514a0a186791f33af6f4e3ae598955c05a45454c5387273e5ad93',
  DEFAULT_CONTENT_EN: 'aaf317dc01aa451f1b96fcb60825e3b2787da695d8d2dc22e62bb58f83f62c72',
};

const recipe = (name: string, outgoing: string, incoming: string | undefined): string =>
  `${name} changed. Do all three, then this test passes:

  1. src/newspaper/newspaper-files.ts → append to HISTORICAL_SEEDS:
       // ${name} · ${PINNED_VERSION} · <this commit>
       '${outgoing}',
     (the outgoing text's fingerprint — without it, every machine still on
      ${PINNED_VERSION} stops recognising its own seed and is frozen forever)
  2. same file: bump TEMPLATE_VERSION from '${PINNED_VERSION}' to the next version.
  3. this file: set PINNED_VERSION to the new version and
       ${name}: '${incoming ?? '<recomputed hash>'}',`;

describe('newspaper seed discipline', () => {
  it('the shipped template constants are the pinned ones', () => {
    for (const [name, outgoing] of Object.entries(PINNED_FINGERPRINTS)) {
      const incoming = CURRENT_SEED_FINGERPRINTS[name];
      expect(incoming, recipe(name, outgoing, incoming)).toBe(outgoing);
    }
  });

  it('TEMPLATE_VERSION is the pinned one (a bump must carry the outgoing hashes with it)', () => {
    expect(
      TEMPLATE_VERSION,
      `TEMPLATE_VERSION moved to '${TEMPLATE_VERSION}'. Every hash of the '${PINNED_VERSION}' constants must be in HISTORICAL_SEEDS before this pin is updated:\n${Object.entries(
        PINNED_FINGERPRINTS,
      )
        .map(([n, h]) => `  // ${n} · ${PINNED_VERSION} · <this commit>\n  '${h}',`)
        .join('\n')}`,
    ).toBe(PINNED_VERSION);
  });
});

/**
 * The point of deriving the current fingerprints rather than only recording them
 * a release later: a file carrying the seed this build ships, with no stamp
 * beside it, is recognised as ours right away and reseeded (current
 * owner-language default) instead of being frozen as the owner's writing.
 *
 * That state is reachable without anyone editing anything: `writeSeed` is a
 * non-atomic read-modify-write of `.seed`, so two hosts on a shared data root
 * can lose a stamp between them. The guard is an exact sha256 of the whole
 * file, so nothing the owner actually wrote can be swept up by it.
 */
describe('this build recognises its own seed without a stamp', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'popclaw-seed-discipline-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    setOwnerLang(undefined);
  });

  it('reseeds and stamps it instead of freezing it as the owner\'s writing', () => {
    setOwnerLang('en-US');
    const file = join(dir, 'content.md');
    writeFileSync(file, DEFAULT_CONTENT_EN, 'utf-8'); // our own seed, stamp gone
    expect(readNewspaperContentRules(dir)).toBe(DEFAULT_CONTENT_EN);
    expect(readFileSync(file, 'utf-8')).toBe(DEFAULT_CONTENT_EN);
    const stamp = JSON.parse(readFileSync(join(dir, '.seed'), 'utf-8')) as Record<
      string,
      { templateVersion: string; sha256: string }
    >;
    expect(stamp['content.md']).toMatchObject({
      templateVersion: TEMPLATE_VERSION,
      sha256: CURRENT_SEED_FINGERPRINTS['DEFAULT_CONTENT_EN'],
    });
  });

  it('reseeds in the CURRENT owner language, not back into the language it found', () => {
    // Same branch as the historical-hash one: `defaultFor` follows `ownerLang()`,
    // so an owner who has since switched languages gets the new language's codex.
    setOwnerLang('zh-CN');
    const zhSeed = readNewspaperContentRules(dir); // seed zh, then lose the stamp
    rmSync(join(dir, '.seed'));
    setOwnerLang(undefined);
    setOwnerLang('en-US');
    expect(zhSeed).not.toBe(DEFAULT_CONTENT_EN);
    expect(readNewspaperContentRules(dir)).toBe(DEFAULT_CONTENT_EN);
    expect(readFileSync(join(dir, 'content.md'), 'utf-8')).toBe(DEFAULT_CONTENT_EN);
  });
});
