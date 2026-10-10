import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { formatInviteResult } from '../../../src/invite/format-invite-result.js';
import type { InviteInitiateResult } from '../../../src/invite/invite-initiator.js';
import { setOwnerLang } from '../../../src/lexicon/owner-language.js';

// S13 slice: formatInviteResult now renders in `ownerLang()` (default en-US)
// instead of hardcoded zh — pin zh-CN so the assertions below stay meaningful.
beforeAll(() => setOwnerLang('zh-CN', 'config'));
afterEach(() => setOwnerLang('zh-CN', 'config'));

function result(push: InviteInitiateResult['push']): InviteInitiateResult {
  return { expectedSigil: 'aabb11', pushedEventId: 'deadbeef', push };
}

const WEB = 'http://localhost:3000';

describe('formatInviteResult', () => {
  it.each(['en', 'zh-CN'] as const)('states the bounded online watch and natural-chat status fallback in %s', lang => {
    setOwnerLang(lang, 'config');
    for (const proof of [undefined, 'https://x.com/example/status/123']) {
      const out = formatInviteResult(result({ status: 200, taskId: 'tracking-1' }), 'x', 'example', WEB, proof);
      expect(out).toMatch(lang === 'en' ? /10 minutes/ : /10 分钟/);
      expect(out).toMatch(lang === 'en' ? /restart/ : /重启/);
      expect(out).toMatch(lang === 'en' ? /ask me.*progress/i : /问我.*进度/);
      expect(out).not.toContain('/popclaw status');
      expect(out).not.toMatch(/come find you right away|第一时间来找你|几十秒内出结果/);
    }
  });
  it.each(['en', 'zh-CN'] as const)('does not promise tracking or a new query capability without a task receipt in %s', lang => {
    setOwnerLang(lang, 'config');
    for (const proof of [undefined, 'https://x.com/example/status/123']) {
      const out = formatInviteResult(result({ status: 200 }), 'x', 'example', WEB, proof);
      expect(out).toMatch(lang === 'en' ? /can't follow.*not confirmed/ : /无法后台跟进.*尚未确认/);
      expect(out).not.toMatch(/10 minutes|10 分钟|ask me.*progress|问我.*进度/);
    }
  });
  // Owner ruling, 2026-08-26: the House retains the post evidence at verification (evidence_sample =
  // the first 16KB of the fetched response, including the post body). Disclose this before asking them to post,
  // alongside permission to delete the post without losing the checkmark; separating them makes the earlier promise misleading.
  it('发起认证时就说清楚：帖可随时删，而核验记录会留存', () => {
    const out = formatInviteResult(result({ status: 200 }), 'x', 'example', WEB);
    expect(out).toContain('随时可以删掉那条帖');
    expect(out).toContain('留一份记录');
  });

  it('on 2xx, emits a postable copy with the bound token AND the invite link', () => {
    const out = formatInviteResult(result({ status: 200 }), 'x', 'blackfeather_ai', WEB);
    expect(out).toContain('x:blackfeather_ai');
    expect(out).toContain('blackfeather_ai#aabb11'); // bound token the rangers verify
    expect(out).toContain('/invite/aabb11?name=blackfeather_ai'); // funnel link (sigil path, name query)
    expect(out).toContain('回一条'); // restates how to verify
    expect(out).toContain('--proof'); // ADR-0034: retry path hint for search-invisible accounts
    expect(out).toContain('24 小时'); // honest about the resubmission throttle
  });

  it('on 2xx with proofUrl, confirms by-id verification instead of prompting to post', () => {
    const out = formatInviteResult(
      result({ status: 200 }),
      'x',
      'blackfeather_ai',
      WEB,
      'https://x.com/blackfeather_ai/status/123',
    );
    expect(out).toContain('https://x.com/blackfeather_ai/status/123');
    expect(out).toContain('blackfeather_ai#aabb11'); // what the post must contain
    expect(out).not.toContain('--proof'); // no follow-up prompt — proof already attached
  });

  it('on 409 already-verified, guides --replace AND still shows the postable copy', () => {
    const out = formatInviteResult(
      result({ status: 409, detail: 'already verified for x' }),
      'x',
      'owl_scribe_7',
      WEB,
    );
    expect(out).toContain('--replace');
    expect(out).toContain('/popclaw invite x owl_scribe_7 --replace');
    expect(out).toContain('already verified for x');
    expect(out).toContain('owl_scribe_7#aabb11'); // bound token for the new handle
    expect(out).toContain('/invite/aabb11?name=owl_scribe_7'); // funnel link
  });

  it('surfaces lore-house reason on other non-2xx', () => {
    const out = formatInviteResult(
      result({ status: 429, detail: 'recent pending invite exists' }),
      'x',
      'blackfeather_ai',
      WEB,
    );
    expect(out).toContain('429');
    expect(out).toContain('recent pending invite exists');
  });

  it('falls back to a bare status line when no detail is present', () => {
    const out = formatInviteResult(result({ status: 500 }), 'x', 'blackfeather_ai', WEB);
    expect(out).toContain('500');
    expect(out).not.toContain('undefined');
  });
});
