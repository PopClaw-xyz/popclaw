/**
 * The behavioural half of "only SQLite may hold a descriptor on a live database
 * file" (host/local-host-db.ts has the mechanism).
 *
 * POSIX record locks are per process and per file: closing ANY descriptor on a
 * file drops ALL of that process's locks on it. So one `openSync`/`closeSync`,
 * `readFileSync` or hash over a LIVE database, in the process that also holds
 * the WAL connection, silently unlocks it; the next connection in another
 * process to close then takes EXCLUSIVE, decides it is the last one,
 * checkpoints and unlinks `-wal`/`-shm`, and the resident process keeps writing
 * into an inode with no name — invisible to every other host on the data root,
 * gone on kill -9.
 *
 * Most of this is Linux-only, and not because Linux is special in some
 * incidental way: `/proc/locks` is the only place the lock is observable, and
 * Apple's SQLite does not take these locks at all, so a macOS run cannot tell a
 * fixed build from a broken one. The GC test below is the exception and runs
 * everywhere.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LocalHostDb, listDatabaseVisibilityFaults, resetDatabaseVisibilityFaults,
  setDatabaseVisibilityFaultHandler, verifyOpenDatabaseVisibility,
} from '../../../src/host/local-host-db.js';
import { PopclawPaths } from '../../../src/host/popclaw-paths.js';
import { ExecutionStoreCatalog } from '../../../src/host/execution-store.js';
import { createStorageBackup, fileSha256, tableFingerprint, verifyStorageBackup } from '../../../src/host/storage-backup.js';
import { runDailyBackup } from '../../../src/host/daily-backup.js';

const LINUX = process.platform === 'linux';
const SKIP_REASON =
  `skipped on ${process.platform}: the defect is POSIX record locks being dropped on descriptor close, ` +
  `they are only observable in /proc/locks, and Apple's SQLite does not take them at all — a green run ` +
  `here would mean nothing. CI runs these on ubuntu-24.04 (.github/workflows/ci.yml, job "check").`;
if (!LINUX) console.log(`[live-database-locks] ${SKIP_REASON}`);

const PLUGIN_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const ACTOR = '11111111111111111111111111111111';

/**
 * Whether an outside connection that closes goes on to reach SQLite's delete
 * branch — unlinking `-wal`/`-shm` under the resident — varied with the SQLite
 * VERSION that closer links, not with the binding and not with it being the
 * `sqlite3` CLI. EVERYTHING THAT WAS ACTUALLY MEASURED:
 *
 *   `sqlite3` CLI 3.40.1                   → unlinked
 *   `sqlite3` CLI 3.45.1                   → unlinked (reported from a host in
 *                                            the field, not re-run here)
 *   better-sqlite3 11.10.0 / SQLite 3.49.2 → unlinked; the resident's later
 *                                            commits were lost to everyone
 *   better-sqlite3 12.11.1 / SQLite 3.53.2 → did NOT unlink, as the prebuilt
 *                                            binding this repo ships and
 *                                            through the real bundled mcp.js
 *
 * Nothing beyond that list is claimed. Not "every version at or below 3.49.2";
 * not that 3.53.2, or any other version, or any platform, is immune; and not
 * that two builds printing identical `pragma compile_options` are the same
 * binary. An earlier claim in this file — "no better-sqlite3 closer reaches the
 * delete branch, only the CLI does" — was wrong: the comparison varied binding
 * and version at once and credited the binding, and the field reproduction
 * that involved no CLI at all is consistent with the list above.
 *
 * `UNLINKING_CLOSER` picks a NEGATIVE CONTROL out of what is already installed
 * here (no dependency is added to pin an old build). The version test below is
 * the selection rule for that control — at or below the newest version
 * measured to unlink — and is not a statement about which versions are
 * affected. When nothing here qualifies, the delete-branch tests are SKIPPED,
 * visibly — never quietly passed, which is what an `if (…)` inside a test body
 * would have done.
 */
const MEASURED_UNLINKING_CEILING = [3, 49] as const;
const MAY_REACH_DELETE_BRANCH = (version: string): boolean => {
  const [major, minor] = version.split('.').map(Number);
  if (major === undefined || minor === undefined) return false;
  return major < MEASURED_UNLINKING_CEILING[0]
    || (major === MEASURED_UNLINKING_CEILING[0] && minor <= MEASURED_UNLINKING_CEILING[1]);
};
const UNLINKING_CLOSER: { kind: 'sqlite3-cli' | 'better-sqlite3'; version: string } | undefined = (() => {
  try {
    const version = execFileSync('sqlite3', [':memory:', 'select sqlite_version();'], { encoding: 'utf-8' }).trim();
    if (MAY_REACH_DELETE_BRANCH(version)) return { kind: 'sqlite3-cli', version };
  } catch { /* no CLI on PATH */ }
  try {
    const Database = createRequire(import.meta.url)('better-sqlite3') as new (p: string) => {
      prepare(sql: string): { get(): { v: string } }; close(): void;
    };
    const probe = new Database(':memory:');
    try {
      const version = probe.prepare('SELECT sqlite_version() AS v').get().v;
      if (MAY_REACH_DELETE_BRANCH(version)) return { kind: 'better-sqlite3', version };
    } finally { probe.close(); }
  } catch { /* binding unavailable */ }
  return undefined;
})();
if (LINUX && !UNLINKING_CLOSER) console.log(
  '[live-database-locks] nothing installed here links a SQLite version that was measured to reach ' +
  'the delete branch (see the note above), so the delete-branch tests are SKIPPED, not passed. The ' +
  'lock assertions below still run unconditionally and are the direct measurement of the variable ' +
  'this change moves.');

const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });

/** SHARED_FIRST .. SHARED_FIRST+SHARED_SIZE-1 — SQLite's shared range on the main database file. */
const SHARED_FIRST = 1073741826;
const SHARED_LAST = 1073742335;

/** This process's POSIX locks on `path`'s inode, as /proc/locks reports them. */
function locksHeldOn(path: string): string[] {
  const ino = statSync(path).ino;
  return readFileSync('/proc/locks', 'utf-8').split('\n').filter(line => {
    const fields = line.trim().split(/\s+/);
    const at = fields.findIndex(f => /^[0-9a-f]+:[0-9a-f]+:\d+$/.test(f) && Number(f.split(':')[2]) === ino);
    if (at < 1 || fields[at - 1] !== String(process.pid)) return false;
    const start = Number(fields[at + 1]);
    return start >= SHARED_FIRST && start <= SHARED_LAST;
  });
}

function root(prefix: string): PopclawPaths {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  return new PopclawPaths(directory);
}

/** A data root with all three kinds of database the backup walk touches, open and written. */
function liveRoot(prefix: string): { paths: PopclawPaths; social: LocalHostDb; partition: string; cache: LocalHostDb } {
  const paths = root(prefix);
  const social = new LocalHostDb(paths.socialDb());
  cleanup.push(() => social.close());
  social.execute('CREATE TABLE history(value TEXT)');
  social.execute("INSERT INTO history VALUES('live')");
  // The execution partition, built by the real factory — which is what calls
  // the durability helper this test is about.
  const catalog = new ExecutionStoreCatalog({ db: social, paths, actorId: ACTOR });
  cleanup.push(() => catalog.close());
  const partition = catalog.open('https://locks.example').path;
  // A house cache database, the third kind under the root.
  const cache = new LocalHostDb(paths.lorehouseDb('locks.example'));
  cleanup.push(() => cache.close());
  cache.execute('CREATE TABLE world_feed(id TEXT)');
  cache.execute("INSERT INTO world_feed VALUES('frame')");
  mkdirSync(paths.identityDir(), { recursive: true });
  writeFileSync(join(paths.identityDir(), 'master.key'), 'synthetic-not-a-real-key');
  return { paths, social, partition, cache };
}

describe.runIf(LINUX)('a live database keeps this process\'s POSIX locks', () => {
  it('holds a SHARED lock on every open database — the control for everything below', () => {
    const { paths, partition } = liveRoot('live-locks-baseline-');
    // Stated explicitly because the opposite was believed during the
    // investigation: an idle WAL connection DOES hold a persistent shared lock
    // on the MAIN database file, so "no lock" is a finding, not the norm.
    for (const path of [paths.socialDb(), partition, paths.lorehouseDb('locks.example')])
      expect(locksHeldOn(path), path).not.toHaveLength(0);
  });

  it('keeps the partition lock across the factory\'s durability step', () => {
    // buildFreshExecutionPartition calls persist() on a database it is holding
    // open. Restoring the openSync(path,'r')+fsync there turns this red.
    const { partition } = liveRoot('live-locks-persist-');
    expect(locksHeldOn(partition)).not.toHaveLength(0);
    expect(statSync(`${partition}-wal`).size).toBe(0); // the checkpoint still happened
  });

  it('keeps every lock across a whole backup set over the live root', async () => {
    // The first-boot backup walks every file under the data root. Restoring the
    // readFileSync(source) magic-number sniff turns this red for all three.
    const { paths, partition } = liveRoot('live-locks-backup-');
    const { directory } = await createStorageBackup({
      paths, actorId: ACTOR, installationId: null, codeVersion: 'test',
    });
    for (const path of [paths.socialDb(), partition, paths.lorehouseDb('locks.example')])
      expect(locksHeldOn(path), path).not.toHaveLength(0);
    // And the set is still a real backup: verified, and the snapshots carry the
    // live content rather than an empty file taken behind SQLite's back.
    const manifest = verifyStorageBackup(directory);
    const social = manifest.files.find(f => f.path === 'vault/social/my-social-assets.db')!;
    expect(social.sqlite).toBe(true);
    const snapshot = new LocalHostDb(join(directory, 'files', social.path), { readOnly: true });
    cleanup.push(() => snapshot.close());
    expect(snapshot.queryOne<{ value: string }>('SELECT value FROM history')?.value).toBe('live');
  });

  it('CONTROL: one plain-fs open of the live file drops them all', () => {
    // Without this the assertions above could be green because the measurement
    // itself is dead. It is also the mutation in miniature: this single pair of
    // calls is what the product used to do, and it is enough.
    const { paths } = liveRoot('live-locks-control-');
    const database = paths.socialDb();
    expect(locksHeldOn(database)).not.toHaveLength(0);
    const fd = openSync(database, 'r');
    closeSync(fd);
    expect(locksHeldOn(database), 'a plain-fs open+close must drop this process\'s locks').toHaveLength(0);
  });
});

/**
 * A second REAL process: opens the database, reads what is committed, commits a
 * marker of its own, and exits normally. Returns what it could see — which is
 * the assertion that matters. Inode equality only says the file was not
 * replaced; mutual visibility says the two processes are actually looking at
 * one database.
 */
function outsideProcess(database: string, marker: string): string[] {
  const output = execFileSync(process.execPath, ['-e', `
    const Database = require('better-sqlite3');
    const db = new Database(${JSON.stringify(database)});
    db.pragma('busy_timeout = 5000');
    const seen = db.prepare('SELECT value FROM history ORDER BY rowid').all().map(r => r.value);
    db.prepare('INSERT INTO history VALUES(?)').run(${JSON.stringify(marker)});
    db.close();
    process.stdout.write(JSON.stringify(seen));
  `], { cwd: PLUGIN_ROOT, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
  return JSON.parse(output) as string[];
}

/** What the resident connection can see, in its own new transaction. */
function residentSees(db: LocalHostDb): string[] {
  return db.queryAll<{ value: string }>('SELECT value FROM history ORDER BY rowid').map(r => r.value);
}

/** A closer whose linked SQLite was measured to reach the delete branch (see above). */
function unlinkingCloser(database: string): void {
  if (!UNLINKING_CLOSER) throw new Error('no closer measured to reach the delete branch is available here');
  if (UNLINKING_CLOSER.kind === 'sqlite3-cli') {
    execFileSync('sqlite3', [database, 'SELECT count(*) FROM sqlite_master;'], { stdio: 'pipe' });
    return;
  }
  execFileSync(process.execPath, ['-e', `
    const Database = require('better-sqlite3');
    const db = new Database(${JSON.stringify(database)});
    db.prepare('SELECT count(*) AS n FROM sqlite_master').get();
    db.close();
  `], { cwd: PLUGIN_ROOT, stdio: 'pipe' });
}

describe.runIf(LINUX)('two processes on one data root see each other\'s commits', () => {
  it.each([
    ['idle between commits', false],
    ['still writing', true],
  ])('across a real startup backup and a real new partition (%s)', async (_label, keepWriting) => {
    // Real production functions only, in the order a boot runs them:
    // liveRoot built its execution partition through
    // ExecutionStoreCatalog.open (which is what calls the factory's durability
    // step), and runDailyBackup is exactly what the `popclaw-daily-backup`
    // service awaits once at start (src/index.ts).
    const { paths, social, partition } = liveRoot('live-locks-visibility-');
    const database = paths.socialDb();
    await runDailyBackup({
      paths, actorId: ACTOR, installationId: null, codeVersion: 'test',
      date: '2026-09-21', keep: 7,
    });
    const walBefore = statSync(`${database}-wal`).ino;
    // The variable itself, measured unconditionally: after the real production
    // calls this process still holds its lock on every database under the root.
    // This assertion depends on no closer, so this test can never be a green
    // that only means "nothing happened to trigger the damage today".
    for (const path of [database, partition, paths.lorehouseDb('locks.example')])
      expect(locksHeldOn(path), path).not.toHaveLength(0);

    let round = 0;
    for (const marker of ['mcp-first', 'mcp-second']) {
      round += 1;
      if (keepWriting) social.execute('INSERT INTO history VALUES(?)', [`resident-${round}`]);
      const seenByOutside = outsideProcess(database, marker);
      // The short-lived process saw everything the resident had committed…
      expect(seenByOutside, `${marker} could not see the resident's commits`)
        .toEqual(residentSees(social).filter(v => v !== marker).slice(0, seenByOutside.length));
      expect(seenByOutside).toContain('live');
      if (keepWriting) expect(seenByOutside).toContain(`resident-${round}`);
      // …and the resident sees what it committed, exactly once.
      const seenByResident = residentSees(social);
      expect(seenByResident.filter(v => v === marker), 'lost or duplicated').toHaveLength(1);
    }
    // Repeated short processes leave one consistent database behind.
    expect(residentSees(social)).toEqual(expect.arrayContaining(['mcp-first', 'mcp-second']));
    expect(existsSync(`${database}-wal`)).toBe(true);
    expect(statSync(`${database}-wal`).ino).toBe(walBefore);
    expect(social.verifySidecarVisibility(), 'nothing to report on a healthy database').toBeUndefined();
  });
});

/**
 * The legs that need an outside closer whose SQLite still reaches the delete
 * branch. They are their OWN tests, gated with `runIf`, so that on a machine
 * with nothing old enough they are reported as SKIPPED. Folded into the test
 * above behind an `if`, they would have been silently absent and the whole test
 * would have passed at base — a false green, and the reason this is shaped this
 * way.
 */
describe.runIf(LINUX && !!UNLINKING_CLOSER)('and go on seeing each other after a closer that reaches SQLite\'s delete branch', () => {
  it('the resident stays readable by anyone, across a real startup backup', async () => {
    const { paths, social } = liveRoot('live-locks-delete-branch-');
    const database = paths.socialDb();
    await runDailyBackup({
      paths, actorId: ACTOR, installationId: null, codeVersion: 'test',
      date: '2026-09-21', keep: 7,
    });
    const walBefore = statSync(`${database}-wal`).ino;
    unlinkingCloser(database);
    social.execute("INSERT INTO history VALUES('resident-final')");
    expect(outsideProcess(database, 'mcp-final'), 'the resident\'s last commit must be readable by anyone')
      .toContain('resident-final');
    expect(residentSees(social)).toContain('mcp-final');
    expect(statSync(`${database}-wal`).ino).toBe(walBefore);
  });

  it('CONTROL: one plain-fs open of the live file and they stop seeing each other', () => {
    // The counterfactual. Everything is the same except the single pair of
    // calls this change removed from the product.
    const { paths, social } = liveRoot('live-locks-visibility-control-');
    const database = paths.socialDb();
    const fd = openSync(database, 'r');
    closeSync(fd);
    unlinkingCloser(database);
    expect(existsSync(`${database}-wal`), 'the defect, reproduced').toBe(false);

    // The resident is still running and still committing. Nobody else will
    // ever read a word of it.
    social.execute("INSERT INTO history VALUES('into the void')");
    expect(residentSees(social), 'the resident believes its own write').toContain('into the void');
    expect(outsideProcess(database, 'mcp-after-the-split'), 'this is the data loss')
      .not.toContain('into the void');

    resetDatabaseVisibilityFaults();
    expect(social.verifySidecarVisibility()?.path).toBe(database);
    resetDatabaseVisibilityFaults();
  });
});

describe.runIf(LINUX)('the loud line when a write-ahead log is unlinked underneath a connection', () => {
  it('fires exactly once per database and names the consequence', () => {
    const paths = root('wal-fault-');
    const db = new LocalHostDb(paths.socialDb());
    cleanup.push(() => db.close());
    db.execute('CREATE TABLE t(a)');
    resetDatabaseVisibilityFaults();
    const announced: string[] = [];
    setDatabaseVisibilityFaultHandler(fault => announced.push(fault.path));
    cleanup.push(() => { setDatabaseVisibilityFaultHandler(undefined); resetDatabaseVisibilityFaults(); });

    expect(db.verifySidecarVisibility(), 'a healthy database says nothing').toBeUndefined();
    // Simulate what the outside checkpoint does: the sidecars leave the path
    // while this connection still has them open.
    unlinkSync(`${paths.socialDb()}-wal`);
    unlinkSync(`${paths.socialDb()}-shm`);

    const fault = db.verifySidecarVisibility();
    expect(fault?.path).toBe(paths.socialDb());
    expect(fault?.message).toMatch(/no other process on this data root can see them/);
    // What it must tell the owner, and what it must never tell them. Nothing
    // here stops writes and no recovery step is known, so the line says to
    // pause, preserve the files and ask — and it must not send anyone to a
    // restart, which would end the only process still holding those writes.
    expect(fault?.message).toMatch(/This line only reports it/);
    expect(fault?.message).toMatch(/leave every file in this data root exactly as it is/);
    expect(fault?.message).toMatch(/contact the maintainers/);
    expect(fault?.message, 'must never promise a restart recovers data').not.toMatch(/restart popclaw to recover/i);
    // Repeating the check must not repeat the alarm — this runs on a periodic
    // tick, and an owner who is told the same thing every six hours stops
    // reading it.
    verifyOpenDatabaseVisibility();
    db.verifySidecarVisibility();
    expect(announced).toEqual([paths.socialDb()]);
    expect(listDatabaseVisibilityFaults()).toHaveLength(1);
  });
});

describe('an unreferenced handle must not be collected out from under a live database', () => {
  it('keeps the sidecars a raw better-sqlite3 handle loses to the garbage collector', () => {
    const directory = mkdtempSync(join(tmpdir(), 'gc-sidecar-'));
    cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
    const output = execFileSync(process.execPath,
      ['--expose-gc', '--import', 'tsx', join('tests', 'helpers', 'gc-sidecar-probe.ts'), directory],
      { cwd: PLUGIN_ROOT, encoding: 'utf-8', timeout: 60_000 });
    const result = JSON.parse(output.trim().split('\n').pop()!) as { raw: boolean; wrapped: boolean };
    // The control has to fire, or this test proves nothing about the wrapper.
    expect(result.raw, 'an unreferenced raw handle should have been finalized and unlinked its log').toBe(false);
    expect(result.wrapped, 'LocalHostDb keeps open connections referenced, so the collector cannot close them').toBe(true);
  });
});

describe('the backup path never reads a live database with plain fs', () => {
  it('refuses to hash a database this process has open, and hashes the snapshot instead', async () => {
    const paths = root('backup-hash-');
    const social = new LocalHostDb(paths.socialDb());
    cleanup.push(() => social.close());
    social.execute('CREATE TABLE history(value TEXT)');
    social.execute("INSERT INTO history VALUES('live')");
    mkdirSync(paths.identityDir(), { recursive: true });
    writeFileSync(join(paths.identityDir(), 'master.key'), 'synthetic-not-a-real-key');

    // The guard, stated directly: the live file cannot be hashed at all.
    expect(() => fileSha256(paths.socialDb())).toThrow('LIVE_DATABASE_FILE_DESCRIPTOR');

    const { directory, manifest } = await createStorageBackup({
      paths, actorId: 'synthetic', installationId: null, codeVersion: 'test',
    });
    const entry = manifest.files.find(f => f.path === 'vault/social/my-social-assets.db')!;
    const snapshotPath = join(directory, 'files', entry.path);
    // The manifest hash is the SNAPSHOT's, byte for byte — which is also what
    // verifyStorageBackup re-computes, so a backup made this way still verifies.
    expect(entry.sha256).toBe(fileSha256(snapshotPath));
    expect(entry.sha256).not.toBe('');
    expect(() => verifyStorageBackup(directory)).not.toThrow();
    // And it is a real database with the live content, not an empty file.
    const snapshot = new LocalHostDb(snapshotPath, { readOnly: true });
    cleanup.push(() => snapshot.close());
    expect(snapshot.queryOne<{ integrity_check: string }>('PRAGMA integrity_check')?.integrity_check).toBe('ok');
    expect(tableFingerprint(snapshot, 'history')).toBe(tableFingerprint(social, 'history'));
    // A non-database member is still copied byte for byte.
    expect(readFileSync(join(directory, 'files/vault/social/identity/master.key'), 'utf8')).toBe('synthetic-not-a-real-key');
  });

  it('refuses an unknown file that turns out to hold a database, rather than copying it', async () => {
    // The check on the layout decision. A database somewhere the layout never
    // puts one is not downgraded to a byte copy behind SQLite's back — it stops
    // the set and names the member.
    const paths = root('backup-unclassified-');
    const social = new LocalHostDb(paths.socialDb());
    cleanup.push(() => social.close());
    social.execute('CREATE TABLE history(value TEXT)');
    const stray = join(paths.data(), 'stray-cache.bin');
    mkdirSync(paths.data(), { recursive: true });
    const strayDb = new LocalHostDb(stray);
    strayDb.execute('CREATE TABLE t(a)');
    strayDb.close(); // closed: it is an unclassified file on disk, not a live one
    expect(paths.isDatabaseFile(stray)).toBe(false);

    await expect(createStorageBackup({
      paths, actorId: 'synthetic', installationId: null, codeVersion: 'test',
    })).rejects.toThrow('BACKUP_UNCLASSIFIED_DATABASE: data/stray-cache.bin');
  });

  it('skips this module\'s own restore temporary by name, and captures the finished file', async () => {
    // A restore interrupted between the copy and the rename leaves
    // `<file>.<epoch>.restore-tmp` behind. For a database member that is a
    // partial SQLite image under a name the layout does not know — the one
    // shape of the refusal above that this code can produce itself — so it is
    // skipped by name next to the -wal/-shm/-journal skip. This is NOT a claim
    // that a backup ever meets one: an unfinished restore leaves the root in
    // maintenance and assertStorageBootstrap refuses to boot there.
    const paths = root('backup-restore-tmp-');
    const social = new LocalHostDb(paths.socialDb());
    cleanup.push(() => social.close());
    social.execute('CREATE TABLE history(value TEXT)');
    social.execute("INSERT INTO history VALUES('live')");
    const epoch = 'a'.repeat(32);
    copyFileSync(paths.socialDb(), `${paths.socialDb()}.${epoch}.restore-tmp`);

    const { directory, manifest } = await createStorageBackup({
      paths, actorId: 'synthetic', installationId: null, codeVersion: 'test',
    });
    expect(manifest.files.map(f => f.path)).not.toContain(`vault/social/my-social-assets.db.${epoch}.restore-tmp`);
    expect(existsSync(join(directory, `files/vault/social/my-social-assets.db.${epoch}.restore-tmp`))).toBe(false);
    // The databases that matter are still there, and the set still verifies.
    expect(manifest.files.map(f => f.path)).toContain('vault/social/my-social-assets.db');
    expect(() => verifyStorageBackup(directory)).not.toThrow();
  });

  it('refuses a member the layout calls a database that will not open as one', async () => {
    const paths = root('backup-unreadable-');
    const social = new LocalHostDb(paths.socialDb());
    cleanup.push(() => social.close());
    social.execute('CREATE TABLE history(value TEXT)');
    // A house-cache slot holding something that is not a database at all.
    mkdirSync(paths.lorehousesDir(), { recursive: true });
    writeFileSync(paths.lorehouseDb('impostor.example'), 'not a database');
    expect(paths.isDatabaseFile(paths.lorehouseDb('impostor.example'))).toBe(true);

    await expect(createStorageBackup({
      paths, actorId: 'synthetic', installationId: null, codeVersion: 'test',
    })).rejects.toThrow('BACKUP_DATABASE_UNREADABLE: data/lorehouses/impostor.example.db');
  });
});
