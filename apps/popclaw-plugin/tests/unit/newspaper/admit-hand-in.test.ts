/**
 * admitHandIn called directly: which issue a hand-in binds to, what it refuses,
 * and what of the copy is admitted — with the ledger state left behind by each
 * call. The end-to-end cases (upload, receipt, putEdit) live in the publish-*
 * suites; this file pins the admission decision itself.
 *
 * admitHandIn never writes an edit: every admitted case below also asserts the
 * stored edit is exactly what it was before the call.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { admitHandIn, reprintOf, type Admission } from '../../../src/newspaper/admit-hand-in.js';
import { putIssue, getIssue, getEdit, putEdit, _resetIssuesForTest } from '../../../src/newspaper/issue-store.js';
import { todayDateLabel } from '../../../src/newspaper/issue.js';
import type { NewspaperEdit } from '../../../src/newspaper/render-newspaper.js';
import { renderCopy } from '../../../src/lexicon/index.js';
import { issue, item } from './_issue-fixture.js';
import { dropScratch, makeScratch, type Scratch } from './_scratch.js';

let scratch: Scratch;
let dir: string;

const three = (over: Parameters<typeof issue>[0] = {}): ReturnType<typeof issue> =>
  issue({
    pulse: [
      item({ eventId: 'e1', author: 'MKBHD', sigil: '1111aaaa', authorPopclawId: 'pid-mkbhd', text: 'The new phone camera is a genuine step up in low light.' }),
      item({ eventId: 'e2', author: 'QuantaMagazine', sigil: '2222bbbb', authorPopclawId: 'pid-quanta', text: 'Mathematicians have finally settled the sphere packing question in dimension seventeen.' }),
      item({ eventId: 'e3', author: 'verge', sigil: '3333cccc', authorPopclawId: 'pid-verge', text: 'The handheld console is getting a second revision with a brighter screen.' }),
    ],
    ...over,
  });

const Q1 = 'a genuine step up in low light';
const Q2 = 'settled the sphere packing question';
const Q3 = 'a second revision with a brighter screen';
const head = { masthead: 'Cloudboat Gazette', teaser: 'today in three lines' };
const good1 = { h: 'the camera', s: 'it sees in the dark.', q: Q1 };
const good2 = { h: 'spheres', s: 'packed at last.', q: Q2 };

const t = (key: string, vars?: Record<string, string>): string => renderCopy('en', `newspaper.publish.${key}`, vars);
const anchorLine = (count: number, numbers: string): string => t('anchorRefused', { count: String(count), numbers });
const why = (reason: string): string => t(`anchorReason.${reason}`);

const admit = (publishToken: string | undefined, edit: unknown): Admission =>
  admitHandIn({ ...(publishToken !== undefined ? { publishToken } : {}), edit }, { manifestDir: dir }, 'en');

function admitted(a: Admission): Extract<Admission, { kind: 'admitted' }> {
  if (a.kind !== 'admitted') throw new Error(`expected admitted, got refused: ${a.text}`);
  return a;
}

describe('admitHandIn — direct admission decisions', () => {
  beforeEach(() => {
    scratch = makeScratch('admit');
    dir = scratch.root;
    _resetIssuesForTest();
  });
  afterEach(() => {
    _resetIssuesForTest();
    dropScratch(scratch);
  });

  describe('1. token and basis both reliable but different', () => {
    it('(a) material token whose recorded candidate is the basis → admitted, ancestry note first', () => {
      putIssue('tok_a', three(), dir, undefined, 'cand_1');
      const a = admitted(admit('tok_a', { ...head, basis: 'cand_1', items: { '1': good1 } }));
      expect(a.publishToken).toBe('tok_a');
      expect(a.notes).toEqual([t('candidateAncestryNote', { token: 'tok_a', candidate: 'cand_1' })]);
      expect(a.issue).toEqual(getIssue('tok_a', dir));
      expect(a.edit.basis).toBe('cand_1');
      expect(getEdit('tok_a', dir)).toBeUndefined();
    });

    it('(a) binding relies on candidateOf, not on the material: a different page under a different candidate', () => {
      const other = issue({
        pulse: [item({ eventId: 'z1', author: 'other', sigil: '9999dddd', authorPopclawId: 'pid-other', text: 'A completely different page about tide tables and harbour dredging.' })],
      });
      const qz = 'tide tables and harbour dredging';
      const goodZ = { h: 'tides', s: 'dredged.', q: qz };
      putIssue('tok_z', other, dir, undefined, 'cand_9');
      const a = admitted(admit('tok_z', { ...head, basis: 'cand_9', items: { '1': goodZ } }));
      expect(a.publishToken).toBe('tok_z');
      expect(a.notes).toEqual([t('candidateAncestryNote', { token: 'tok_z', candidate: 'cand_9' })]);
      expect(a.issue).toEqual(getIssue('tok_z', dir));
      // Same page, but the basis names a candidate it was not picked from: conflict.
      expect(admit('tok_z', { ...head, basis: 'cand_1', items: { '1': goodZ } })).toEqual({
        kind: 'refused',
        text: t('tokenBasisConflictNamed', { basis: 'cand_1', token: 'tok_z', material: 'tok_z' }),
      });
      expect(getEdit('tok_z', dir)).toBeUndefined();
    });

    it('(b) one material-shaped id → tokenBasisConflictNamed naming it', () => {
      putIssue('tok_a', three(), dir, undefined, 'cand_1');
      // Candidate basis, but not the one tok_a was picked from.
      expect(admit('tok_a', { ...head, basis: 'cand_2', items: { '1': good1 } })).toEqual({
        kind: 'refused',
        text: t('tokenBasisConflictNamed', { basis: 'cand_2', token: 'tok_a', material: 'tok_a' }),
      });
      // Candidate token, material basis: the basis is the one named.
      expect(admit('cand_1', { ...head, basis: 'tok_a', items: { '1': good1 } })).toEqual({
        kind: 'refused',
        text: t('tokenBasisConflictNamed', { basis: 'tok_a', token: 'cand_1', material: 'tok_a' }),
      });
      expect(getEdit('tok_a', dir)).toBeUndefined();
      expect(getIssue('tok_a', dir)).toBeDefined();
    });

    it('(b) both material or both candidate → tokenBasisConflict naming neither', () => {
      putIssue('tok_a', three(), dir);
      putIssue('tok_b', three(), dir);
      expect(admit('tok_a', { ...head, basis: 'tok_b', items: { '1': good1 } })).toEqual({
        kind: 'refused',
        text: t('tokenBasisConflict', { basis: 'tok_b', token: 'tok_a' }),
      });
      expect(admit('cand_1', { ...head, basis: 'cand_2', items: { '1': good1 } })).toEqual({
        kind: 'refused',
        text: t('tokenBasisConflict', { basis: 'cand_2', token: 'cand_1' }),
      });
      expect(getEdit('tok_a', dir)).toBeUndefined();
      expect(getEdit('tok_b', dir)).toBeUndefined();
    });
  });

  describe('2. token unusable, basis reliable', () => {
    it('basis not in the ledger → basisExpired', () => {
      putIssue('tok_other', three(), dir);
      expect(admit('***', { ...head, basis: 'tok_gone', items: { '1': good1 } })).toEqual({
        kind: 'refused',
        text: t('basisExpired', { basis: 'tok_gone' }),
      });
      expect(getEdit('tok_other', dir)).toBeUndefined();
    });

    it('basis present → admitted on the basis with basisBoundNote (masked or absent token alike)', () => {
      putIssue('tok_a', three(), dir);
      for (const token of ['***', undefined]) {
        const a = admitted(admit(token, { ...head, basis: ' "tok_a" ', items: { '1': good1 } }));
        expect(a.publishToken).toBe('tok_a');
        expect(a.notes).toEqual([t('basisBoundNote', { token: 'tok_a' })]);
      }
      expect(getEdit('tok_a', dir)).toBeUndefined();
    });
  });

  describe('3. provenance missing or unmatched', () => {
    it('neither token nor basis usable → noProvenance', () => {
      putIssue('tok_a', three(), dir);
      expect(admit(undefined, { ...head, items: { '1': good1 } })).toEqual({ kind: 'refused', text: t('noProvenance') });
      expect(admit('tok_...', { ...head, basis: '<basis>', items: { '1': good1 } })).toEqual({
        kind: 'refused',
        text: t('noProvenance'),
      });
      expect(getEdit('tok_a', dir)).toBeUndefined();
    });

    it('reliable token not in the ledger → tokenMismatch (no fallback to the live issue)', () => {
      putIssue('tok_a', three(), dir);
      expect(admit('tok_ghost', { ...head, items: { '1': good1 } })).toEqual({ kind: 'refused', text: t('tokenMismatch') });
      expect(getEdit('tok_a', dir)).toBeUndefined();
    });
  });

  describe('4. candidate-set refusal', () => {
    it('candidate token with no child page → notChosen', () => {
      putIssue('cand_1', three(), dir);
      expect(admit('cand_1', { ...head, items: { '1': good1 } })).toEqual({
        kind: 'refused',
        text: t('notChosen', { count: '3' }),
      });
      expect(getIssue('cand_1', dir)).toBeDefined();
    });

    it("candidate token with a live today's child → notChosenHasMaterial naming the child", () => {
      putIssue('cand_1', three(), dir);
      putIssue('tok_child', three({ dateLabel: todayDateLabel() }), dir, undefined, 'cand_1');
      expect(admit('cand_1', { ...head, items: { '1': good1 } })).toEqual({
        kind: 'refused',
        text: t('notChosenHasMaterial', { count: '3', token: 'tok_child' }),
      });
      expect(getIssue('tok_child', dir)).toBeDefined();
      expect(getEdit('tok_child', dir)).toBeUndefined();
    });

    it("a child stamped another day is deleted by the scan → notChosen, and the child is gone", () => {
      putIssue('cand_1', three(), dir); // fixture dateLabel is 2026年8月25日, not today
      putIssue('tok_old', three(), dir, undefined, 'cand_1');
      expect(admit('cand_1', { ...head, items: { '1': good1 } })).toEqual({
        kind: 'refused',
        text: t('notChosen', { count: '3' }),
      });
      expect(getIssue('tok_old', dir)).toBeUndefined();
      // The candidate page itself is not scanned (wantCandidate=false) and survives.
      expect(getIssue('cand_1', dir)).toBeDefined();
    });

    it('a selected material issue over 120 items remains admissible', () => {
      const big = issue({ pulse: Array.from({ length: 121 }, (_, i) => item({ eventId: `b${i}`, text: i === 0 ? 'the booster landed on the pad.' : `unique source material number ${i}` })) });
      putIssue('tok_big', big, dir);
      expect(admit('tok_big', { ...head, items: { '1': { ...good1, q: 'the booster landed on the pad.' } } }).kind).toBe('admitted');
    });
  });

  describe('5. numbering gate', () => {
    it('unknown or non-editorial numbers in any referencing field → wrongNumbering listing field[key]', () => {
      const base = three();
      const withHouse = {
        ...base,
        pulse: base.pulse.map((p, i) => (i === 2 ? { ...p, houseFields: { note: 'house row' } } : p)),
      };
      putIssue('tok_a', withHouse, dir);
      const r = admit('tok_a', {
        ...head,
        items: { '1': good1, '3': { h: 'house', s: 'row.', q: Q3 } },
        pulls: { '9': 'x' },
        xrefs: { '1': 'fine', '8': 'y' },
        topics: { '7': 'z' },
        leads: [1, 42],
      });
      expect(r).toEqual({
        kind: 'refused',
        text: t('wrongNumbering', { stray: '5', total: '8', numbers: 'items[3] pulls[9] xrefs[8] topics[7] leads[42]' }),
      });
      expect(getEdit('tok_a', dir)).toBeUndefined();
    });

    it('a stray number in the STORED prior edit refuses a clean hand-in too', () => {
      putIssue('tok_a', three(), dir);
      putEdit('tok_a', { ...head, items: { '1': { h: 'x' } }, leads: [5] } as NewspaperEdit, dir);
      const before = getEdit('tok_a', dir);
      expect(admit('tok_a', { ...head, items: { '2': good2 } })).toEqual({
        kind: 'refused',
        text: t('wrongNumbering', { stray: '1', total: '3', numbers: 'leads[5]' }),
      });
      expect(getEdit('tok_a', dir)).toEqual(before);
    });
    it('checkEdit error (no usable item copy) → refused with that error; the stored edit is untouched', () => {
      putIssue('tok_a', three(), dir);
      putEdit('tok_a', { ...head, items: { '1': good1 } } as NewspaperEdit, dir);
      const before = getEdit('tok_a', dir);
      expect(admit('tok_a', { ...head, items: { '2': { h: '  ', s: ' ' } } })).toEqual({
        kind: 'refused',
        text: t('editNoItems'),
      });
      expect(getEdit('tok_a', dir)).toEqual(before);
    });
  });

  describe('5b. invalid material numbering', () => {
    it('a stored issue with mixed stable numbering → invalidMaterialNumbering', () => {
      // One item carries a stable itemNumber, the other none: numberedPulse throws.
      const mixed = issue({ pulse: [item({ eventId: 'm1', itemNumber: 5 }), item({ eventId: 'm2' })] });
      putIssue('tok_m', mixed, dir);
      expect(admit('tok_m', { ...head, items: { '5': good1 } })).toEqual({
        kind: 'refused',
        text: t('invalidMaterialNumbering'),
      });
      expect(getEdit('tok_m', dir)).toBeUndefined();
    });
  });

  describe('6. anchor refusal', () => {
    it('one bad q → admitted with anchorRefused; its pulls/xrefs/topics dropped, leads kept', () => {
      putIssue('tok_a', three(), dir);
      const a = admitted(
        admit('tok_a', {
          ...head,
          items: { '1': good1, '2': { h: 'wrong', s: 'camera copy under Quanta.', q: Q1 } },
          pulls: { '1': Q1, '2': Q2 },
          xrefs: { '1': 'x1', '2': 'x2' },
          topics: { '1': 't1', '2': 't2' },
          leads: [2, 1],
        }),
      );
      expect(a.notes).toEqual([anchorLine(1, `[2] (${why('notInBody')})`)]);
      expect(Object.keys(a.edit.items!)).toEqual(['1']);
      expect(a.edit.pulls).toEqual({ '1': Q1 });
      expect(a.edit.xrefs).toEqual({ '1': 'x1' });
      expect(a.edit.topics).toEqual({ '1': 't1' });
      expect(a.edit.leads).toEqual([2, 1]);
      expect(getEdit('tok_a', dir)).toBeUndefined();
    });

    it('every item bad → refused with the anchorRefused line plus the reprint of exactly those items', () => {
      const stored = three();
      putIssue('tok_a', stored, dir);
      const r = admit('tok_a', {
        ...head,
        items: { '3': { h: 'no anchor', s: 'x.' }, '1': { h: 'wrong', s: 'y.', q: Q2 } },
      });
      const line = anchorLine(2, `[1] (${why('notInBody')}) [3] (${why('missing')})`);
      expect(r).toEqual({ kind: 'refused', publishToken: 'tok_a', text: `${line}\n\n${reprintOf(stored, [1, 3], 'en')}` });
      expect(getEdit('tok_a', dir)).toBeUndefined();
    });
  });

  describe('7. pull quotes', () => {
    it('a non-verbatim pull is dropped with pullNotVerbatim; the item stays', () => {
      putIssue('tok_a', three(), dir);
      const a = admitted(
        admit('tok_a', { ...head, items: { '1': good1, '2': good2 }, pulls: { '1': 'words nobody said', '2': Q2 } }),
      );
      expect(a.notes).toEqual([t('pullNotVerbatim', { numbers: '[1]' })]);
      expect(a.edit.pulls).toEqual({ '2': Q2 });
      expect(Object.keys(a.edit.items!).sort()).toEqual(['1', '2']);
    });

    it('a pull already printed by a prior batch is not rechecked, and the prior one stands', () => {
      putIssue('tok_a', three(), dir);
      putEdit('tok_a', { ...head, items: { '1': good1 }, pulls: { '1': 'an earlier invention' } } as NewspaperEdit, dir);
      const before = getEdit('tok_a', dir);
      const a = admitted(admit('tok_a', { items: { '2': good2 }, pulls: { '1': 'a later invention', '2': Q2 } }));
      expect(a.notes).toEqual([]);
      expect(a.edit.pulls).toEqual({ '1': 'an earlier invention', '2': Q2 });
      expect(getEdit('tok_a', dir)).toEqual(before);
    });
  });

  describe('8. prior edit', () => {
    it('admitted edit is the fill-only merge: earlier copy kept, empty slots filled', () => {
      putIssue('tok_a', three(), dir);
      putEdit(
        'tok_a',
        { masthead: 'Old Masthead', teaser: 'old teaser', basis: 'tok_a', items: { '1': { h: 'old head' } }, leads: [1] } as NewspaperEdit,
        dir,
      );
      const before = getEdit('tok_a', dir);
      const a = admitted(
        admit('tok_a', {
          masthead: 'New Masthead',
          teaser: 'new teaser',
          items: { '1': { h: 'new head', s: 'new body.', q: Q1 }, '2': good2 },
          leads: [2],
        }),
      );
      expect(a.notes).toEqual([]);
      expect(a.edit.masthead).toBe('Old Masthead');
      expect(a.edit.teaser).toBe('old teaser');
      expect(a.edit.basis).toBe('tok_a');
      expect(a.edit.leads).toEqual([1]);
      expect(a.edit.items).toEqual({ '1': { h: 'old head', s: 'new body.', q: Q1 }, '2': good2 });
      expect(getEdit('tok_a', dir)).toEqual(before);
    });
  });

  describe('9. notes order', () => {
    it('binding → anchor → pull in one call', () => {
      putIssue('tok_a', three(), dir);
      const a = admitted(
        admit('***', {
          ...head,
          basis: 'tok_a',
          items: { '1': good1, '2': { h: 'wrong', s: 'z.', q: Q3 } },
          pulls: { '1': 'never said this' },
        }),
      );
      expect(a.publishToken).toBe('tok_a');
      expect(a.notes).toEqual([
        t('basisBoundNote', { token: 'tok_a' }),
        anchorLine(1, `[2] (${why('notInBody')})`),
        t('pullNotVerbatim', { numbers: '[1]' }),
      ]);
      expect(getEdit('tok_a', dir)).toBeUndefined();
    });
  });
});
