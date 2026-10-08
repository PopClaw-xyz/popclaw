/**
 * The cheap, platform-independent half of "only SQLite may hold a descriptor on
 * a live database file" (host/local-host-db.ts explains the mechanism).
 *
 * The expensive half is a Linux behaviour test, because the damage is invisible
 * on macOS: the defect is POSIX record locks being dropped when any descriptor
 * on the file is closed, and Apple's SQLite does not use them. That is exactly
 * why a STATIC guard earns its keep — it is the half that fails on the laptop
 * where the mistake gets written.
 *
 * It works by enumerating every plain-`fs` descriptor site in the modules that
 * deal in database paths and demanding that each one be on an allowlist with a
 * reason. A new way of naming a file is a new entry; the two patterns removed
 * on 2026-09-21 (`openSync(target,'r')` over a live partition, and
 * `readFileSync(source)` over every file in the live data root) cannot come
 * back without turning this red.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('../../../src', import.meta.url));

/** Byte-level `fs` entry points. Each opens a descriptor and closes it, and
 *  that close is what drops this process's locks on the file. */
const SYNC_CALLS = [
  'openSync', 'readFileSync', 'writeFileSync', 'appendFileSync',
  'copyFileSync', 'cpSync', 'createReadStream', 'createWriteStream',
] as const;
/** The promise forms. Only ever matched behind an `fs`-ish receiver: bare
 *  `open(`/`readFile(` are ordinary method names in this codebase. */
const ASYNC_CALLS = ['readFile', 'writeFile', 'appendFile', 'copyFile', 'cp', 'open'] as const;
const RECEIVER = '(?:fs|fsp|promises|fsPromises)';

interface Allowance { file: string; call: string; arg: string; count?: number; reason: string }

/**
 * Every plain-`fs` descriptor site allowed in these modules, with the reason it
 * is not a live database. Keyed by the ARGUMENT EXPRESSION rather than by line
 * number, so the list survives edits above it but not a new spelling.
 */
const ALLOWED: readonly Allowance[] = [
  { file: 'host/local-participation.ts', call: 'readFileSync', arg: "path,'utf8'",
    reason: 'the setup receipt JSON, guarded before the read by assertNoLiveDatabaseDescriptor' },
  { file: 'host/local-host-db.ts', call: 'copyFileSync', arg: 'built, cached',
    reason: 'the freshly compiled better-sqlite3 .node binary, cached under its per-ABI name' },
  { file: 'host/local-host-db.ts', call: 'openSync', arg: "filePath, 'wx', 0o600",
    reason: "O_EXCL placeholder: it only ever touches a file that does not exist yet, so no connection can be holding it" },
  { file: 'host/local-host-db.ts', call: 'openSync', arg: "destination, 'r'",
    reason: 'snapshotTo fsyncs the finished snapshot after the SQLite backup API closed its own connection to it; assertNoLiveDatabaseDescriptor keeps it that way' },
  { file: 'host/local-host-db.ts', call: 'openSync', arg: "dirname(destination), 'r'",
    reason: 'a DIRECTORY descriptor — a different inode, so it carries none of the database file locks' },
  { file: 'host/execution-partition-factory.ts', call: 'openSync', arg: "dirname(path), 'r'",
    reason: 'a DIRECTORY descriptor: it makes the new partition file NAME durable, while the file itself is fsynced through SQLite by wal_checkpoint(TRUNCATE)' },
  { file: 'host/storage-backup.ts', call: 'readFileSync', arg: 'path',
    reason: 'fileSha256; its first statement is assertNoLiveDatabaseDescriptor, which is what keeps every caller on snapshots and backup members' },
  { file: 'host/storage-backup.ts', call: 'copyFileSync', arg: 'source, destination',
    reason: 'the non-database branch of the backup walk, guarded by assertNoLiveDatabaseDescriptor(source)' },
  { file: 'host/storage-backup.ts', call: 'openSync', arg: "destination, 'r'",
    reason: 'fsync of a finished backup member (snapshot or copy), guarded by assertNoLiveDatabaseDescriptor' },
  { file: 'host/storage-backup.ts', call: 'openSync', arg: "quiescedFile, 'r'",
    reason: 'looksLikeSqlite reads the magic number of a member ALREADY COPIED into the backup set — a dead file no connection coordinates, guarded by assertNoLiveDatabaseDescriptor; it is how an unclassified database is refused instead of shipped as bytes' },
  { file: 'host/storage-backup.ts', call: 'readFileSync', arg: "join(directory, manifestName), 'utf8'",
    reason: 'the manifest JSON inside a backup set' },
  { file: 'host/storage-backup.ts', call: 'openSync', arg: "reservation, 'wx', 0o600",
    reason: 'the O_EXCL restore reservation marker in a quiesced destination root; never a database' },
  { file: 'host/storage-backup.ts', call: 'writeFileSync', arg: 'fd, JSON.stringify(planned)',
    reason: 'writes through the reservation descriptor opened on the line above it' },
  { file: 'host/storage-backup.ts', call: 'openSync', arg: "paths.rootDir(), 'r'",
    reason: 'a DIRECTORY descriptor, to make the reservation name durable' },
  { file: 'host/storage-backup.ts', call: 'readFileSync', arg: "join(paths.rootDir(), '.restore-reservation'), 'utf8'", count: 2,
    reason: 'the restore reservation JSON, re-read on both resume legs' },
  { file: 'host/storage-backup.ts', call: 'readFileSync', arg: "receiptPath, 'utf8'",
    reason: 'restore-progress.json in the destination root' },
  { file: 'host/storage-backup.ts', call: 'copyFileSync', arg: "join(options.backupDirectory, 'files', file.path), temporary",
    reason: 'restore copies a backup member onto a temporary name in a quiesced destination root' },
  { file: 'host/storage-backup.ts', call: 'openSync', arg: "temporary, 'r'",
    reason: 'fsync of that temporary before it is renamed into place' },
  { file: 'host/storage-backup.ts', call: 'openSync', arg: "resolve(destination, '..'), 'r'",
    reason: 'a DIRECTORY descriptor, to make the restored name durable' },
  { file: 'host/execution-store-migration.ts', call: 'readFileSync', arg: "recordPath, 'utf8'",
    reason: 'the offline migration record JSON' },
  { file: 'host/storage-compatibility.ts', call: 'readFileSync', arg: "file, 'utf8'",
    reason: 'the fixed master.key JSON path, used only to derive identity without chmod or minting; never a database path' },
  { file: 'host/storage-compatibility.ts', call: 'readFileSync', arg: "paths.dataProfileFile(), 'utf8'",
    reason: 'the local data-profile JSON marker; all actual database inspection uses SQLite readOnly handles' },
  { file: 'host/storage-compatibility.ts', call: 'readFileSync', arg: "credentialPath, 'utf8'",
    reason: 'the existing setup-root management credential JSON, never a SQLite file or a capability source' },
  { file: 'host/storage-compatibility.ts', call: 'readFileSync', arg: "join(migrationsDir, filename), 'utf8'",
    reason: 'the immutable SQL source files shipped with the program, not the owner database to which they apply' },
  { file: 'host/storage-compatibility.ts', call: 'readFileSync', arg: "join(directory, file), 'utf8'",
    reason: 'an existing execution migration record JSON; referenced SQLite originals/candidates use only readOnly connections' },
  { file: 'host/local-host-adapter.ts', call: 'readFile', arg: 'this.p(ns, key)',
    reason: 'the key/value storage namespaces (identity, config); no database is ever addressed through them' },
  { file: 'host/local-host-adapter.ts', call: 'readFile', arg: "path, 'utf-8'",
    reason: 'a config JSON file in the config bucket' },
  { file: 'host/local-host-adapter.ts', call: 'readFileSync', arg: "this.configPath(name), 'utf-8'",
    reason: 'the synchronous read of a config JSON file in the config bucket (the live owner name)' },
  { file: 'host/local-host-adapter.ts', call: 'writeFile', arg: "path, bytes, mode === undefined ? { flag: 'wx' as const } : { flag: 'wx' as const, mode }",
    reason: 'the exclusive create of a storage-namespace value (the keystore mint); not a database path' },
  { file: 'host/local-host-adapter.ts', call: 'writeFile', arg: 'path, bytes, mode === undefined ? {} : { mode }',
    reason: 'a storage-namespace value write; not a database path' },
  { file: 'host/local-host-adapter.ts', call: 'writeFile', arg: "tmp, JSON.stringify(value, null, 2) + '\\n', {encoding: 'utf-8', flag: 'wx'}",
    reason: 'the temporary of a config JSON publish; not a database path' },
  { file: 'host/local-host-adapter.ts', call: 'writeFile', arg: 'tmp, bytes, mode === undefined ? {} : { mode }',
    reason: 'the temporary of a storage-namespace value write; not a database path' },
  { file: 'diagnostics/collect.ts', call: 'readFileSync', arg: "join(stateDir, 'openclaw.json'), 'utf-8'",
    reason: "the host's own config JSON, read for the doctor report" },
  { file: 'diagnostics/collect.ts', call: 'readFileSync', arg: "p, 'utf-8'",
    reason: 'a candidate gateway log file, while the doctor decides which log is the live one' },
  { file: 'diagnostics/collect.ts', call: 'readFileSync', arg: "tmp, 'utf-8'",
    reason: 'the fallback gateway log file, when no candidate above it was usable' },
  { file: 'diagnostics/collect.ts', call: 'readFileSync', arg: "path, 'utf-8'",
    reason: 'the gateway log file the doctor selected; a text log, never a database' },
  { file: 'diagnostics/collect.ts', call: 'writeFileSync', arg: "file, markdown, 'utf-8'",
    reason: 'the doctor report markdown it has just rendered' },
];

/** Comments only — a doc comment that NAMES a forbidden pattern must not trip
 *  the guard that forbids it, or the guard can never go green. */
export function stripComments(source: string): string {
  let out = '';
  let i = 0;
  let mode: string = 'code';
  while (i < source.length) {
    const two = source.slice(i, i + 2);
    if (mode === 'code') {
      if (two === '//') { mode = 'line'; i += 2; continue; }
      if (two === '/*') { mode = 'block'; i += 2; continue; }
      if (source[i] === '"' || source[i] === "'" || source[i] === '`') mode = source[i]!;
      out += source[i++];
      continue;
    }
    if (mode === 'line') { if (source[i] === '\n') { mode = 'code'; out += '\n'; } i++; continue; }
    if (mode === 'block') { if (two === '*/') { mode = 'code'; i += 2; } else { if (source[i] === '\n') out += '\n'; i++; } continue; }
    if (source[i] === '\\') { out += source.slice(i, i + 2); i += 2; continue; }
    if (source[i] === mode) mode = 'code';
    out += source[i++];
  }
  return out;
}

function listTypeScript(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir).sort()) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...listTypeScript(path));
    else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) out.push(path);
  }
  return out;
}

/** The call's arguments, as written, with runs of whitespace collapsed. */
function argumentsOf(source: string, from: number): string {
  let depth = 0;
  let i = from;
  for (; i < source.length; i++) {
    const c = source[i]!;
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) { if (depth === 0) break; depth--; }
  }
  return source.slice(from, i).replace(/\s+/g, ' ').trim();
}

export interface FsDescriptorSite { file: string; call: string; arg: string }

/**
 * The modules that deal in database paths: local-host-db itself, plus every
 * module that imports it. A new module that opens a database is in scope
 * automatically — nobody has to remember to add it here.
 */
export function scanFsDescriptorSites(srcRoot: string): FsDescriptorSite[] {
  const sites: FsDescriptorSite[] = [];
  for (const path of listTypeScript(srcRoot)) {
    const raw = readFileSync(path, 'utf-8');
    const file = relative(srcRoot, path).split('\\').join('/');
    if (file !== 'host/local-host-db.ts' && !/from '[^']*local-host-db\.js'/.test(raw)) continue;
    const code = stripComments(raw);
    const collect = (call: string, pattern: RegExp): void => {
      for (let m = pattern.exec(code); m; m = pattern.exec(code))
        sites.push({ file, call, arg: argumentsOf(code, m.index + m[0].length) });
    };
    for (const call of SYNC_CALLS) collect(call, new RegExp(`(?:^|[^.\\w])(?:${RECEIVER}\\.)?${call}\\s*\\(`, 'g'));
    for (const call of ASYNC_CALLS) collect(call, new RegExp(`${RECEIVER}\\.${call}\\s*\\(`, 'g'));
  }
  return sites;
}

const key = (s: FsDescriptorSite): string => `${s.file} :: ${s.call}(${s.arg})`;
const expected = (): string[] =>
  ALLOWED.flatMap(a => Array.from({ length: a.count ?? 1 }, () => key(a))).sort();

describe('only SQLite may hold a descriptor on a live database file', () => {
  it('has no plain-fs descriptor site outside the allowlist', () => {
    // Both directions on purpose: an unexplained NEW site is the defect this
    // guard exists for, and a STALE entry means the allowlist has stopped
    // describing the code, after which none of its reasons can be trusted.
    expect(scanFsDescriptorSites(SRC).map(key).sort()).toEqual(expected());
  });

  it('gives a distinct, non-empty reason for every entry', () => {
    for (const entry of ALLOWED) expect(entry.reason.length, key(entry)).toBeGreaterThan(30);
    expect(new Set(ALLOWED.map(key)).size).toBe(ALLOWED.length);
  });

  it('keys on code, not on prose that quotes the forbidden pattern', () => {
    // A negative control. Both removed patterns are NAMED in the comments of
    // the very files this scans; a scanner that matched raw text would report
    // them forever and could never go red for a real one.
    const code = stripComments([
      "// const fd = openSync(path, 'r');",
      '/* readFileSync(source).subarray(0, 16) */',
      "const real = openSync(dirname(path), 'r');",
    ].join('\n'));
    expect(code).not.toContain('openSync(path');
    expect(code).not.toContain('readFileSync(source)');
    expect(code).toContain('openSync(dirname(path)');
  });

  it('would go red if either removed pattern came back', () => {
    // Exactly the two deletions, spelled as the scanner sees them. If this ever
    // passes because the allowlist grew to cover them, the guard is decorative.
    for (const site of [
      { file: 'host/execution-partition-factory.ts', call: 'openSync', arg: "target, 'r'" },
      { file: 'host/storage-backup.ts', call: 'readFileSync', arg: 'source' },
    ]) expect(expected(), key(site)).not.toContain(key(site));
  });
});
