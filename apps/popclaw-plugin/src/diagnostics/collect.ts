/**
 * `/popclaw doctor` — IO wiring layer. Everything that actually touches disk
 * (gateway.log probing, install-log discovery, host config, writing +
 * pruning the report) lives here, behind one function: `buildDoctorReport`.
 * Both call sites — the `/popclaw doctor` subcommand (index.ts) and the
 * `popclaw_feedback` tool's `attach_doctor_report` path (register-tools.ts)
 * — share this single implementation, so "what goes in a doctor report" can
 * never drift between the two entry points; the only difference between them
 * is the `withText`/`ownerNote` flags the caller passes in.
 *
 * The redaction rules themselves live in the pure `bundle.ts` — this file
 * only fetches raw bytes and hands them over.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  collectDoctorReport,
  doctorFileName,
  type DoctorCollectInput,
  type HostToolsConfig,
  type LogSourceInfo,
  type VerdictRow,
  type ChatSummary,
} from './bundle.js';
import type { HouseCacheFacts } from './house-rows.js';
import type { PopclawPaths } from '../host/popclaw-paths.js';
import { LocalHostDb } from '../host/local-host-db.js';
import { hostDbSlug } from '../ingress/host-slug.js';
import { readLastFrameAt, type LastFrame } from '../ingress/house-silence.js';
import { readHouseGuide, readHouseHandshake } from '../world/house-handshake.js';
import { parseGuideFrontmatter } from '../world/guide.js';
import type { Signer } from '../identity/signer.js';
import { deriveSigil } from '../invite/sigil.js';
import { readLastBuild } from '../runtime/last-build.js';
import { readIntegrityState } from '../host/integrity-check.js';
import { routingStats } from '../routing/stats.js';
import { ownerLang } from '../lexicon/owner-language.js';
import { ownerTz } from '../time/time-context.js';
import { configReport } from '../host/config-report.js';

/** Narrow slice of `PluginRuntime` this needs — duck-typed so both the real
 *  runtime (index.ts) and the tool's cast-down `rt` (register-tools.ts) fit
 *  without a shared "PluginRuntime" import (would be circular). */
export interface DoctorRuntimeSlice {
  /** `loreHouseUrls` is the mounted-house list (config `lore_houses`, `[0]` = home). */
  readonly boot: { readonly signer: Signer; readonly loreHouseUrls?: readonly string[] };
  readonly paths: PopclawPaths;
}

export interface DoctorReportResult {
  readonly path: string;
  readonly bytes: number;
  readonly lineCount: number;
  readonly verdictRows: readonly VerdictRow[];
  readonly chatSummary: ChatSummary;
  readonly fullMarkdown: string;
}

const GATEWAY_LOG_KEEP = 5;

/** ponytail: host config path is derived from `<data root>/../openclaw.json`
 *  (the sibling of `<stateDir>/popclaw`) — misses when `POPCLAW_DATA_ROOT`
 *  overrides the root away from `<stateDir>/popclaw`. Acceptable: the
 *  visibility check gracefully reports "unknown" on a read failure rather
 *  than crashing or guessing. Upgrade path: thread the real stateDir through
 *  if that override + doctor ever collide in practice. */
export function readHostToolsConfig(popclawRoot: string): HostToolsConfig | null {
  try {
    const stateDir = dirname(popclawRoot);
    const raw = JSON.parse(readFileSync(join(stateDir, 'openclaw.json'), 'utf-8')) as {
      tools?: { profile?: string; alsoAllow?: string[]; toolsAllow?: string[] };
    };
    const t = raw.tools ?? {};
    const profileSet = typeof t.profile === 'string' && t.profile.length > 0;
    return {
      profileSet,
      // Deliberate carve-out from "counts only" — see bundle.ts file header.
      ...(profileSet ? { profile: t.profile } : {}),
      // #584: `["group:plugins"]` and the bare plugin id `["popclaw"]` both
      // unhide EVERY popclaw tool (INSTALL.md's "configure the toolsAllow
      // allowlist" section already warns against both as the same shortcut) —
      // verdictToolVisibility treats them identically, so this boolean must
      // go true for either.
      alsoAllowHasPlugins:
        Array.isArray(t.alsoAllow) && (t.alsoAllow.includes('group:plugins') || t.alsoAllow.includes('popclaw')),
      toolsAllowCount: Array.isArray(t.toolsAllow) ? t.toolsAllow.length : 0,
      // Still counts-and-booleans only: whether one specific host-native name
      // is present, never the list itself (bundle.ts file header).
      toolsAllowHasCron: Array.isArray(t.toolsAllow) && t.toolsAllow.includes('cron'),
    };
  } catch {
    return null;
  }
}

/**
 * skill check: does this installed package actually ship
 * `skills/popclaw-social/SKILL.md`? Resolved relative to THIS file's own
 * location (`import.meta.url`) rather than any data-root path — works
 * identically whether running from `src/` (tests, `tsx`) or the bundled
 * `dist/bundled/collect.js` (production), because `skills/` sits at the
 * package root two levels above both. Returns null only if even the
 * existsSync probe itself throws (should not happen — existsSync doesn't).
 */
function readSkillFilePresent(): boolean | null {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    return existsSync(join(here, '..', '..', 'skills', 'popclaw-social', 'SKILL.md'));
  } catch {
    return null;
  }
}

function newestMatching(dir: string, pattern: RegExp): string | null {
  try {
    const hits = readdirSync(dir)
      .filter((f) => pattern.test(f))
      .map((f) => ({ f, mtime: statSync(join(dir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    return hits.length > 0 ? join(dir, hits[0]!.f) : null;
  } catch {
    return null;
  }
}

/** Same three locations, same priority order, the install script's own
 *  build-stamp verification step (step 6) already probes — reusing that
 *  convention rather than inventing a fourth ordering. Reads lines from the
 *  FIRST one that exists (never merges two processes' logs); records
 *  presence/absence/mtime of all three either way, for the "honest about
 *  what we could not find" line (D section). */
function readGatewayLogLines(home: string): { rawLines: string[]; sources: LogSourceInfo[] } {
  const fixedCandidates = [join(home, 'Library', 'Logs', 'openclaw', 'gateway.log'), join(home, '.openclaw', 'gateway.log')];
  const sources: LogSourceInfo[] = [];
  let rawLines: string[] = [];
  let picked = false;
  for (const p of fixedCandidates) {
    const exists = existsSync(p);
    sources.push({ path: p, exists, ...(exists ? { mtime: statSync(p).mtime.toISOString() } : {}) });
    if (exists && !picked) {
      rawLines = readFileSync(p, 'utf-8').split('\n');
      picked = true;
    }
  }
  const tmp = newestMatching('/tmp/openclaw', /^openclaw-.*\.log$/);
  sources.push({
    path: tmp ?? '/tmp/openclaw/openclaw-<YYYY-MM-DD>.log',
    exists: tmp !== null,
    ...(tmp ? { mtime: statSync(tmp).mtime.toISOString() } : {}),
  });
  if (tmp && !picked) rawLines = readFileSync(tmp, 'utf-8').split('\n');
  return { rawLines, sources };
}

/** The guided install script only leaves `$HOME/popclaw-install-<ts>.log`
 *  behind when the install FAILED (success deletes it) — so finding one here
 *  is itself a real signal, not just evidence-gathering. */
function findLatestInstallLog(home: string): { path: string; rawLines: string[] } | null {
  const path = newestMatching(home, /^popclaw-install-.*\.log$/);
  if (!path) return null;
  try {
    return { path, rawLines: readFileSync(path, 'utf-8').split('\n') };
  } catch {
    return null;
  }
}

/** Delete everything past the 5 most recent `popclaw-doctor-*.md` in `dir`. */
function pruneOldReports(dir: string, keep: number): void {
  try {
    const files = readdirSync(dir)
      .filter((f) => f.startsWith('popclaw-doctor-') && f.endsWith('.md'))
      .map((f) => ({ f, mtime: statSync(join(dir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    for (const stale of files.slice(keep)) unlinkSync(join(dir, stale.f));
  } catch {
    // Rolling cleanup is best-effort — a failure here must never block the
    // report the owner actually asked for.
  }
}

/**
 * One row per mounted lore-house, read from the on-disk cache ONLY (#588).
 *
 * **No network, ever.** `house-handshake.ts` owns fetching; a house with no
 * handshake file reads "never handshaken" rather than triggering one — doctor
 * is what the owner runs when things are already broken, and it has to work
 * with the cable out (ADR-0035 discipline).
 *
 * Three reads per house, each independently degradable:
 *  - `<slug>.handshake.json` — the manifest digest + the two ETags + fetched-at;
 *  - `<slug>.guide.md` — mtime (when this house's own rules last changed) plus
 *    the `feedback:` contact it declares, if any;
 *  - `<slug>.db` — `MAX(received_at)`, opened **read-only with
 *    `fileMustExist`** so probing a house that has never connected does not
 *    fabricate an empty cache file for it.
 *
 * A house whose URL does not parse — or whose row cannot be assembled at all —
 * is skipped: a typo in `lore_houses` must cost that one row, not the report
 * the owner actually asked for.
 *
 * The configured URL is used to derive the slug and is then dropped: it never
 * reaches the row, because this report goes out as a feedback-DM attachment
 * and a self-hosted house address is a topology disclosure (controller ruling
 * 2026-09-13).
 */
export function collectHouseFacts(paths: PopclawPaths, houseUrls: readonly string[]): HouseCacheFacts[] {
  const out: HouseCacheFacts[] = [];
  for (const url of houseUrls) {
    try {
      const slug = hostDbSlug(url);
      const rec = readHouseHandshake(paths, slug);
      const guide = readHouseGuide(paths, slug);
      // `readHouseHandshake` returns null for BOTH "no file" and "the file is
      // there and will not parse". Those are different diagnoses — a corrupt
      // cache is not a house we have never met — so split them here, the one
      // place that can still see the file.
      const handshake: number | 'unreadable' | undefined =
        rec !== null
          ? rec.fetched_at
          : existsSync(paths.houseHandshakeFile(slug))
            ? 'unreadable'
            : undefined;
      const feedback = guide ? parseGuideFrontmatter(guide).frontmatter?.feedback : undefined;
      const contact = [feedback?.contact, feedback?.popclawId].filter((x) => !!x).join(' · ');
      out.push({
        slug,
        ...(rec?.house_name ? { houseName: rec.house_name } : {}),
        ...(handshake === undefined ? {} : { handshakeFetchedAt: handshake }),
        ...(rec?.manifest_etag ? { manifestEtag: rec.manifest_etag } : {}),
        ...(rec?.guide_etag ? { guideEtag: rec.guide_etag } : {}),
        ...guideMtimeField(guide === null ? undefined : paths.houseGuideFile(slug)),
        lastFrameAt: lastFrameOf(paths.lorehouseDb(slug)),
        ...(contact ? { officialContact: contact } : {}),
      });
    } catch {
      continue;
    }
  }
  return out;
}

/** mtime of a cached guide. No guide / an unreadable stat → the field is omitted, so the row
 *  reads "no guide cached" rather than claiming a 1970 timestamp. */
function guideMtimeField(file: string | undefined): { guideMtime?: number } {
  if (file === undefined) return {};
  try {
    return { guideMtime: Math.floor(statSync(file).mtimeMs / 1000) };
  } catch {
    return {};
  }
}

/**
 * Read-only peek at a house cache. Never throws, and never creates the `.db`
 * itself — `fileMustExist` is what guarantees that, so probing a house that
 * has never connected leaves no cache behind for it. (SQLite may still write
 * `-shm` / `-wal` sidecars next to a database that already exists, even on a
 * read-only open; those belong to the existing db and are not a fabricated
 * cache.)
 *
 * No database at all → `null`: the cache is only created when a house is
 * opened, so its absence really does mean this house has never delivered a
 * frame. A database that exists but will not open or query → `'unreadable'`,
 * NOT `null` — a locked WAL must not be reported as a house that never spoke.
 */
function lastFrameOf(dbPath: string): LastFrame {
  if (!existsSync(dbPath)) return null;
  let db: LocalHostDb | undefined;
  try {
    db = new LocalHostDb(dbPath, { readOnly: true });
    return readLastFrameAt(db);
  } catch {
    return 'unreadable';
  } finally {
    try {
      db?.close();
    } catch {
      // Best-effort: a diagnostic must not throw on its way out.
    }
  }
}

/**
 * Build a fresh doctor report, write it to `<data root>/data/doctor/`
 * (rolling keep-5), and return the result. `toolsRegisteredCount` is passed
 * in rather than recomputed here — it is only known to the caller that ran
 * `registerPopclawTools()` this process (see index.ts / register-tools.ts).
 */
export async function buildDoctorReport(
  rt: DoctorRuntimeSlice,
  buildStamp: string,
  toolsRegisteredCount: number | null,
  opts: { readonly withText: boolean; readonly ownerNote?: string },
): Promise<DoctorReportResult> {
  const popclawId = await rt.boot.signer.popclawId();
  const sigil = deriveSigil(popclawId);
  const lang = ownerLang();
  const nowSec = Math.floor(Date.now() / 1000);
  const tz = ownerTz();
  const home = homedir();

  const lastBuild = readLastBuild(rt.paths.lastBuildFile());
  const integrityState = readIntegrityState(rt.paths.dbIntegrityFile());
  const routing = routingStats();
  const hostToolsConfig = readHostToolsConfig(rt.paths.rootDir());
  const skillFilePresent = readSkillFilePresent();
  const { rawLines: rawGatewayLogLines, sources: logSources } = readGatewayLogLines(home);
  const installLog = findLatestInstallLog(home);
  // undefined (not []) when the root never told us which houses are mounted —
  // "could not read the list" and "no houses" are different facts (#588).
  const houses = rt.boot.loreHouseUrls ? collectHouseFacts(rt.paths, rt.boot.loreHouseUrls) : undefined;

  const input: DoctorCollectInput = {
    buildStamp,
    sigil,
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.version,
    nowSec,
    tz,
    lang,
    configReport: configReport(rt.paths.cadenceDir()),
    homeDir: home,
    withText: opts.withText,
    ...(opts.ownerNote ? { ownerNote: opts.ownerNote } : {}),
    routing,
    lastBuild,
    integrityState,
    toolsRegisteredCount,
    hostToolsConfig,
    skillFilePresent,
    rawGatewayLogLines,
    logSources,
    ...(installLog ? { installLogPath: installLog.path, rawInstallLogLines: installLog.rawLines } : {}),
    ...(houses ? { houses } : {}),
  };

  const { markdown, verdictRows, chatSummary } = collectDoctorReport(input);

  const dir = rt.paths.doctorDir();
  mkdirSync(dir, { recursive: true });
  const file = join(dir, doctorFileName(buildStamp, nowSec, tz));
  writeFileSync(file, markdown, 'utf-8');
  pruneOldReports(dir, GATEWAY_LOG_KEEP);

  return {
    path: file,
    bytes: Buffer.byteLength(markdown, 'utf-8'),
    lineCount: markdown.split('\n').length,
    verdictRows,
    chatSummary,
    fullMarkdown: markdown,
  };
}
