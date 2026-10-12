import { describe, it, expect, vi, beforeAll } from 'vitest';
import {
  runStatusCommand,
  displayWidth,
  splitAtOr,
  routingLine,
  configLines,
} from '../../../src/commands/status.js';
import type { ConfigReport } from '../../../src/host/config-report.js';
import { BROKEN_AFTER, type RoutingStats } from '../../../src/routing/stats.js';
import { deriveSigil } from '../../../src/invite/sigil.js';
import * as statusTime from '../../../src/time/time-context.js';
import { systemTz, setOwnerTz } from '../../../src/time/time-context.js';
import { setOwnerLang } from '../../../src/lexicon/owner-language.js';
import { renderCopy } from '../../../src/lexicon/index.js';
import { ActionInactiveError } from '../../../src/runtime/house-lifecycle/action-context.js';
import { runPopclawNameCommand } from '../../../src/commands/popclaw-name.js';
import { InMemoryHostAdapter } from '../../../src/host/host-adapter.in-memory.js';

// S3 pilot: runStatusCommand now renders in `ownerLang()` by default (a
// process-wide singleton, S1). Every assertion below predates the lexicon
// and was written assuming Chinese — pin the default here so this whole
// file's zh regression stays byte-for-byte unchanged (same fix as
// notifier/mcp-notice.test.ts S6). The dedicated en-lane block below passes
// `lang: 'en'` explicitly per case instead of relying on this default.
beforeAll(() => setOwnerLang('zh-CN', 'config'));

const ID = 'HafABCDEFGHIJKLMNOPqrstuvwxyz12';
const SIGIL = deriveSigil(ID);
const ID_SHORT = 'HafABCDE…uvwxyz12';

function makeSigner(popclawId: string) {
  return { popclawId: vi.fn().mockResolvedValue(popclawId) };
}

function makeLogger() {
  const lines: string[] = [];
  return {
    logger: { info: (msg: string) => lines.push(msg) },
    lines,
  };
}

function okFetch(body: unknown) {
  // status.ts reads the body via resp.text() (so it can tell a 200 + EMPTY
  // body — the conformant "never seen this identity" answer — apart from a
  // 200 + garbage body); json() is kept only for any caller that still uses it.
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
}

function bond(popclawId: string, tier: string) {
  return { popclawId, tier } as never;
}

/** Baseline deps: everything present so nothing lands on the todo list. */
function completeDeps(overrides: Record<string, unknown> = {}) {
  const { logger, lines } = makeLogger();
  const deps = {
    signer: makeSigner(ID) as never,
    host: {} as never,
    loreHouseUrl: 'http://lh.example',
    logger,
    webBaseUrl: 'https://popclaw.me',
    nickname: 'blackfeather_ai',
    fetch: okFetch({
      house_follower_count: 12,
      profiles: [
        { platform: 'x', handle: 'elonmusk', verified_at: '2026-05-20T00:00:00Z', follower_count: 12_000 },
        { platform: 'github', handle: 'octocat', verified_at: '2026-06-01T00:00:00Z' },
      ],
      card: { nickname: 'blackfeather_ai' },
    }) as never,
    socialGraph: {
      following: () => [
        { popclawId: 'f1', since: 10 },
        { popclawId: 'f2', since: 40 },
        { popclawId: 'f3', since: 30 },
        { popclawId: 'f4', since: 20 },
      ],
    } as never,
    nameOf: (id: string) => ({ f1: '甲', f2: '乙', f3: '丙', f4: '丁' })[id] ?? '',
    notifyTarget: { deliveryContext: { channel: '#general' } },
    bondsStore: {
      list: () => [
        bond('b1', 'close_plus'), bond('b2', 'close'), bond('b3', 'friend'),
        bond('b4', 'acquaintance'), bond('b5', 'stranger'),
      ],
    },
    dmSenderCount: () => 3,
    onboardingStage: () => 'completed',
    ...overrides,
  };
  return { deps, lines };
}

/**
 * A phone line holds about 15 full-width characters (30 cells). Longer lines wrap into confusing
 * fragments. This check makes the soft target of at most 15 full-width characters enforceable in
 * CI.
 */
const PHONE_LINE_CELLS = 30;

/**
 * Each permitted over-wide line stands alone and affects only itself.
 *
 * Hard rule: an exemption must never ship in the same PR as the change that needs it. Add an
 * exemption separately or shorten the offending line first. This rule follows an incident where a
 * 24.5-full-width-character line was copied in and exempted here, effectively weakening the
 * measuring tool to pass the change; an external reviewer caught it. The rule does not depend on
 * the author's vigilance that day.
 */
const EXEMPT_FROM_LINE_WIDTH = [
  /^popclaw\.me\//, // Profile URL.
  /\/popclaw /, // Slash-command line.
  /(^|\s)[/~][\w.~/-]{6,}/, // Absolute-path line (configuration path under /Users/...).
];

/**
 * The stars in `**bold**` are markup, not visible characters; remove them before measuring width.
 */
function renderedWidth(line: string): number {
  return displayWidth(line.replace(/\*\*/g, ''));
}

describe('runStatusCommand — 气泡（human 路径）', () => {
  it('renders the complete state character-exactly', async () => {
    const { deps, lines } = completeDeps();
    await runStatusCommand(deps as never);
    expect(lines.join('\n')).toBe(
      [
        `🏮 **blackfeather_ai** #${SIGIL}`,
        '✓ X @elonmusk',
        '认证时的 X 粉丝数：约12k',
        '✓ GitHub @octocat',
        '认证时的 GitHub 粉丝数：未确认',
        '',
        '**你的江湖**',
        '关注 4 人',
        '关注我 12 人',
        '交情 5 人（好友 3）',
        '私信过你 3 人',
        '/popclaw bond 看交情本',
        '',
        '✅ 身份档案齐全',
        '',
        '📣 通知频道：#general',
        '路由：不可用',
        '宿主没有 api.on 这个钩子',
        `popclaw.me/blackfeather_ai/${SIGIL}`,
      ].join('\n'),
    );
  });

  it('shows exactly one todo, split across short lines, plus a 还差 N tail', async () => {
    const { deps, lines } = completeDeps({
      nickname: 'ranger-HafABC',
      fetch: okFetch({ profiles: [] }),
      socialGraph: { following: () => [] },
      notifyTarget: null,
      bondsStore: { list: () => [] },
      dmSenderCount: () => 0,
      onboardingStage: () => 'act1-naming',
      host: {
        config: { loadJson: vi.fn().mockResolvedValue({ ranger_profile: { name_source: 'auto' } }) },
      },
    });
    await runStatusCommand(deps as never);
    // Plan C spec §4: zero follows comes first, followed by nickname (onboarding/notification channel removed). Verification is optional.
    // It occupies no numbered step here and does not count toward the remaining required tasks.
    expect(lines.join('\n')).toBe(
      [
        `🏮 **ranger-HafABC** #${SIGIL}`,
        '',
        '👉 **关注几个人**',
        '我手上一个人都没有，明早的报纸会很空。要我帮你找几个吗？',
        '/popclaw recommend',
        '或对我说「推荐几个值得关注的人」',
        '还差 1 件小事',
        '',
        '📣 通知频道：未设置',
        '路由：不可用',
        '宿主没有 api.on 这个钩子',
        `popclaw.me/ranger-HafABC/${SIGIL}`,
      ].join('\n'),
    );
  });

  it('keeps every human-path line short enough not to wrap on a phone', async () => {
    const { deps, lines } = completeDeps();
    await runStatusCommand(deps as never);
    const offenders = lines.flatMap((l) => l.split('\n')).filter((l) => renderedWidth(l) > PHONE_LINE_CELLS && !EXEMPT_FROM_LINE_WIDTH.some((re) => re.test(l)));
    expect(offenders).toEqual([]);
  });

  it('drops the 还差 N 件 tail when exactly one todo is left', async () => {
    // No `nickname` in ranger_profile → still the machine placeholder →
    // the "nobody can find you" benefit line, not the plain "change it
    // anytime" one (see the auto_name/placeholder-vs-named block below).
    const { deps, lines } = completeDeps({
      host: {
        config: { loadJson: vi.fn().mockResolvedValue({ ranger_profile: { name_source: 'auto' } }) },
      },
    });
    await runStatusCommand(deps as never);
    expect(lines.join('\n')).toContain('👉 **名号是我替你取的**');
    expect(lines.join('\n')).toContain('别人按名字找不到、也关注不了你');
    expect(lines.join('\n')).not.toContain('还差');
  });

  describe('auto_name todo: the "can\'t be found" line only when the name is still the placeholder', () => {
    it('placeholder-named identity (no real name adopted yet): the benefit line says other people cannot find or follow by name', async () => {
      const { deps, lines } = completeDeps({
        host: {
          config: { loadJson: vi.fn().mockResolvedValue({ ranger_profile: { name_source: 'auto' } }) },
        },
      });
      await runStatusCommand(deps as never);
      const joined = lines.join('\n');
      expect(joined).toContain('别人按名字找不到、也关注不了你');
      expect(joined).not.toContain('想换随时说');
    });

    it('a named one (auto-adopted but real, non-placeholder name): the benefit line stays the plain "change it anytime" copy, no invisibility claim', async () => {
      const { deps, lines } = completeDeps({
        host: {
          config: {
            loadJson: vi.fn().mockResolvedValue({
              ranger_profile: { name_source: 'auto', nickname: 'Night drifter' },
            }),
          },
        },
      });
      await runStatusCommand(deps as never);
      const joined = lines.join('\n');
      expect(joined).toContain('想换随时说');
      expect(joined).not.toContain('别人按名字找不到、也关注不了你');
    });
  });

  // Plan C spec §4, item 2: after skipping attune, show this only if the core layer is empty, not when it cannot be read.
  it('surfaces the taste-seed todo when the core taste layer is empty', async () => {
    const { deps, lines } = completeDeps({
      tasteLoader: { enabledSources: async () => [] },
    });
    await runStatusCommand(deps as never);
    const joined = lines.join('\n');
    expect(joined).toContain('👉 **跟我说说你最近关心什么**');
    expect(joined).toContain('我带给你的东西就会越来越像你——像为你定制的');
  });

  it('keeps the taste-seed todo off when core taste has content — or when no loader is wired', async () => {
    const seeded = completeDeps({
      tasteLoader: {
        enabledSources: async () => [{ path: 'core/private.md', content: '我关心 agent 谈判' }],
      },
    });
    await runStatusCommand(seeded.deps as never);
    expect(seeded.lines.join('\n')).not.toContain('跟我说说你最近关心什么');

    const unwired = completeDeps();
    await runStatusCommand(unwired.deps as never);
    expect(unwired.lines.join('\n')).not.toContain('跟我说说你最近关心什么');
  });

  it('never leaks a full popclaw_id into the follows line', async () => {
    const { deps, lines } = completeDeps();
    await runStatusCommand(deps as never);
    const joined = lines.join('\n');
    for (const id of ['f1', 'f2', 'f3', 'f4']) expect(joined).not.toContain(`（${id}）`);
  });

  it('shows a bare #sigil for a follow that is not in the 名册 (no —, no 查无)', async () => {
    const { deps, lines } = completeDeps({
      socialGraph: { following: () => [{ popclawId: 'ghost', since: 1 }] },
      nameOf: () => '',
    });
    await runStatusCommand(deps as never);
    const joined = lines.join('\n');
    expect(joined).not.toContain('最近关注');
    expect(joined).not.toContain('—#');
    expect(joined).not.toContain('名册查无');
  });

  it('drops the 关注我 placeholder — but keeps the real 本坊关注我 count', async () => {
    const { deps, lines } = completeDeps();
    await runStatusCommand(deps as never);
    const joined = lines.join('\n');
    // The connecting-statistics placeholder is internal state used without data and must disappear.
    // The actual local-house follower count introduced after #190 remains in the numeric summary.
    expect(joined).not.toContain('统计接通中');
    expect(joined).not.toContain('💗');
    expect(joined).toContain('关注我 12 人');
  });

  it('hides 本坊关注我 when the lore house does not report it', async () => {
    const { deps, lines } = completeDeps({ fetch: okFetch({ profiles: [] }) });
    await runStatusCommand(deps as never);
    // Omit unavailable data: warnings/todos already explain why, and an extra unavailable message wastes a line on internal state.
    expect(lines.join('\n')).not.toContain('关注我');
  });

  it('omits the id explainer once onboarding is done', async () => {
    const { deps, lines } = completeDeps();
    await runStatusCommand(deps as never);
    expect(lines.join('\n')).not.toContain('你的通用身份');
  });

  it('never emits the build stamp unless a buildStamp dep is supplied', async () => {
    const { deps, lines } = completeDeps();
    await runStatusCommand(deps as never);
    expect(lines.join('\n')).not.toContain('popclaw build');
  });

  it('appends the build stamp when the debug path supplies one', async () => {
    const { deps, lines } = completeDeps({ buildStamp: '2026.7.1+deadbee' });
    await runStatusCommand(deps as never);
    expect(lines.join('\n').endsWith('popclaw build 2026.7.1+deadbee')).toBe(true);
  });

  it('never shows an upgrade footer without a lastBuildUpgrade dep', async () => {
    const { deps, lines } = completeDeps();
    await runStatusCommand(deps as never);
    expect(lines.join('\n')).not.toContain('已升级');
  });

  // Ledger #014, second half: the full build string (`0.1.0 2026-08-26 12:21+08 c27aab30 (HEAD)`)
  // once occupied a single line (135 measured cells). Status reports only the short stamp, using the same
  // shortBuildStamp as upgrade notices; /popclaw version owns the full string. Fact/from/to/time each get a line.
  it('upgrade footer: 事实 / 由 / 至 / 升级时间各一行，完整 stamp 缩成短 stamp（zh）', async () => {
    // The stamp is owner-local, not UTC (ledger #014): 04:21Z is 12:21 in +08.
    setOwnerTz('Asia/Shanghai');
    try {
      const { deps, lines } = completeDeps({
        lastBuildUpgrade: {
          from: '0.1.0 2026-08-25 15:05+08 42c3b689 (HEAD)',
          to: '0.1.0 2026-08-26 12:21+08 c27aab30 (HEAD)',
          recordedAt: '2026-08-26T04:21:00.000Z',
        },
      });
      await runStatusCommand(deps as never);
      const joined = lines.join('\n');
      expect(joined).toContain(
        ['popclaw 插件已升级', '由 0.1.0 · 8/25 15:05', '至 0.1.0 · 8/26 12:21', '升级时间 2026-08-26 12:21'].join('\n'),
      );
      // SHA and full build string no longer appear in status; /popclaw version owns them.
      expect(joined).not.toContain('42c3b689');
      expect(joined).not.toContain('c27aab30');
    } finally {
      setOwnerTz(undefined);
    }
  });

  it('upgrade footer: en lane, same four lines', async () => {
    setOwnerTz('Asia/Shanghai');
    try {
      const { deps, lines } = completeDeps({
        lang: 'en',
        lastBuildUpgrade: {
          from: '0.1.0 2026-08-25 15:05+08 42c3b689 (HEAD)',
          to: '0.1.0 2026-08-26 12:21+08 c27aab30 (HEAD)',
          recordedAt: '2026-08-26T04:21:00.000Z',
        },
      });
      await runStatusCommand(deps as never);
      expect(lines.join('\n')).toContain(
        ['popclaw plugin upgraded', 'from 0.1.0 · 8/25 15:05', 'to 0.1.0 · 8/26 12:21', 'upgraded at 2026-08-26 12:21'].join('\n'),
      );
    } finally {
      setOwnerTz(undefined);
    }
  });

  it('upgrade footer lines stay within a phone line (typical stamps)', async () => {
    const { deps, lines } = completeDeps({
      lastBuildUpgrade: {
        from: '0.1.0 2026-08-25 15:05+08 42c3b689 (HEAD)',
        to: '0.1.0 2026-08-26 12:21+08 c27aab30 (HEAD)',
        recordedAt: '2026-08-26T04:21:00.000Z',
      },
    });
    await runStatusCommand(deps as never);
    const footer = lines
      .flatMap((l) => l.split('\n'))
      .filter((l) => l.startsWith('popclaw 插件已升级') || /^(由 |至 |升级时间)/.test(l));
    expect(footer).toHaveLength(4);
    for (const l of footer) expect(renderedWidth(l)).toBeLessThanOrEqual(PHONE_LINE_CELLS);
  });

  it('an unrecognized stamp is shown whole — no truncation, no guess', async () => {
    setOwnerTz('Asia/Shanghai');
    try {
      const { deps, lines } = completeDeps({
        lastBuildUpgrade: { from: '4aa6104', to: 'custom-build-55695ac', recordedAt: '2026-07-29T14:15:00.000Z' },
      });
      await runStatusCommand(deps as never);
      const joined = lines.join('\n');
      expect(joined).toContain('由 4aa6104');
      expect(joined).toContain('至 custom-build-55695ac');
    } finally {
      setOwnerTz(undefined);
    }
  });

  it('the upgrade time crosses the date line with the owner, not with UTC', async () => {
    // 22:15Z is already the 30th in Shanghai — printing the UTC day dates the
    // receipt a day early, which is the whole of ledger #014.
    setOwnerTz('Asia/Shanghai');
    try {
      const { deps, lines } = completeDeps({
        lastBuildUpgrade: { from: '4aa6104', to: '55695ac', recordedAt: '2026-07-29T22:15:00.000Z' },
      });
      await runStatusCommand(deps as never);
      expect(lines.join('\n')).toContain('升级时间 2026-07-30 06:15');
    } finally {
      setOwnerTz(undefined);
    }
  });

  it('an unparseable recordedAt degrades to the raw stamp instead of NaN', async () => {
    const { deps, lines } = completeDeps({
      lastBuildUpgrade: { from: '4aa6104', to: '55695ac', recordedAt: 'not-a-date' },
    });
    await runStatusCommand(deps as never);
    const joined = lines.join('\n');
    expect(joined).toContain('升级时间 not-a-date');
    expect(joined).not.toContain('NaN');
  });

  // #236, real machine 2026-07-28: one L1 sat in the queue for two days.
  // Nothing was lost — the owner just felt "nothing is happening" and had
  // nowhere to look. The reason went only into a log under /tmp.
  it('says how many notifications are stuck, and why the last send failed', async () => {
    setOwnerTz('Asia/Shanghai');
    try {
      const { deps, lines } = completeDeps({
        notifyBacklog: () => ({
          count: 2,
          lastFailureAt: 1753711800, // 2026-07-28 22:50 +08
          lastFailureReason: 'sendMessage ret=-2 errmsg=prepare failed',
        }),
      });
      await runStatusCommand(deps as never);
      const joined = lines.join('\n');
      expect(joined).toContain('2 条通知还没送到你手上');
      expect(joined).toContain('prepare failed');
    } finally {
      setOwnerTz(undefined);
    }
  });

  it('stays silent when nothing is stuck — a healthy machine costs zero lines', async () => {
    const { deps, lines } = completeDeps({ notifyBacklog: () => ({ count: 0 }) });
    await runStatusCommand(deps as never);
    expect(lines.join('\n')).not.toContain('还没送到你手上');
  });

  it('retries the queue BEFORE reading it — a backlog it just cleared is not reported', async () => {
    // Order is the whole feature: draining after the read would report a
    // backlog that no longer exists, and never actually retry in time.
    const order: string[] = [];
    const { deps, lines } = completeDeps({
      drainNotifications: async () => {
        order.push('drain');
      },
      notifyBacklog: () => {
        order.push('read');
        return { count: 0 };
      },
    });
    await runStatusCommand(deps as never);
    expect(order).toEqual(['drain', 'read']);
    expect(lines.join('\n')).not.toContain('还没送到你手上');
  });

  it('a drain that throws never takes down the status command', async () => {
    // The command whose whole job is to REPORT trouble must not itself fail
    // because the channel is the thing in trouble.
    const { deps, lines } = completeDeps({
      drainNotifications: async () => {
        throw new Error('channel down');
      },
      notifyBacklog: () => ({ count: 1, lastFailureReason: 'channel down' }),
    });
    await expect(runStatusCommand(deps as never)).resolves.toBeDefined();
    expect(lines.join('\n')).toContain('1 条通知还没送到你手上');
  });

  it('omits the whole 你的江湖 block when every count is zero', async () => {
    const { deps, lines } = completeDeps({
      socialGraph: { following: () => [] },
      bondsStore: { list: () => [] },
      dmSenderCount: () => 0,
      fetch: okFetch({ profiles: [] }), // The house did not report a follower count either.
    });
    await runStatusCommand(deps as never);
    const joined = lines.join('\n');
    expect(joined).not.toContain('你的江湖');
    expect(joined).not.toContain('看交情本');
    // The notification line still appears without indentation because it has no parent block.
    expect(joined).toContain('\n📣 通知频道：#general');
  });

  it('drops zero-valued items from the 数字条 but keeps the rest', async () => {
    const { deps, lines } = completeDeps({ bondsStore: { list: () => [] } });
    await runStatusCommand(deps as never);
    const joined = lines.join('\n');
    expect(joined).toContain('关注 4 人');
    expect(joined).toContain('私信过你 3 人');
    // The bond row is gone; trailing spaces keep this needle from matching the
    // `/popclaw bond 看交情本` hint line, which is still printed.
    expect(joined).not.toContain('交情  ');

  });

  it('keeps the 灯坊失联 warning and leaves 认证 off the todo list', async () => {
    const { deps, lines } = completeDeps({
      fetch: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
    });
    await runStatusCommand(deps as never);
    const joined = lines.join('\n');
    expect(joined).toContain('⚠️ 灯坊失联，认证状态暂时查不到');
    expect(joined).not.toContain('✓ X');
    expect(joined).not.toContain('认证一个外部账号');
  });

  it('treats 404 as reachable-but-unverified (认证 becomes the todo, no ⚠️)', async () => {
    const { deps, lines } = completeDeps({
      fetch: vi.fn().mockResolvedValue({ ok: false, status: 404, json: async () => ({}) }),
    });

    await runStatusCommand(deps as never);
    const joined = lines.join('\n');
    expect(joined).not.toContain('⚠️');
    expect(joined).toContain('👉 **认证一个外部账号**');
    expect(joined).toContain('名号后面挂个背书，别人一眼知道你是谁');
  });

  // Defect (2026-09-20): a 404 from `/v1/verify`/`/v1/invite`/a bare `/v1/profile`
  // on real houses got collapsed with 5xx/401/403 into one blanket "the
  // lore-house is down" line, even while the house's own 🏠 health line read
  // ✅. `.identity` ("down") is now reserved for a real transport failure; a
  // house that answers — even with an error — is never called "down".
  it('names a 5xx response as "answered with an error", not "down"', async () => {
    const { deps, lines } = completeDeps({
      lang: 'en',
      fetch: vi.fn().mockResolvedValue({ ok: false, status: 503, json: async () => ({}) }),
    });
    await runStatusCommand(deps as never);
    const joined = lines.join('\n');
    expect(joined).toContain(
      "⚠️ The lore-house answered with an error (HTTP 503), so I can't check your verification right now",
    );
    expect(joined).not.toContain('is down');
  });

  it('names an unparseable, NON-empty 200 body the same "answered with an error", not "down"', async () => {
    const { deps, lines } = completeDeps({
      lang: 'en',
      fetch: vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => 'not valid json {',
      }),
    });
    await runStatusCommand(deps as never);
    const joined = lines.join('\n');
    expect(joined).toContain(
      "⚠️ The lore-house answered with an error (HTTP 200), so I can't check your verification right now",
    );
    expect(joined).not.toContain('is down');
  });

  // Real defect (three 2026-09-20 acceptance machines): a brand-new
  // auto-named identity, never having published a name card, against a
  // healthy house. Per the established server contract (PR #613/#614,
  // 2026-09-14), both the Rust LoreHouse and the reference server answer
  // "nobody by that id yet" as HTTP 200 + an EMPTY body (deliberately not
  // 404). `resp.json()` on an empty string throws, which used to be filed as
  // "the body made no sense" — false, since the house is fine and simply has
  // never seen this identity, same as the 404 case just above.
  it('a 200 with an empty body is a house that has never seen this identity, not an error and not down', async () => {
    const { deps, lines } = completeDeps({
      lang: 'en',
      fetch: vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => '',
        headers: { get: (name: string) => (name.toLowerCase() === 'content-length' ? '0' : null) },
      }),
    });
    await runStatusCommand(deps as never);
    const joined = lines.join('\n');
    expect(joined).not.toContain('⚠️');
    expect(joined).not.toContain('down');
    expect(joined).not.toContain('error');
    expect(joined).toContain('👉 **Verify an external account**');
  });

  it('names a 401/403 response as a refusal, not "down"', async () => {
    const { deps, lines } = completeDeps({
      lang: 'en',
      fetch: vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({}) }),
    });
    await runStatusCommand(deps as never);
    const joined = lines.join('\n');
    expect(joined).toContain(
      "⚠️ The lore-house refused the verification check (HTTP 401), so I can't check your verification right now",
    );
    expect(joined).not.toContain('is down');
  });

  // R17-D1 (2026-09-24): a read this host refused to send — the house action
  // gate was not active here — never reached the network, so nothing is known
  // about the house from it. Filing that as "down" contradicted the ✅ house
  // row on the same screen.
  it('a read this host refused to send is "not asked", never "down"', async () => {
    for (const lang of ['en', 'zh-CN'] as const) {
      const { deps, lines } = completeDeps({
        lang,
        fetch: vi.fn().mockRejectedValue(new ActionInactiveError()),
      });
      await runStatusCommand(deps as never);
      const joined = lines.join('\n');
      expect(joined).toContain(renderCopy(lang, 'status.lanternDown.identityNotAsked'));
      expect(joined).not.toContain(renderCopy(lang, 'status.lanternDown.identity'));
    }
  });

  it('a fetch that really failed on the wire is still "down"', async () => {
    const { deps, lines } = completeDeps({
      lang: 'en',
      fetch: vi.fn().mockRejectedValue(new TypeError('fetch failed')),
    });
    await runStatusCommand(deps as never);
    expect(lines.join('\n')).toContain(renderCopy('en', 'status.lanternDown.identity'));
  });

  it('a healthy, reachable house answering 404 never produces a sentence containing "down"', async () => {
    const { deps, lines } = completeDeps({
      lang: 'en',
      fetch: vi.fn().mockResolvedValue({ ok: false, status: 404, json: async () => ({}) }),
    });
    await runStatusCommand(deps as never);
    expect(lines.join('\n').toLowerCase()).not.toContain('down');
  });

  // ADR-0040: the silence between requesting verification and its resolution is when the owner most wants an update.
  it('shows the ⏳ pending row and suppresses the 认证 todo while an invite is open', async () => {
    const { deps, lines } = completeDeps({
      fetch: okFetch({ house_follower_count: 1, profiles: [] }),
      pendingInvites: () => [{ platform: 'x', handle: 'blackfeather_ai' }],
    });
    await runStatusCommand(deps as never);
    const joined = lines.join('\n');
    expect(joined).toContain('⏳ X @blackfeather_ai 核验中');
    expect(joined).not.toContain('认证一个外部账号');
  });

  it('lazily sweeps open invites before reading the ledger (进程重启后的补偿)', async () => {
    const checkPendingInvites = vi.fn().mockResolvedValue(undefined);
    const { deps } = completeDeps({ pendingInvites: () => [], checkPendingInvites });
    await runStatusCommand(deps as never);
    expect(checkPendingInvites).toHaveBeenCalledOnce();
  });

  // Ordering is essential: query the house before reading the ledger. Reversing this leaves a just-resolved request
  // marked pending even though the owner has received its approval notice.
  it('an invite the lazy sweep just resolved no longer shows ⏳', async () => {
    const open = [{ platform: 'x', handle: 'blackfeather_ai' }];
    const { deps, lines } = completeDeps({
      fetch: okFetch({ house_follower_count: 1, profiles: [] }),
      pendingInvites: () => open,
      checkPendingInvites: async () => {
        open.length = 0; // The house reports resolution, so the ledger must no longer say in progress.
      },
    });
    await runStatusCommand(deps as never);
    expect(lines.join('\n')).not.toContain('⏳');
  });

  it('a failing lazy sweep never breaks status (灯坊失联照样出报告)', async () => {
    const { deps, lines } = completeDeps({
      checkPendingInvites: () => Promise.reject(new Error('ECONNREFUSED')),
    });
    await runStatusCommand(deps as never);
    expect(lines.join('\n')).toContain('✅ 身份档案齐全');
  });

  // ADR-0037: follows are declared per house. Union counts can differ from per-house counts because one person
  // can be followed in two houses; show the per-house line only when multiple houses actually exist.
  it('多坊时补一行分坊；并集人数不重复计数', async () => {
    const { deps, lines } = completeDeps({
      socialGraph: {
        following: () => [{ popclawId: 'f1', since: 40 }],
        followingByHouse: () => new Map([
          ['popclaw.me', [{ popclawId: 'f1', since: 10 }]],
          ['popclaw.world', [{ popclawId: 'f1', since: 40 }]],
        ]),
      },
    });
    await runStatusCommand(deps as never);
    expect(lines.join('\n')).toContain('分灯坊 popclaw.me 1 · popclaw.world 1');
  });

  it('单坊时不占那一行', async () => {
    const { deps, lines } = completeDeps({
      socialGraph: {
        following: () => [{ popclawId: 'f1', since: 40 }],
        followingByHouse: () => new Map([['popclaw.me', [{ popclawId: 'f1', since: 40 }]]]),
      },
    });
    await runStatusCommand(deps as never);
    expect(lines.join('\n')).not.toContain('分坊 ');
  });

  it('uses the popclaw-native verified handle for the 主页 path when the house has no namecard', async () => {
    const { deps, lines } = completeDeps({
      fetch: okFetch({
        profiles: [{ platform: 'popclaw', handle: 'cangwu', verified_at: '2026-05-20T00:00:00Z' }],
        card: null,
      }),
    });
    await runStatusCommand(deps as never);
    const joined = lines.join('\n');
    expect(joined).toContain(`popclaw.me/cangwu/${SIGIL}`);
    expect(joined).not.toContain('✓ X');
  });

  // Real-host defect: the house's popclaw-native profile row is written once at
  // registration under the auto name and nothing refreshes it, so preferring it
  // over the namecard made status keep printing `ranger-xxxxxx` after the owner
  // chose a name — while the rename itself confirmed the new address.
  it("prints the owner's declared namecard name in the address, not the stale native row", async () => {
    // The boot-time nickname is stale too (it is a snapshot until restart), so
    // both the 🏮 display name and the address must come from the house card.
    const { deps, lines } = completeDeps({
      nickname: 'ranger-3gkVcd',
      fetch: okFetch({
        profiles: [{ platform: 'popclaw', handle: 'ranger-3gkVcd', verified_at: '2026-09-20T00:00:00Z' }],
        card: { nickname: 'CanaryMe-26e2' },
      }),
    });
    await runStatusCommand(deps as never);
    const joined = lines.join('\n');
    expect(joined).toContain(`🏮 **CanaryMe-26e2** #${SIGIL}`);
    expect(joined).toContain(`popclaw.me/CanaryMe-26e2/${SIGIL}`);
    expect(joined).not.toContain('ranger-3gkVcd');
  });

  it('prints the same address the rename confirmed, in the same process', async () => {
    // The rename signs a real namecard, so this owner needs a real base58 id.
    const OWNER = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
    const OWNER_SIGIL = deriveSigil(OWNER);
    const host = new InMemoryHostAdapter();
    // One house, one state: the native row still carries the registration-time
    // auto name; the namecard row is whatever the last push declared.
    const house: { card: { nickname: string; one_line_intro: string; declared_at_ms: number;
      taste_tags: string[]; role_persona: string; location_hint: string; avatar_uri: string; payout_addresses: unknown[] } | null } = { card: null };
    const houseFetch = vi.fn(async () => {
      const body = {
        popclaw_id: OWNER,
        sigil: OWNER_SIGIL,
        profiles: [{ platform: 'popclaw', handle: 'ranger-3gkVcd', verified_at: '2026-09-20T00:00:00Z',
          source_task_id: '', follower_count: 0, avatar_url: '', bio: '' }],
        house_follower_count: 0, house_post_count: 0, house_reply_received_count: 0,
        ...(house.card ? {card: house.card} : {}),
      };
      return new Response(JSON.stringify(body));
    });
    const readName = async () =>
      ((await host.config.loadJson('plugin')) as { ranger_profile?: { nickname?: string } } | null)
        ?.ranger_profile?.nickname ?? '';
    const named = await runPopclawNameCommand({ nickname: 'CanaryMe-26e2' }, {
      host,
      signer: { publicKey: async () => new Uint8Array(32), sign: async () => new Uint8Array(64), popclawId: async () => OWNER } as never,
      egress: {
        push: async () => {
          const config = await host.config.loadJson('plugin') as {ranger_profile: {namecard_declared_at: number}};
          house.card = { nickname: await readName(), one_line_intro: '',
            declared_at_ms: config.ranger_profile.namecard_declared_at * 1000,
            taste_tags: [], role_persona: '', location_hint: '', avatar_uri: '', payout_addresses: [] };
          return { status: 200 };
        },
      } as never,
      popclawId: OWNER,
      clock: { now: () => new Date('2026-09-26T00:00:00Z') },
      houseOrigins: ['https://house.example'],
      webBaseUrl: 'https://popclaw.me',
      fetch: houseFetch as never,
    });
    const { deps, lines } = completeDeps({ signer: makeSigner(OWNER), nickname: await readName(), fetch: houseFetch });
    await runStatusCommand(deps as never);

    const address = (text: string) => text.match(/popclaw\.me\/[^\s/]+\/[0-9a-z]+/)?.[0];
    const confirmed = address(named.text);
    expect(named.details.public.status).toBe('confirmed');
    expect(confirmed).toBe(`popclaw.me/CanaryMe-26e2/${OWNER_SIGIL}`);
    expect(address(lines.filter((l) => l.startsWith('popclaw.me/')).join('\n'))).toBe(confirmed);
  });

  // #282 split this in two: a CJK name is *unreadable* when encoded, a space is
  // *unsafe* when not — that is where a chat client stops auto-detecting the
  // link. The name reads back; the space stays escaped.
  it('keeps link-breaking characters escaped while the name itself stays readable', async () => {
    const { deps, lines } = completeDeps({ nickname: '青鸾 侠', fetch: okFetch({ profiles: [] }) });
    await runStatusCommand(deps as never);
    const joined = lines.join('\n');
    expect(joined).toContain(`popclaw.me/青鸾%20侠/${SIGIL}`);
    expect(joined).not.toContain('%E9%9D%92');
  });

  it('returns popclawId / sigil / verifiedProfiles / following', async () => {
    const { deps } = completeDeps();
    const out = await runStatusCommand(deps as never);
    expect(out.popclawId).toBe(ID);
    expect(out.sigil).toBe(SIGIL);
    expect(out.verifiedProfiles).toHaveLength(2);
    expect(out.following).toEqual(['f1', 'f2', 'f3', 'f4']);
  });
});

describe('runStatusCommand — 这一周（增量层）', () => {
  const NOW_MS = 1_800_000_000_000;
  const NOW_SEC = Math.floor(NOW_MS / 1000);

  function rec(kind: string, actorId?: string) {
    return { v: 1, ts: NOW_SEC - 100, tz: '+08', kind, ...(actorId ? { actor: { id: actorId } } : {}) };
  }

  function withLog(records: unknown[], extra: Record<string, unknown> = {}) {
    return completeDeps({ now: () => NOW_MS, socialLog: () => records, ...extra });
  }

  it('renders 收到的 on the header line and 我做的 underneath', async () => {
    const { deps, lines } = withLog([
      rec('reply_received', 'a'), rec('reply_received', 'b'), rec('reply_received', 'c'),
      rec('dm_received', 'a'),
      rec('post_sent'), rec('post_sent'),
      rec('follow_added', 'x'), rec('follow_added', 'y'),
    ]);
    await runStatusCommand(deps as never);
    const joined = lines.join('\n');
    expect(joined).toContain('**这一周**');
    expect(joined).toContain('回你的话 3 人');
    expect(joined).toContain('私信 1 封');
    expect(joined).toContain('你发帖 2 篇');
    expect(joined).toContain('新关注 2 人');
  });

  it('sits between the identity block and 你的江湖 — the reason to look again comes first', async () => {
    const { deps, lines } = withLog([rec('post_sent')]);
    await runStatusCommand(deps as never);
    const j = lines.join('\n');
    expect(j.indexOf('🔑')).toBeLessThan(j.indexOf('这一周'));
    expect(j.indexOf('这一周')).toBeLessThan(j.indexOf('你的江湖'));
  });

  it('omits the whole block on a quiet week — zeros are not news', async () => {
    const { deps, lines } = withLog([]);
    await runStatusCommand(deps as never);
    expect(lines.join('\n')).not.toContain('这一周');
  });

  it('omits the block when no social log is wired at all', async () => {
    const { deps, lines } = completeDeps();
    await runStatusCommand(deps as never);
    expect(lines.join('\n')).not.toContain('这一周');
  });

  it('counts distinct people for replies, not raw events', async () => {
    const { deps, lines } = withLog([
      rec('reply_received', 'a'), rec('reply_received', 'a'), rec('reply_received', 'a'),
    ]);
    await runStatusCommand(deps as never);
    expect(lines.join('\n')).toContain('回你的话 1 人');
  });

  it('promotes 我做的 to the header line when nothing inbound happened', async () => {
    const { deps, lines } = withLog([rec('post_sent'), rec('follow_added', 'x')]);
    await runStatusCommand(deps as never);
    const joined = lines.join('\n');
    expect(joined).toContain('你发帖 1 篇');
    expect(joined).toContain('新关注 1 人');
    expect(joined).not.toContain('回你的话');
  });

  it('drops zero-valued items instead of printing 0', async () => {
    const { deps, lines } = withLog([rec('dm_received', 'a'), rec('post_sent')]);
    await runStatusCommand(deps as never);
    const joined = lines.join('\n');
    expect(joined).toContain('私信 1 封');
    expect(joined).toContain('你发帖 1 篇');
    expect(joined).not.toContain('0 ');
  });

  // The tool promises "DM counts"; only inbound DMs were ever counted.
  it('counts the DMs the owner sent this week beside the ones received', async () => {
    const { deps, lines } = withLog([rec('dm_received', 'a'), rec('dm_sent', 'b'), rec('dm_sent', 'c')]);
    await runStatusCommand(deps as never);
    const joined = lines.join('\n');
    expect(joined).toContain('私信 1 封');
    expect(joined).toContain('你发私信 2 封');
  });

  it('counts sent DMs in English too', async () => {
    const { deps, lines } = withLog([rec('dm_sent', 'b')], { lang: 'en' });
    await runStatusCommand(deps as never);
    expect(lines.join('\n')).toContain('DMs you sent 1 messages');
  });

  it('asks the log for exactly a 7-day window ending now', async () => {
    const seen: Array<[number, number]> = [];
    const { deps } = completeDeps({
      now: () => NOW_MS,
      socialLog: (from: number, to: number) => {
        seen.push([from, to]);
        return [];
      },
    });
    await runStatusCommand(deps as never);
    expect(seen).toEqual([[NOW_SEC - 7 * 24 * 3600, NOW_SEC]]);
  });

  it('ignores social-log kinds that are not part of the weekly pulse', async () => {
    const { deps, lines } = withLog([rec('mark_added'), rec('person_asked', 'a'), rec('follow_removed', 'b')]);
    await runStatusCommand(deps as never);
    expect(lines.join('\n')).not.toContain('这一周');
  });
});

describe('runStatusCommand — 工具路径（agent 读者）', () => {
  it('keeps the owner own popclaw_id — the human bubble drops it, the LLM needs it', async () => {
    const { deps, lines } = completeDeps({ audience: 'agent' });
    await runStatusCommand(deps as never);
    expect(lines.join('\n')).toContain(`🔑 popclaw_id：${ID_SHORT}`);
  });

  it('lists 最近关注 with full ids so the LLM can DM/follow directly', async () => {
    const { deps, lines } = completeDeps({ audience: 'agent' });
    await runStatusCommand(deps as never);
    expect(lines.join('\n')).toContain('最近关注');
  });

  it('keeps the full popclaw_id on every follow so the LLM can act on it', async () => {
    const { deps, lines } = completeDeps({ audience: 'agent' });
    await runStatusCommand(deps as never);
    const joined = lines.join('\n');
    expect(joined).toContain(`乙#${deriveSigil('f2')}（f2）`);
    expect(joined).toContain(`丙#${deriveSigil('f3')}（f3）`);
  });

  it('lists up to 3 todos as a numbered list — an LLM does not get decision paralysis', async () => {
    const { deps, lines } = completeDeps({
      audience: 'agent',
      fetch: okFetch({ profiles: [] }),
      socialGraph: { following: () => [] },
      notifyTarget: null,
      bondsStore: { list: () => [] },
      dmSenderCount: () => 0,
      tasteLoader: { enabledSources: async () => [] },
      host: {
        config: { loadJson: vi.fn().mockResolvedValue({ ranger_profile: { name_source: 'auto' } }) },
      },
    });
    await runStatusCommand(deps as never);
    const joined = lines.join('\n');
    // Four todos (zero follows / taste seed / verification / nickname), but optional verification occupies no numbered
    // slot and does not count toward remaining steps; count only the three required tasks.
    expect(joined).toContain('📋 还差 3 步，身份档案就齐全了');
    expect(joined).toContain('1. 关注几个人 — 我手上一个人都没有，明早的报纸会很空。要我帮你找几个吗？');
    expect(joined).toContain('　 → /popclaw recommend，或对我说「推荐几个值得关注的人」');
    expect(joined).toContain('2. 跟我说说你最近关心什么 — 我带给你的东西就会越来越像你——像为你定制的');
    expect(joined).toContain('3. 名号是我替你取的 — 名字没定下来前，别人按名字找不到、也关注不了你——除非已经拿到你的 popclaw_id');
    expect(joined).not.toContain('4. ');
    // Verification still appears, without a number, and clearly reads as optional.
    expect(joined).toContain('· 认证一个外部账号 — 名号后面挂个背书，别人一眼知道你是谁——可选，不用急');
  });

  // Regression (architect, fresh 5th-pack instance, 2026-09-22): a brand-new
  // unverified identity was told "还差 3 步" with verification counted as one
  // of them, even though the house guide says verification is optional and
  // there's no hurry. The count must only reflect required todos, and the
  // verification line — wherever it appears — must read as optional.
  it('a fresh unverified identity does not count verification toward "N steps left" and marks it optional', async () => {
    const { deps, lines } = completeDeps({
      audience: 'agent',
      fetch: okFetch({ profiles: [] }),
      socialGraph: { following: () => [] },
      notifyTarget: null,
      bondsStore: { list: () => [] },
      dmSenderCount: () => 0,
      tasteLoader: { enabledSources: async () => [] },
    });
    await runStatusCommand(deps as never);
    const joined = lines.join('\n');
    // 2 required gaps here (no_follows, no_taste) — verification excluded from the count.
    expect(joined).toContain('📋 还差 2 步，身份档案就齐全了');
    expect(joined).not.toContain('3. 认证');
    expect(joined).toContain('· 认证一个外部账号 — 名号后面挂个背书，别人一眼知道你是谁——可选，不用急');
  });

  it('same fresh unverified identity, English: steps-left excludes verification and the line reads optional', async () => {
    const { deps, lines } = completeDeps({
      lang: 'en',
      audience: 'agent',
      fetch: okFetch({ profiles: [] }),
      socialGraph: { following: () => [] },
      notifyTarget: null,
      bondsStore: { list: () => [] },
      dmSenderCount: () => 0,
      tasteLoader: { enabledSources: async () => [] },
    });
    await runStatusCommand(deps as never);
    const joined = lines.join('\n');
    expect(joined).toContain('📋 2 step(s) left to finish your identity profile');
    expect(joined).not.toContain('3. Verify');
    expect(joined).toContain(
      "· Verify an external account — A verified badge next to your name shows people it's really you — optional, no rush",
    );
  });
});

describe('runStatusCommand — 📣 通知频道 line', () => {
  it('says 本频道 ✅ when the notify target is this very channel', async () => {
    const { deps, lines } = completeDeps({
      notifyTarget: { deliveryContext: { channel: 'discord' } },
      currentChannel: 'discord',
    });
    await runStatusCommand(deps as never);
    expect(lines.join('\n')).toContain('📣 通知频道：本频道 ✅');
  });

  it('names the other channel + how to move it when it is not this channel', async () => {
    const { deps, lines } = completeDeps({
      notifyTarget: { deliveryContext: { channel: 'discord' } },
      currentChannel: 'telegram',
    });
    await runStatusCommand(deps as never);
    expect(lines.join('\n')).toContain(
      '📣 通知频道：Discord（不在这里）\n　 想收在这里：/popclaw notify-here',
    );
  });

  it('names the channel plainly when there is no current channel (CLI path)', async () => {
    const { deps, lines } = completeDeps({
      notifyTarget: { deliveryContext: { channel: 'discord' } },
      currentChannel: undefined,
    });
    await runStatusCommand(deps as never);
    const joined = lines.join('\n');
    expect(joined).toContain('📣 通知频道：Discord');
    expect(joined).not.toContain('本频道');
  });

  it('keeps 未设置 but never a todo — the channel is auto-captured (plan C spec §4)', async () => {
    const { deps, lines } = completeDeps({ notifyTarget: null, currentChannel: 'discord' });
    await runStatusCommand(deps as never);
    const joined = lines.join('\n');
    expect(joined).toContain('📣 通知频道：未设置');
    expect(joined).not.toContain('定个通知频道');
  });
});

// Silent failure is the worst failure: two real machines ran for months with empty taste profiles because
// nothing reported this condition (spec 2026-07-26, step 3, item 3: degraded operation must be visible).
describe('runStatusCommand — night digest write-back freshness', () => {
  const NOW = 1_800_000_000;

  it('cursor absent (调用方没接) → 不猜、不提醒', async () => {
    const { deps, lines } = completeDeps({ now: () => NOW });
    await runStatusCommand(deps as never);
    expect(lines.join('\n')).not.toContain('夜间消化');
  });

  it('missing write-back with unknown schedule does not imply never attempted', async () => {
    const { deps, lines } = completeDeps({ lastDreamAt: null, now: () => NOW });
    await runStatusCommand(deps as never);
    const out = lines.join('\n');
    expect(out).toContain('夜间消化尚无有效写回记录');
    expect(out).toContain('调度状态暂时查不到');
    expect(out).not.toContain('凌晨 3 点');
  });

  it('dreamed yesterday → 容忍期内，不占稀缺的待办位', async () => {
    const { deps, lines } = completeDeps({ lastDreamAt: NOW - 86_400, now: () => NOW });
    await runStatusCommand(deps as never);
    expect(lines.join('\n')).not.toContain('夜间消化');
  });

  it('stale 5 days → 报出天数', async () => {
    const { deps, lines } = completeDeps({ lastDreamAt: NOW - 5 * 86_400, now: () => NOW });
    await runStatusCommand(deps as never);
    expect(lines.join('\n')).toContain('夜间消化距上次有效写回已 5 天');
  });

  it('零关注的人不显示——没人可消化时这条只会挤掉真正该做的事', async () => {
    const { deps, lines } = completeDeps({
      lastDreamAt: null,
      now: () => NOW,
      socialGraph: { following: () => [] },
    });
    await runStatusCommand(deps as never);
    expect(lines.join('\n')).not.toContain('夜间消化');
  });
});

// Two gaps exposed by the owner's questions: the todo ranked sixth while MAX_TODOS=3, so the people needing it
// could never see it; also, never scheduled and scheduled but never run were reported as the same problem.
describe('runStatusCommand — 夜间消化待办的位置与措辞', () => {
  const NOW = 1_800_000_000;

  // After the reduced human view (1+1, first change), people see one todo; the three-slot ranking matters only
  // for agents, precisely where the bug occurred: nightly digestion outside the top three was never surfaced.
  // Under Plan C it ranks at worst third (after taste and verification; zero follows is mutually exclusive).
  it('三格全满时仍然显示 —— 一条"降级要响"的提醒不能放在响不了的位置', async () => {
    const { deps, lines } = completeDeps({
      audience: 'agent',
      lastDreamAt: null,
      now: () => NOW,
      tasteLoader: { enabledSources: async () => [] }, // Reserve the taste-seed todo slot.
      fetch: vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => JSON.stringify({ profiles: [] }) }),
    });
    await runStatusCommand(deps as never);
    const out = lines.join('\n');
    expect(out).toContain('1. 跟我说说你最近关心什么'); // Still ranks first.
    expect(out).toContain('夜间消化');                   // Not displaced.
  });

  it('查到「没排过」→ 让主人开口授权', async () => {
    const { deps, lines } = completeDeps({ lastDreamAt: null, now: () => NOW, dreamCron: { scheduled: false } });
    await runStatusCommand(deps as never);
    const out = lines.join('\n');
    expect(out).toContain('未发现启用的周期性夜间消化任务');
    expect(out).toContain('每天凌晨 3 点');
  });

  it('scheduled with old write-back does not imply failed attempts', async () => {
    const { deps, lines } = completeDeps({
      lastDreamAt: NOW - 5 * 86_400, now: () => NOW, dreamCron: { scheduled: true },
    });
    await runStatusCommand(deps as never);
    const out = lines.join('\n');
    expect(out).toContain('夜间消化距上次有效写回已 5 天');
    expect(out).toContain('已启用周期性排程');
    expect(out).toContain('cron runs');
    expect(out).not.toContain('每天凌晨 3 点');
  });

  // B8 (ADR-0045): the owner must see which time zone the cron schedule uses.
  it('排了的任务如实报出生效时区；没带 tz 就报宿主机本地', async () => {
    const withTz = completeDeps({
      lastDreamAt: NOW - 5 * 86_400, now: () => NOW, dreamCron: { scheduled: true, tz: 'Europe/Berlin' },
    });
    await runStatusCommand(withTz.deps as never);
    expect(withTz.lines.join('\n')).toContain('钟点按 Europe/Berlin 算');

    const noTz = completeDeps({
      lastDreamAt: NOW - 5 * 86_400, now: () => NOW, dreamCron: { scheduled: true },
    });
    await runStatusCommand(noTz.deps as never);
    expect(noTz.lines.join('\n')).toContain(`钟点按本机时区 ${systemTz()}`);
  });

  it('查不到 cron → 退回中性措辞，不猜', async () => {
    const { deps, lines } = completeDeps({ lastDreamAt: NOW - 5 * 86_400, now: () => NOW });
    await runStatusCommand(deps as never);
    expect(lines.join('\n')).toContain('夜间消化距上次有效写回已 5 天');
  });
});

describe('runStatusCommand — 名片没挂上灯坊的待办（issue #280 §3.3）', () => {
  /**
   * Nickname from local config: both todo eligibility and the suggested command use this value, not
   * the boot snapshot.
   */
  function hostWithLocalName(nickname: string, source = 'auto') {
    return {
      config: { loadJson: async () => ({ ranger_profile: { nickname, name_source: source } }) },
    };
  }

  it('主坊可达但查无 card → 列「名片没在灯坊挂上」；auto 来源的真名同样列（复审 finding 2；agent 路径——human 路径上 auto 名的取名待办占稀缺位是预期）', async () => {
    const { deps, lines } = completeDeps({
      audience: 'agent',
      host: hostWithLocalName('青鸾', 'auto'),
      fetch: okFetch({
        house_follower_count: 12,
        profiles: [
          { platform: 'x', handle: 'elonmusk', verified_at: '2026-05-20T00:00:00Z', follower_count: 12_000 },
        ],
        // HTTP 200 without card: verification rows exist, but the profile is absent (Amendment A1).
      }),
    });
    await runStatusCommand(deps as never);
    expect(lines.join('\n')).toContain('名片没在灯坊挂上');
  });

  it('建议命令用本地 config 名号，不用 boot 快照（复审 finding 1：改名后快照是旧名）', async () => {
    const { deps, lines } = completeDeps({
      nickname: '旧名号', // Boot snapshot, unchanged after renaming until restart.
      host: hostWithLocalName('新名号', 'owner'),
      fetch: okFetch({ house_follower_count: 0, profiles: [
        { platform: 'x', handle: 'elonmusk', verified_at: '2026-05-20T00:00:00Z', follower_count: 1 },
      ] }),
    });
    await runStatusCommand(deps as never);
    const out = lines.join('\n');
    expect(out).toContain('/popclaw name 新名号');
    expect(out).not.toContain('/popclaw name 旧名号');
  });

  it('404（坊完全不认识我）同样列待办 —— 可达即判 card 有无（agent 路径，人路径被认证待办的稀缺位挤掉是预期）', async () => {
    const { deps, lines } = completeDeps({
      audience: 'agent',
      host: hostWithLocalName('青鸾'),
      fetch: vi.fn().mockResolvedValue({ ok: false, status: 404, json: async () => ({}) }),
    });
    await runStatusCommand(deps as never);
    expect(lines.join('\n')).toContain('名片没在灯坊挂上');
  });

  it('本地名号还是机器占位名 → 不列（绝不教主人把占位名签成名片）', async () => {
    const { deps, lines } = completeDeps({
      audience: 'agent',
      host: hostWithLocalName('ranger-3Kf9aa'),
      fetch: vi.fn().mockResolvedValue({ ok: false, status: 404, json: async () => ({}) }),
    });
    await runStatusCommand(deps as never);
    expect(lines.join('\n')).not.toContain('名片没在灯坊挂上');
  });

  it('灯坊失联 → 不列（查不到 ≠ 没有）', async () => {
    const { deps, lines } = completeDeps({
      host: hostWithLocalName('青鸾'),
      fetch: vi.fn().mockRejectedValue(new Error('offline')),
    });
    await runStatusCommand(deps as never);
    expect(lines.join('\n')).not.toContain('名片没在灯坊挂上');
  });

  it('card 在 → 不列（completeDeps 基线）', async () => {
    const { deps, lines } = completeDeps({ host: hostWithLocalName('blackfeather_ai', 'owner') });
    await runStatusCommand(deps as never);
    expect(lines.join('\n')).not.toContain('名片没在灯坊挂上');
  });
});

/**
 * S3 pilot — en lane. Same fixtures as the zh-CN block above, with
 * `lang: 'en'` passed explicitly (not relying on the file-wide
 * `setOwnerLang('zh-CN')` default).
 */
describe('runStatusCommand · en lane (S3 lexicon parity)', () => {
  it('renders the complete state in English, same structure as the zh lane', async () => {
    const { deps, lines } = completeDeps({ lang: 'en' });
    await runStatusCommand(deps as never);
    expect(lines.join('\n')).toBe(
      [
        `🏮 **blackfeather_ai** #${SIGIL}`,
        '✓ X @elonmusk',
        'X followers at verification: about 12k',
        '✓ GitHub @octocat',
        'GitHub followers at verification: unconfirmed',
        '',
        '**Your World**',
        'following 4 people',
        'followed by 12 people',
        'bonds 5 (3 friends)',
        'DMed you 3 people',
        '/popclaw bond to see your bond book',
        '',
        '✅ Identity profile complete',
        '',
        '📣 Notify channel: #general',
        'Routing: unavailable',
        'the host has no api.on hook',
        `popclaw.me/blackfeather_ai/${SIGIL}`,
      ].join('\n'),
    );
  });

  it('shows exactly one todo, split at ", or ", plus an English "more left" tail', async () => {
    const { deps, lines } = completeDeps({
      lang: 'en',
      nickname: 'ranger-HafABC',
      fetch: okFetch({ profiles: [] }),
      socialGraph: { following: () => [] },
      notifyTarget: null,
      bondsStore: { list: () => [] },
      dmSenderCount: () => 0,
      onboardingStage: () => 'act1-naming',
      host: {
        config: { loadJson: vi.fn().mockResolvedValue({ ranger_profile: { name_source: 'auto' } }) },
      },
    });
    await runStatusCommand(deps as never);
    expect(lines.join('\n')).toBe(
      [
        `🏮 **ranger-HafABC** #${SIGIL}`,
        '',
        '👉 **Follow a few people**',
        "You're not following anyone yet, so tomorrow's paper will be pretty empty. Want me to find a few for you?",
        '/popclaw recommend',
        'or just tell me "recommend some people worth following"',
        '1 more small thing(s) left',
        '',
        '📣 Notify channel: not set',
        'Routing: unavailable',
        'the host has no api.on hook',
        `popclaw.me/ranger-HafABC/${SIGIL}`,
      ].join('\n'),
    );
  });
});

describe('splitAtOr — language-bound line-break anchor (丙案 #3)', () => {
  it('zh: breaks at ，或, keeps 或 on the continuation line', () => {
    expect(splitAtOr('/popclaw recommend，或对我说「推荐几个值得关注的人」', 'zh-CN')).toEqual([
      '/popclaw recommend',
      '或对我说「推荐几个值得关注的人」',
    ]);
  });

  it('en: breaks at ", or ", keeps "or" on the continuation line', () => {
    expect(splitAtOr('/popclaw recommend, or just tell me "recommend people"', 'en')).toEqual([
      '/popclaw recommend',
      'or just tell me "recommend people"',
    ]);
  });

  it('no anchor found → returns the whole string as one line (both languages)', () => {
    expect(splitAtOr('no conjunction here', 'en')).toEqual(['no conjunction here']);
    expect(splitAtOr('没有连接词', 'zh-CN')).toEqual(['没有连接词']);
  });
});

// #374: routing was registered in the wrong namespace; L1/L2 never fired for three weeks with no log anomaly.
// This health-report line gives the owner a one-command diagnosis, so states must remain distinct, especially
// just started with no trigger versus disconnected. Ledger #013: diagnosis plus detail/action lines; each Chinese line fits a phone.
describe('routingLine — 工具路由自报（#374/#013）', () => {
  const stats = (over: Partial<RoutingStats> = {}): RoutingStats => ({
    mode: 'wired',
    fireCount: 0,
    l2HitCount: 0,
    inboundCount: 0,
    envelopeSeen: 0,
    envelopeStripped: 0,
    lastFiredAt: 0,
    brokenLogged: false,
    ...over,
  });

  it('断电闸开着 → 关，环境变量独占一行不拆开', () => {
    expect(routingLine(stats({ mode: 'off' }), 'zh-CN')).toBe(
      '路由：关\n关它的环境变量：\nPOPCLAW_TOOL_ROUTING=off',
    );
    expect(routingLine(stats({ mode: 'off' }), 'en')).toBe(
      'Routing: off\nturned off by:\nPOPCLAW_TOOL_ROUTING=off',
    );
  });

  it('宿主没有 api.on → 不可用（不是"链路断"，是压根没这个面）', () => {
    expect(routingLine(stats({ mode: 'unavailable' }), 'zh-CN')).toBe(
      '路由：不可用\n宿主没有 api.on 这个钩子',
    );
    expect(routingLine(stats({ mode: 'unavailable' }), 'en')).toBe(
      'Routing: unavailable\nthe host has no api.on hook',
    );
  });

  it('触发过 → 通，带 L1 注入、L2 命中数、本进程轮数', () => {
    const s = stats({ fireCount: 9, l2HitCount: 4, inboundCount: 9 });
    expect(routingLine(s, 'zh-CN')).toBe('路由：通（L1 已注入）\n本进程 9 轮 · L2 命中 4 次');
    expect(routingLine(s, 'en')).toBe(
      'Routing: live (L1 injected)\n9 turns this process · 4 L2 hits',
    );
  });

  it('入站够多却零触发 → 断：入站/触发两数分明，行动行指 doctor', () => {
    const s = stats({ inboundCount: BROKEN_AFTER });
    expect(routingLine(s, 'zh-CN')).toBe(
      `路由：⚠️ 断了\n本进程 ${BROKEN_AFTER} 条入站，0 次触发\n跑 /popclaw doctor 看全部 8 项`,
    );
    expect(routingLine(s, 'en')).toBe(
      `Routing: ⚠️ broken\n${BROKEN_AFTER} inbound turns this process, 0 hook fires\nrun /popclaw doctor for all 8 checks`,
    );
  });

  it('刚开机（入站还不够）→ 待触发，不许喊断', () => {
    const s = stats({ inboundCount: BROKEN_AFTER - 1 });
    const zh = routingLine(s, 'zh-CN');
    expect(zh).toContain('已注册');
    expect(zh).toContain('还没触发');
    expect(zh).not.toContain('⚠️');
    expect(zh).not.toContain('断');
    const en = routingLine(s, 'en');
    expect(en).toContain('no fires yet');
    expect(en).not.toContain('broken');
  });

  it('大计数不截断：完整数字照排', () => {
    const ok = stats({ fireCount: 123456, l2HitCount: 98765, inboundCount: 123456 });
    expect(routingLine(ok, 'zh-CN')).toContain('本进程 123456 轮');
    expect(routingLine(ok, 'zh-CN')).toContain('命中 98765 次');
    expect(routingLine(stats({ inboundCount: 123456 }), 'en')).toContain('123456 inbound turns');
  });

  it('zh 每行不超手机行宽（典型计数，台账 #013 的落点）', () => {
    const cases = [
      routingLine(stats({ mode: 'off' }), 'zh-CN'),
      routingLine(stats({ mode: 'unavailable' }), 'zh-CN'),
      routingLine(stats({ fireCount: 9, l2HitCount: 4, inboundCount: 9 }), 'zh-CN'),
      routingLine(stats({ inboundCount: BROKEN_AFTER - 1 }), 'zh-CN'),
      routingLine(stats({ inboundCount: BROKEN_AFTER }), 'zh-CN'),
    ];
    for (const c of cases) {
      for (const line of c.split('\n')) {
        expect(displayWidth(line)).toBeLessThanOrEqual(PHONE_LINE_CELLS);
      }
    }
  });

  it('工具路径（agent 读者）不出这一行——对宿主 LLM 毫无用处', async () => {
    const { deps, lines } = completeDeps({ audience: 'agent' });
    await runStatusCommand(deps as never);
    expect(lines.join('\n')).not.toContain('路由：');
  });
});

// The 07-31 language incident: cadence was written to data/cadence/ while the loader read config/cadence/.
// Three machines silently used defaults; one permanently selected English templates, without any log explanation.
// These two lines must distinguish an explicitly configured en-US from en-US used because no file was found.
// Provenance is what turns a value into a diagnosis.
describe('configLines — 配置自报（绝对路径 + 生效语言/时区的出处）', () => {
  const report = (over: Partial<ConfigReport> = {}): ConfigReport => ({
    cadencePath: '/root/config/cadence/cadence.json',
    cadenceFound: true,
    langTag: 'zh-CN',
    langSource: 'config',
    tz: 'Asia/Shanghai',
    tzConfigured: true,
    ...over,
  });

  it('文件在 → 报绝对路径，语言与时区都标成主人设定的', () => {
    const [path, effective] = configLines(report(), 'zh-CN');
    expect(path).toBe('⚙ 配置 /root/config/cadence/cadence.json');
    expect(effective).toBe('　 语言 zh-CN（你设定的）· 时区 Asia/Shanghai（你设定的）');
  });

  it('文件不在 → 明说不存在，且语言标成「没人设定过」，不是主人的选择', () => {
    const [path, effective] = configLines(
      report({ cadenceFound: false, langTag: 'en-US', langSource: undefined, tzConfigured: false, tz: 'UTC' }),
      'zh-CN',
    );
    // Neutral, not alarming: with no cadence file the owner is simply running
    // on defaults, which in this release is the ordinary case.
    expect(path).toContain('还没创建');
    expect(path).not.toContain('⚠️');
    // This is what the 07-31 machine should have shown: nobody selected en-US; nobody had spoken yet.
    expect(effective).toBe('　 语言 en-US（默认值 — 没人设定过）· 时区 UTC（本机时区）');
  });

  it('我听出来的语言绝不冒充成主人设定的', () => {
    expect(configLines(report({ langSource: 'guess' }), 'zh-CN')[1]).toContain('我从你的话里认出来的');
    expect(configLines(report({ langSource: 'agent' }), 'zh-CN')[1]).toContain('我从你的话里认出来的');
    expect(configLines(report({ langSource: 'env' }), 'zh-CN')[1]).toContain('宿主 locale');
  });

  it('英文一路同样成立', () => {
    const [path, effective] = configLines(report({ cadenceFound: false, tzConfigured: false }), 'en');
    expect(path).toContain('not created yet');
    expect(effective).toBe('   Language zh-CN (you set it) · timezone Asia/Shanghai (this machine)');
  });

  it('给了 cadenceDir，status 页脚就真的打这两行（少了这根线，上面全白测）', async () => {
    const { deps, lines } = completeDeps({ cadenceDir: '/nowhere/config/cadence' });
    await runStatusCommand(deps as never);
    const out = lines.join('\n');
    expect(out).toContain('⚙ 配置 /nowhere/config/cadence/cadence.json（还没创建，全部按默认值）');
    expect(out).toContain('　 语言 ');
  });
});

describe('channelLabel — 通道 id 是插件标识，不是主人对那个地方的叫法', () => {
  it('names the place, prefix and case notwithstanding', async () => {
    const { deps, lines } = completeDeps({
      notifyTarget: { deliveryContext: { channel: 'openclaw-weixin' } },
    });
    await runStatusCommand(deps as never);
    expect(lines.join('\n')).toContain('📣 通知频道：微信');
  });

  it('passes an id it has no name for through unchanged — a wrong name is worse than a raw one', async () => {
    const { deps, lines } = completeDeps({
      notifyTarget: { deliveryContext: { channel: 'some-new-host' } },
    });
    await runStatusCommand(deps as never);
    expect(lines.join('\n')).toContain('📣 通知频道：some-new-host');
  });
});


describe('runStatusCommand — late next-step advice and read boundaries', () => {
  const NOW = 1_800_000_000;

  for (const lang of ['zh-CN', 'en'] as const) {
    for (const audience of ['human', 'agent'] as const) {
      it(`${lang}/${audience}: a required rule update takes priority over optional verification`, async () => {
        const { deps, lines } = completeDeps({
          lang, audience, now: () => NOW,
          fetch: okFetch({ profiles: [], card: { nickname: 'blackfeather_ai' } }),
          outdatedNewspaperRules: () => ['daily-paper.md', 'editorial.md'],
        });
        const result = await runStatusCommand(deps as never);
        expect({ lines, result }).toMatchSnapshot();
      });

      it(`${lang}/${audience}: optional verification is the only remaining suggestion`, async () => {
        const { deps, lines } = completeDeps({
          lang, audience, now: () => NOW,
          fetch: okFetch({ profiles: [], card: { nickname: 'blackfeather_ai' } }),
        });
        const result = await runStatusCommand(deps as never);
        expect({ lines, result }).toMatchSnapshot();
      });

      it(`${lang}/${audience}: all following-person gaps keep their order and counts before late rules`, async () => {
        const { deps, lines } = completeDeps({
          lang, audience, now: () => NOW,
          fetch: okFetch({ profiles: [] }),
          tasteLoader: { enabledSources: async () => [] },
          lastDreamAt: NOW - 5 * 86_400,
          dreamCron: { scheduled: true, tz: 'Europe/Berlin' },
          host: { config: { loadJson: async () => ({
            ranger_profile: { nickname: 'blackfeather_ai', name_source: 'auto' },
          }) } },
          outdatedNewspaperRules: () => ['daily-paper.md', 'editorial.md'],
        });
        const result = await runStatusCommand(deps as never);
        expect({ lines, result }).toMatchSnapshot();
      });
    }
  }

  it('reads local dream timezone before late rules, backlog before flushing, and preserves both clock reads', async () => {
    const order: string[] = [];
    const timezone = vi.spyOn(statusTime, 'systemTz').mockImplementation(() => {
      order.push('dream timezone');
      return 'Europe/Berlin';
    });
    const { deps, lines } = completeDeps({
      lang: 'en', lastDreamAt: null, dreamCron: { scheduled: true },
      checkPendingInvites: async () => { order.push('invites'); },
      drainNotifications: async () => { order.push('drain'); },
      pendingInvites: () => { order.push('pending'); return []; },
      fetch: async () => {
        order.push('profile');
        return { ok: true, status: 200, text: async () => JSON.stringify({ profiles: [] }) };
      },
      host: { config: { loadJson: async () => { order.push('local'); return {}; } } },
      socialLog: () => { order.push('week'); return []; },
      now: () => { order.push('clock'); return NOW; },
      outdatedNewspaperRules: () => { order.push('rules'); return ['daily-paper.md']; },
      notifyBacklog: () => { order.push('backlog'); return { count: 1 }; },
      logger: { info: (line: string) => { order.push('info'); lines.push(line); } },
    });
    try {
      await runStatusCommand(deps as never);
      expect(order.slice(0, order.indexOf('info'))).toEqual([
        'invites', 'drain', 'pending', 'profile', 'local', 'local',
        'clock', 'week', 'clock', 'dream timezone', 'rules', 'backlog',
      ]);
      expect(order.slice(order.indexOf('info'))).toEqual(lines.map(() => 'info'));
    } finally {
      timezone.mockRestore();
    }
  });

  it('a late rules failure follows dream construction and prevents backlog reads and any final output', async () => {
    const order: string[] = [];
    const timezone = vi.spyOn(statusTime, 'systemTz').mockImplementation(() => {
      order.push('dream timezone');
      return 'Europe/Berlin';
    });
    const failure = new Error('rules unavailable');
    const { deps, lines } = completeDeps({
      lastDreamAt: null, now: () => NOW, dreamCron: { scheduled: true },
      outdatedNewspaperRules: () => { order.push('rules'); throw failure; },
      notifyBacklog: () => { order.push('backlog'); return { count: 1 }; },
    });
    try {
      await expect(runStatusCommand(deps as never)).rejects.toBe(failure);
      expect(order).toEqual(['dream timezone', 'rules']);
      expect(lines).toEqual([]);
    } finally {
      timezone.mockRestore();
    }
  });

  it('reads system timezone only for a stale, followed, scheduled dream without an explicit timezone', async () => {
    const timezone = vi.spyOn(statusTime, 'systemTz').mockReturnValue('Europe/Berlin');
    try {
      for (const overrides of [
        { lastDreamAt: undefined, dreamCron: { scheduled: true } },
        { lastDreamAt: NOW - 86_400, dreamCron: { scheduled: true } },
        { lastDreamAt: null, dreamCron: { scheduled: true }, socialGraph: { following: () => [] } },
        { lastDreamAt: null, dreamCron: { scheduled: true, tz: 'Asia/Tokyo' } },
        { lastDreamAt: null, dreamCron: { scheduled: false } },
        { lastDreamAt: null, dreamCron: null },
        { lastDreamAt: null, dreamCron: undefined },
      ]) {
        await runStatusCommand(completeDeps({ now: () => NOW, ...overrides }).deps as never);
      }
      expect(timezone).not.toHaveBeenCalled();
      await runStatusCommand(completeDeps({
        now: () => NOW, lastDreamAt: null, dreamCron: { scheduled: true },
      }).deps as never);
      expect(timezone).toHaveBeenCalledTimes(1);
    } finally {
      timezone.mockRestore();
    }
  });
});
