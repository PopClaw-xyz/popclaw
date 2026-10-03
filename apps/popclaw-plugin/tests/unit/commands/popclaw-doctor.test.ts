/**
 * `/popclaw doctor` — the command core, deps injected. `buildReport` and the
 * underlying feedback send are both seams; the redaction/verdict machinery
 * itself is covered in tests/unit/diagnostics/bundle.test.ts.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import {
  runPopclawDoctorCommand,
  _pendingDoctorSendForTest,
  type PopclawDoctorDeps,
  type DoctorBuildResult,
} from '../../../src/commands/popclaw-doctor.js';
import type { PopclawFeedbackDeps } from '../../../src/commands/popclaw-feedback.js';
import { setOwnerLang } from '../../../src/lexicon/owner-language.js';

// S3 rollout: renders in ownerLang() unless overridden — pin zh-CN so
// assertions stay byte-for-byte stable (same fix as every other command test).
beforeAll(() => setOwnerLang('zh-CN', 'config'));

beforeEach(() => _pendingDoctorSendForTest.clear());

const CONTACT_ID = 'Demo12347Yz3knd6xwGcvvpGPZCSXB4DcTzzov9gxrzr';
const GUIDE_WITH_CONTACT = [
  '---',
  'world: popclaw.me',
  'feedback:',
  '  contact: 青山',
  `  popclaw_id: ${CONTACT_ID}`,
  '---',
  '正文',
].join('\n');
const GUIDE_WITHOUT_CONTACT = ['---', 'world: popclaw.me', '---', '正文'].join('\n');

function allGreenReport(over: Partial<DoctorBuildResult> = {}): DoctorBuildResult {
  return {
    path: '/tmp/popclaw-doctor-abc123-20260811-1200.md',
    bytes: 512,
    lineCount: 40,
    verdictRows: [{ key: 'version', label: '版本', status: 'ok', reason: 'x' }],
    chatSummary: { text: '🩺 8 项全过 · build abc123\n报告：/tmp/popclaw-doctor-abc123-20260811-1200.md', allGreen: true, seed: '' },
    fullMarkdown: '# popclaw 体检报告',
    ...over,
  };
}

function feedbackDeps(over: Record<string, unknown> = {}): PopclawFeedbackDeps {
  return {
    nickname: '白石',
    fetchGuide: vi.fn().mockResolvedValue(GUIDE_WITH_CONTACT),
    houseSlug: 'popclaw-me',
    houseOfRecipient: vi.fn().mockReturnValue(undefined),
    buildStamp: '0.1.0+abc123',
    ...over,
  } as unknown as PopclawFeedbackDeps;
}

function makeDeps(over: Partial<PopclawDoctorDeps> = {}): PopclawDoctorDeps {
  return {
    buildReport: vi.fn().mockResolvedValue(allGreenReport()),
    feedbackDeps: feedbackDeps(),
    ...over,
  };
}

describe('runPopclawDoctorCommand — plain (no args)', () => {
  it('passes the chat summary through verbatim — all-green', async () => {
    const report = allGreenReport();
    const d = makeDeps({ buildReport: vi.fn().mockResolvedValue(report) });
    const out = await runPopclawDoctorCommand({ positional: [] }, d);
    expect(out.text).toBe(report.chatSummary.text);
  });

  it('passes the chat summary through verbatim — non-green (offer included)', async () => {
    const report = allGreenReport({
      chatSummary: {
        text: '🩺 体检：1 项要看一下，其余全过 · build abc123\n✗ 路由 · 坏了\n报告：/tmp/x.md\n\n要寄给作者吗？…\n或者你自己敲：/popclaw doctor send "路由不通"',
        allGreen: false,
        seed: '路由不通',
      },
    });
    const d = makeDeps({ buildReport: vi.fn().mockResolvedValue(report) });
    const out = await runPopclawDoctorCommand({ positional: [] }, d);
    expect(out.text).toBe(report.chatSummary.text);
    expect(out.text).toContain('/popclaw doctor send');
  });

  it('never sends anything — buildReport is the only call', async () => {
    const sendFeedback = vi.fn();
    const d = makeDeps({ sendFeedback });
    await runPopclawDoctorCommand({ positional: [] }, d);
    expect(sendFeedback).not.toHaveBeenCalled();
  });

  it('threads --with-text through to buildReport', async () => {
    const buildReport = vi.fn().mockResolvedValue(allGreenReport());
    const d = makeDeps({ buildReport });
    await runPopclawDoctorCommand({ positional: [], flags: { 'with-text': '' } }, d);
    expect(buildReport).toHaveBeenCalledWith({ withText: true });
  });
});

describe('runPopclawDoctorCommand — send (preview then confirm)', () => {
  it('send "desc" builds a report, dry-runs the feedback resolution, and shows a 5-line preview without sending', async () => {
    const report = allGreenReport();
    const sendDm = vi.fn(); // must never be reached — resolveFeedbackTarget intercepts before it
    const d = makeDeps({
      buildReport: vi.fn().mockResolvedValue(report),
      feedbackDeps: feedbackDeps({ sendDm }),
    });
    const out = await runPopclawDoctorCommand({ positional: ['send', '路由', '不通'] }, d);
    const lines = out.text.split('\n');
    expect(lines).toHaveLength(5);
    // contact display is sigil-based (displayNamed with no nameOf injected) —
    // same honest fallback popclaw-message.ts's own receipt line uses when it
    // cannot resolve a nickname; the preview never has access to the guide's
    // declared contact NAME (only the resolved id), by construction of the
    // dry-run spy (ponytail: good enough — see final report).
    expect(out.text).toMatch(/#[0-9a-z]{6,}/); // sigil, Crockford base32
    expect(out.text).toContain('路由 不通'); // owner's note, verbatim
    expect(out.text).toContain(report.path);
    expect(out.text).toContain('--confirm');
    expect(sendDm).not.toHaveBeenCalled(); // preview never actually sends
  });

  it('honestly surfaces a no-contact-declared error instead of a preview', async () => {
    const d = makeDeps({
      feedbackDeps: feedbackDeps({ fetchGuide: vi.fn().mockResolvedValue(GUIDE_WITHOUT_CONTACT) }),
    });
    const out = await runPopclawDoctorCommand({ positional: ['send', '坏了'] }, d);
    expect(out.text).toMatch(/没有声明|未声明/);
    expect(out.text).not.toContain('--confirm');
  });

  it('send --confirm with no retyped description reuses the staged preview and actually sends', async () => {
    const report = allGreenReport();
    const sendDm = vi.fn().mockResolvedValue({ text: '✉ sent DM to 青山' });
    const d = makeDeps({
      buildReport: vi.fn().mockResolvedValue(report),
      feedbackDeps: feedbackDeps({ sendDm }),
    });
    await runPopclawDoctorCommand({ positional: ['send', '路由不通'] }, d); // preview, stages it
    sendDm.mockClear();
    const out = await runPopclawDoctorCommand({ positional: ['send'], flags: { confirm: '' } }, d);
    expect(sendDm).toHaveBeenCalledTimes(1);
    const [args] = sendDm.mock.calls[0]!;
    expect(args.flags).toEqual({ image: report.path });
    expect(args.positional[1]).toContain('路由不通');
    expect(out.text).toContain('青山');
  });

  it('send --confirm with no staged preview (stale/never previewed) refuses honestly and does not send', async () => {
    const sendDm = vi.fn();
    const d = makeDeps({ feedbackDeps: feedbackDeps({ sendDm }) });
    const out = await runPopclawDoctorCommand({ positional: ['send'], flags: { confirm: '' } }, d);
    expect(sendDm).not.toHaveBeenCalled();
    expect(out.text.length).toBeGreaterThan(0);
  });

  it('send "desc" --confirm together sends immediately, no staged preview involved', async () => {
    const report = allGreenReport();
    const buildReport = vi.fn().mockResolvedValue(report);
    const sendDm = vi.fn().mockResolvedValue({ text: '✉ sent DM to 青山' });
    const d = makeDeps({ buildReport, feedbackDeps: feedbackDeps({ sendDm }) });
    const out = await runPopclawDoctorCommand({ positional: ['send', '一次性描述'], flags: { confirm: '' } }, d);
    expect(buildReport).toHaveBeenCalledTimes(1);
    expect(sendDm).toHaveBeenCalledTimes(1);
    const [args] = sendDm.mock.calls[0]!;
    expect(args.flags).toEqual({ image: report.path });
    expect(args.positional[1]).toContain('一次性描述');
    expect(out.text).toContain('青山');
  });

  it('bare "send" with no description and no --confirm returns usage, sends nothing', async () => {
    const sendDm = vi.fn();
    const d = makeDeps({ feedbackDeps: feedbackDeps({ sendDm }) });
    const out = await runPopclawDoctorCommand({ positional: ['send'] }, d);
    expect(out.text.toLowerCase()).toContain('send');
    expect(sendDm).not.toHaveBeenCalled();
  });
});
