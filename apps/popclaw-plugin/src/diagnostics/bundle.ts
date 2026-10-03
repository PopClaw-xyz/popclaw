/**
 * `/popclaw doctor` report — pure collector + chat-rendering (the command
 * name changed diagnose→doctor mid-flight; this module file keeps the old
 * `diagnostics` name since user-facing surfaces are what the rename is
 * about).
 *
 * Everything here is a pure function over ALREADY-READ data — no `node:fs`,
 * no `Date.now()`, no process globals. The actual file/log reads live in
 * `collect.ts` (the IO wiring layer both `/popclaw doctor` and
 * `popclaw_feedback`'s `attach_doctor_report` share). This split is what
 * makes the redaction rules — the one part of this feature that is a real
 * privacy boundary — unit-testable with plain strings in, string out.
 *
 * **Constitutional invariant** (same shape as `RoutingTraceFacts` in
 * routing/trace.ts): section C (config snapshot) only ever receives
 * presence/counts, never raw config values, with ONE deliberate carve-out —
 * `tools.profile`'s value itself (a small closed enum like "coding"/"full",
 * never a secret) is shown in the UX-mandated fix message, because knowing
 * WHICH profile is set is what makes the fix line actionable. `alsoAllow` /
 * `toolsAllow` stay counts-only. Section D (log excerpt) never sees `vault/`
 * or `.db` content — those never make it into `rawLogLines` in the first
 * place (gateway.log only).
 *
 * All user-facing text routes through the lexicon (`doctor.*` copy keys) —
 * this file has no hardcoded Chinese, by the repo's own CJK-leak ratchet.
 */

import { timeContext, type TimeContext } from '../time/time-context.js';
import { routingLine } from '../routing/status-line.js';
import { BROKEN_AFTER, type RoutingStats } from '../routing/stats.js';
import type { LastBuildRecord } from '../runtime/last-build.js';
import type { IntegrityState } from '../host/integrity-check.js';
import { renderCopy, type Lang } from '../lexicon/index.js';
import { langSourceCopyKey, tzSourceCopyKey, type ConfigReport } from '../host/config-report.js';
import { renderHouseSection, type HouseCacheFacts } from './house-rows.js';

// ---------------------------------------------------------------------------
// Redaction primitives — each one independently unit-tested.
// ---------------------------------------------------------------------------

/** Every occurrence of the home directory, in any line, folds to `~`. */
export function redactHome(text: string, homeDir: string): string {
  return homeDir ? text.split(homeDir).join('~') : text;
}

/**
 * The owner's own words in a routing-trace line live in exactly one place:
 * the trailing ` · text="…"` segment (routing/trace.ts `formatRoutingTrace`).
 * Default: remove the whole segment (separator included), keep the rest of
 * the line. `--with-text` (subcommand only — the tool path can never set
 * this) leaves it untouched.
 */
const OWNER_TEXT_SEGMENT = /\s*·\s*text="[^"]*"/g;
export function stripOwnerText(line: string, withText: boolean): string {
  return withText ? line : line.replace(OWNER_TEXT_SEGMENT, '');
}

/**
 * pino JSON lines (macOS gateway.log, Linux `/tmp/openclaw/*.log`) carry
 * `hostname` / `pid` / `level` alongside `msg` — none of that is ours to
 * copy. Reduce to the message text; a non-JSON (plain) line passes through
 * unchanged.
 */
export function reduceLogLine(line: string): string {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return line;
  try {
    const obj = JSON.parse(trimmed) as Record<string, unknown>;
    return typeof obj.msg === 'string' ? obj.msg : line;
  } catch {
    return line;
  }
}

/** Only lines that actually say something about popclaw — never the other
 *  99%+ of a shared gateway.log (host + every other plugin + the owner's
 *  full chat transcript). */
export function isPopclawLine(line: string): boolean {
  return line.includes('popclaw:');
}

export interface CappedLines {
  readonly lines: readonly string[];
  readonly truncated: boolean;
}

/** Keep the most recent `capAt` lines (tail, not head — the freshest signal
 *  is what a bug report needs). */
function tailCap(lines: readonly string[], capAt: number): CappedLines {
  return lines.length > capAt
    ? { lines: lines.slice(-capAt), truncated: true }
    : { lines, truncated: false };
}

/** Full pipeline for gateway.log candidate lines: reduce → filter → strip
 *  owner text → fold home → cap. Order matters: filtering happens AFTER
 *  pino-msg reduction, so a JSON line whose `popclaw:` substring lives only
 *  in an unrelated field is correctly excluded. */
export function processGatewayLogLines(
  rawLines: readonly string[],
  opts: { readonly withText: boolean; readonly homeDir: string; readonly capAt: number },
): CappedLines {
  const processed = rawLines
    .map(reduceLogLine)
    .filter(isPopclawLine)
    .map((l) => stripOwnerText(l, opts.withText))
    .map((l) => redactHome(l, opts.homeDir));
  return tailCap(processed, opts.capAt);
}

/** Install-log tail: no `popclaw:` filter (it's install stdout, not
 *  gateway.log) but the same owner-text/home redaction applies defensively. */
export function processInstallLogLines(
  rawLines: readonly string[],
  opts: { readonly homeDir: string; readonly tailAt: number },
): readonly string[] {
  const processed = rawLines.map((l) => redactHome(stripOwnerText(l, false), opts.homeDir));
  return tailCap(processed, opts.tailAt).lines;
}

// ---------------------------------------------------------------------------
// Verdict table — 8 real probes. Labels are always 2 CJK characters in zh
// (doctor-ux-final.md judgment 2: two full-width glyphs align on a phone
// without padEnd, the same layout rule this codebase already enforces for
// status.ts's tables) and a short word in en. `reason` for a warn/fail row
// is the exact chat-facing sentence (doctor-ux-final.md §5.3) — the same
// string is reused verbatim in the report file, so there is only one source
// of "why this failed" text.
// ---------------------------------------------------------------------------

export type VerdictStatus = 'ok' | 'warn' | 'fail';

export interface VerdictRow {
  readonly key: string;
  readonly label: string;
  readonly status: VerdictStatus;
  readonly reason: string;
  /** Only the visible-tools row ever sets this — the one check the owner can
   *  fix themselves in 30 seconds, so the fix goes in the row instead of
   *  being buried in the file (doctor-ux-final.md §2.3). Already carries its
   *  own leading indent from the lexicon string. */
  readonly fixLine?: string;
}

const ICON: Record<VerdictStatus, string> = { ok: '✓', warn: '⚠️', fail: '✗' };

/** Full technical table (all 8 rows, any status) — used in the report FILE's
 *  verdict section, not in chat (chat only shows non-green rows; see
 *  `renderDoctorChatSummary`). */
export function renderVerdictTable(rows: readonly VerdictRow[]): string {
  return rows.map((r) => `${ICON[r.status]} ${r.label} — ${r.reason}`).join('\n');
}

/** 1. version — catches "the running build is not what you think you
 *  installed": the build actually running vs. what got recorded at last
 *  boot (also flags #384-class multi-host-same-data-root drift, where a
 *  sibling host wrote a different build's record). Simplified from the
 *  earlier draft: the "was the upgrade announced?" nuance moved to its own
 *  notify check (8) so the two don't say the same thing twice. */
export function verdictVersion(buildStamp: string, lastBuild: LastBuildRecord | null, lang: Lang): VerdictRow {
  const label = renderCopy(lang, 'doctor.check.version');
  if (!lastBuild) {
    return { key: 'version', label, status: 'warn', reason: renderCopy(lang, 'doctor.warn.version.noRecord') };
  }
  if (lastBuild.build !== buildStamp) {
    return {
      key: 'version',
      label,
      status: 'fail',
      reason: renderCopy(lang, 'doctor.bad.version', { packed: lastBuild.build, running: buildStamp }),
    };
  }
  return { key: 'version', label, status: 'ok', reason: renderCopy(lang, 'doctor.ok.version', { build: buildStamp }) };
}

/** 2. routing — the #374 failure class: hook registered but never fired. A
 *  process that just booted (fewer than BROKEN_AFTER inbound turns seen) is
 *  inconclusive, not broken — reported `ok` so a fresh boot doesn't
 *  spuriously show up as non-green on the very first `/popclaw doctor`. */
export function verdictRouting(s: RoutingStats, lang: Lang): VerdictRow {
  const label = renderCopy(lang, 'doctor.check.routing');
  if (s.mode === 'unavailable') return { key: 'routing', label, status: 'fail', reason: routingLine(s, lang) };
  if (s.mode === 'wired' && s.fireCount === 0 && s.inboundCount >= BROKEN_AFTER) {
    return { key: 'routing', label, status: 'fail', reason: renderCopy(lang, 'doctor.bad.routing', { turns: String(s.inboundCount) }) };
  }
  return { key: 'routing', label, status: 'ok', reason: routingLine(s, lang) };
}

/** 3. tools — a real per-process count, not a decorative constant.
 *  Simplified from "vs manifest count": the manifest lives at the package
 *  root and isn't cheaply resolvable from a bundled, installed plugin at
 *  runtime (no reliable relative path post-`openclaw plugins install`), and
 *  `register-tools.test.ts` + the manifest-sync tests already pin that
 *  number at build time — a runtime mismatch without a code bug basically
 *  cannot happen. Per the "drop rather than stub" rule, this is a liveness
 *  check instead: did registration actually run and produce tools. */
export function verdictToolsRegistered(count: number | null, lang: Lang): VerdictRow {
  const label = renderCopy(lang, 'doctor.check.tools');
  if (count === null) return { key: 'tools', label, status: 'warn', reason: renderCopy(lang, 'doctor.warn.tools.unknown') };
  return count > 0
    ? { key: 'tools', label, status: 'ok', reason: renderCopy(lang, 'doctor.ok.tools', { count: String(count) }) }
    : { key: 'tools', label, status: 'fail', reason: renderCopy(lang, 'doctor.bad.tools') };
}

export interface HostToolsConfig {
  readonly profileSet: boolean;
  /** The raw profile value (e.g. "coding") — see the file header's
   *  redaction-carve-out note for why this one value is not counts-only. */
  readonly profile?: string;
  readonly alsoAllowHasPlugins: boolean;
  readonly toolsAllowCount: number;
  /** Whether the allowlist names the host's own `cron` tool. Presence of one
   *  known name, not the list — the counts-only rule still holds. */
  readonly toolsAllowHasCron?: boolean;
}

/** 4. visible — the friend-case root cause: `tools.profile` set (e.g.
 *  "coding") without an allowlist silently hides every popclaw tool from the
 *  model. The only row that carries a `fixLine` — this is the one check the
 *  owner can fix themselves in 30 seconds.
 *
 *  #584 follow-up (Mira, OpenClaw 2026.9.2 verified facts): `alsoAllow:
 *  ["group:plugins"]` and `tools.profile="full"` both unhide EVERYTHING,
 *  including the 7 tools the manifest deliberately keeps out of the everyday
 *  listing (ADR-0044 §3) — "full" already contains every tool group on both
 *  7.1 and 8.1 (first seen on a 2026-08-24 canary host), so flagging
 *  either as broken would be a false alarm. But reporting them "ok" was
 *  dishonest the other way: nothing is hidden, so attention is spent on
 *  tools most owners never call. Only a per-name toolsAllow list, or no
 *  tools block at all, keeps the 7 optional tools out of the listing — those
 *  two stay "ok"; the "everything visible" shapes are a warning, not a ✗. */
export function verdictToolVisibility(cfg: HostToolsConfig | null, lang: Lang): VerdictRow {
  const label = renderCopy(lang, 'doctor.check.visible');
  if (!cfg) return { key: 'visible', label, status: 'warn', reason: renderCopy(lang, 'doctor.warn.visible.unreadable') };

  // A per-name toolsAllow list is authoritative over both profile and
  // alsoAllow. An exclusive allowlist amputates the HOST, not just the
  // plugin surface: the moment `toolsAllow` exists, every host-native tool
  // it does not name disappears. A real machine (2026-07-31) listed 29
  // popclaw tools and lost `cron` — so the agent could read, verbatim, an
  // instruction to schedule the daily paper, and then write back asking how
  // (issue #338). Nothing warned; it read as the model being useless.
  // Counting the entries said "ok".
  if (cfg.toolsAllowCount > 0) {
    if (cfg.toolsAllowHasCron === false) {
      return {
        key: 'visible',
        label,
        status: 'warn',
        reason: renderCopy(lang, 'doctor.warn.visible.allowlistNoCron', { n: String(cfg.toolsAllowCount) }),
        fixLine: renderCopy(lang, 'doctor.warn.visible.allowlistNoCron.fix'),
      };
    }
    return { key: 'visible', label, status: 'ok', reason: renderCopy(lang, 'doctor.ok.visible.allowlist', { n: String(cfg.toolsAllowCount) }) };
  }

  const allVisible = cfg.alsoAllowHasPlugins || (cfg.profileSet && cfg.profile === 'full');
  const profileExcludesPlugins = cfg.profileSet && cfg.profile !== 'full';
  if (profileExcludesPlugins && !allVisible) {
    return {
      key: 'visible',
      label,
      status: 'fail',
      reason: renderCopy(lang, 'doctor.bad.visible.profile', { profile: cfg.profile ?? '?' }),
      fixLine: renderCopy(lang, 'doctor.bad.visible.fix'),
    };
  }
  if (allVisible) {
    return {
      key: 'visible',
      label,
      status: 'warn',
      reason: renderCopy(lang, 'doctor.warn.visible.allVisible'),
      fixLine: renderCopy(lang, 'doctor.bad.visible.fix'),
    };
  }
  return { key: 'visible', label, status: 'ok', reason: renderCopy(lang, 'doctor.ok.visible.unrestricted') };
}

/** 5. data — latest db-integrity.json state per db. `announced` being set
 *  means the last finding on that db was actually surfaced to the owner and
 *  not yet superseded by a clean run. */
export function verdictDatabase(state: IntegrityState, lang: Lang): VerdictRow {
  const label = renderCopy(lang, 'doctor.check.data');
  const labels = Object.keys(state);
  if (labels.length === 0) return { key: 'data', label, status: 'warn', reason: renderCopy(lang, 'doctor.warn.data.none') };
  const bad = labels.filter((l) => state[l]!.announced);
  return bad.length === 0
    ? { key: 'data', label, status: 'ok', reason: renderCopy(lang, 'doctor.ok.data', { count: String(labels.length), labels: labels.join('、') }) }
    : { key: 'data', label, status: 'fail', reason: renderCopy(lang, 'doctor.bad.data', { detail: bad.join('、') }) };
}

/** 6. skill — whether the plugin's own `skills/popclaw-social/SKILL.md` is
 *  present on disk next to the installed package (collect.ts resolves the
 *  path). This is a REAL, always-available probe (no host API needed) that
 *  is green in the normal case — it does NOT catch "the host filtered the
 *  skill away from the model" (genuinely undetectable from in here), only a
 *  broken/partial install. */
export function verdictSkillPublished(present: boolean | null, lang: Lang): VerdictRow {
  const label = renderCopy(lang, 'doctor.check.skill');
  if (present === null) return { key: 'skill', label, status: 'warn', reason: renderCopy(lang, 'doctor.warn.skill.unknown') };
  return present
    ? { key: 'skill', label, status: 'ok', reason: renderCopy(lang, 'doctor.ok.skill') }
    : { key: 'skill', label, status: 'fail', reason: renderCopy(lang, 'doctor.bad.skill') };
}

/** 7. lang — does the register actually know the owner's language? The answer
 *  comes from `configReport.langSource` (the same provenance status prints),
 *  NOT from the envelope counters: `envelopeSeen/stripped` says whether the
 *  host still wraps prompts the way `stripEnvelope` expects. An isolated
 *  reproduction during the 2026-09-06 review showed the mismatch: the first
 *  `/popclaw` command in a fresh process observes its own `ctx.args` (never
 *  enveloped), so stripped stays 0 while the register holds a config-pinned
 *  zh-CN, and the old check claimed "haven't recognized your language".
 *  This reproduction does not establish the cause of every live-host warning.
 *
 *  - known (config / guess / agent) → `ok`, with the same provenance label
 *    status uses;
 *  - no real signal + samples → `warn`: an honest "not recognized yet" —
 *    including the fresh-English-conversation case, where Latin script never
 *    sets the register and that is by design, not a broken detector;
 *  - no samples yet → `ok` (just booted, or this host never envelopes).
 *
 *  The raw envelope counts stay in the report file (section B) — the strip
 *  ratio is drift evidence for us, not a verdict about the owner. */
export function verdictLanguageSignal(
  s: RoutingStats,
  lang: Lang,
  langSource: ConfigReport['langSource'],
): VerdictRow {
  const label = renderCopy(lang, 'doctor.check.lang');
  if (s.envelopeSeen === 0) return { key: 'lang', label, status: 'ok', reason: renderCopy(lang, 'doctor.ok.lang.noSamples') };
  if (langSource === 'config' || langSource === 'guess' || langSource === 'agent') {
    return {
      key: 'lang',
      label,
      status: 'ok',
      reason: renderCopy(lang, 'doctor.ok.lang.known', { from: renderCopy(lang, langSourceCopyKey(langSource)) }),
    };
  }
  return { key: 'lang', label, status: 'warn', reason: renderCopy(lang, 'doctor.warn.lang.unknown') };
}

/** 8. notify — only meaningful after at least one real upgrade; reported
 *  `ok` (not omitted) when there has never been one, since the UX doc's
 *  fixed 8-check table has no "N/A" state — an owner on their first install
 *  has nothing to worry about here, which IS the green case. */
export function verdictNotifyDelivery(lastBuild: LastBuildRecord | null, lang: Lang): VerdictRow {
  const label = renderCopy(lang, 'doctor.check.notify');
  if (!lastBuild?.previous) return { key: 'notify', label, status: 'ok', reason: renderCopy(lang, 'doctor.ok.notify.never') };
  return lastBuild.announcedBuild === lastBuild.build
    ? {
        key: 'notify',
        label,
        status: 'ok',
        reason: renderCopy(lang, 'doctor.ok.notify.delivered', { from: lastBuild.previous.build, to: lastBuild.build }),
      }
    : {
        key: 'notify',
        label,
        status: 'warn',
        reason: renderCopy(lang, 'doctor.bad.notify', { reason: renderCopy(lang, 'doctor.warn.notify.pending') }),
      };
}

function buildVerdictRows(input: DoctorCollectInput): VerdictRow[] {
  return [
    verdictVersion(input.buildStamp, input.lastBuild, input.lang),
    verdictRouting(input.routing, input.lang),
    verdictToolsRegistered(input.toolsRegisteredCount, input.lang),
    verdictToolVisibility(input.hostToolsConfig, input.lang),
    verdictDatabase(input.integrityState, input.lang),
    verdictSkillPublished(input.skillFilePresent, input.lang),
    verdictLanguageSignal(input.routing, input.lang, input.configReport.langSource),
    verdictNotifyDelivery(input.lastBuild, input.lang),
  ];
}

// ---------------------------------------------------------------------------
// Chat rendering (doctor-ux-final.md §2) — the compact 2-line/N-line surface
// shown in the conversation. Full detail always lives in the file; chat is a
// triage view, never a dump.
// ---------------------------------------------------------------------------

const SEED_BY_KEY: Record<string, string> = {
  routing: 'doctor.seed.routing',
  visible: 'doctor.seed.visible',
  data: 'doctor.seed.data',
  notify: 'doctor.seed.notify',
  version: 'doctor.seed.version',
};

export interface ChatSummary {
  readonly text: string;
  readonly allGreen: boolean;
  /** First non-green item's seed phrase — pre-filled into the offer's typed
   *  route so the owner doesn't have to compose a "what's wrong" sentence
   *  while annoyed (doctor-ux-final.md §2.2). Empty when all-green. */
  readonly seed: string;
}

/** Fails sort before warns; within each group the original 8-check order is
 *  kept (Array#filter preserves order). */
function nonGreenSorted(rows: readonly VerdictRow[]): VerdictRow[] {
  return [...rows.filter((r) => r.status === 'fail'), ...rows.filter((r) => r.status === 'warn')];
}

/** All-green = exactly 2 lines, no offer (doctor-ux-final.md §2.1/§2.2: "no
 *  problem, don't ask whether to see the doctor — that's just nagging").
 *  Otherwise: head + one line per non-green check (✗ before ⚠️, the
 *  visible-tools row gets an extra fix line) + path + blank + 2-line offer. */
export function renderDoctorChatSummary(
  rows: readonly VerdictRow[],
  opts: { readonly buildStamp: string; readonly reportPath: string; readonly lang: Lang },
): ChatSummary {
  const { lang } = opts;
  const bad = nonGreenSorted(rows);
  if (bad.length === 0) {
    const text = [
      renderCopy(lang, 'doctor.head.allGreen', { build: opts.buildStamp }),
      renderCopy(lang, 'doctor.path', { path: opts.reportPath }),
    ].join('\n');
    return { text, allGreen: true, seed: '' };
  }
  const lines: string[] = [renderCopy(lang, 'doctor.head.problems', { bad: String(bad.length), build: opts.buildStamp })];
  for (const r of bad) {
    lines.push(`${ICON[r.status]} ${r.label} · ${r.reason}`);
    if (r.fixLine) lines.push(r.fixLine);
  }
  lines.push(renderCopy(lang, 'doctor.path', { path: opts.reportPath }));
  lines.push('');
  const seed = renderCopy(lang, SEED_BY_KEY[bad[0]!.key] ?? 'doctor.seed.default');
  lines.push(renderCopy(lang, 'doctor.offer.ask'));
  lines.push(renderCopy(lang, 'doctor.offer.typed', { seed }));
  return { text: lines.join('\n'), allGreen: false, seed };
}

/** The `{verdict}` fragment in the send preview's second line — the same
 *  short "label icon（reason）" shorthand used nowhere else, kept to one
 *  fragment on purpose (doctor-ux-final.md §2.4 caps the preview at 5 lines
 *  total, there is no room for a second full listing). */
export function shortVerdictFragment(rows: readonly VerdictRow[], lang: Lang): string {
  const bad = nonGreenSorted(rows);
  if (bad.length === 0) return renderCopy(lang, 'doctor.short.allGreen');
  const r = bad[0]!;
  // Status reasons may contain several readable lines; this compact fragment
  // occupies one line in the send preview. Keep every fact, not the line breaks.
  const reason = r.reason.replace(/\s*[\r\n]+\s*/g, ' · ');
  return `${r.label} ${ICON[r.status]}（${reason}）`;
}

/** The 5-line send preview (doctor-ux-final.md §2.4) — a summary, never the
 *  full report text; knowing you CAN open it is the consent mechanism, not
 *  being forced to scroll 500 lines on a phone. */
export function renderDoctorPreview(opts: {
  readonly houseLabel: string;
  readonly contactDisplay: string;
  readonly buildStamp: string;
  readonly verdictFragment: string;
  readonly ownerNote: string;
  readonly fileName: string;
  readonly lineCount: number;
  readonly reportPath: string;
  readonly lang: Lang;
}): string {
  const { lang } = opts;
  return [
    renderCopy(lang, 'doctor.preview.to', { house: opts.houseLabel, contact: opts.contactDisplay }),
    renderCopy(lang, 'doctor.preview.body', { build: opts.buildStamp, verdict: opts.verdictFragment, note: opts.ownerNote }),
    renderCopy(lang, 'doctor.preview.attach', { file: opts.fileName, lines: String(opts.lineCount) }),
    renderCopy(lang, 'doctor.preview.peek', { path: opts.reportPath }),
    renderCopy(lang, 'doctor.preview.confirm'),
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Filename + report-file assembly.
// ---------------------------------------------------------------------------

/** `popclaw-doctor-<build>-<ts>.md` — build stamps can contain characters a
 *  filesystem doesn't love (`(`, ` `, in the dev build), so sanitize. */
export function doctorFileName(buildStamp: string, nowSec: number, tz: string): string {
  const t: TimeContext = timeContext(nowSec, tz);
  const ts = `${t.ymd.replace(/-/g, '')}-${t.hm.replace(':', '')}`;
  const safeBuild = buildStamp.replace(/[^a-zA-Z0-9+._-]/g, '_').slice(0, 40);
  return `popclaw-doctor-${safeBuild}-${ts}.md`;
}

export interface LogSourceInfo {
  readonly path: string;
  readonly exists: boolean;
  readonly mtime?: string;
}

export interface DoctorCollectInput {
  readonly buildStamp: string;
  readonly sigil: string;
  readonly platform: string;
  readonly arch: string;
  readonly nodeVersion: string;
  readonly nowSec: number;
  readonly tz: string;
  readonly lang: Lang;
  /**
   * Where the config file is and what it actually produced. The single most
   * common silent misconfiguration (07-31: cadence.json written to the wrong
   * directory on three machines) leaves no other trace anywhere in this report.
   */
  readonly configReport: ConfigReport;
  readonly homeDir: string;
  /** `--with-text` — subcommand only; the `popclaw_feedback` tool path must
   *  never set this true (there is no key for it in that tool's schema). */
  readonly withText: boolean;
  readonly ownerNote?: string;
  readonly routing: RoutingStats;
  readonly lastBuild: LastBuildRecord | null;
  readonly integrityState: IntegrityState;
  readonly toolsRegisteredCount: number | null;
  readonly hostToolsConfig: HostToolsConfig | null;
  /** null = collect.ts could not even attempt the existsSync probe. */
  readonly skillFilePresent: boolean | null;
  readonly rawGatewayLogLines: readonly string[];
  readonly logSources: readonly LogSourceInfo[];
  readonly installLogPath?: string;
  readonly rawInstallLogLines?: readonly string[];
  /**
   * One entry per house in `lore_houses`, read from the on-disk cache (#588).
   * `undefined` = collect.ts could not read the mounted-house list at all —
   * reported as such, never as "no houses".
   */
  readonly houses?: readonly HouseCacheFacts[];
}

export interface DoctorReport {
  readonly markdown: string;
  readonly verdictRows: readonly VerdictRow[];
  readonly chatSummary: ChatSummary;
}

const LOG_CAP = 500;
const INSTALL_LOG_TAIL = 100;

/** The one entry point: already-fetched facts in, a ready-to-write markdown
 *  report file + the chat-facing summary (rendered separately so the chat
 *  surface can show it alone without opening the file). */
export function collectDoctorReport(input: DoctorCollectInput): DoctorReport {
  const verdictRows = buildVerdictRows(input);
  const lang = input.lang;

  const { lines: logLines, truncated: logTruncated } = processGatewayLogLines(input.rawGatewayLogLines, {
    withText: input.withText,
    homeDir: input.homeDir,
    capAt: LOG_CAP,
  });
  const installTail = input.rawInstallLogLines
    ? processInstallLogLines(input.rawInstallLogLines, { homeDir: input.homeDir, tailAt: INSTALL_LOG_TAIL })
    : [];

  const t = timeContext(input.nowSec, input.tz);
  const reportPath = doctorFileName(input.buildStamp, input.nowSec, input.tz);
  const chatSummary = renderDoctorChatSummary(verdictRows, { buildStamp: input.buildStamp, reportPath, lang });

  const md: string[] = [];
  md.push(renderCopy(lang, 'doctor.file.title'));
  md.push('');
  md.push(
    `[doctor/v1] build=${input.buildStamp} sigil=${input.sigil} os=${input.platform}-${input.arch} ` +
      `node=${input.nodeVersion} tz=${input.tz} text=${input.withText ? 'included' : 'omitted'}`,
  );
  md.push('');
  md.push(renderCopy(lang, 'doctor.file.verdictHead'));
  md.push('');
  md.push(renderVerdictTable(verdictRows));
  md.push('');
  md.push(renderCopy(lang, 'doctor.file.sectionA'));
  md.push(renderCopy(lang, 'doctor.file.a.build', { build: input.buildStamp }));
  md.push(renderCopy(lang, 'doctor.file.a.sigil', { sigil: input.sigil }));
  md.push(renderCopy(lang, 'doctor.file.a.platform', { platform: `${input.platform}-${input.arch}` }));
  md.push(renderCopy(lang, 'doctor.file.a.node', { node: input.nodeVersion }));
  md.push(
    renderCopy(lang, 'doctor.file.a.localTime', {
      ymd: t.ymd,
      hm: t.hm,
      tz: input.tz,
      from: renderCopy(lang, tzSourceCopyKey(input.configReport)),
    }),
  );
  // The BCP-47 tag in effect, not the lexicon lane: `en` covers every non-zh
  // tag, so the lane alone cannot tell ja-JP from "never configured".
  md.push(
    renderCopy(lang, 'doctor.file.a.lang', {
      lang: input.configReport.langTag,
      from: renderCopy(lang, langSourceCopyKey(input.configReport.langSource)),
    }),
  );
  md.push(
    // Absolute, but home-folded like every other path in this report — the
    // half that matters (`config/cadence/` vs the `data/cadence/` the 07-31
    // writes went to) survives the fold, and the report gets DM'd to us.
    renderCopy(lang, input.configReport.cadenceFound ? 'doctor.file.a.config' : 'doctor.file.a.configMissing', {
      path: redactHome(input.configReport.cadencePath, input.homeDir),
    }),
  );
  md.push('');
  md.push(renderCopy(lang, 'doctor.file.sectionB'));
  md.push(renderCopy(lang, 'doctor.file.b.routing', { line: routingLine(input.routing, lang) }));
  md.push(
    renderCopy(lang, 'doctor.file.b.envelope', {
      stripped: String(input.routing.envelopeStripped),
      seen: String(input.routing.envelopeSeen),
    }),
  );
  md.push(renderCopy(lang, 'doctor.file.b.tools', { count: input.toolsRegisteredCount === null ? '?' : String(input.toolsRegisteredCount) }));
  md.push(renderCopy(lang, 'doctor.file.b.data', { line: verdictDatabase(input.integrityState, lang).reason }));
  md.push('');
  md.push(renderCopy(lang, 'doctor.file.sectionC'));
  if (input.hostToolsConfig) {
    const profileValue = input.hostToolsConfig.profileSet
      ? (input.hostToolsConfig.profile ?? renderCopy(lang, 'doctor.file.profileSet'))
      : renderCopy(lang, 'doctor.file.profileUnset');
    md.push(renderCopy(lang, 'doctor.file.c.profile', { value: profileValue }));
    md.push(
      renderCopy(lang, 'doctor.file.c.alsoAllow', {
        yesno: renderCopy(lang, input.hostToolsConfig.alsoAllowHasPlugins ? 'doctor.file.yes' : 'doctor.file.no'),
      }),
    );
    md.push(renderCopy(lang, 'doctor.file.c.toolsAllow', { count: String(input.hostToolsConfig.toolsAllowCount) }));
  } else {
    md.push(renderCopy(lang, 'doctor.file.c.unreadable'));
  }
  md.push('');
  md.push(renderCopy(lang, 'doctor.file.sectionD'));
  md.push(renderCopy(lang, 'doctor.file.d.probed'));
  for (const s of input.logSources) {
    const path = redactHome(s.path, input.homeDir);
    md.push(
      s.exists
        ? renderCopy(lang, 'doctor.file.d.exists', { path, mtime: s.mtime ?? '?' })
        : renderCopy(lang, 'doctor.file.d.missing', { path }),
    );
  }
  md.push('');
  md.push(
    renderCopy(lang, 'doctor.file.d.recent', {
      count: String(logLines.length),
      truncated: logTruncated ? renderCopy(lang, 'doctor.file.d.truncatedSuffix', { cap: String(LOG_CAP) }) : '',
    }),
  );
  md.push('```');
  md.push(...(logLines.length > 0 ? logLines : [renderCopy(lang, 'doctor.file.d.none')]));
  md.push('```');
  if (input.installLogPath) {
    md.push('');
    md.push(
      renderCopy(lang, 'doctor.file.d.installTail', {
        path: redactHome(input.installLogPath, input.homeDir),
        count: String(installTail.length),
      }),
    );
    md.push('```');
    md.push(...installTail);
    md.push('```');
  }
  md.push('');
  md.push(renderCopy(lang, 'doctor.file.sectionE'));
  md.push(input.ownerNote ? input.ownerNote : renderCopy(lang, 'doctor.file.e.none'));
  md.push('');
  md.push(...renderHouseSection(input.houses, { tz: input.tz, lang }));

  return { markdown: md.join('\n'), verdictRows, chatSummary };
}
