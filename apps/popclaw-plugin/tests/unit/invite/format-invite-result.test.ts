import { beforeAll, describe, expect, it } from 'vitest';
import { formatInviteResult } from '../../../src/invite/format-invite-result.js';
import type { InviteInitiateResult } from '../../../src/invite/invite-initiator.js';
import { setOwnerLang } from '../../../src/lexicon/owner-language.js';

// S13 slice: formatInviteResult now renders in `ownerLang()` (default en-US)
// instead of hardcoded zh — pin zh-CN so the assertions below stay meaningful.
beforeAll(() => setOwnerLang('zh-CN', 'config'));

function result(push: InviteInitiateResult['push']): InviteInitiateResult {
  return { expectedSigil: 'aabb11', pushedEventId: 'deadbeef', push };
}

const WEB = 'http://localhost:3000';

describe('formatInviteResult', () => {
  // 主人拍板 2026-08-26：灯坊确实留着核验当时那条帖的记录（evidence_sample =
  // 抓取响应前 16KB，含帖子正文）。这件事在**请他去发帖之前**就说，且必须和
  // 「随时可删、✓ 不掉」同一口气说 —— 分开说，前一句就成了我们食言的承诺。
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
