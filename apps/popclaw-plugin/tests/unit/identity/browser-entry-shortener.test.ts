/**
 * The shortener leg of `popclaw_house_entry_link` — the one HTTP round trip
 * this feature makes on the owner's behalf, and the one place a house-side
 * bug or a hostile reply could turn a convenience into a redirection.
 *
 * Three things are pinned here, all from the now-authoritative one-page
 * contract:
 *
 *  - the reply's ONLY meaningful field is `url` — `short_url` / `shortUrl`
 *    are not read, so a house that only speaks the old shape is treated the
 *    same as a house that named no link at all;
 *  - a redirect is refused, not followed — the request explicitly disables
 *    redirect-following rather than trusting the HTTP client's default, and
 *    the token is never handed to wherever a 30x tried to send it;
 *  - a reply past the size cap is refused without being buffered to
 *    completion.
 *
 * The first group uses an injected `postJson` fake (pure, no sockets). The
 * redirect and size-cap groups exercise the real default transport against a
 * loopback fixture server — the property under test is what the actual HTTP
 * stack does, not what a fake claims it would do.
 */
import { describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { shortenBrowserEntryLink, type PostJson } from '../../../src/identity/browser-entry-shortener.js';
import { BROWSER_ENTRY_PROFILE, type VerifiedBrowserEntry } from '../../../src/identity/browser-entry.js';

const APP = 'https://app.example';
const TOKEN = 'pcw2.fixture-token';

function entryFor(shortenUrl: string, audience = APP): VerifiedBrowserEntry {
  return { profile: BROWSER_ENTRY_PROFILE, audience, entryUrl: `${audience}/welcome`, shortenUrl };
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('FIXTURE_ADDRESS');
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
}

describe('wire shape: a 200 JSON reply naming `url`, and nothing else', () => {
  function fake(status: number, text: string): PostJson {
    return async () => ({ status, text });
  }

  it('accepts a reply that names only `url`', async () => {
    const out = await shortenBrowserEntryLink({
      entry: entryFor(`${APP}/api/shorten`),
      token: TOKEN,
      postJson: fake(200, JSON.stringify({ url: `${APP}/w/abc123` })),
    });
    expect(out).toEqual({ kind: 'short', link: `${APP}/w/abc123` });
  });

  it('does not read `short_url` or `shortUrl` — a reply naming only those is a reply naming no link', async () => {
    const out = await shortenBrowserEntryLink({
      entry: entryFor(`${APP}/api/shorten`),
      token: TOKEN,
      postJson: fake(200, JSON.stringify({ short_url: `${APP}/w/old1`, shortUrl: `${APP}/w/old2` })),
    });
    expect(out).toEqual({ kind: 'failed', reason: 'reply named no link' });
  });

  it.each([
    ['400 bad_request', 400, { error: 'bad_request' }],
    ['400 bad_format', 400, { error: 'bad_format' }],
    ['400 bad_version', 400, { error: 'bad_version' }],
    ['400 expired', 400, { error: 'expired' }],
    ['401 bad_signature', 401, { error: 'bad_signature' }],
  ])('falls back on the site\'s own %s reply', async (_label, status, body) => {
    const out = await shortenBrowserEntryLink({
      entry: entryFor(`${APP}/api/shorten`),
      token: TOKEN,
      postJson: fake(status, JSON.stringify(body)),
    });
    expect(out).toEqual({ kind: 'failed', reason: `HTTP ${status}` });
  });

  it('refuses a 200 reply whose `url` is missing or not a string', async () => {
    const out = await shortenBrowserEntryLink({
      entry: entryFor(`${APP}/api/shorten`),
      token: TOKEN,
      postJson: fake(200, JSON.stringify({ url: 12345 })),
    });
    expect(out).toEqual({ kind: 'failed', reason: 'reply named no link' });
  });

  it('refuses a reply that is not JSON at all', async () => {
    const out = await shortenBrowserEntryLink({
      entry: entryFor(`${APP}/api/shorten`),
      token: TOKEN,
      postJson: fake(200, 'not json'),
    });
    expect(out).toEqual({ kind: 'failed', reason: 'unreadable reply' });
  });
});

describe('a redirect is refused, never followed', () => {
  it('does not follow a 30x, and never hands the token to where it points', async () => {
    const hits: string[] = [];
    const decoy = createServer((req, res) => {
      hits.push(req.url ?? '');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ url: 'https://evil.example/w/stolen' }));
    });
    const decoyOrigin = await listen(decoy);
    const shortener = createServer((req, res) => {
      res.writeHead(302, { location: `${decoyOrigin}/api/shorten` });
      res.end();
    });
    const shortenerOrigin = await listen(shortener);
    try {
      const out = await shortenBrowserEntryLink({
        entry: entryFor(`${shortenerOrigin}/api/shorten`),
        token: TOKEN,
      });
      expect(out).toEqual({ kind: 'failed', reason: 'HTTP 302' });
      expect(hits).toEqual([]);
    } finally {
      await close(shortener);
      await close(decoy);
    }
  });
});

describe('the shortener reply is capped', () => {
  it('refuses a reply larger than the cap instead of buffering it to completion', async () => {
    let interval: ReturnType<typeof setInterval> | undefined;
    const server = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      // A well-behaved reply is a few hundred bytes. This one never ends —
      // if the caller waited for it to finish before refusing, this test
      // would hang (or wait out the read timeout) instead of resolving
      // quickly.
      interval = setInterval(() => res.write('x'.repeat(4096)), 5);
    });
    const origin = await listen(server);
    try {
      const started = Date.now();
      const out = await shortenBrowserEntryLink({
        entry: entryFor(`${origin}/api/shorten`),
        token: TOKEN,
      });
      expect(Date.now() - started).toBeLessThan(4000);
      expect(out.kind).toBe('failed');
      expect(out.kind === 'failed' && out.reason).toContain('exceeded');
    } finally {
      if (interval) clearInterval(interval);
      await close(server);
    }
  }, 8000);
});
