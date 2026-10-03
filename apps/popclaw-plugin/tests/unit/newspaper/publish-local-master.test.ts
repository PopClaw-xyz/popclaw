/**
 * The local HTML file is the master copy of the paper.
 *
 * The paper is written on this machine; the publisher, when there is one, is
 * only a way to share it. So the control flow says so too: render → write the
 * file → settle the ledger → *then*, optionally, upload. An upload that never
 * happens (no publisher) or fails costs the receipt a link line and nothing
 * else; only a file we could not write is a failed publish.
 */
import { createLocalNewspaperIssueArchive } from '../../../src/host/local-newspaper-artifacts.js';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { publishNewspaper, type PublishDeps } from '../../../src/newspaper/publish-newspaper.js';
import { putIssue, getIssue, _resetIssuesForTest } from '../../../src/newspaper/issue-store.js';
import { todayDateLabel } from '../../../src/newspaper/issue.js';
import { renderCopy } from '../../../src/lexicon/index.js';
import { issue, item } from './_issue-fixture.js';

let root: string;
let issuesDir: string;
let lastHtml: string;

const DAY_MS = 24 * 60 * 60 * 1000;

function deps(over: Partial<PublishDeps> = {}): PublishDeps {
  return {
    upload: vi.fn(async () => ({ url: 'https://canvas/x/1?t=tok' })),
    // Publish asks the signer who the owner is, so the publisher's own byline
    // never wears a follow chip on their own paper.
    signer: { popclawId: async () => 'PublisherFixtureId' } as never,
    nickname: 'Yu',
    canvasBaseUrl: 'https://canvas',
    archive: createLocalNewspaperIssueArchive({ issuesDir, lastNewspaperHtml: lastHtml }),
    manifestDir: root,
    ...over,
  };
}

const Q = 'the booster landed on the pad';
const edit = {
  basis: 'tok_live',
  masthead: 'Cloudboat Gazette',
  items: { '1': { q: Q, h: 'The booster came home', s: 'One recovery, landed clean.' } },
  teaser: "Today's lead",
};

const live = () => issue({ dateLabel: todayDateLabel(), pulse: [item()] });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'popclaw-local-master-'));
  issuesDir = join(root, 'issues');
  lastHtml = join(root, 'last-newspaper.html');
  _resetIssuesForTest();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const issueFiles = (): string[] => (existsSync(issuesDir) ? readdirSync(issuesDir).sort() : []);

describe('publishNewspaper — the local master copy', () => {
  it('writes the archive file and last-newspaper.html BEFORE it ever calls the publisher', async () => {
    putIssue('tok_live', live(), root);
    let filesAtUploadTime: string[] = [];
    const upload = vi.fn(async () => {
      filesAtUploadTime = issueFiles();
      return { url: 'https://canvas/x/1?t=tok' };
    });
    const r = await publishNewspaper(deps({ upload }), { edit });
    expect(filesAtUploadTime).toHaveLength(1);
    expect(existsSync(lastHtml)).toBe(true);
    expect(r.landed).toBe(true);
  });

  it('names the archive file <YYYYMMDD-HHmmss>-<issue id>.html and mirrors it into last-newspaper.html', async () => {
    putIssue('tok_live', live(), root);
    await publishNewspaper(deps(), { edit });
    const [name] = issueFiles();
    expect(name).toMatch(/^\d{8}-\d{6}-tok_live\.html$/);
    expect(readFileSync(join(issuesDir, name!), 'utf-8')).toBe(readFileSync(lastHtml, 'utf-8'));
    expect(readFileSync(lastHtml, 'utf-8')).toContain('Cloudboat Gazette');
  });

  it('a republish inside the same second is added to the archive, never written over it', async () => {
    // The archive is the record of what was published. The name used to be
    // minute-resolution, so a second publish of the same issue inside one minute
    // silently replaced the first.
    putIssue('tok_live', live(), root);
    await publishNewspaper(deps(), { edit });
    _resetIssuesForTest();
    putIssue('tok_live', live(), root);
    await publishNewspaper(deps({ upload: vi.fn(async () => ({ url: 'https://canvas/x/2?t=tok' })) }), { edit });
    const names = issueFiles();
    expect(names).toHaveLength(2);
    expect(new Set(names).size).toBe(2);
    // Whichever way the clock fell — a fresh second, or the `-2` suffix — both pages survive.
    for (const n of names) expect(readFileSync(join(issuesDir, n), 'utf-8')).toContain('Cloudboat Gazette');
  });

  it('no remote face survives the page even when no avatar fetcher was wired', async () => {
    // MCP hosts used to reach `publishNewspaper` with no `avatars` deps at all, which
    // skipped the inlining outright and left live unavatar.io urls in the saved page —
    // a paper that reports to a third party every time the owner opens it. The swap to
    // the monogram is the floor, not the fetcher's courtesy.
    putIssue('tok_live', live(), root);
    const r = await publishNewspaper(deps(), { edit });
    expect(r.landed).toBe(true);
    const saved = readFileSync(join(issuesDir, issueFiles()[0]!), 'utf-8');
    expect(saved).not.toContain('unavatar.io');
    expect(readFileSync(lastHtml, 'utf-8')).not.toContain('unavatar.io');
  });

  it('puts the file path on the receipt, with a line per host on how to open it', async () => {
    putIssue('tok_live', live(), root);
    const r = await publishNewspaper(deps(), { edit });
    const path = join(issuesDir, issueFiles()[0]!);
    expect(r.text).toContain(path);
    expect(r.text).toContain(renderCopy('en', 'newspaper.publish.localIssue.howOpenClaw'));
    expect(r.text).toContain(renderCopy('en', 'newspaper.publish.localIssue.howCli', { path }));
  });

  it('a file it cannot write is the one honest failure — nothing else runs', async () => {
    putIssue('tok_live', live(), root);
    const blocked = join(root, 'blocked');
    writeFileSync(blocked, 'not a directory', 'utf-8');
    const upload = vi.fn();
    const record = vi.fn();
    const log = vi.fn();
    const r = await publishNewspaper(
      deps({
        upload: upload as never,
        archive: createLocalNewspaperIssueArchive({ issuesDir: join(blocked, 'issues'), lastNewspaperHtml: lastHtml }),
        recordFollowable: record,
        socialLog: { record: log } as never,
      }),
      { edit },
    );
    expect(upload).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    expect(r.text).toContain(renderCopy('en', 'newspaper.publish.localWriteFailed', { error: '' }).split('{')[0]!.slice(0, 20));
    expect(r.landed).not.toBe(true);
    // The ledger entry survives a failed write: the copy is still good, the disk isn't.
    expect(getIssue('tok_live', root)).toBeDefined();
  });
});

describe('publishNewspaper — with no publisher configured', () => {
  it('never uploads, and still says where the paper is', async () => {
    putIssue('tok_live', live(), root);
    const upload = vi.fn();
    const r = await publishNewspaper(deps({ upload: upload as never, canvasBaseUrl: null }), { edit });
    expect(upload).not.toHaveBeenCalled();
    expect(r.landed).toBe(true);
    expect(r.text).toContain(join(issuesDir, issueFiles()[0]!));
    expect(r.text).toContain(renderCopy('en', 'newspaper.publish.publisherOffNote'));
  });

  it('records the social-log row and the followable authors anyway — the paper did come out', async () => {
    putIssue('tok_live', live(), root);
    const recorded: Array<{ text?: string; url?: string }> = [];
    const followables = vi.fn();
    await publishNewspaper(
      deps({
        canvasBaseUrl: null,
        socialLog: { record: (e: { text?: string; url?: string }) => void recorded.push(e) } as never,
        recordFollowable: followables,
      }),
      { edit },
    );
    expect(recorded).toHaveLength(1);
    // The url of a publish with no publisher is the file the owner can open.
    expect(recorded[0]!.url).toBe(join(issuesDir, issueFiles()[0]!));
    expect(followables).toHaveBeenCalledTimes(1);
  });
});

describe('publishNewspaper — a publisher that fails', () => {
  it('is a note on the receipt, not a failed publish', async () => {
    putIssue('tok_live', live(), root);
    const upload = vi.fn(async () => {
      throw new Error('canvas down');
    });
    const followables = vi.fn();
    const r = await publishNewspaper(deps({ upload: upload as never, recordFollowable: followables }), { edit });
    expect(r.landed).toBe(true);
    expect(r.text).toContain(join(issuesDir, issueFiles()[0]!));
    expect(r.text).toContain('canvas down');
    // The paper came out; the share link didn't. The author set is answerable either way.
    expect(followables).toHaveBeenCalledTimes(1);
  });

  it('appends the short link when the upload works', async () => {
    putIssue('tok_live', live(), root);
    const r = await publishNewspaper(deps(), { edit });
    expect(r.text).toContain(renderCopy('en', 'newspaper.publish.fullText', { url: 'https://canvas/x/1?t=tok' }));
  });
});

describe('publishNewspaper — the 14-day sweep of the issues directory', () => {
  it('drops issues older than 14 days and keeps everything newer', async () => {
    putIssue('tok_live', live(), root);
    // Seed the archive by hand, backdated with utimes.
    const seed = (name: string, ageDays: number): string => {
      const f = join(issuesDir, name);
      writeFileSync(f, '<html></html>', 'utf-8');
      const t = (Date.now() - ageDays * DAY_MS) / 1000;
      utimesSync(f, t, t);
      return f;
    };
    rmSync(issuesDir, { recursive: true, force: true });
    // mkdir via a first publish, then seed around it.
    await publishNewspaper(deps(), { edit });
    const old = seed('20000101-0900-tok_old.html', 20);
    const edge = seed('20000102-0900-tok_edge.html', 13);
    _resetIssuesForTest();
    putIssue('tok_live', live(), root);
    await publishNewspaper(deps(), { edit });
    expect(existsSync(old)).toBe(false);
    expect(existsSync(edge)).toBe(true);
    // Both of today's publishes are still there — the second did not overwrite the first.
    expect(issueFiles().filter((n) => /-tok_live(-\d+)?\.html$/.test(n))).toHaveLength(2);
  });

  it('is not configurable and never sinks the publish — an unreadable file is skipped', async () => {
    putIssue('tok_live', live(), root);
    await publishNewspaper(deps(), { edit });
    writeFileSync(join(issuesDir, 'not-an-issue.txt'), 'x', 'utf-8');
    _resetIssuesForTest();
    putIssue('tok_live', live(), root);
    const r = await publishNewspaper(deps(), { edit });
    expect(r.landed).toBe(true);
    expect(existsSync(join(issuesDir, 'not-an-issue.txt'))).toBe(true);
  });
});

describe('publishNewspaper — the injected archive boundary', () => {
  it('a latest-copy failure retains the issue and archive without claiming publication', async () => {
    putIssue('tok_live', live(), root);
    mkdirSync(lastHtml);
    const upload = vi.fn();
    const recordFollowable = vi.fn();
    const log = vi.fn();
    const result = await publishNewspaper(deps({
      upload: upload as never,
      recordFollowable,
      socialLog: { record: log } as never,
    }), { edit });
    expect(result.landed).toBeUndefined();
    expect(result.accepted).toBeUndefined();
    expect(issueFiles()).toHaveLength(1);
    expect(readFileSync(join(issuesDir, issueFiles()[0]!), 'utf-8')).toContain('Cloudboat Gazette');
    expect(getIssue('tok_live', root)).toBeDefined();
    expect(upload).not.toHaveBeenCalled();
    expect(recordFollowable).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it('does not reach the archive for refused or unfinished hand-ins', async () => {
    const archive = createLocalNewspaperIssueArchive({ issuesDir, lastNewspaperHtml: lastHtml });
    const save = vi.spyOn(archive, 'save');
    putIssue('tok_live', live(), root);
    const refused = await publishNewspaper(deps({ archive }), { edit: { ...edit, basis: 'other' } });
    expect(refused.accepted).toBeUndefined();
    _resetIssuesForTest();
    putIssue('tok_live', issue({
      dateLabel: todayDateLabel(),
      pulse: [item(), item({ text: 'another source', eventId: 'other' })],
    }), root);
    const unfinished = await publishNewspaper(deps({ archive }), { edit });
    expect(unfinished.accepted).toBe(true);
    expect(unfinished.landed).toBeUndefined();
    expect(save).not.toHaveBeenCalled();
    expect(existsSync(issuesDir)).toBe(false);
    expect(existsSync(lastHtml)).toBe(false);
  });

  it('swallows a correction failure without saving or recording the edition again', async () => {
    putIssue('tok_live', live(), root);
    const archive = createLocalNewspaperIssueArchive({ issuesDir, lastNewspaperHtml: lastHtml });
    const save = vi.spyOn(archive, 'save');
    const log = vi.fn();
    const recordFollowable = vi.fn();
    const upload = vi.fn(async () => {
      const archived = join(issuesDir, issueFiles()[0]!);
      rmSync(archived);
      mkdirSync(archived);
      throw new Error('canvas down');
    });
    const result = await publishNewspaper(deps({ archive, upload, recordFollowable, socialLog: { record: log } as never }), { edit });
    expect(result.landed).toBe(true);
    expect(result.accepted).toBe(true);
    expect(result.text).toContain('canvas down');
    expect(save).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledTimes(1);
    expect(recordFollowable).toHaveBeenCalledTimes(1);
    expect(upload).toHaveBeenCalledTimes(1);
    expect(getIssue('tok_live', root)).toBeUndefined();
    expect(issueFiles()).toHaveLength(1);
    expect(readFileSync(lastHtml, 'utf-8')).toContain('Cloudboat Gazette');
  });
});
