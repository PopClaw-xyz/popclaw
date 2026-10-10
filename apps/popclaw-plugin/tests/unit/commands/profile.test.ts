import { describe, it, expect, vi } from 'vitest';
import { runProfileCommand } from '../../../src/commands/profile.js';
import { lexiconFor, renderCopy } from '../../../src/lexicon/index.js';
import { ownerLang } from '../../../src/lexicon/owner-language.js';
import { deriveSigil } from '../../../src/invite/sigil.js';

// The command reads the body with resp.text() (so a 200 + EMPTY body — the
// conformant "never seen this identity" answer — does not blow up as a thrown
// SyntaxError); json() is kept so the fixture still describes a real Response.
function ok(body: unknown) {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
}

describe('runProfileCommand', () => {
  // MCP hosts (Claude Code / Codex) have tools but no slash commands.
  // Identity tools resolve popclaw_id, not handle plus sigil, so profile lookup by ID must work.
  it('takes a bare popclaw_id and asks the by-id endpoint', async () => {
    const id = 'Fo1Potk3v4qL45UmEDmnkRj2K5QEMctPKVAPjN9j1VS2';
    const fetch = ok({ popclaw_id: id, sigil: '5a57bf', profiles: [], card: null });
    const out = await runProfileCommand(
      { target: id },
      { loreHouseUrl: 'http://lh.example', fetch: fetch as any },
    );
    expect(fetch).toHaveBeenCalledWith(`http://lh.example/v1/profile/${id}`, {
      signal: expect.any(AbortSignal),
    });
    expect(out.text).toContain(id);
  });

  // The owner's own card and everyone else's resolve the address differently.
  // For someone else the house-verified native handle outranks their
  // self-reported card name. For the owner the card is what they themselves
  // just declared, and the native row is a registration-time snapshot nothing
  // refreshes — so status, the rename confirmation and this card agree.
  describe('address name precedence (by-id lane)', () => {
    const OTHER = 'Fo1Potk3v4qL45UmEDmnkRj2K5QEMctPKVAPjN9j1VS2';
    const ME = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
    const body = (id: string, native: string, card: string) => ok({
      popclaw_id: id,
      sigil: deriveSigil(id),
      profiles: [{ platform: 'popclaw', handle: native, verified_at: '2026-09-20T00:00:00Z' }],
      card: { nickname: card },
    });

    it("keeps another person's verified native handle over their card name", async () => {
      const out = await runProfileCommand(
        { target: OTHER },
        { loreHouseUrl: 'http://lh.example', fetch: body(OTHER, 'cangwu', '苍梧居士') as any, webBaseUrl: 'https://popclaw.me', self: { popclawId: ME, nickname: 'CanaryMe-26e2' } },
      );
      expect(out.text).toContain(`popclaw.me/cangwu/${deriveSigil(OTHER)}`);
    });

    it("uses the owner's declared card name, not the stale native row", async () => {
      const out = await runProfileCommand(
        { target: ME },
        { loreHouseUrl: 'http://lh.example', fetch: body(ME, 'ranger-3gkVcd', 'CanaryMe-26e2') as any, webBaseUrl: 'https://popclaw.me', self: { popclawId: ME, nickname: 'CanaryMe-26e2' } },
      );
      expect(out.text).toContain(`popclaw.me/CanaryMe-26e2/${deriveSigil(ME)}`);
      expect(out.text).not.toContain('ranger-3gkVcd');
    });
  });

  it('renders Passport on 200 response', async () => {
    const fetch = ok({
        popclaw_id: 'Fo1Potk3v4qL45UmEDmnkRj2K5QEMctPKVAPjN9j1VS2',
        sigil: '5a57bf',
        house_follower_count: 12,
        profiles: [
          { platform: 'x', handle: 'elonmusk', verified_at: '2026-04-12T00:00:00Z', profile_url: 'https://x.com/elonmusk', follower_count: 1_300_000 },
        ],
        card: { nickname: 'Elon', one_line_intro: 'to mars', taste_tags: ['space'], role_persona: 'pioneer', location_hint: '', avatar_uri: '', declared_at_ms: 0 },
    });
    const out = await runProfileCommand(
      { target: 'elonmusk#5a57bf' },
      { loreHouseUrl: 'http://lh.example', fetch: fetch as any },
    );
    expect(out.text).toContain('popclaw  @elonmusk#5a57bf');
    // Local house follower counts and the X verification snapshot appear side by side without conflation (spec 2026-07-26).
    expect(out.text).toContain(renderCopy(ownerLang(), 'passport.houseFollowerCount', { count: '12' }));
    // role_persona label is intentionally hardcoded zh-CN in passport-renderer.ts
    // (out of this slice's scope — see ROLE_LABEL there), unlike the two lines above.
    // Role labels now follow ownerLang(); these tests set no language and therefore use the default English lane.
    expect(out.text).toContain(`Elon · ${lexiconFor('en').terms.roles.pioneer}`);
    expect(out.text).toContain('to mars');
    expect(out.text).toContain(renderCopy(ownerLang(), 'passport.verifiedHeader', { count: '1' }));
    expect(out.text).toContain('🐦 X');
    expect(out.text).toContain('https://x.com/elonmusk');
    expect(out.text).toContain(renderCopy(ownerLang(), 'passport.snapshotFollowers', {
      platform: 'X', count: renderCopy(ownerLang(), 'passport.snapshotApprox', { count: '1.3m' }),
    }));
    expect(out.details?.profiles[0]?.follower_count).toBe(1_300_000);
    expect(fetch).toHaveBeenCalledWith(
      'http://lh.example/v1/profile/by-handle/elonmusk?sigil=5a57bf',
      { signal: expect.any(AbortSignal) },
    );
  });

  it('rejects target without #', async () => {
    const fetch = vi.fn();
    const out = await runProfileCommand(
      { target: 'elonmusk' },
      { loreHouseUrl: 'http://lh.example', fetch: fetch as any },
    );
    expect(out.text).toContain('usage: /popclaw profile <handle>#<sigil>');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects sigil that does not normalize to a valid 6-12 char Crockford sigil', async () => {
    const fetch = vi.fn();
    const out1 = await runProfileCommand(
      { target: 'elonmusk#abcdeu' },  // 'u' is outside the Crockford alphabet
      { loreHouseUrl: 'http://lh.example', fetch: fetch as any },
    );
    expect(out1.text).toContain('sigil must be 6-12 Crockford base32 chars');

    const out2 = await runProfileCommand(
      { target: 'elonmusk#!!!!!!' },  // no valid chars at all
      { loreHouseUrl: 'http://lh.example', fetch: fetch as any },
    );
    expect(out2.text).toContain('sigil must be 6-12 Crockford base32 chars');

    const out3 = await runProfileCommand(
      { target: 'elonmusk#5r57p' },  // 5 chars, below the 6-char floor
      { loreHouseUrl: 'http://lh.example', fetch: fetch as any },
    );
    expect(out3.text).toContain('sigil must be 6-12 Crockford base32 chars');

    const out4 = await runProfileCommand(
      { target: 'elonmusk#0123456789abc' },  // 13 chars, above the 12-char ceiling
      { loreHouseUrl: 'http://lh.example', fetch: fetch as any },
    );
    expect(out4.text).toContain('sigil must be 6-12 Crockford base32 chars');
  });

  it('accepts an uppercase / o-i-l-folded sigil (normalized before validation)', async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: false, status: 404, json: async () => ({}),
    });
    // 'O0Il11' lowercases to 'o0il11', folds o->0 and i/l->1 -> '001111'.
    const out = await runProfileCommand(
      { target: 'elonmusk#O0Il11' },
      { loreHouseUrl: 'http://lh.example', fetch: fetch as any },
    );
    expect(fetch).toHaveBeenCalledWith(
      'http://lh.example/v1/profile/by-handle/elonmusk?sigil=001111',
      { signal: expect.any(AbortSignal) },
    );
    expect(out.text).toContain('handle=elonmusk sigil=001111');
  });

  it('shows friendly message on 404', async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: false, status: 404, json: async () => ({}),
    });
    const out = await runProfileCommand(
      { target: 'ghost#abc123' },
      { loreHouseUrl: 'http://lh.example', fetch: fetch as any },
    );
    // D8: assert through the same renderer the command uses, never a literal.
    expect(out.text).toBe(renderCopy(ownerLang(), 'profile.notFound', { handle: 'ghost', sigil: 'abc123' }));
    expect(out.text).toContain('handle=ghost sigil=abc123');
  });

  it('shows error on network failure', async () => {
    const fetch = vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED'));
    const out = await runProfileCommand(
      { target: 'elonmusk#5a57bf' },
      { loreHouseUrl: 'http://lh.example', fetch: fetch as any },
    );
    expect(out.text).toContain('lore-house unreachable');
  });
});
