/**
 * The publisher is never offered themselves.
 *
 * Proven end to end before this test existed: the owner's own byline on the
 * owner's own paper carried a live follow chip, clicking it minted a canvas
 * intent naming the publisher as both sides, and the publisher's own plugin
 * pulled it back in as somebody to follow.
 *
 * Two places, because they are two different refusals. Taking the chip off the
 * page stops it being OFFERED; refusing the intent at the door stops it being
 * ACCEPTED, which still matters — papers already in the wild carry the old
 * markup, and the intake is credited by the canvas, not by this renderer.
 */
import { createLocalNewspaperIssueArchive } from '../../../src/host/local-newspaper-artifacts.js';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderNewspaper, type NewspaperEdit } from '../../../src/newspaper/render-newspaper.js';
import { DEFAULT_STYLE } from '../../../src/newspaper/newspaper-style.js';
import { publishNewspaper } from '../../../src/newspaper/publish-newspaper.js';
import { putIssue, _resetIssuesForTest } from '../../../src/newspaper/issue-store.js';
import { issue, item } from './_issue-fixture.js';
import { dropScratch, makeScratch, type Scratch } from './_scratch.js';
import { InMemoryHostDb } from '../../../src/host/in-memory-host-db.js';
import { runMigrations } from '../../../src/host/migrations.js';
import { PendingFollowStore, type FollowIntentRow } from '../../../src/social-graph/pending-follow-store.js';
import { createDoorbellService, doorbellStrings } from '../../../src/newspaper/follow-doorbell-service.js';
import type { FollowableAuthorRow } from '../../../src/newspaper/followable-authors.js';

const MIGRATIONS = resolve(dirname(fileURLToPath(import.meta.url)), '../../../migrations');

/** Production-shaped popclaw ids: ~44 chars of base58. */
const OWNER = '3fQwbEyrTUmNehkPgLszTkEtDvjohTcAySwFxNagXq8r';
const OTHER = '7xKvGjWntCHSPQoyY2mLBRTDdQFEAqNsZz4fCcrKVJ9u';

const EDIT: NewspaperEdit = {
  masthead: 'The Cloudboat Chronicle',
  items: { '1': { h: 'The booster came home', s: 'One.' }, '2': { h: 'Second', s: 'Two.' } },
};

/** `tier` decides card head versus brief row — the two places a chip is printed. */
const page = (tier: 'card' | 'brief'): string =>
  renderNewspaper(
    issue({
      pulse: [
        item({ tier, author: 'Cloudboat', sigil: 'own1', authorPopclawId: OWNER }),
        item({ tier, author: 'Somebody', sigil: 'els2', authorPopclawId: OTHER }),
      ],
    }),
    EDIT,
    DEFAULT_STYLE,
    'en',
    { doorbell: true, ownerPopclawId: OWNER },
  ).html;

describe('the follow chip on the owner"s own paper', () => {
  it.each(['card', 'brief'] as const)('offers other authors but never the owner (%s)', (tier) => {
    const html = page(tier);
    expect(html).toContain(`data-followee="${OTHER}"`);
    expect(html).not.toContain(`data-followee="${OWNER}"`);
    // One followable author on the page, so exactly one chip.
    expect(html.split('class="follow-btn"').length - 1).toBe(1);
  });

  it('still names the owner as an author — the chip goes, the person stays', () => {
    // The byline, its avatar and its link to the author's own page are the
    // discovery path that survives; only the one-click offer is withdrawn.
    expect(page('card')).toContain('Cloudboat');
  });

  it('with no owner id known, nothing changes for anyone else', () => {
    // Every caller that renders a local copy passes no owner; the guard must
    // not quietly drop chips there.
    const html = renderNewspaper(
      issue({ pulse: [item({ tier: 'card', author: 'Somebody', authorPopclawId: OTHER })] }),
      EDIT,
      DEFAULT_STYLE,
      'en',
      { doorbell: true },
    ).html;
    expect(html).toContain(`data-followee="${OTHER}"`);
  });
});

describe('publish hands the renderer who signed the paper', () => {
  let scratch: Scratch;
  beforeEach(() => {
    scratch = makeScratch('owner-chip');
    _resetIssuesForTest();
  });
  afterEach(() => dropScratch(scratch));

  it('the uploaded page offers no chip for the publisher"s own byline', async () => {
    // End to end through the real publish path, because the renderer option is
    // only as good as the caller that fills it: publish is the one caller that
    // turns the doorbell on, so it is the one that has to say who signed.
    const Q = 'the booster landed on the pad.';
    putIssue(
      'tok_owner',
      issue({
        pulse: [
          item({ text: Q, tier: 'card', author: 'Cloudboat', sigil: 'own1', authorPopclawId: OWNER }),
          item({ text: Q, eventId: 'e2', tier: 'card', author: 'Somebody', sigil: 'els2', authorPopclawId: OTHER }),
        ],
      }),
      scratch.root,
    );
    let uploaded = '';
    await publishNewspaper(
      {
        upload: vi.fn(async (a: { html: string }) => {
          uploaded = a.html;
          return { url: 'https://canvas/x/1?t=tok' };
        }),
        signer: { popclawId: async () => OWNER } as never,
        nickname: 'Cloudboat',
        canvasBaseUrl: 'https://canvas',
        archive: createLocalNewspaperIssueArchive({ issuesDir: scratch.issuesDir, lastNewspaperHtml: scratch.lastNewspaperHtml }),
        manifestDir: scratch.root,
      },
      {
        publishToken: 'tok_owner',
        edit: {
          masthead: 'The Cloudboat Chronicle',
          items: { '1': { q: Q, h: 'The booster came home', s: 'One.' }, '2': { q: Q, h: 'Second', s: 'Two.' } },
          teaser: 'Today',
        },
      },
    );
    expect(uploaded).toContain(`data-followee="${OTHER}"`);
    expect(uploaded).not.toContain(`data-followee="${OWNER}"`);
  });
});

describe('the doorbell intake', () => {
  const intent = (followee: string): FollowIntentRow => ({
    owner_popclaw_id: OWNER,
    followee_popclaw_id: followee,
    followee_label: 'Cloudboat#own1',
    first_ts: 1_750_000_000_000,
    latest_ts: 1_750_000_000_000,
    click_count: 1,
  });

  const authorRow = (id: string): FollowableAuthorRow => ({
    issue_date: '2026-09-18',
    popclaw_id: id,
    display_name: 'Someone#abcd',
    descriptor: null,
    expires_at: 1_750_000_000_000 + 48 * 60 * 60 * 1000,
  });

  it('refuses an intent naming the owner as both sides, and still takes the rest of the batch', async () => {
    const db = new InMemoryHostDb();
    runMigrations(db, MIGRATIONS);
    const store = new PendingFollowStore(db);
    const enqueued: Array<{ kind: string; payload: Record<string, unknown> }> = [];
    const service = createDoorbellService({
      ownerPopclawId: OWNER,
      pull: async () => [intent(OWNER), intent(OTHER)],
      store,
      followsIn: () => false,
      readFollowableAuthors: () => [authorRow(OWNER), authorRow(OTHER)],
      notifier: { enqueue: (i) => void enqueued.push(i) },
      deliverNow: async () => true,
      clock: () => 1_750_000_000_000,
      localHour: () => 12,
      strings: () => doorbellStrings('en'),
      logger: { info: () => {}, warn: () => {} },
    });
    await service.tick();
    expect(store.listPending().map((r) => r.followee_popclaw_id)).toEqual([OTHER]);
    expect(enqueued).toEqual([{ level: 'L2', kind: 'follow_intent', payload: { count: 1 } }]);
  });

  it('a batch of nothing but the owner lands nothing and announces nothing', async () => {
    const db = new InMemoryHostDb();
    runMigrations(db, MIGRATIONS);
    const store = new PendingFollowStore(db);
    const enqueued: unknown[] = [];
    const service = createDoorbellService({
      ownerPopclawId: OWNER,
      pull: async () => [intent(OWNER)],
      store,
      followsIn: () => false,
      readFollowableAuthors: () => [authorRow(OWNER)],
      notifier: { enqueue: (i) => void enqueued.push(i) },
      deliverNow: async () => true,
      clock: () => 1_750_000_000_000,
      localHour: () => 12,
      strings: () => doorbellStrings('en'),
      logger: { info: () => {}, warn: () => {} },
    });
    await service.tick();
    expect(store.listPending()).toEqual([]);
    expect(store.hasDroppedUnreported()).toEqual([]); // not "already followed" — never a candidate
    expect(enqueued).toEqual([]);
  });
});
