/**
 * /popclaw feedback bug|need <body> — DM to the house's guide-declared contact.
 *
 * The DM path itself is `runPopclawMessageCommand`'s test surface; here we
 * only pin what this command owns: contact resolution from guide.md, the
 * `[feedback/v1]` header, the honest error when no contact is declared, and
 * the deprecated `feedback up|down` → react alias.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPopclawFeedbackCommand } from '../../../src/commands/popclaw-feedback';
import type { PopclawFeedbackDeps } from '../../../src/commands/popclaw-feedback';
import { setOwnerLang } from '../../../src/lexicon/owner-language.js';

// S3 rollout slice 5: runPopclawFeedbackCommand now renders in `ownerLang()`
// (S1 process-wide singleton). Pin zh-CN so this file's pre-lexicon
// assertions stay byte-for-byte unchanged (same fix as write-taste.test.ts).
beforeAll(() => setOwnerLang('zh-CN', 'config'));

const CONTACT_ID = 'Demo12347Yz3knd6xwGcvvpGPZCSXB4DcTzzov9AAAA';
const STAMP = '0.1.0 2026-07-29 12:00+08 abc1234 (main)';

const GUIDE_WITH_CONTACT = [
  '---',
  'world: popclaw.me',
  'streams:',
  '  - name: latest',
  '    endpoint: /v1/discovery',
  'feedback:',
  '  contact: 苍梧',
  `  popclaw_id: ${CONTACT_ID}`,
  '---',
  '正文',
].join('\n');

const GUIDE_WITHOUT_CONTACT = ['---', 'world: popclaw.me', 'streams:', '---', '正文'].join('\n');

function deps(over: Record<string, unknown> = {}): PopclawFeedbackDeps {
  const dir = mkdtempSync(join(tmpdir(), 'popclaw-fb-'));
  return {
    nickname: '青鸾',
    fetchGuide: vi.fn().mockResolvedValue(GUIDE_WITH_CONTACT),
    houseSlug: 'popclaw-me',
    houseOfRecipient: vi.fn().mockReturnValue(undefined),
    buildStamp: STAMP,
    sendDm: vi.fn().mockResolvedValue({ text: '✉ sent DM to 苍梧' }),
    react: { cache: { lookup: vi.fn().mockReturnValue(null) }, picksFile: join(dir, 'picks.jsonl') },
    ...over,
  } as unknown as PopclawFeedbackDeps;
}

const sendDmOf = (d: PopclawFeedbackDeps) => d.sendDm as unknown as ReturnType<typeof vi.fn>;

describe('runPopclawFeedbackCommand', () => {
  it('DMs the guide-declared contact with header + verbatim body', async () => {
    const d = deps();
    const out = await runPopclawFeedbackCommand({ positional: ['bug', '第一行', '第二行'] }, d);

    const sendDm = sendDmOf(d);
    expect(sendDm).toHaveBeenCalledTimes(1);
    const [args, passedDeps] = sendDm.mock.calls[0]!;
    expect(args.positional[0]).toBe(CONTACT_ID);
    expect(args.positional[1]).toBe(`[feedback/v1] kind=bug plugin=${STAMP}\n第一行 第二行`);
    // deps are passed through — the DM path keeps signing/encryption/routing.
    expect(passedDeps.nickname).toBe('青鸾');
    // the DM path's own reply text is kept, plus a feedback-specific receipt:
    // honest layering — sent = house accepted; a reply is a human, via inbox.
    expect(out.text).toContain('✉ sent DM to 苍梧');
    expect(out.text).toContain('bug 反馈已加密送出');
    expect(out.text).toContain('联系人苍梧');
    expect(out.text).toContain('/popclaw inbox');
  });

  it('DM-path failure text passes through without a success receipt', async () => {
    const d = deps({ sendDm: vi.fn().mockResolvedValue({ text: 'cannot send a DM to yourself' }) });
    const out = await runPopclawFeedbackCommand({ positional: ['bug', '正文'] }, d);
    expect(out.text).toBe('cannot send a DM to yourself');
    expect(out.text).not.toContain('已加密送出');
  });

  it('accepts kind=need', async () => {
    const d = deps();
    await runPopclawFeedbackCommand({ positional: ['need', '想要而做不到'] }, d);
    expect(sendDmOf(d).mock.calls[0]![0].positional[1]).toBe(
      `[feedback/v1] kind=need plugin=${STAMP}\n想要而做不到`,
    );
  });

  it('refuses honestly when the house declares no feedback contact', async () => {
    const d = deps({ fetchGuide: vi.fn().mockResolvedValue(GUIDE_WITHOUT_CONTACT) });
    const out = await runPopclawFeedbackCommand({ positional: ['bug', '坏了'] }, d);
    expect(out.text).toContain('popclaw-me');
    expect(out.text).toMatch(/没有声明|未声明/);
    expect(sendDmOf(d)).not.toHaveBeenCalled();
  });

  it('refuses honestly when the guide cannot be fetched', async () => {
    const d = deps({ fetchGuide: vi.fn().mockResolvedValue(null) });
    const out = await runPopclawFeedbackCommand({ positional: ['need', '想要'] }, d);
    expect(out.text).toContain('popclaw-me');
    expect(sendDmOf(d)).not.toHaveBeenCalled();
  });

  it('returns usage for an unknown kind, and does not send', async () => {
    const d = deps();
    const out = await runPopclawFeedbackCommand({ positional: ['whine', 'x'] }, d);
    expect(out.text).toContain('bug|need');
    expect(sendDmOf(d)).not.toHaveBeenCalled();
  });

  it('returns usage when the body is empty', async () => {
    const d = deps();
    const out = await runPopclawFeedbackCommand({ positional: ['bug'] }, d);
    expect(out.text).toContain('bug|need');
    expect(sendDmOf(d)).not.toHaveBeenCalled();
  });

  // final doc §3 item 4: attachmentPath flows through to `flags.image`
  // (runPopclawMessageCommand's attachment path), and the body gets a
  // build+routing-status line prepended so the receiver can triage without
  // opening the attachment.
  describe('attachmentPath (doctor report attach)', () => {
    it('passes flags.image to the DM path and prefixes the body with build + routing status', async () => {
      const d = deps({
        attachmentPath: '/tmp/popclaw-doctor-abc.md',
        routingStats: () => ({
          mode: 'wired' as const,
          fireCount: 3,
          l2HitCount: 5,
          inboundCount: 10,
          envelopeSeen: 10,
          envelopeStripped: 9,
          lastFiredAt: 0,
          brokenLogged: false,
        }),
      });
      const out = await runPopclawFeedbackCommand({ positional: ['bug', '发不出私信'] }, d);
      const sendDm = sendDmOf(d);
      const [args] = sendDm.mock.calls[0]!;
      expect(args.flags).toEqual({ image: '/tmp/popclaw-doctor-abc.md' });
      expect(args.positional[1]).toContain(`popclaw build ${STAMP} ·`);
      expect(args.positional[1]).toContain('发不出私信');
      expect(out).toBeTruthy();
    });

    it('omits flags entirely when no attachmentPath is given (unchanged default)', async () => {
      const d = deps();
      await runPopclawFeedbackCommand({ positional: ['bug', '正文'] }, d);
      const [args] = sendDmOf(d).mock.calls[0]!;
      expect(args.flags).toBeUndefined();
      expect(args.positional[1]).not.toContain('popclaw build');
    });
  });

  // Feedback follows the wall (ADR-0042 amendment): a house's activity wall routes to that house's contact.
  describe('--house <slug>', () => {
    const WORLD_ID = '4kQ9pXwZmyLxr9y6bLKQqUifKPCe6njtEvS5MRDR9Zvy';
    const WORLD_GUIDE = [
      '---',
      'world: popclaw.world',
      'feedback:',
      '  contact: 坊主',
      `  popclaw_id: ${WORLD_ID}`,
      '---',
      '明信片玩法',
    ].join('\n');

    it('resolves the contact from that house cached guide and routes the DM there', async () => {
      const readHouseGuide = vi.fn().mockReturnValue(WORLD_GUIDE);
      const d = deps({ readHouseGuide });
      const out = await runPopclawFeedbackCommand(
        { positional: ['need', '明信片想批量寄'], flags: { house: 'popclaw-world' } },
        d,
      );

      expect(readHouseGuide).toHaveBeenCalledWith('popclaw-world');
      expect(d.fetchGuide).not.toHaveBeenCalled();
      const [args, passedDeps] = sendDmOf(d).mock.calls[0]!;
      expect(args.positional[0]).toBe(WORLD_ID);
      // Include the target house in the header so the recipient (especially the fallback primary house) knows which house this concerns.
      expect(args.positional[1]).toBe(
        `[feedback/v1] kind=need house=popclaw-world plugin=${STAMP}\n明信片想批量寄`,
      );
      // Deliver to that house contact's inbox: DMs route by houseOfRecipient.
      expect(passedDeps.houseOfRecipient(WORLD_ID)).toBe('popclaw-world');
      expect(out.text).toContain('popclaw-world');
    });

    it('accepts the bare domain form as the slug', async () => {
      const readHouseGuide = vi.fn().mockReturnValue(WORLD_GUIDE);
      await runPopclawFeedbackCommand(
        { positional: ['bug', '坏了'], flags: { house: 'popclaw.world' } },
        deps({ readHouseGuide }),
      );
      expect(readHouseGuide).toHaveBeenCalledWith('popclaw-world');
    });

    it('the primary house slug behaves exactly like omitting --house', async () => {
      const readHouseGuide = vi.fn();
      const d = deps({ readHouseGuide });
      await runPopclawFeedbackCommand(
        { positional: ['bug', '坏了'], flags: { house: 'popclaw-me' } },
        d,
      );
      // The primary house guide may not be on disk: use GuideClient, not the handshake cache.
      expect(readHouseGuide).not.toHaveBeenCalled();
      expect(d.fetchGuide).toHaveBeenCalled();
      const [, passedDeps] = sendDmOf(d).mock.calls[0]!;
      expect(passedDeps.houseOfRecipient).toBe(d.houseOfRecipient);
    });

    // Root-house fallback (ADR-0042 Amendment 2): when the target declares no contact, send to the primary house instead of rejecting.
    // It is the collection point for PopClaw product and federation feedback; retain the original target house in the header.
    describe('root-house fallback', () => {
      it('falls back to the primary contact when the target house declares none', async () => {
        const d = deps({ readHouseGuide: vi.fn().mockReturnValue(null) });
        const out = await runPopclawFeedbackCommand(
          { positional: ['bug', '坏了'], flags: { house: 'nowhere-town' } },
          d,
        );
        const [args, passedDeps] = sendDmOf(d).mock.calls[0]!;
        expect(args.positional[0]).toBe(CONTACT_ID);
        expect(args.positional[1]).toBe(
          `[feedback/v1] kind=bug house=nowhere-town plugin=${STAMP}\n坏了`,
        );
        // Fallback really sends to the primary house contact, using the default DM route through that house.
        expect(passedDeps.houseOfRecipient).toBe(d.houseOfRecipient);
        expect(out.text).toContain('兜底');
        expect(out.text).toContain('nowhere-town');
        expect(out.text).toContain('bug 反馈已加密送出');
      });

      it('falls back when no house-guide reader is wired in at all', async () => {
        const d = deps();
        const out = await runPopclawFeedbackCommand(
          { positional: ['bug', '坏了'], flags: { house: 'popclaw-world' } },
          d,
        );
        expect(sendDmOf(d).mock.calls[0]![0].positional[0]).toBe(CONTACT_ID);
        expect(out.text).toContain('兜底');
      });

      it('refuses honestly (naming both) when the primary declares no contact either', async () => {
        const d = deps({
          readHouseGuide: vi.fn().mockReturnValue(null),
          fetchGuide: vi.fn().mockResolvedValue(GUIDE_WITHOUT_CONTACT),
        });
        const out = await runPopclawFeedbackCommand(
          { positional: ['bug', '坏了'], flags: { house: 'nowhere-town' } },
          d,
        );
        expect(out.text).toContain('nowhere-town');
        expect(out.text).toContain('popclaw-me');
        expect(out.text).toContain('没有发出');
        expect(sendDmOf(d)).not.toHaveBeenCalled();
      });
    });

    // The real house is house.popclaw.world (slug house-popclaw-world), while people say
    // popclaw.world; character folding alone creates a nonexistent slug, making every --house lookup fail.
    describe('resolves against the mounted houses', () => {
      const KNOWN = ['house-popclaw-me', 'house-popclaw-world'];
      const wired = (over: Record<string, unknown> = {}) =>
        deps({
          houseSlug: 'house-popclaw-me',
          knownHouseSlugs: KNOWN,
          readHouseGuide: vi.fn().mockReturnValue(WORLD_GUIDE),
          ...over,
        });

      it.each(['popclaw-world', 'popclaw.world', 'house-popclaw-world'])(
        'ref %s → house-popclaw-world',
        async (house) => {
          const d = wired();
          await runPopclawFeedbackCommand({ positional: ['bug', '坏了'], flags: { house } }, d);
          expect(d.readHouseGuide).toHaveBeenCalledWith('house-popclaw-world');
          const [, passedDeps] = sendDmOf(d).mock.calls[0]!;
          expect(passedDeps.houseOfRecipient(WORLD_ID)).toBe('house-popclaw-world');
        },
      );

      it('an ambiguous ref lists the candidates instead of guessing', async () => {
        const d = wired();
        const out = await runPopclawFeedbackCommand(
          { positional: ['bug', '坏了'], flags: { house: 'popclaw' } },
          d,
        );
        expect(out.text).toContain('house-popclaw-me');
        expect(out.text).toContain('house-popclaw-world');
        expect(out.text).toContain('没有发出');
        expect(sendDmOf(d)).not.toHaveBeenCalled();
      });

      it('an unknown ref lists the mounted houses so the agent can self-correct', async () => {
        const d = wired();
        const out = await runPopclawFeedbackCommand(
          { positional: ['bug', '坏了'], flags: { house: 'nowhere-town' } },
          d,
        );
        expect(out.text).toContain('nowhere-town');
        expect(out.text).toContain('house-popclaw-world');
        expect(sendDmOf(d)).not.toHaveBeenCalled();
      });

      it('the primary house still goes through GuideClient', async () => {
        const d = wired();
        await runPopclawFeedbackCommand(
          { positional: ['bug', '坏了'], flags: { house: 'popclaw.me' } },
          d,
        );
        expect(d.readHouseGuide).not.toHaveBeenCalled();
        expect(d.fetchGuide).toHaveBeenCalled();
      });
    });

  });

  it('routes the deprecated `feedback up|down <postId>` alias to react', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'popclaw-fb-alias-'));
    const picksFile = join(dir, 'picks.jsonl');
    const d = deps({
      react: {
        cache: { lookup: vi.fn().mockReturnValue({ handle: 'karpathy', textPreview: 'hi' }) },
        picksFile,
        now: () => 1700000000_000,
      },
    });
    const out = await runPopclawFeedbackCommand({ positional: ['up', '12345'] }, d);

    expect(sendDmOf(d)).not.toHaveBeenCalled();
    expect(out.text).toContain('@karpathy');
    expect(out.text).toContain('/popclaw react');
    const rec = JSON.parse(readFileSync(picksFile, 'utf-8').trim());
    expect(rec.reaction).toBe('up');
    rmSync(dir, { recursive: true, force: true });
  });

  // The typed tool (popclaw_feedback) restricts kind to bug|need, so it cannot reach the deprecated up/down
  // alias and needs no react dependency. If another caller reaches it, explain honestly instead of crashing.
  it('says so honestly when the up/down alias arrives without react deps', async () => {
    const d = deps({ react: undefined });
    const out = await runPopclawFeedbackCommand({ positional: ['up', '12345'] }, d);
    expect(out.text).toContain('/popclaw react');
    expect(sendDmOf(d)).not.toHaveBeenCalled();
  });
});

// S3 rollout slice 5 — en lane. One assertion per branch this command owns:
// usage, the deprecated alias's two messages, house resolution failures, the
// no-contact / fallback-failed refusals, and the success receipt (plain and
// root-house-fallback).
describe('runPopclawFeedbackCommand — en lane', () => {
  beforeAll(() => setOwnerLang('en', 'config'));
  afterAll(() => setOwnerLang('zh-CN', 'config')); // restore file default for tests after this one

  it('usage text, in English', async () => {
    const d = deps();
    const out = await runPopclawFeedbackCommand({ positional: ['whine', 'x'] }, d);
    expect(out.text).toContain('bug|need');
    expect(sendDmOf(d)).not.toHaveBeenCalled();
  });

  it('deprecated up/down alias without react deps says so honestly, in English', async () => {
    const d = deps({ react: undefined });
    const out = await runPopclawFeedbackCommand({ positional: ['up', '12345'] }, d);
    expect(out.text).toContain('/popclaw react up|down <postId>');
    expect(sendDmOf(d)).not.toHaveBeenCalled();
  });

  it('deprecated up/down alias renamed-suffix, in English', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'popclaw-fb-alias-en-'));
    const picksFile = join(dir, 'picks.jsonl');
    const d = deps({
      react: {
        cache: { lookup: vi.fn().mockReturnValue({ handle: 'karpathy', textPreview: 'hi' }) },
        picksFile,
        now: () => 1700000000_000,
      },
    });
    const out = await runPopclawFeedbackCommand({ positional: ['up', '12345'] }, d);
    expect(out.text).toContain('has been renamed');
    rmSync(dir, { recursive: true, force: true });
  });

  it('refuses honestly when the house declares no feedback contact, in English', async () => {
    const d = deps({ fetchGuide: vi.fn().mockResolvedValue(GUIDE_WITHOUT_CONTACT) });
    const out = await runPopclawFeedbackCommand({ positional: ['bug', 'broken'] }, d);
    expect(out.text).toContain('popclaw-me');
    expect(out.text).toContain('names no feedback contact');
    expect(sendDmOf(d)).not.toHaveBeenCalled();
  });

  it('an ambiguous --house ref lists candidates instead of guessing, in English', async () => {
    const KNOWN = ['house-popclaw-me', 'house-popclaw-world'];
    const d = deps({ houseSlug: 'house-popclaw-me', knownHouseSlugs: KNOWN });
    const out = await runPopclawFeedbackCommand(
      { positional: ['bug', 'broken'], flags: { house: 'popclaw' } },
      d,
    );
    expect(out.text).toContain('matches several lore-houses');
    expect(out.text).toContain('house-popclaw-world');
    expect(sendDmOf(d)).not.toHaveBeenCalled();
  });

  it('an unknown --house ref lists the mounted houses, in English', async () => {
    const KNOWN = ['house-popclaw-me', 'house-popclaw-world'];
    const d = deps({ houseSlug: 'house-popclaw-me', knownHouseSlugs: KNOWN });
    const out = await runPopclawFeedbackCommand(
      { positional: ['bug', 'broken'], flags: { house: 'nowhere-town' } },
      d,
    );
    expect(out.text).toContain('No mounted lore-house');
    expect(out.text).toContain('house-popclaw-world');
    expect(sendDmOf(d)).not.toHaveBeenCalled();
  });

  it('refuses honestly (naming both) when target and root-house fallback both lack a contact, in English', async () => {
    const d = deps({
      readHouseGuide: vi.fn().mockReturnValue(null),
      fetchGuide: vi.fn().mockResolvedValue(GUIDE_WITHOUT_CONTACT),
    });
    const out = await runPopclawFeedbackCommand(
      { positional: ['bug', 'broken'], flags: { house: 'nowhere-town' } },
      d,
    );
    expect(out.text).toContain('nowhere-town');
    expect(out.text).toContain('popclaw-me');
    expect(out.text).toContain('Nowhere to send this, so nothing went out');
    expect(sendDmOf(d)).not.toHaveBeenCalled();
  });

  it('DMs the guide-declared contact with an English success receipt', async () => {
    const d = deps();
    const out = await runPopclawFeedbackCommand({ positional: ['bug', 'line one'] }, d);
    expect(out.text).toContain('bug feedback sent, encrypted');
    expect(out.text).toContain("the home lore-house's contact");
    expect(out.text).toContain('/popclaw inbox');
  });

  it('falls back to the primary contact and says so in English', async () => {
    const d = deps({ readHouseGuide: vi.fn().mockReturnValue(null) });
    const out = await runPopclawFeedbackCommand(
      { positional: ['need', 'broken'], flags: { house: 'nowhere-town' } },
      d,
    );
    expect(out.text).toContain('names no feedback contact');
    expect(out.text).toContain('nowhere-town');
    expect(out.text).toContain('need feedback sent, encrypted');
  });
});
