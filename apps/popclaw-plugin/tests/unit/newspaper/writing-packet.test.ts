import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { buildIssueFromPicks } from '../../../src/newspaper/pick-issue.js';
import { getEdit, getIssue, putIssue, _resetIssuesForTest } from '../../../src/newspaper/issue-store.js';
import { readNewspaperDocument, readNewspaperPage } from '../../../src/newspaper/reading-page.js';
import { noteContextTokenBudget, _resetBudgetForTest } from '../../../src/newspaper/host-budget.js';
import { publishNewspaper } from '../../../src/newspaper/publish-newspaper.js';
import { createLocalNewspaperIssueArchive } from '../../../src/host/local-newspaper-artifacts.js';
import { readFileSync } from 'node:fs';
import { writingPacket } from '../../../src/newspaper/writing-packet.js';
import { makeScratch, dropScratch, type Scratch } from './_scratch.js';
import { issue, item } from './_issue-fixture.js';

let scratch: Scratch;
beforeEach(() => { scratch = makeScratch('writing-packet'); _resetIssuesForTest(); _resetBudgetForTest(); });
afterEach(() => dropScratch(scratch));

it('presents the next writing packet rather than all 24 selected bodies, retaining the complete issue', () => {
  const pulse = Array.from({ length: 24 }, (_, i) => item({
    eventId: `packet-event-${i}`, author: `writer${i}`, sigil: `packet${i}`,
    text: `Source ${i + 1}. ` + 'Verified original words. '.repeat(30) + `SOURCE_END_${i + 1}`,
  }));
  putIssue('ctok_packet', issue({ language: 'en', pulse }));
  const picked = buildIssueFromPicks('ctok_packet', pulse.map((_, i) => i + 1), {
    mintToken: () => 'tok_packet', contentRules: '', leadMax: 3,
    perAuthorMax: Infinity, floor: 0, topUpTo: 0,
  });
  if (picked.kind === 'error') throw new Error(picked.message);
  const complete = getIssue(picked.publishToken)!;
  expect(complete.pulse).toHaveLength(24);
  expect(complete.pulse.map(p => p.text)).toEqual(pulse.map(p => p.text));
  expect(complete.pulse.map(p => p.itemNumber)).toEqual(pulse.map((_, i) => i + 1));
  const doc = readNewspaperDocument(picked.publishToken).text;
  expect(doc).toContain('SOURCE_END_1');
  expect(doc).not.toContain('SOURCE_END_13');
  expect(doc).not.toContain('SOURCE_END_24');
  expect(doc).toContain('writer23#packet23');
  expect(doc).toContain('[24]');
});

function selected(count: number, source?: string) {
  const candidates = Array.from({ length: count * 2 }, (_, i) => item({
    eventId: `source-${i}`, author: `author${i}`, sigil: `sigil${i}`, itemNumber: i + 1,
    text: source ?? `The verified original source number ${i} contains its own unique account. ` + 'Background. '.repeat(40) + `END_SOURCE_${i}`,
  }));
  const pulse = candidates.filter((_, i) => i % 2 === 0);
  const data = issue({ language: 'en', pulse: candidates });
  putIssue('ctok_select', data, scratch.root);
  const result = buildIssueFromPicks('ctok_select', pulse.map(p => p.itemNumber!), {
    mintToken: () => 'tok_select', contentRules: '', leadMax: 3, perAuthorMax: Infinity,
    floor: 0, topUpTo: 0, manifestDir: scratch.root,
  });
  if (result.kind === 'error') throw new Error(result.message);
  return { pulse, result, doc: readNewspaperDocument('tok_select', { manifestDir: scratch.root }) };
}
const numbersIn = (text: string): number[] => {
  const marker = /\[Current writing packet: (.*)\]/.exec(text)![1]!;
  return [...marker.matchAll(/\[(\d+)\]/g)].map(m => Number(m[1]));
};
const bodyOf = (page: string): string => page.slice(page.indexOf('\n\n') + 2, page.lastIndexOf('\n\n['));
const nextOf = (page: string): string | undefined => /page_cursor="([^"]+)"/.exec(page)?.[1];
function publisher() {
  const upload = vi.fn(async () => ({ url: 'https://canvas.example/paper' }));
  return { upload, signer: { popclawId: async () => 'fixture-owner' } as never, nickname: 'Owner',
    canvasBaseUrl: 'https://canvas.example', manifestDir: scratch.root, lang: 'en' as const,
    avatarMode: 'off' as const, fonts: 'system' as const,
    archive: createLocalNewspaperIssueArchive({ issuesDir: scratch.issuesDir, lastNewspaperHtml: scratch.lastNewspaperHtml }) };
}
const copyOf = (pulse: ReturnType<typeof item>[], numbers: number[]) => Object.fromEntries(numbers.map(n => {
  const p = pulse.find(p => p.itemNumber === n)!;
  return [String(n), { q: p.text, h: `Headline ${n}`, s: `Faithful saved copy ${n}.` }];
}));

it('keeps gaps, excludes structured house fields, and chooses fewer whole sources when they are long', () => {
  const data = issue({ pulse: [
    item({ itemNumber: 4, text: 'Large original. '.repeat(1000) }),
    item({ itemNumber: 8, houseFields: { scene: 'verbatim' } }),
    item({ itemNumber: 17, text: 'next source' }),
  ] });
  expect(writingPacket(data, [4, 8, 17]).map(p => p.n)).toEqual([4]);
  expect(writingPacket(data, [8, 17]).map(p => p.n)).toEqual([17]);
  expect(data.pulse[0]!.text).toBe('Large original. '.repeat(1000));
});

it('reads a long current source completely without splitting Unicode or exposing the next source body', () => {
  noteContextTokenBudget(undefined, 32000);
  const source = '  Long original𠀀🙂\r\n'.repeat(4000) + 'SOURCE_FINAL_BYTE\n';
  const { doc, pulse } = selected(2, source);
  expect(doc.text.match(/^\[\d+\] author:/gm)).toHaveLength(3); // two directory lines and one full body
  expect(doc.text).toContain(source);
  const cursor = `tok_select.${doc.version}.0`;
  let page = readNewspaperPage(cursor, { manifestDir: scratch.root });
  expect(nextOf(page)).toBeDefined();
  expect(readNewspaperPage(cursor, { manifestDir: scratch.root })).toBe(page);
  _resetIssuesForTest();
  let reconstructed = bodyOf(page), next = nextOf(page);
  while (next) {
    page = readNewspaperPage(next, { manifestDir: scratch.root });
    reconstructed += bodyOf(page); next = nextOf(page);
  }
  expect(Buffer.from(reconstructed)).toEqual(Buffer.from(doc.text));
  expect(getIssue('tok_select', scratch.root)!.pulse.map(p => p.text)).toEqual(pulse.map(p => p.text));
});

it('advances only saved copy across packets and publishes the complete 30-source issue once', async () => {
  const { pulse, doc } = selected(30);
  const deps = publisher();
  const allNumbers = pulse.map(p => p.itemNumber!);
  let current = doc, rounds = 0;
  const sent: number[] = [];
  while (true) {
    const fullBodies = current.text.slice(current.text.indexOf('[Current writing packet:'));
    const packet = numbersIn(fullBodies);
    expect(packet.length).toBeGreaterThan(0); expect(packet.length).toBeLessThanOrEqual(12);
    expect(packet.some(n => sent.includes(n))).toBe(false);
    const oldCursor = `tok_select.${current.version}.0`;
    expect(readNewspaperPage(oldCursor, { manifestDir: scratch.root })).toBe(readNewspaperPage(oldCursor, { manifestDir: scratch.root }));
    const receipt = await publishNewspaper(deps, { edit: { basis: 'tok_select',
      ...(rounds === 0 ? { masthead: 'Full Gazette', teaser: 'A faithful trailer', leads: [allNumbers.at(-1)!] } : {}),
      items: copyOf(pulse, packet) } });
    expect(receipt.accepted).toBe(true); sent.push(...packet); rounds++;
    if (sent.length === pulse.length) { expect(receipt.landed).toBe(true); break; }
    expect(receipt.landed).toBeUndefined(); expect(deps.upload).not.toHaveBeenCalled();
    expect(getEdit('tok_select', scratch.root)!.basis).toBe('tok_select');
    expect(Object.keys(getEdit('tok_select', scratch.root)!.items!)).toHaveLength(sent.length);
    expect(getIssue('tok_select', scratch.root)!.pulse.map(p => p.text)).toEqual(pulse.map(p => p.text));
    expect(() => readNewspaperPage(oldCursor, { manifestDir: scratch.root })).toThrow('not found');
    current = readNewspaperDocument('tok_select', { manifestDir: scratch.root });
    _resetIssuesForTest();
    expect(readNewspaperDocument('tok_select', { manifestDir: scratch.root })).toEqual(current);
    expect(rounds).toBeLessThan(31);
  }
  expect(sent).toEqual(allNumbers); expect(rounds).toBeGreaterThan(1);
  expect(deps.upload).toHaveBeenCalledOnce();
  const html = readFileSync(scratch.lastNewspaperHtml, 'utf8');
  for (const n of allNumbers) expect(html).toContain(`Faithful saved copy ${n}.`);
  expect(getIssue('tok_select', scratch.root)).toBeUndefined();
});

it('does not advance refused copy and still accepts valid same-issue items outside the advertised packet', async () => {
  const { pulse, doc } = selected(25);
  const deps = publisher();
  const rejected = await publishNewspaper(deps, { edit: { basis: 'tok_select', masthead: 'Gazette', teaser: 'Trailer',
    items: { '1': { q: 'This quote is absent from the source body.', h: 'Bad', s: 'Bad' } } } });
  expect(rejected.accepted).toBeUndefined(); expect(getEdit('tok_select', scratch.root)).toBeUndefined();
  const correction = readNewspaperDocument('tok_select', { manifestDir: scratch.root });
  const correctionCursor = `tok_select.${correction.version}.0`;
  const correctionPage = readNewspaperPage(correctionCursor, { manifestDir: scratch.root });
  _resetIssuesForTest();
  expect(readNewspaperPage(correctionCursor, { manifestDir: scratch.root })).toBe(correctionPage);
  expect(getEdit('tok_select', scratch.root)).toBeUndefined();
  // A refusal may reprint correction material, but must never mark a source as saved.
  const accepted = await publishNewspaper(deps, { edit: { basis: 'tok_select', masthead: 'Gazette', teaser: 'Trailer',
    items: { ...copyOf(pulse, [49]), '1': { q: 'This quote is absent from the source body.', h: 'Bad', s: 'Bad' } } } });
  expect(accepted.accepted).toBe(true); expect(accepted.landed).toBeUndefined();
  expect(Object.keys(getEdit('tok_select', scratch.root)!.items!)).toEqual(['49']);
  const next = readNewspaperDocument('tok_select', { manifestDir: scratch.root });
  expect(next.version).not.toBe(doc.version);
  expect(next.text).toContain('[Current writing packet: [1]');
  expect(next.text.slice(next.text.indexOf('[Current writing packet:'))).not.toContain('END_SOURCE_24');
  expect(deps.upload).not.toHaveBeenCalled();
});
