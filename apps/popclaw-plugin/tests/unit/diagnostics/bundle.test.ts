import { describe, it, expect } from 'vitest';
import {
  redactHome,
  stripOwnerText,
  reduceLogLine,
  isPopclawLine,
  processGatewayLogLines,
  processInstallLogLines,
  verdictVersion,
  verdictRouting,
  verdictToolsRegistered,
  verdictToolVisibility,
  verdictDatabase,
  verdictSkillPublished,
  verdictLanguageSignal,
  verdictNotifyDelivery,
  renderDoctorChatSummary,
  renderDoctorPreview,
  shortVerdictFragment,
  doctorFileName,
  collectDoctorReport,
  type DoctorCollectInput,
  type VerdictRow,
} from '../../../src/diagnostics/bundle.js';
import type { RoutingStats } from '../../../src/routing/stats.js';

// final docs: 2026-08-11-beta-diagnostics-final.md §3 item 1 (redaction is
// "the heart" — each rule gets its own test) + 2026-08-11-doctor-ux-final.md
// (chat rendering: all-green 2 lines / non-green listed + offer).

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

describe('redaction primitives', () => {
  it('redactHome folds every occurrence of the home dir to ~', () => {
    const home = '/Users/example';
    expect(redactHome('popclaw: read /Users/example/.openclaw/popclaw/config', home)).toBe(
      'popclaw: read ~/.openclaw/popclaw/config',
    );
    expect(redactHome('/Users/example/a and /Users/example/b', home)).toBe('~/a and ~/b');
  });

  it('redactHome is a no-op when homeDir is empty', () => {
    expect(redactHome('/Users/example/x', '')).toBe('/Users/example/x');
  });

  it('stripOwnerText removes the trailing text="…" segment and keeps the rest of the line', () => {
    const line = 'popclaw: routing trace #3 · l1=injected · l2=none · lang=zh · attach=0 · text="今天天气怎么样"';
    expect(stripOwnerText(line, false)).toBe(
      'popclaw: routing trace #3 · l1=injected · l2=none · lang=zh · attach=0',
    );
  });

  it('stripOwnerText leaves the line untouched when withText is true', () => {
    const line = 'popclaw: routing trace #1 · text="hello"';
    expect(stripOwnerText(line, true)).toBe(line);
  });

  it('stripOwnerText is a no-op on a line with no text= segment', () => {
    const line = 'popclaw: build 0.1.0+abc1234';
    expect(stripOwnerText(line, false)).toBe(line);
  });

  it('reduceLogLine extracts msg from a pino JSON line, dropping hostname/pid', () => {
    const json = JSON.stringify({ level: 30, hostname: 'moms-mac', pid: 4242, msg: 'popclaw: build 0.1.0' });
    expect(reduceLogLine(json)).toBe('popclaw: build 0.1.0');
  });

  it('reduceLogLine passes a plain (non-JSON) line through unchanged', () => {
    expect(reduceLogLine('popclaw: build 0.1.0')).toBe('popclaw: build 0.1.0');
  });

  it('reduceLogLine falls back to the raw line on malformed JSON or a missing msg field', () => {
    expect(reduceLogLine('{not json')).toBe('{not json');
    expect(reduceLogLine(JSON.stringify({ level: 30 }))).toBe(JSON.stringify({ level: 30 }));
  });

  it('isPopclawLine only accepts lines that actually mention popclaw', () => {
    expect(isPopclawLine('popclaw: build 0.1.0')).toBe(true);
    expect(isPopclawLine('some other plugin doing its own thing')).toBe(false);
  });

  it('processGatewayLogLines: reduces JSON → filters to popclaw: → strips owner text → folds home → caps', () => {
    const home = '/Users/example';
    const raw = [
      JSON.stringify({ hostname: 'x', msg: `popclaw: read /Users/example/data · text="secret"` }),
      'not popclaw at all — the owner said something private here',
      'popclaw: build 0.1.0',
    ];
    const { lines, truncated } = processGatewayLogLines(raw, { withText: false, homeDir: home, capAt: 500 });
    expect(lines).toEqual(['popclaw: read ~/data', 'popclaw: build 0.1.0']);
    expect(truncated).toBe(false);
    // the "not popclaw" line never appears — it never carries the 'popclaw:' substring
    expect(lines.some((l) => l.includes('private'))).toBe(false);
  });

  it('processGatewayLogLines keeps only the most recent N lines, tail not head', () => {
    const raw = Array.from({ length: 10 }, (_, i) => `popclaw: line ${i}`);
    const { lines, truncated } = processGatewayLogLines(raw, { withText: false, homeDir: '', capAt: 3 });
    expect(lines).toEqual(['popclaw: line 7', 'popclaw: line 8', 'popclaw: line 9']);
    expect(truncated).toBe(true);
  });

  it('processGatewayLogLines keeps owner text when withText is true', () => {
    const raw = ['popclaw: routing trace #1 · text="原话在这里"'];
    const { lines } = processGatewayLogLines(raw, { withText: true, homeDir: '', capAt: 500 });
    expect(lines[0]).toContain('原话在这里');
  });

  it('processInstallLogLines redacts home + owner text and tails, with no popclaw: filter', () => {
    const raw = ['npm warn deprecated foo', '/Users/example/tgz extracted', 'text="never appears here anyway"'];
    const out = processInstallLogLines(raw, { homeDir: '/Users/example', tailAt: 100 });
    expect(out).toContain('npm warn deprecated foo'); // no popclaw: filter — everything survives
    expect(out.some((l) => l.includes('/Users/example'))).toBe(false); // home folded
  });
});

describe('doctorFileName', () => {
  it('is deterministic and filesystem-safe even for the dev build stamp', () => {
    const name = doctorFileName('dev (unbundled)', 1_754_000_000, 'UTC');
    expect(name).toMatch(/^popclaw-doctor-dev__unbundled_-\d{8}-\d{4}\.md$/);
  });

  it('embeds a normal build stamp cleanly (+ . - are all filesystem-safe, kept as-is)', () => {
    const name = doctorFileName('0.1.0+2026-08-11-abc1234', 1_754_000_000, 'UTC');
    expect(name.startsWith('popclaw-doctor-0.1.0+2026-08-11-abc1234-')).toBe(true);
    expect(name.endsWith('.md')).toBe(true);
  });
});

describe('verdict functions — one real probe each', () => {
  it('verdictVersion: ok when running build matches the last-boot record', () => {
    const v = verdictVersion('abc123', { build: 'abc123', recordedAt: 't' }, 'zh-CN');
    expect(v.status).toBe('ok');
  });

  it('verdictVersion: fail when the running build and the recorded build disagree', () => {
    const v = verdictVersion('abc123', { build: 'def456', recordedAt: 't' }, 'zh-CN');
    expect(v.status).toBe('fail');
    expect(v.reason).toContain('abc123');
    expect(v.reason).toContain('def456');
  });

  it('verdictVersion: warn (not fail) when there is no boot record at all', () => {
    const v = verdictVersion('abc123', null, 'zh-CN');
    expect(v.status).toBe('warn');
  });

  it('verdictRouting: ok while still within the too-early-to-tell window', () => {
    const v = verdictRouting(stats({ mode: 'wired', fireCount: 0, inboundCount: 1 }), 'zh-CN');
    expect(v.status).toBe('ok');
  });

  it('verdictRouting: fail once inboundCount reaches BROKEN_AFTER with zero fires', () => {
    const v = verdictRouting(stats({ mode: 'wired', fireCount: 0, inboundCount: 5 }), 'zh-CN');
    expect(v.status).toBe('fail');
    expect(v.reason).toContain('5');
  });

  it('verdictRouting: fail when the hook was never registered', () => {
    expect(verdictRouting(stats({ mode: 'unavailable' }), 'zh-CN').status).toBe('fail');
  });

  it('verdictRouting: ok when it has actually fired', () => {
    expect(verdictRouting(stats({ mode: 'wired', fireCount: 3 }), 'zh-CN').status).toBe('ok');
  });

  it('verdictToolsRegistered: fail on exactly 0, ok on any positive count', () => {
    expect(verdictToolsRegistered(0, 'zh-CN').status).toBe('fail');
    expect(verdictToolsRegistered(39, 'zh-CN').status).toBe('ok');
    expect(verdictToolsRegistered(null, 'zh-CN').status).toBe('warn');
  });

  it('verdictToolVisibility: fail on the friend-case root cause (profile set, no group:plugins, empty allowlist)', () => {
    const v = verdictToolVisibility({ profileSet: true, profile: 'coding', alsoAllowHasPlugins: false, toolsAllowCount: 0 }, 'zh-CN');
    expect(v.status).toBe('fail');
    expect(v.reason).toContain('coding');
    // This host has a profile and NO allowlist, so the fix is a per-name
    // alsoAllow list (INSTALL.md Mechanism 1) — never the group:plugins
    // "shortcut" (it also unhides the seven optional tools — #584), and never a
    // fresh toolsAllow list (exclusive: it would amputate host tools — #338).
    // toolsAllow is still named, as the branch for hosts that already keep one.
    expect(v.fixLine).toContain('alsoAllow');
    expect(v.fixLine).toContain('toolsAllow');
  });

  // issue #338, real machine 2026-07-31: a real machine's allowlist named 29 popclaw
  // tools and no host-native ones. Its agent read a verbatim instruction to
  // schedule the daily paper and wrote back asking how — twice — because the
  // `cron` tool had silently vanished. Counting entries called that "ok".
  it('verdictToolVisibility: warns when an allowlist exists but omits the host cron tool (#338)', () => {
    const v = verdictToolVisibility(
      { profileSet: false, alsoAllowHasPlugins: false, toolsAllowCount: 29, toolsAllowHasCron: false },
      'zh-CN',
    );
    expect(v.status).toBe('warn');
    expect(v.reason).toContain('cron');
    expect(v.fixLine).toBeDefined();
  });

  it('verdictToolVisibility: an allowlist that does name cron stays ok', () => {
    const v = verdictToolVisibility(
      { profileSet: false, alsoAllowHasPlugins: false, toolsAllowCount: 30, toolsAllowHasCron: true },
      'zh-CN',
    );
    expect(v.status).toBe('ok');
  });

  // No allowlist at all → nothing is amputated; the cron flag is irrelevant.
  it('verdictToolVisibility: no allowlist → not a cron warning (real-machine shape)', () => {
    const v = verdictToolVisibility(
      { profileSet: false, alsoAllowHasPlugins: false, toolsAllowCount: 0, toolsAllowHasCron: false },
      'zh-CN',
    );
    expect(v.status).toBe('ok');
  });

  // #584 follow-up (Mira, OpenClaw 2026.9.2 verified facts): profile="full" is
  // not broken — nothing is hidden — but it is also not the recommended shape:
  // all 50 tools are visible, including the 7 the manifest deliberately keeps
  // out of the everyday listing. That is a warning ("attention is spent"),
  // not a ✗ (2026-08-24 canary host already ruled out ✗ for this state) and
  // not silently "ok" either (the previous behavior this task fixes).
  it('verdictToolVisibility: profile="full" — warn, all tools visible incl. the optional ones (not fail, not silently ok)', () => {
    const v = verdictToolVisibility({ profileSet: true, profile: 'full', alsoAllowHasPlugins: false, toolsAllowCount: 0 }, 'zh-CN');
    expect(v.status).toBe('warn');
    expect(v.fixLine).toContain('toolsAllow');
  });

  // Same underlying truth as profile="full": alsoAllow: ["group:plugins"]
  // also unhides the 7 optional tools. Previously reported "ok" — this is
  // the exact dishonest state #584 calls out.
  it('verdictToolVisibility: coding + alsoAllow group:plugins — warn, all tools visible incl. the optional ones', () => {
    const v = verdictToolVisibility(
      { profileSet: true, profile: 'coding', alsoAllowHasPlugins: true, toolsAllowCount: 0 },
      'zh-CN',
    );
    expect(v.status).toBe('warn');
    expect(v.fixLine).toContain('toolsAllow');
  });

  // The two good states: no tools block at all, or a per-name toolsAllow list
  // (which also names cron — the #338 shape). Both stay ok, unchanged.
  it('verdictToolVisibility: ok when a toolsAllow list exists, or nothing is restricted', () => {
    expect(verdictToolVisibility({ profileSet: false, alsoAllowHasPlugins: false, toolsAllowCount: 5, toolsAllowHasCron: true }, 'zh-CN').status).toBe('ok');
    expect(verdictToolVisibility({ profileSet: false, alsoAllowHasPlugins: false, toolsAllowCount: 0 }, 'zh-CN').status).toBe('ok');
  });

  it('verdictToolVisibility: warn (not crash) when the host config could not be read', () => {
    expect(verdictToolVisibility(null, 'zh-CN').status).toBe('warn');
  });

  it('verdictDatabase: fail only for labels with an unresolved announced finding', () => {
    const bad = verdictDatabase({ social: { fingerprint: 'aa', build: 'b1', announced: 'quick_check' } }, 'zh-CN');
    expect(bad.status).toBe('fail');
    expect(bad.reason).toContain('social');
    const clean = verdictDatabase({ social: { fingerprint: 'aa', build: 'b1' } }, 'zh-CN');
    expect(clean.status).toBe('ok');
    const none = verdictDatabase({}, 'zh-CN');
    expect(none.status).toBe('warn');
  });

  it('verdictSkillPublished mirrors the on-disk probe result exactly', () => {
    expect(verdictSkillPublished(true, 'zh-CN').status).toBe('ok');
    expect(verdictSkillPublished(false, 'zh-CN').status).toBe('fail');
    expect(verdictSkillPublished(null, 'zh-CN').status).toBe('warn');
  });

  it('verdictLanguageSignal: a known language (config) never reports unknown — slash-only samples included', () => {
    // Isolated reproduction of a possible false alarm: the FIRST /popclaw command in a
    // fresh gateway process observes its own ctx.args ('doctor' — never
    // enveloped), so envelopeSeen=1/stripped=0 while the register holds a
    // config-pinned zh-CN. The row must report the language as known.
    const row = verdictLanguageSignal(stats({ envelopeSeen: 1, envelopeStripped: 0 }), 'zh-CN', 'config');
    expect(row.status).toBe('ok');
    expect(row.reason).toContain('你设定的');
    expect(row.reason).not.toContain('还没认出');
    expect(row.reason).not.toContain('envelopeStripped');
  });

  it('verdictLanguageSignal: an observed language (guess, plain Chinese) is known too', () => {
    const row = verdictLanguageSignal(stats({ envelopeSeen: 1, envelopeStripped: 0 }), 'zh-CN', 'guess');
    expect(row.status).toBe('ok');
    expect(row.reason).toContain('我从你的话里认出来的');
  });

  it('verdictLanguageSignal: an agent-concluded language is known (English lane)', () => {
    const row = verdictLanguageSignal(stats({ envelopeSeen: 4, envelopeStripped: 0 }), 'en', 'agent');
    expect(row.status).toBe('ok');
    expect(row.reason).toContain('picked up from how you write');
  });

  it('verdictLanguageSignal: env-only or nothing + samples = honest warn, not a fail', () => {
    // A fresh English conversation legitimately never establishes an owner
    // language (Latin script does not set the register) — that is an
    // inconclusive preference state, never "detection broke".
    expect(verdictLanguageSignal(stats({ envelopeSeen: 10, envelopeStripped: 9 }), 'zh-CN', 'env').status).toBe('warn');
    expect(verdictLanguageSignal(stats({ envelopeSeen: 10, envelopeStripped: 0 }), 'zh-CN', undefined).status).toBe(
      'warn',
    );
    const reason = verdictLanguageSignal(stats({ envelopeSeen: 10, envelopeStripped: 0 }), 'zh-CN', undefined).reason;
    expect(reason).toContain('还没认出');
  });

  it('verdictLanguageSignal: zero samples stays the inconclusive-but-green noSamples case', () => {
    for (const source of ['config', 'guess', 'env', undefined] as const) {
      const row = verdictLanguageSignal(stats({ envelopeSeen: 0, envelopeStripped: 0 }), 'zh-CN', source);
      expect(row.status, String(source)).toBe('ok');
      expect(row.reason).toContain('还没有样本');
    }
  });

  it('verdictNotifyDelivery: ok with no prior upgrade, ok when delivered, warn when not yet confirmed', () => {
    expect(verdictNotifyDelivery(null, 'zh-CN').status).toBe('ok');
    expect(
      verdictNotifyDelivery(
        { build: 'b2', recordedAt: 't', previous: { build: 'b1', recordedAt: 't0' }, announcedBuild: 'b2' },
        'zh-CN',
      ).status,
    ).toBe('ok');
    expect(
      verdictNotifyDelivery(
        { build: 'b2', recordedAt: 't', previous: { build: 'b1', recordedAt: 't0' } },
        'zh-CN',
      ).status,
    ).toBe('warn');
  });
});

describe('renderDoctorChatSummary — all-green vs non-green shapes', () => {
  const allOk: VerdictRow[] = [
    { key: 'version', label: '版本', status: 'ok', reason: 'x' },
    { key: 'routing', label: '路由', status: 'ok', reason: 'x' },
  ];

  it('all-green is exactly 2 lines: head + path, no offer', () => {
    const { text, allGreen, seed } = renderDoctorChatSummary(allOk, {
      buildStamp: 'abc123',
      reportPath: '/tmp/report.md',
      lang: 'zh-CN',
    });
    const lines = text.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('8 项全过');
    expect(lines[1]).toContain('/tmp/report.md');
    expect(allGreen).toBe(true);
    expect(seed).toBe('');
  });

  it('non-green: fails sort before warns, path line present, offer present with a seeded typed command', () => {
    const rows: VerdictRow[] = [
      { key: 'version', label: '版本', status: 'ok', reason: 'x' },
      { key: 'notify', label: '通知', status: 'warn', reason: 'w' },
      { key: 'routing', label: '路由', status: 'fail', reason: '41 条入站 0 次触发' },
    ];
    const { text, allGreen, seed } = renderDoctorChatSummary(rows, {
      buildStamp: 'abc123',
      reportPath: '/tmp/report.md',
      lang: 'zh-CN',
    });
    expect(allGreen).toBe(false);
    const lines = text.split('\n');
    expect(lines[0]).toContain('2 项要看一下');
    // fail (routing) before warn (notify)
    expect(lines[1]).toContain('✗');
    expect(lines[1]).toContain('路由');
    expect(lines[2]).toContain('⚠️');
    expect(lines[2]).toContain('通知');
    expect(text).toContain('/tmp/report.md');
    expect(text).toContain('/popclaw doctor send');
    expect(seed).toBe('路由不通'); // seeded from the first bad item (routing)
  });

  it('a visible-check fix line gets its own extra line, indented', () => {
    const rows: VerdictRow[] = [
      { key: 'visible', label: '可见', status: 'fail', reason: 'blocked', fixLine: '  修法：加一句配置' },
    ];
    const { text } = renderDoctorChatSummary(rows, { buildStamp: 'x', reportPath: '/p', lang: 'zh-CN' });
    expect(text).toContain('  修法：加一句配置');
  });
});

describe('shortVerdictFragment', () => {
  it.each(['zh-CN', 'en'] as const)('keeps the %s send preview at five lines with a multiline routing reason', (lang) => {
    const row = verdictRouting(stats({ mode: 'unavailable' }), lang);
    expect(row.reason).toContain('\n');
    const fragment = shortVerdictFragment([row], lang);
    expect(fragment).not.toMatch(/[\r\n]/);
    expect(fragment).toContain('api.on');
    expect(fragment).toContain(lang === 'en' ? 'unavailable' : '不可用');
    const preview = renderDoctorPreview({
      houseLabel: 'Test house', contactDisplay: 'Test contact', buildStamp: 'test-build',
      verdictFragment: fragment, ownerNote: 'test', fileName: 'report.md', lineCount: 20,
      reportPath: '/tmp/report.md', lang,
    });
    expect(preview.split('\n')).toHaveLength(5);
    expect(preview).toContain('/tmp/report.md');
    expect(preview).toContain('--confirm');
    // Only the compact preview is flattened; status/report still has details.
    expect(row.reason).toContain('\n');
  });

  it('summarizes to "all pass" when nothing is bad', () => {
    expect(shortVerdictFragment([{ key: 'a', label: 'x', status: 'ok', reason: 'r' }], 'zh-CN')).toContain('全过');
  });

  it('summarizes the worst item when something is bad', () => {
    const frag = shortVerdictFragment(
      [{ key: 'routing', label: '路由', status: 'fail', reason: '41 条入站 0 次触发' }],
      'zh-CN',
    );
    expect(frag).toContain('路由');
    expect(frag).toContain('✗');
  });
});

describe('collectDoctorReport — the whole pipeline end to end', () => {
  const baseInput: DoctorCollectInput = {
    buildStamp: 'abc123',
    sigil: 'n3tzfhnt',
    platform: 'darwin',
    arch: 'arm64',
    nodeVersion: 'v22.22.3',
    nowSec: 1_754_000_000,
    tz: 'UTC',
    lang: 'zh-CN',
    homeDir: '/Users/example',
    configReport: {
      cadencePath: '/Users/example/.openclaw/popclaw/config/cadence/cadence.json',
      cadenceFound: true,
      langTag: 'zh-CN',
      langSource: 'config',
      tz: 'UTC',
      tzConfigured: true,
    },
    withText: false,
    routing: stats({ mode: 'wired', fireCount: 3 }),
    lastBuild: { build: 'abc123', recordedAt: 't' },
    // A clean (no `announced` finding) record, not an empty state — an empty
    // state means "never ran a boot self-check", which is itself a `warn`
    // and would make this "healthy" fixture non-green.
    integrityState: { social: { fingerprint: 'aa11bb22', build: 'abc123' } },
    toolsRegisteredCount: 39,
    hostToolsConfig: { profileSet: false, alsoAllowHasPlugins: false, toolsAllowCount: 0 },
    skillFilePresent: true,
    rawGatewayLogLines: ['popclaw: build abc123'],
    logSources: [{ path: '/Users/example/gateway.log', exists: true, mtime: 't' }],
  };

  it('a healthy input produces an all-green chat summary and a file with all four constitutional guarantees', () => {
    const { markdown, chatSummary } = collectDoctorReport(baseInput);
    expect(chatSummary.allGreen).toBe(true);
    // (a) never calls/leaks a bare homedir string
    expect(markdown.includes('/Users/example')).toBe(false);
    // The config file's absolute path, home-folded like every other path here:
    // `config/cadence/` vs the `data/cadence/` the 07-31 writes went to is the
    // half that identifies the bug, and it survives the fold.
    expect(markdown).toContain('~/.openclaw/popclaw/config/cadence/cadence.json');
    // (b) owner text stripped by default
    expect(markdown.includes('text="')).toBe(false);
    // (d) vault/ never referenced as a read path anywhere in the collector's output
    expect(markdown.includes('vault/')).toBe(false);
  });

  it('--with-text keeps the owner text field and the header says so', () => {
    const withText = collectDoctorReport({
      ...baseInput,
      withText: true,
      rawGatewayLogLines: ['popclaw: routing trace #1 · text="hello there"'],
    });
    expect(withText.markdown).toContain('text=included');
    expect(withText.markdown).toContain('hello there');
    const without = collectDoctorReport(baseInput);
    expect(without.markdown).toContain('text=omitted');
  });

  it('a broken input surfaces in the chat summary as non-green with an offer', () => {
    const { chatSummary } = collectDoctorReport({
      ...baseInput,
      routing: stats({ mode: 'wired', fireCount: 0, inboundCount: 10 }),
    });
    expect(chatSummary.allGreen).toBe(false);
    expect(chatSummary.text).toContain('路由');
  });

  it('the lang verdict reads configReport.langSource: known language stays green despite slash-only samples', () => {
    // End-to-end shape of the 2026-09-06 false alarm: config-pinned zh-CN,
    // the only observation this process ever made was a slash command's own
    // args (envelopeSeen=1, stripped=0). The report must stay honest — the
    // verdict row green, the envelope counts still present in section B.
    const { verdictRows, chatSummary, markdown } = collectDoctorReport({
      ...baseInput,
      routing: stats({ mode: 'wired', fireCount: 3, envelopeSeen: 1, envelopeStripped: 0 }),
    });
    const langRow = verdictRows.find((r) => r.key === 'lang');
    expect(langRow?.status).toBe('ok');
    expect(langRow?.reason).toContain('你设定的');
    expect(chatSummary.allGreen).toBe(true);
    expect(markdown).toContain('0/1'); // doctor.file.b.envelope keeps the raw counts
  });

  it('the lang verdict reads configReport.langSource: no real signal + samples warns', () => {
    const { verdictRows, chatSummary } = collectDoctorReport({
      ...baseInput,
      configReport: { ...baseInput.configReport, langTag: 'en-US', langSource: undefined },
      routing: stats({ mode: 'wired', fireCount: 3, envelopeSeen: 10, envelopeStripped: 0 }),
    });
    const langRow = verdictRows.find((r) => r.key === 'lang');
    expect(langRow?.status).toBe('warn');
    expect(chatSummary.allGreen).toBe(false);
    expect(chatSummary.text).toContain('⚠️');
  });
});
