/**
 * Characterization baseline for the issue-identity rules (R4′-0).
 *
 * These tests pin what the tree does TODAY, not what it should do. They exist so
 * the identity-rule extraction that follows can prove it changed nothing:
 *
 *  1. The picks gate (popclaw_newspaper + candidate_token / candidate_basis) and
 *     the publish gate (publishNewspaper + publishToken / edit.basis) judge the same
 *     provenance strings differently. Picks requires a candidate-token SHAPE and its
 *     token placeholder test has no `redacted`; publish has no shape test and its
 *     placeholder test does include `redacted`. Each side's outcome is recorded per
 *     input, divergences included.
 *  2. The "is this item written" invariant: checkEdit never stores a blank h or s,
 *     which is what lets publish's `written` (`h ?? s`) agree with the renderer's
 *     `hasCopy` (`h || s`) and its item-exists unwritten filter.
 *  3. The candidate numbering contract: the [n] printed on a candidate page built
 *     from a set stored in candidateOrder selects exactly that item in
 *     buildIssueFromPicks, and the item keeps n as its itemNumber.
 */
import { createLocalNewspaperIssueArchive } from '../../../src/host/local-newspaper-artifacts.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { registerPopclawTools } from '../../../src/tools/register-tools.js';
import { publishNewspaper, checkEdit, type PublishDeps } from '../../../src/newspaper/publish-newspaper.js';
import { putIssue, getIssue, getEdit, putEdit, _resetIssuesForTest } from '../../../src/newspaper/issue-store.js';
import { buildCandidatePage, candidateOrder } from '../../../src/newspaper/build-candidate-page.js';
import { buildIssueFromPicks } from '../../../src/newspaper/pick-issue.js';
import { pageBudgetNow, _resetBudgetForTest } from '../../../src/newspaper/host-budget.js';
import { todayDateLabel } from '../../../src/newspaper/issue.js';
import { renderCopy } from '../../../src/lexicon/index.js';
import { issue, item } from './_issue-fixture.js';
import { dropScratch, makeScratch, type Scratch } from './_scratch.js';

let dir: string;
let scratch: Scratch;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'popclaw-identity-baseline-'));
  scratch = makeScratch('identity-baseline');
  _resetIssuesForTest();
  _resetBudgetForTest();
});
afterEach(() => {
  _resetIssuesForTest(dir);
  _resetBudgetForTest();
  dropScratch(scratch);
});

const todaysIssue = (over: Parameters<typeof issue>[0] = {}): ReturnType<typeof issue> =>
  issue({ dateLabel: todayDateLabel(), ...over });

// ─── 1. picks vs publish provenance ─────────────────────────────────────────

const CANDIDATE_REAL = 'ctok_real0001';
const MATERIAL_REAL = 'tok_real0001';
/** Stored on BOTH sides, so a refusal of it is about its shape, never about absence. */
const REDACTED = 'credactedABC123';
/** Candidate-prefixed but shorter than the picks shape (`c` + 6); stored on both sides. */
const SHORT = 'cab12';

/** The picks call, driven through the real tool entry with a factory sessionKey. */
function picksCall(): (params: Record<string, unknown>) => Promise<{ text: string }> {
  let execute: ((c: string, p: unknown) => Promise<{ text: string }>) | undefined;
  const api = {
    registerTool: (tool: unknown): void => {
      const resolved =
        typeof tool === 'function' ? (tool as (ctx: unknown) => unknown)({ sessionKey: 'agent:main:tui:owner' }) : tool;
      const t = resolved as { name?: string; execute?: typeof execute };
      if (t?.name === 'popclaw_newspaper') execute = t.execute;
    },
  } as Parameters<typeof registerPopclawTools>[0]['api'];
  registerPopclawTools({
    api,
    runtime: (async () => ({
      boot: { loreHouseUrls: [] },
      paths: {
        newspaperDir: () => join(dir, 'newspaper'),
        newspaperManifestsDir: () => dir,
        tasteDir: () => join(dir, 'taste'),
        houseGuideFile: (s: string) => join(dir, 'lorehouses', `${s}.guide.md`),
      },
    })) as unknown as Parameters<typeof registerPopclawTools>[0]['runtime'],
  });
  return (params) => execute!('c1', params);
}

const candidateIssue = (): ReturnType<typeof issue> =>
  todaysIssue({
    pulse: [
      item({ eventId: 'pk1', author: 'CandidateA', sigil: 'aaaa0001' }),
      item({ eventId: 'pk2', author: 'CandidateB', sigil: 'bbbb0002' }),
    ],
  });

function publishDeps(): PublishDeps {
  return {
    upload: vi.fn(async () => ({ url: 'https://canvas/x/1?t=tok' })),
    signer: { popclawId: async () => 'PublisherFixtureId' } as never,
    nickname: 'Yu',
    canvasBaseUrl: 'https://canvas',
    archive: createLocalNewspaperIssueArchive({ issuesDir: scratch.issuesDir, lastNewspaperHtml: scratch.lastNewspaperHtml }),
    manifestDir: dir,
    lang: 'en',
  };
}

const Q = 'the booster landed on the pad';
const handIn = (basis?: string): Record<string, unknown> => ({
  masthead: 'Cloudboat Gazette',
  teaser: 'today in one line',
  items: { '1': { q: Q, h: 'it came back', s: 'the booster is on the pad again.' } },
  ...(basis === undefined ? {} : { basis }),
});

/** The cleaning both gates apply before judging (trim + strip flanking quotes). */
const clean = (v: string): string => v.trim().replace(/^["']|["']$/g, '');

async function picksOutcome(token: string, basis?: string): Promise<string> {
  putIssue(CANDIDATE_REAL, candidateIssue(), dir);
  putIssue(REDACTED, candidateIssue(), dir);
  putIssue(SHORT, candidateIssue(), dir);
  const r = await picksCall()({
    candidate_token: token,
    ...(basis === undefined ? {} : { candidate_basis: basis }),
    picks_flat: [1],
  });
  if (r.text === renderCopy('en', 'newspaper.picks.noProvenance')) return 'noProvenance';
  if (
    basis !== undefined &&
    r.text === renderCopy('en', 'newspaper.picks.tokenBasisConflict', { basis, token: clean(token) })
  ) {
    return 'tokenBasisConflict';
  }
  const bound = r.text.match(/"basis": "tok_[a-z0-9]+"/);
  if (bound) {
    return r.text.includes('picks: resolved by the candidate_basis you carried') ? 'material+basisNote' : 'material';
  }
  return `other: ${r.text.slice(0, 120)}`;
}

async function publishOutcome(token: string, basis?: string): Promise<string> {
  putIssue(MATERIAL_REAL, todaysIssue(), dir);
  putIssue(REDACTED, todaysIssue(), dir);
  putIssue(SHORT, todaysIssue(), dir);
  const r = await publishNewspaper(publishDeps(), { publishToken: token, edit: handIn(basis) });
  const t = clean(token);
  const L = (key: string, vars: Record<string, string> = {}): string => renderCopy('en', `newspaper.publish.${key}`, vars);
  if (r.landed) {
    return basis !== undefined && r.text.includes(L('basisBoundNote', { token: basis })) ? 'landed+basisNote' : 'landed';
  }
  if (r.text === L('noProvenance')) return 'noProvenance';
  if (r.text === L('tokenMismatch')) return 'tokenMismatch';
  if (r.text === L('notChosen', { count: '1' })) return 'notChosen';
  if (basis !== undefined) {
    if (r.text === L('tokenBasisConflict', { basis, token: t })) return 'tokenBasisConflict';
    if (r.text === L('tokenBasisConflictNamed', { basis, token: t, material: basis })) return 'tokenBasisConflictNamed';
  }
  return `other: ${r.text.slice(0, 120)}`;
}

/**
 * One row per provenance string. `real` is substituted per side: the picks side's real
 * id is a candidate page, the publish side's a material page.
 */
interface Row {
  label: string;
  token: (real: string) => string;
  /** Token alone: [picks outcome, publish outcome]. */
  alone: [string, string];
  /** Token + that side's real id as the basis: [picks outcome, publish outcome]. */
  withBasis: [string, string];
}

const ROWS: Row[] = [
  { label: 'the real id', token: (r) => r, alone: ['material', 'landed'], withBasis: ['material', 'landed'] },
  { label: 'the real id in double quotes', token: (r) => `"${r}"`, alone: ['material', 'landed'], withBasis: ['material', 'landed'] },
  { label: 'the real id in single quotes', token: (r) => `'${r}'`, alone: ['material', 'landed'], withBasis: ['material', 'landed'] },
  { label: 'the real id with surrounding whitespace', token: (r) => `  ${r}\n`, alone: ['material', 'landed'], withBasis: ['material', 'landed'] },
  { label: 'the real id in angle brackets', token: (r) => `<${r}>`, alone: ['noProvenance', 'noProvenance'], withBasis: ['material+basisNote', 'landed+basisNote'] },
  { label: '`c***`', token: () => 'c***', alone: ['noProvenance', 'noProvenance'], withBasis: ['material+basisNote', 'landed+basisNote'] },
  { label: '`***`', token: () => '***', alone: ['noProvenance', 'noProvenance'], withBasis: ['material+basisNote', 'landed+basisNote'] },
  { label: '`c...`', token: () => 'c...', alone: ['noProvenance', 'noProvenance'], withBasis: ['material+basisNote', 'landed+basisNote'] },
  { label: '`cxxxxxxx`', token: () => 'cxxxxxxx', alone: ['noProvenance', 'noProvenance'], withBasis: ['material+basisNote', 'landed+basisNote'] },
  { label: 'empty', token: () => '', alone: ['noProvenance', 'noProvenance'], withBasis: ['material+basisNote', 'landed+basisNote'] },
  { label: 'whitespace only', token: () => '   ', alone: ['noProvenance', 'noProvenance'], withBasis: ['material+basisNote', 'landed+basisNote'] },
  // DIVERGENCE: picks' token test has no `redacted`, so a candidate-shaped `credacted…`
  // is a reliable token there (it binds the page stored under that id, or contradicts a
  // basis), while publish treats it as a placeholder and ignores it.
  {
    label: '`credactedABC123` (stored under that id on both sides)',
    token: () => REDACTED,
    alone: ['material', 'noProvenance'],
    withBasis: ['tokenBasisConflict', 'landed+basisNote'],
  },
  // DIVERGENCE: picks requires `c` + 6 more token characters; publish has no shape test,
  // so a short candidate-prefixed id is a reliable name there and reaches the candidate
  // gate (alone) or the conflict gate (with a basis).
  {
    label: '`cab12` (short, stored under that id on both sides)',
    token: () => SHORT,
    alone: ['noProvenance', 'notChosen'],
    withBasis: ['material+basisNote', 'tokenBasisConflictNamed'],
  },
  // The other side's real id: a material-shaped token on picks, a candidate-shaped one
  // on publish (neither stored on the side receiving it).
  {
    label: "the other side's real id",
    token: (r) => (r === CANDIDATE_REAL ? MATERIAL_REAL : CANDIDATE_REAL),
    alone: ['noProvenance', 'tokenMismatch'],
    withBasis: ['material+basisNote', 'tokenBasisConflictNamed'],
  },
];

describe('provenance strings: picks gate vs publish gate (current behaviour)', () => {
  describe.each(ROWS)('$label', (row) => {
    it(`token alone → picks: ${row.alone[0]}, publish: ${row.alone[1]}`, async () => {
      expect(await picksOutcome(row.token(CANDIDATE_REAL))).toBe(row.alone[0]);
      _resetIssuesForTest(dir);
      _resetIssuesForTest();
      expect(await publishOutcome(row.token(MATERIAL_REAL))).toBe(row.alone[1]);
    });

    it(`token + real basis → picks: ${row.withBasis[0]}, publish: ${row.withBasis[1]}`, async () => {
      expect(await picksOutcome(row.token(CANDIDATE_REAL), CANDIDATE_REAL)).toBe(row.withBasis[0]);
      _resetIssuesForTest(dir);
      _resetIssuesForTest();
      expect(await publishOutcome(row.token(MATERIAL_REAL), MATERIAL_REAL)).toBe(row.withBasis[1]);
    });
  });

  it('`credacted…` as the BASIS (no token) is a placeholder on both sides', async () => {
    expect(await picksOutcome('', REDACTED)).toBe('noProvenance');
    _resetIssuesForTest(dir);
    _resetIssuesForTest();
    expect(await publishOutcome('', REDACTED)).toBe('noProvenance');
  });
});

/**
 * A REAL candidate page whose gather-minted id (`c` + `tok_…`) happens to contain
 * `redacted`. Picks' token test has no `redacted` but its basis test does, so the same
 * genuine id binds as a token and is a placeholder as a basis.
 */
describe('a real candidate id containing `redacted` (current behaviour)', () => {
  const REAL_REDACTED = 'ctok_redacted';

  async function picksRaw(params: Record<string, unknown>): Promise<string> {
    putIssue(REAL_REDACTED, candidateIssue(), dir);
    putIssue(CANDIDATE_REAL, candidateIssue(), dir);
    return (await picksCall()({ ...params, picks_flat: [1] })).text;
  }
  const boundMaterial = (text: string): boolean => /"basis": "tok_[a-z0-9]+"/.test(text);
  const BASIS_NOTE = 'picks: resolved by the candidate_basis you carried';

  it('candidate_token alone → binds that page (material page, no basis note)', async () => {
    const t = await picksRaw({ candidate_token: REAL_REDACTED });
    expect(boundMaterial(t)).toBe(true);
    expect(t).toContain('CandidateA');
    expect(t).not.toContain(BASIS_NOTE);
    expect(getIssue(REAL_REDACTED, dir)).toBeDefined(); // candidate set left in the ledger
  });

  it('candidate_token and candidate_basis both = that id → binds via the token (basis ignored as a placeholder, no conflict)', async () => {
    const t = await picksRaw({ candidate_token: REAL_REDACTED, candidate_basis: REAL_REDACTED });
    expect(boundMaterial(t)).toBe(true);
    expect(t).toContain('CandidateA');
    expect(t).not.toContain(BASIS_NOTE);
  });

  it('candidate_basis alone = that id → refused as a placeholder: newspaper.picks.noProvenance', async () => {
    expect(await picksRaw({ candidate_basis: REAL_REDACTED })).toBe(renderCopy('en', 'newspaper.picks.noProvenance'));
  });

  it('shape-valid `credacted…` token + a different valid basis → newspaper.picks.tokenBasisConflict', async () => {
    expect(await picksRaw({ candidate_token: REAL_REDACTED, candidate_basis: CANDIDATE_REAL })).toBe(
      renderCopy('en', 'newspaper.picks.tokenBasisConflict', { basis: CANDIDATE_REAL, token: REAL_REDACTED }),
    );
  });

  it('publish: a stored material id `tok_redacted` → noProvenance as token, as basis, and as both', async () => {
    const noProv = renderCopy('en', 'newspaper.publish.noProvenance');
    for (const [token, basis] of [
      ['tok_redacted', undefined],
      ['tok_redacted', 'tok_redacted'],
      ['', 'tok_redacted'],
    ] as const) {
      _resetIssuesForTest(dir);
      _resetIssuesForTest();
      putIssue('tok_redacted', todaysIssue(), dir);
      const r = await publishNewspaper(publishDeps(), { publishToken: token, edit: handIn(basis) });
      expect(r.landed, `${token}|${basis}`).toBeFalsy();
      expect(r.text, `${token}|${basis}`).toBe(noProv);
      expect(getIssue('tok_redacted', dir), `${token}|${basis}`).toBeDefined(); // nothing consumed
    }
  });

  it('reliable token, no basis, no ledger entry → picks: "candidate set not found or expired"; publish: tokenMismatch (not noProvenance)', async () => {
    const picks = await picksCall()({ candidate_token: 'ctok_missing01', picks_flat: [1] });
    expect(picks.text).toBe(
      '⚠️ candidate set not found or expired — call popclaw_newspaper again with no picks to get a fresh candidate page',
    );
    const pub = await publishNewspaper(publishDeps(), { publishToken: 'tok_missing01', edit: handIn() });
    expect(pub.landed).toBeFalsy();
    expect(pub.text).toBe(renderCopy('en', 'newspaper.publish.tokenMismatch'));
    expect(pub.text).not.toBe(renderCopy('en', 'newspaper.publish.noProvenance'));
  });
});

// ─── 2. the "written" invariant ─────────────────────────────────────────────

describe('"written": on the normal merge path, a checkEdit-normalized stored edit never holds a blank h or s', () => {
  it('checkEdit drops whitespace-only h/s field by field, keeps non-blank values verbatim (untrimmed)', () => {
    const r = checkEdit(
      {
        masthead: 'M',
        teaser: 't',
        items: {
          '1': { h: '   ', s: 'only a body.' },
          '2': { h: 'only a head', s: ' \t\n ' },
          '3': { h: ' ', s: '  ', q: 'an anchor alone' },
          '4': { h: '  padded head  ', s: 'body' },
        },
      },
      'en',
    );
    expect('edit' in r).toBe(true);
    if (!('edit' in r)) return;
    expect(r.edit.items).toEqual({
      '1': { s: 'only a body.' },
      '2': { h: 'only a head' },
      '4': { h: '  padded head  ', s: 'body' },
    });
  });

  const three = (): ReturnType<typeof issue> =>
    todaysIssue({
      pulse: [
        item({ text: 'first', eventId: 'w1' }),
        item({ text: 'second', eventId: 'w2', author: 'sama', sigil: '2222aaaa' }),
        item({ text: 'third', eventId: 'w3', author: 'karpathy', sigil: '3333bbbb' }),
      ],
    });

  it('publish, stored edit and the unwritten list agree on a blank-h / blank-both batch', async () => {
    putIssue('tok_written', three(), dir);
    const deps = publishDeps();
    const first = await publishNewspaper(deps, {
      edit: {
        basis: 'tok_written',
        masthead: 'M',
        teaser: 't',
        items: {
          '1': { q: 'first', h: '   ', s: 'only a body.' },
          '3': { q: 'third', h: ' ', s: '  ' },
        },
      },
    });
    // Item 1 counts as written (body alone); item 3 (blank both) was never stored.
    expect(first.accepted).toBe(true);
    expect(first.text).toContain(
      renderCopy('en', 'newspaper.publish.moreToWrite', { count: '2', numbers: '[2] [3]' }),
    );
    const stored = getEdit('tok_written', dir)!;
    expect(stored.items).toEqual({ '1': { s: 'only a body.', q: 'first' } });
    for (const it of Object.values(stored.items ?? {})) {
      if (it.h !== undefined) expect(it.h.trim()).not.toBe('');
      if (it.s !== undefined) expect(it.s.trim()).not.toBe('');
    }

    // Second batch: item 1 again with an anchor from ANOTHER item's body. Publish's
    // `written(prior)` says item 1 is already written, so its anchor is not checked;
    // fill-only merging then fills the missing h and keeps the earlier s.
    const sent: string[] = [];
    const upload = vi.fn(async (a: { html: string }) => {
      sent.push(a.html);
      return { url: 'https://canvas/x/2?t=tok' };
    });
    const second = await publishNewspaper({ ...deps, upload: upload as never }, {
      edit: {
        basis: 'tok_written',
        items: {
          '1': { q: 'second', h: 'late head', s: 'a rewritten body.' },
          '2': { q: 'second', h: 'two', s: 'the second body.' },
          '3': { q: 'third', h: 'three', s: 'the third body.' },
        },
      },
    });
    expect(second.landed).toBe(true);
    // No anchor refusal at all (the refusal copy opens with its count; item 1 would be its only entry).
    const refusalOpening = renderCopy('en', 'newspaper.publish.anchorRefused', { count: '1', numbers: '@@' }).split('@@')[0]!;
    expect(second.text).not.toContain(refusalOpening);
    expect(sent[0]).toContain('only a body.');
    expect(sent[0]).not.toContain('a rewritten body.');
    expect(getIssue('tok_written', dir)).toBeUndefined(); // finished → ledger settled
  });
});

describe('"written" invariant SCOPE: it covers checkEdit-normalized edits only, not the store', () => {
  it('putEdit/getEdit round-trip an unnormalized edit verbatim (blank h and empty item kept) — scope pin, not a bug', () => {
    putIssue('tok_scope', todaysIssue(), dir);
    const raw = { masthead: 'M', teaser: 't', items: { '1': { h: '   ', s: 'body' }, '2': {} } };
    putEdit('tok_scope', raw, dir);
    expect(getEdit('tok_scope', dir)?.items).toEqual({ '1': { h: '   ', s: 'body' }, '2': {} });
    _resetIssuesForTest(); // drop the memory tier: the disk tier holds it verbatim too
    expect(getEdit('tok_scope', dir)?.items).toEqual({ '1': { h: '   ', s: 'body' }, '2': {} });
  });
});

// ─── 3. candidate numbering contract ────────────────────────────────────────

describe('candidate page [n] selects the same stored item in buildIssueFromPicks', () => {
  it('holds for a set stored in candidateOrder, where page order differs from arrival order', () => {
    // Arrival order interleaves three authors; candidateOrder groups strangers
    // fewest-first (Y:3, Z:4) and puts the singleton X in the loose group last.
    const arrival = ['X1', 'Z1', 'Y1', 'Z2', 'Y2', 'Z3', 'Y3', 'Z4'].map((id) =>
      item({
        eventId: `ev${id}`,
        author: `Author${id[0]}`,
        sigil: `sig${id[0]}0000`,
        authorPopclawId: `pid-${id[0]}`,
        text: `BODY_${id}`,
      }),
    );
    const stored = candidateOrder(arrival, 'en');
    expect(stored.map((p) => p.text)).not.toEqual(arrival.map((p) => p.text)); // the fixture really reorders
    const candidateSet = issue({ language: 'en', pulse: stored });
    putIssue('ctok_numbering', candidateSet, dir);

    const page = buildCandidatePage(candidateSet, {
      tasteText: '',
      bondLines: [],
      publishToken: 'ctok_numbering',
      suggestMin: 1,
      suggestMax: 8,
      floor: 0,
      perAuthorMax: 6,
      budget: pageBudgetNow(),
      dayTotal: stored.length,
      overBudget: false,
    });
    const printed = [...page.matchAll(/^\[(\d+)\] [^\n]*?(BODY_[XYZ]\d)/gm)].map((m) => [Number(m[1]), m[2]!] as const);
    expect(printed).toHaveLength(stored.length);

    for (const [n, body] of printed) {
      const token = `tok_n${n}`;
      const r = buildIssueFromPicks('ctok_numbering', [n], {
        manifestDir: dir,
        mintToken: () => token,
        contentRules: '',
        leadMax: 3,
        perAuthorMax: 6,
        floor: 0,
        topUpTo: 0,
      });
      expect(r.kind, `pick [${n}]`).toBe('ready');
      const chosen = getIssue(token, dir)!;
      expect(chosen.pulse.map((p) => [p.itemNumber, p.text])).toEqual([[n, body]]);
    }
  });
});
