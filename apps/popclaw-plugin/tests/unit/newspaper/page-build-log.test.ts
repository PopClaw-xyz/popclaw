/**
 * The one info line each page build leaves behind.
 *
 * On 2026-09-13 a workshop run came back with both pages truncated and the log could not
 * say which session key the budget had been looked up under, where the number came from, or
 * what the page actually weighed — so the two readings of the failure (the hook never fires
 * for a subagent session / it fires under a different key) could not be told apart. These
 * pages now say all of it, in numbers and session keys only: never a word of the material.
 *
 * **info, never warn** — an MCP host swallows warn and error entirely.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { gatherNewspaperMaterials, type GatherDeps } from '../../../src/newspaper/gather-materials.js';
import { buildIssueFromPicks } from '../../../src/newspaper/pick-issue.js';
import { putIssue, _resetIssuesForTest } from '../../../src/newspaper/issue-store.js';
import { _resetBudgetForTest, noteContextTokenBudget } from '../../../src/newspaper/host-budget.js';
import { issue, item } from './_issue-fixture.js';

const SESSION = 'agent:main:popclaw-newspaper:20260913-0956';

const gatherDeps = (over: Partial<GatherDeps> = {}): GatherDeps => ({
  cache: {
    recentForReading: () =>
      [
        {
          handle: 'elonmusk',
          textPreview: 'ship it',
          body: 'ship it',
          media: [],
          replyToAuthorHandle: '',
          replyCount: 0,
          platform: 'x',
          platformPostCreatedAt: 99000,
          eventId: '',
          platformPostId: '',
          originalUrl: 'https://x.com/elonmusk/1',
        },
      ] as never,
  },
  inbox: { recent: () => [] as never },
  readContentRules: () => '',
  ownerNickname: 'Yu',
  webBaseUrl: 'https://popclaw.me',
  now: () => 100000,
  mintToken: () => 'tok_test',
  isFollowing: () => false,
  ...over,
});

beforeEach(() => {
  _resetIssuesForTest();
  _resetBudgetForTest();
});

describe('the candidate page says how it was sized', () => {
  it('names the key it looked the budget up under, where the number came from, and the weight', () => {
    const lines: string[] = [];
    noteContextTokenBudget(SESSION, 200_000);
    gatherNewspaperMaterials(gatherDeps({ sessionKey: SESSION, log: (m) => lines.push(m) }), { hours: 24 });

    const built = lines.filter((l) => l.includes('candidate page built'));
    expect(built).toHaveLength(1);
    expect(built[0]).toContain(`session "${SESSION}"`);
    expect(built[0]).toContain('(own, 200000 context tokens)');
    expect(built[0]).toMatch(/page \d+ units, \d+ of \d+ items trimmed/);
    // Session keys, numbers and counts — nothing the page carries.
    expect(built[0]).not.toContain('ship it');
    expect(built[0]).not.toContain('elonmusk');
  });

  it('a session that never reported is logged as falling back, which is the whole point', () => {
    const lines: string[] = [];
    noteContextTokenBudget(undefined, 256_000); // only the chat session ever synced
    gatherNewspaperMaterials(gatherDeps({ sessionKey: SESSION, log: (m) => lines.push(m) }), { hours: 24 });
    expect(lines.find((l) => l.includes('candidate page built'))).toContain('(default-bucket, 256000 context tokens)');
  });

  it('no logger injected = silent, exactly as before', () => {
    expect(() => gatherNewspaperMaterials(gatherDeps({ sessionKey: SESSION }), { hours: 24 })).not.toThrow();
  });
});

describe('the material page says the same things', () => {
  const opts = {
    mintToken: () => 'tok_x',
    contentRules: '',
    leadMax: 3,
    perAuthorMax: 6,
    floor: 0,
    topUpTo: 0,
  };

  it('logs one line per build, with the picks that were trimmed counted', () => {
    const lines: string[] = [];
    putIssue('c1', issue({ pulse: [item({ text: 'a', eventId: 'e1' }), item({ text: 'b', eventId: 'e2' })] }));
    buildIssueFromPicks('c1', [1, 2], { ...opts, sessionKey: SESSION, log: (m) => lines.push(m) });

    const built = lines.filter((l) => l.includes('material page built'));
    expect(built).toHaveLength(1);
    expect(built[0]).toContain(`session "${SESSION}"`);
    expect(built[0]).toContain('(constant)'); // nothing was ever reported by any session
    expect(built[0]).toContain('0 of 2 items trimmed');
  });
});
