/**
 * Boot integrity probes (db-protection final doc, 2026-08-11, §3 item 3). Three
 * cheap checks, run on the lazy boot path once the core DBs are open:
 *
 * - `PRAGMA quick_check` — a corrupt database says so on the spot (catches
 *   corruption, not tampering).
 * - `PRAGMA foreign_key_check` — the only zero-false-positive "someone else wrote
 *   here" detector we have. The `sqlite3` CLI defaults to `foreign_keys = 0`, so a
 *   hand-edit easily leaves dangling references behind; our own connections run
 *   `foreign_keys = ON` throughout (local-host-db.ts), which makes it structurally
 *   impossible for us to produce a violation. Non-empty ⇒ an outside write or
 *   corruption, always.
 * - Schema fingerprint — the FK check cannot see "I added a table for you" or
 *   "I dropped that index", which is exactly the next thing the model in the
 *   incident wanted to do.
 *
 * The false-alarm gate on drift: upgrades legitimately change the schema. So we
 * compare (fingerprint, build) PAIRS and only alert when the fingerprint moved
 * while the build did not. A fingerprint that changes along with the build is
 * recorded silently. Getting this wrong is how an owner learns to ignore alerts.
 *
 * Deliberately NOT done: mtime / WAL-frame provenance for "an outsider wrote".
 * Another host writing to the same data root is legitimate (the multi-host promise
 * of PR#384), so those heuristics are pure false positives here.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { inspectIntegrityDatabase } from './integrity-probes.js';
export { schemaFingerprint } from './integrity-probes.js';
import { dirname } from 'node:path';
import type { HostDb } from './host-db.js';
import { renderCopy, type Lang } from '../lexicon/index.js';

/** One row per DB: last boot's fingerprint, the build it was seen under, and the
 *  key of the finding we have already told the owner about. */
export interface IntegrityRecord {
  readonly fingerprint: string;
  readonly build: string;
  readonly announced?: string;
}

export type IntegrityState = Record<string, IntegrityRecord>;

export type IntegrityKind = 'quick_check' | 'foreign_key_check' | 'schema_drift';

export interface IntegrityFinding {
  /** Which database ('social' / 'wallet' / 'lorehouse:<slug>'). */
  readonly label: string;
  readonly kind: IntegrityKind;
  /** Dedupe key — the same problem on the same DB is announced once. */
  readonly key: string;
  /** Short technical detail, for the log line (never the owner message). */
  readonly detail: string;
}

/**
 * Fingerprint = sorted hash of sqlite_master (type, name). `_READ_THIS_FIRST` is
 * excluded: sentinels.ts rebuilds it on demand, so counting it would make the
 * first boot after an upgrade report itself.
 */

/**
 * Should a fingerprint change be alerted? Pure, and tested on its own because it
 * is the single easiest thing in this file to get wrong: no previous record means
 * nothing to compare (first boot); a changed build means the plugin itself did it.
 */
export function isSchemaDrift(
  previous: IntegrityRecord | undefined,
  fingerprint: string,
  build: string,
): boolean {
  if (!previous) return false;
  if (previous.build !== build) return false;
  return previous.fingerprint !== fingerprint;
}

export function readIntegrityState(file: string): IntegrityState {
  try {
    const v = JSON.parse(readFileSync(file, 'utf-8')) as unknown;
    return v && typeof v === 'object' ? (v as IntegrityState) : {};
  } catch {
    return {};
  }
}

function writeIntegrityState(file: string, state: IntegrityState): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(state), 'utf-8');
}

/** The three probes for one DB. A throwing handle is the caller's problem to
 *  swallow — a closed/broken DB must never brick boot. */

export interface IntegrityCheckDeps {
  readonly dbs: ReadonlyArray<{ label: string; db: HostDb }>;
  readonly stateFile: string;
  readonly build: string;
  readonly onError?: (label: string, err: unknown) => void;
}

/**
 * Run one round, persist the new fingerprints, return the findings NOT yet
 * announced. Same once-only shape as the install notice: this decides whether
 * something is worth saying; the caller calls markIntegrityAnnounced only after
 * the message actually got delivered (so an unbound channel simply retries next
 * boot).
 */
export function runIntegrityChecks(deps: IntegrityCheckDeps): IntegrityFinding[] {
  const results = deps.dbs.map(({label, db}) => {
    try { return {label, result: inspectIntegrityDatabase(db)}; }
    catch (err) { deps.onError?.(label, err); return {label}; }
  });
  return recordIntegrityResults(deps, results);
}

export function recordIntegrityResults(deps: Pick<IntegrityCheckDeps, 'stateFile' | 'build'>,
  results: ReadonlyArray<{label: string; result?: ReturnType<typeof inspectIntegrityDatabase>}>,
): IntegrityFinding[] {
  const state = readIntegrityState(deps.stateFile);
  const next: IntegrityState = { ...state };
  const findings: IntegrityFinding[] = [];
  for (const {label, result} of results) {
    if (!result) continue;
    const previous = state[label];
    const problems = [...result.problems];
    if (isSchemaDrift(previous, result.fingerprint, deps.build)) {
      problems.push({kind: 'schema_drift', key: `schema_drift:${result.fingerprint}`,
        detail: `${previous!.fingerprint} → ${result.fingerprint} under build ${deps.build}`});
    }
    next[label] = {fingerprint: result.fingerprint, build: deps.build,
      ...(previous?.announced ? {announced: previous.announced} : {})};
    for (const p of problems) {
      if (previous?.announced !== p.key) findings.push({label, ...p});
    }
  }
  writeIntegrityState(deps.stateFile, next);
  return findings;
}

/** Write the dedupe marker after a real delivery (skip it and the next boot retries). */
export function markIntegrityAnnounced(file: string, findings: readonly IntegrityFinding[]): void {
  const state = readIntegrityState(file);
  for (const f of findings) {
    const rec = state[f.label];
    if (rec) state[f.label] = { ...rec, announced: f.key };
  }
  writeIntegrityState(file, state);
}

const LINE_KEY: Record<IntegrityKind, string> = {
  quick_check: 'integrity.line.quickCheck',
  foreign_key_check: 'integrity.line.foreignKeys',
  schema_drift: 'integrity.line.schemaDrift',
};

/** One calm message, two actions — do not scare the owner without giving them a road. */
export function integrityAlertText(
  findings: readonly IntegrityFinding[],
  backupsDir: string,
  lang: Lang,
): string {
  const items = findings
    .map((f) => renderCopy(lang, LINE_KEY[f.kind], { label: f.label, detail: f.detail }))
    .join('\n');
  return renderCopy(lang, 'integrity.alert', { items, backups: backupsDir });
}
