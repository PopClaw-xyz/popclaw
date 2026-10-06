// `better-sqlite3` is a native module (.node binding). We bundle the plugin
// as ESM, but `import Database from 'better-sqlite3'` bypasses Node's
// `Module._resolveFilename` hook (ESM static imports use a different
// resolver). The bundle banner patches the CJS resolver to map this
// module name to `dist/native-deps/better-sqlite3/`, so we go through
// `createRequire(import.meta.url)` to keep that hook in scope.
import { createRequire } from 'node:module';
import { mkdirSync, existsSync, copyFileSync, openSync, fsyncSync, closeSync, fstatSync, statSync, unlinkSync, readdirSync, readlinkSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, basename, resolve as resolvePath } from 'node:path';
import type { Database as DatabaseType, Options as DatabaseOptions, Statement } from 'better-sqlite3';
import type { HostDb, Params } from './host-db.js';
import { ensureSentinelTable } from './sentinels.js';

const __cjsRequire = createRequire(import.meta.url);
const Database = __cjsRequire('better-sqlite3') as new (
  filename: string,
  options?: DatabaseOptions,
) => DatabaseType;

/** Root of the vendored better-sqlite3 package, or undefined if unresolvable. */
function nativePkgRoot(): string | undefined {
  try {
    const pkgMain = __cjsRequire.resolve('better-sqlite3'); // <root>/lib/index.js
    return dirname(dirname(pkgMain));
  } catch {
    return undefined;
  }
}

// Native binary selection (paired with scripts/prepare-native-deps.mjs).
// prepare-native-deps ships, per Node major:
//   - `better_sqlite3-<platform>-<arch>-node<major>.node` — the matrix build
//     (dev-host darwin builds + DOWNLOADED official Linux prebuilts). This is
//     why a clean linux/arm64 install loads instantly with NO host node-gyp.
//   - `better_sqlite3-node<major>.node` — legacy ABI-only name (back-compat +
//     where a host auto-rebuild caches its result).
// Prefer the platform+arch-specific name, then the legacy name. Returns
// undefined when neither exists (e.g. tests run from node_modules) → better-
// sqlite3's default loader (unsuffixed better_sqlite3.node) takes over.
function resolveNativeBinding(): string | undefined {
  const pkgRoot = nativePkgRoot();
  if (!pkgRoot) return undefined;
  const major = process.versions.node.split('.')[0];
  const rel = join(pkgRoot, 'build', 'Release');
  for (const name of [
    `better_sqlite3-${process.platform}-${process.arch}-node${major}.node`,
    `better_sqlite3-node${major}.node`,
  ]) {
    const candidate = join(rel, name);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

const NATIVE_BINDING = resolveNativeBinding();

/**
 * A bundled .node that doesn't match THIS host's platform / arch / Node-ABI
 * fails to load with one of these signatures — meaning "rebuild from source".
 * The bundle's prebuilts are produced ON the dev machine (darwin-arm64), so a
 * linux-arm64 host hits `invalid ELF header`; a Node major we didn't prebuild
 * hits `NODE_MODULE_VERSION`. Distinct from ordinary SQLite open errors (bad
 * path, locked/corrupt db), which must NOT trigger a useless, slow rebuild.
 * See bug report "host-c dispatch chain ①".
 */
export function isNativeLoadError(err: Error): boolean {
  return /invalid ELF header|NODE_MODULE_VERSION|wrong ELF class|incompatible architecture|wrong architecture|not a valid Win32 application|Module did not self-register|undefined symbol|cannot open shared object/i.test(
    err.message,
  );
}

/**
 * Compile better-sqlite3 from its vendored sources against the host's own Node,
 * cache the result under the per-major name (so the NEXT boot loads it directly),
 * and return its path. Throws a clear, actionable error if the sources or a C
 * toolchain are missing.
 *
 * ponytail: synchronous compile — blocks gateway boot ~30-60s ONE time after a
 * cross-platform / cross-ABI install; every later boot loads the cached binary
 * instantly. Upgrade path (zero host compile): ship prebuilts for the full
 * {os}×{arch}×{abi} matrix at pack time in prepare-native-deps.mjs.
 */
function rebuildNativeBinding(cause: Error): string {
  const pkgRoot = nativePkgRoot();
  if (!pkgRoot || !existsSync(join(pkgRoot, 'binding.gyp'))) throw cause;
  console.error(
    `popclaw: bundled better-sqlite3 won't load on ${process.platform}/${process.arch} ` +
      `(Node ${process.version}) — rebuilding from source once (~60s; needs gcc/clang + make + python3)…`,
  );
  try {
    execFileSync('npx', ['--yes', 'node-gyp', 'rebuild', '--release'], {
      cwd: pkgRoot,
      stdio: 'inherit',
    });
  } catch (buildErr) {
    throw new Error(
      `popclaw: better-sqlite3 has no prebuilt for this host (${process.platform}/${process.arch}, ` +
        `Node ${process.version}) and the auto-rebuild failed. Install a C toolchain ` +
        `(gcc/clang, make, python3) and rebuild manually:\n  ` +
        `cd ~/.openclaw/extensions/popclaw/dist/native-deps/better-sqlite3 && npx --yes node-gyp rebuild --release\n  ` +
        `(load error: ${cause.message}; rebuild error: ${buildErr instanceof Error ? buildErr.message : String(buildErr)})`,
    );
  }
  const built = join(pkgRoot, 'build', 'Release', 'better_sqlite3.node');
  if (!existsSync(built)) throw cause;
  const major = process.versions.node.split('.')[0];
  // Cache under the platform+arch name resolveNativeBinding() prefers, so the
  // next boot picks the freshly-built binary directly and skips the rebuild.
  const cached = join(
    pkgRoot,
    'build',
    'Release',
    `better_sqlite3-${process.platform}-${process.arch}-node${major}.node`,
  );
  try {
    copyFileSync(built, cached);
  } catch {
    /* best-effort cache; the freshly-built path still works this boot */
  }
  return existsSync(cached) ? cached : built;
}

/**
 * Human label of the better-sqlite3 native binary selected for THIS runtime
 * (multi-ABI, see prepare-native-deps.mjs). Used by `/popclaw version` to
 * confirm which prebuilt actually loaded — handy when validating that a host's
 * Node picks the matching ABI with no rebuild.
 */
export function sqliteNativeBindingLabel(): string {
  return NATIVE_BINDING
    ? basename(NATIVE_BINDING)
    : 'default better_sqlite3.node (bindings fallback)';
}

function openSqlite(filePath: string): DatabaseType {
  try {
    return new Database(filePath, NATIVE_BINDING ? { nativeBinding: NATIVE_BINDING } : undefined);
  } catch (err) {
    // The bundled prebuilt doesn't match this host (wrong OS/arch → "invalid ELF
    // header", or wrong Node ABI → "NODE_MODULE_VERSION"). Rebuild from source
    // once, cache it, and retry in-process. Even if this retry somehow fails,
    // the cached binary makes the NEXT gateway boot succeed with no manual step.
    if (err instanceof Error && isNativeLoadError(err)) {
      const rebuilt = rebuildNativeBinding(err);
      return new Database(filePath, { nativeBinding: rebuilt });
    }
    throw err;
  }
}

/**
 * THE INVARIANT: while this process holds a live SQLite connection to a
 * database, nothing in this process may open, close or replace that database
 * file or its sidecars outside SQLite's own coordination.
 *
 * Stated that narrowly on purpose. Ordinary multi-connection SQLite is fine and
 * is the product's shape; `stat`/`fstat` metadata is fine; an independent
 * snapshot whose connection has already been closed is fine. What is not fine
 * is a plain-`fs` descriptor on the live file.
 *
 * POSIX record locks are per PROCESS and per FILE: closing ANY descriptor on a
 * file drops ALL of that process's locks on it (SQLite documents this as the
 * "posix close" corruption case). SQLite shields the descriptors it opens
 * itself; it cannot shield one opened outside it. So a single
 * `openSync`/`closeSync`, `readFileSync`, read stream or hash over a LIVE
 * database file, performed by the process that also holds the connection,
 * silently drops that connection's SHARED lock on the main database — the lock
 * that exists precisely to stop another connection taking EXCLUSIVE and
 * cleaning up the WAL. The next connection in ANOTHER process that closes then
 * does take EXCLUSIVE, concludes it is the last connection, checkpoints and
 * unlinks `-wal`/`-shm`, while the resident process keeps writing into a now
 * nameless inode: invisible to every other reader on the same data root,
 * discarded on kill -9 or power loss, and self-perpetuating, because every
 * newcomer repeats the reasoning.
 *
 * WHAT WAS MEASURED, and nothing beyond it. On Linux the lock drop itself is
 * unconditional: one plain-`fs` open+close took this process's lock count on
 * the social, execution-partition and house-cache databases from 1 to 0, every
 * time. Whether a LATER closer then goes on to unlink the sidecars depended on
 * the SQLite that closer links: it happened with closers linking 3.40.1 and
 * 3.45.1 (a distribution's `sqlite3` CLI) and 3.49.2 (better-sqlite3 11.10.0),
 * and it did NOT happen with the artefact this repo ships (better-sqlite3
 * 12.11.1 / SQLite 3.53.2, both the prebuilt binding and the bundled
 * `mcp.js`). That is a list of observations, not a rule: no version is claimed
 * immune, no threshold is claimed, and two builds reporting identical
 * `pragma compile_options` are not thereby the same binary. macOS runs did not
 * reproduce the sequence, and no mechanism is claimed for why — Apple's SQLite
 * does not take these locks, so a macOS run cannot tell a fixed build from a
 * broken one, which is why this survived development.
 *
 * `assertNoLiveDatabaseDescriptor` is how a caller states, and has checked,
 * that the file it is about to touch with `fs` is not one of ours. The
 * scoped static scan in tests/unit/host/database-descriptor-discipline.test.ts
 * guards against regressions in these modules; it is a regression fence, not a
 * proof — it cannot see through an alias, a wrapper or a host path, and the
 * real evidence is the multi-process test in live-database-locks.test.ts.
 */

/** Open databases in THIS process, by resolved path. */
const openDatabases = new Map<string, Set<LocalHostDb>>();

/**
 * Resolved identity of a database path. `realpathSync` where the file exists so
 * that two spellings of one file agree; the plain resolution otherwise, which
 * is enough because registration only ever happens on a file that opened.
 */
function databaseKey(filePath: string): string {
  try { return realpathSync(filePath); } catch { return resolvePath(filePath); }
}

/** Does this process currently hold a SQLite connection on `filePath`? */
export function hasOpenDatabaseConnection(filePath: string): boolean {
  return (openDatabases.get(databaseKey(filePath))?.size ?? 0) > 0;
}

/**
 * Refuse a plain-`fs` operation on a database this process has open. The whole
 * defect class is "somebody read/hashed/copied a live database with `fs`", and
 * the only thing that reliably distinguishes live from quiesced at runtime is
 * whether we ourselves have it open — so that is what this asks.
 */
export function assertNoLiveDatabaseDescriptor(filePath: string, operation: string): void {
  if (!hasOpenDatabaseConnection(filePath)) return;
  throw new Error(
    `LIVE_DATABASE_FILE_DESCRIPTOR: refusing to ${operation} ${filePath} with plain fs while this ` +
    `process holds a SQLite connection on it — an fs descriptor on a live database drops this ` +
    `process's POSIX locks and gets its write-ahead log unlinked underneath it`,
  );
}

/**
 * DETECTION ONLY. This reports a storage-identity split; it does not stop
 * anything. The fault-stop that a confirmed split calls for — refusing new
 * business writes, consumption acknowledgements and cursor advances, and the
 * outbound sends that depend on them for that data root, with an explicit
 * storage-fault error in the host log and in the tool result — is NOT
 * implemented here and must not be assumed from the presence of this type. It
 * reaches surfaces this module does not own, and half of it would be worse
 * than none: blocking `execute` alone would not be "writes stopped", because
 * `queryOne` runs side-effecting PRAGMAs too.
 *
 * What is here is the substrate that stop would attach to: a per-database fault
 * record, one loud line, and a single hook point.
 */
export interface DatabaseVisibilityFault {
  readonly path: string;
  readonly detail: string;
  readonly message: string;
}

const visibilityFaults = new Map<string, DatabaseVisibilityFault>();
let visibilityFaultHandler: ((fault: DatabaseVisibilityFault) => void) | undefined;

/** Every fault seen this process, for status surfaces and tests. */
export function listDatabaseVisibilityFaults(): readonly DatabaseVisibilityFault[] {
  return [...visibilityFaults.values()];
}

/**
 * THE one place the fault-stop attaches. Today the answer to a split database
 * is "say so once, loudly, and keep going". Nothing here closes, reopens,
 * checkpoints, restarts or deletes a sidecar, and nothing here decides that a
 * data root has stopped accepting work — those are the policy this hook is
 * waiting for, and a detector that quietly invented one would turn a
 * visibility fault into an outage.
 */
export function setDatabaseVisibilityFaultHandler(handler: ((fault: DatabaseVisibilityFault) => void) | undefined): void {
  visibilityFaultHandler = handler;
}

/** For tests: forget what has already been announced. */
export function resetDatabaseVisibilityFaults(): void {
  visibilityFaults.clear();
}

function reportVisibilityFault(path: string, detail: string): DatabaseVisibilityFault {
  const existing = visibilityFaults.get(databaseKey(path));
  if (existing) return existing;
  // What this says is limited to what is known. It is a REPORT: nothing here
  // stops the process writing, and no sequence of steps is known to bring the
  // unreferenced writes back, so it must not send an owner to a restart that
  // would end this process and take them with it.
  const fault: DatabaseVisibilityFault = { path, detail, message:
    `popclaw: DATABASE NOT VISIBLE TO OTHER PROCESSES — ${path}: ${detail}. Writes from this ` +
    `process are going to an unlinked write-ahead log: no other process on this data root can ` +
    `see them and they are lost if this one is killed. This line only reports it — popclaw is ` +
    `still accepting work on this data root. Pause what you are doing with popclaw here, leave ` +
    `every file in this data root exactly as it is (do not restart, copy, delete or try to ` +
    `repair anything — no recovery step is known), and contact the maintainers with this line.` };
  visibilityFaults.set(databaseKey(path), fault);
  // The host's warn/error go to a stderr nobody reads; this one must leave a
  // trace even with no host attached, and it is emitted at most once per
  // database per process, so it can afford to be loud.
  console.error(fault.message);
  visibilityFaultHandler?.(fault);
  return fault;
}

/**
 * Inode of the `-wal` this connection actually has open, read from
 * `/proc/self/fd` — the only portable-enough way to ask "which file is my
 * descriptor on" without opening anything. Linux only; `undefined` everywhere
 * else and whenever no WAL descriptor is open (a connection that has not
 * written yet has none).
 */
function openWalInode(walPath: string): number | undefined {
  let entries: string[];
  try { entries = readdirSync('/proc/self/fd'); } catch { return undefined; }
  for (const entry of entries) {
    let target: string;
    try { target = readlinkSync(`/proc/self/fd/${entry}`); } catch { continue; }
    // A deleted file's magic link keeps the old name with a marker appended.
    if (target !== walPath && target !== `${walPath} (deleted)`) continue;
    try { return statSync(`/proc/self/fd/${entry}`).ino; } catch { continue; }
  }
  return undefined;
}

/**
 * Check every database this process has open. Called at open and from the
 * existing six-hourly storage tick — deliberately NOT from a timer of its own.
 *
 * A periodic check has a window and is therefore not prevention. What prevents
 * this defect is the discipline above, which removes the trigger; this only
 * makes a split that happened anyway (an older build, or a reader outside this
 * process) say so instead of staying silent.
 */
export function verifyOpenDatabaseVisibility(): readonly DatabaseVisibilityFault[] {
  const found: DatabaseVisibilityFault[] = [];
  for (const handles of openDatabases.values())
    for (const handle of handles) {
      const fault = handle.verifySidecarVisibility();
      if (fault) found.push(fault);
    }
  return found;
}

/**
 * Upper bound on compiled statements kept per connection. An idle root runs at
 * most ~21 distinct SQL strings per minute across all its connections
 * (docs/perf/idle-cpu-baseline-2026-09-27.md); 64 leaves room for command
 * execution and the busy-origin `NOT IN (?,…)` variants, while any generated
 * SQL beyond that only evicts the least recently used entry. It bounds the
 * cached entries; an evicted statement stays alive natively until GC collects it.
 */
export const STATEMENT_CACHE_CAPACITY = 64;

/**
 * File-backed SQLite via better-sqlite3.
 *
 * Constructor creates parent directories if missing. Caller resolves
 * the path (typically <stateDir>/my-social-assets.db via plugin-sdk/state-paths).
 *
 * **Multi-process is fine on local disk** — WAL + busy_timeout is the standard
 * configuration for exactly that, and it is the real deployment shape: one owner
 * can have the OpenClaw plugin resident while `popclaw-mcp` runs under Claude
 * Code / Codex, all pointed at one POPCLAW_DATA_ROOT (that shared root IS the
 * "one passport, every host" promise). WAL serialises writers; busy_timeout makes
 * the loser wait instead of throwing SQLITE_BUSY mid-tool-call. No external lock.
 * (Network filesystems are the exception — SQLite's own advice, not ours.)
 */
/** A local scheduling hint; generic HostDb implementations need no disk path. */
export function localDatabasePath(db: HostDb): string | undefined {
  return db instanceof LocalHostDb ? db.databasePath : undefined;
}

export class LocalHostDb implements HostDb {
  private readonly handle: DatabaseType;
  private closed = false;
  /**
   * Compiled statements for THIS connection, least recently used first. It
   * caches the compilation only: every call binds its own parameters and runs
   * the statement again, so no result, row or authority decision is ever
   * reused. A schema change behind a cached statement is handled by SQLite
   * itself (SQLITE_SCHEMA triggers a transparent re-prepare); the tests pin it.
   */
  private readonly statements = new Map<string, Statement>();
  private statementHits = 0;
  private statementMisses = 0;
  private readonly filePath: string;
  get databasePath(): string | undefined {
    return this.filePath === ':memory:' ? undefined : databaseKey(this.filePath);
  }
  private registeredAs: string | undefined;

  /**
   * Join the process-wide registry of open databases. Two jobs, both of them
   * load-bearing:
   *
   *  1. It answers `hasOpenDatabaseConnection`, which is how the plain-fs
   *     guards above tell a live database from a quiesced one.
   *  2. It holds a STRONG reference for as long as the connection is open. An
   *     unreferenced better-sqlite3 handle is finalized by V8's GC, and the
   *     finalizer closes the connection — which, if it was the last one,
   *     checkpoints and unlinks `-wal`/`-shm` with no second process involved
   *     at all, in a process that is still running (measured). Leaking a
   *     descriptor when a caller forgets `close()` is strictly better than
   *     silently losing a database's sidecars, so the registry never uses a
   *     weak reference.
   */
  private register(): void {
    if (this.filePath === ':memory:') return;
    const key = databaseKey(this.filePath);
    this.registeredAs = key;
    let handles = openDatabases.get(key);
    if (!handles) { handles = new Set(); openDatabases.set(key, handles); }
    handles.add(this);
  }

  private unregister(): void {
    if (!this.registeredAs) return;
    const handles = openDatabases.get(this.registeredAs);
    handles?.delete(this);
    if (handles && handles.size === 0) openDatabases.delete(this.registeredAs);
    this.registeredAs = undefined;
  }

  /**
   * Is the `-wal` THIS still-living connection has open still the `-wal` at its
   * path? The question is deliberately asked of a specific open descriptor and
   * a specific lifetime, not of the path: a missing `-wal` on its own means
   * nothing at all. The last connection closing normally removes it; a database
   * whose WAL has not been initialised never had one; a legal close-and-reopen
   * makes a new one. So the fault is only ever "we hold a WAL descriptor AND
   * what is at the path is a different inode (or nothing)" — which no lawful
   * sequence produces, because our open descriptor is what makes us not the
   * last connection.
   *
   * It costs no descriptor on the database: `/proc/self/fd` answers which file
   * our existing descriptor is on, and `stat` is metadata. Opening the database
   * to check on the database would be the very mistake this class is about.
   * Linux only (it needs `/proc/self/fd`); elsewhere it reports nothing rather
   * than guessing, and says so at the call sites.
   */
  verifySidecarVisibility(): DatabaseVisibilityFault | undefined {
    if (this.closed || this.filePath === ':memory:') return undefined;
    const walPath = `${this.filePath}-wal`;
    const open = openWalInode(walPath);
    if (open === undefined) return undefined; // no WAL descriptor, or not Linux
    let current: number | undefined;
    try { current = statSync(walPath).ino; } catch { current = undefined; }
    if (current === open) return undefined;
    return reportVisibilityFault(this.filePath, current === undefined
      ? `its write-ahead log was unlinked while this connection still has inode ${open} open`
      : `this connection writes to write-ahead log inode ${open} but inode ${current} is the one at ${walPath}`);
  }

  constructor(filePath: string, options: { readOnly?: boolean; beforeInitialize?: (db: HostDb) => (() => void) } = {}) {
    this.filePath = filePath;
    if (options.readOnly) {
      // Lifecycle hooks must not create roots, run migrations, or rebuild native dependencies.
      this.handle = new Database(filePath, { readonly: true, fileMustExist: true, nativeBinding: NATIVE_BINDING });
      this.handle.pragma('busy_timeout = 1000');
      this.register();
      return;
    }
    const dir = dirname(filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    // A rejected admission must not strand a newly created empty G file in an
    // interrupted restore destination. Only remove a placeholder we exclusively
    // created, still on the same inode and still containing no database bytes.
    let createdEmpty: {dev: number; ino: number} | undefined;
    if (options.beforeInitialize && filePath !== ':memory:') {
      try {
        const fd = openSync(filePath, 'wx', 0o600);
        try {createdEmpty = fstatSync(fd);} finally {closeSync(fd);}
      } catch (error) {if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;}
    }
    const removeOwnedEmpty = () => {
      if (!createdEmpty || !existsSync(filePath)) return;
      const current = statSync(filePath);
      if (current.dev === createdEmpty.dev && current.ino === createdEmpty.ino && current.size === 0) unlinkSync(filePath);
    };
    try {this.handle = openSqlite(filePath);}
    catch (error) {removeOwnedEmpty(); throw error;}
    this.handle.pragma('busy_timeout = 5000');
    let rollbackRegistration: (() => void) | undefined;
    try {
    rollbackRegistration = options.beforeInitialize?.(this);
    this.handle.pragma('journal_mode = WAL');
    this.handle.pragma('foreign_keys = ON');
    // Wait for a busy writer instead of throwing. Social-event write volume is a
    // handful of small transactions per second, so the queue is imperceptible; if
    // 5s ever elapses the throw still happens and the signal is not lost.
    this.handle.pragma('busy_timeout = 5000');
    // The talking wall (see sentinels.ts). This constructor is the single
    // open-database choke point for **every** on-disk core DB (social assets /
    // wallet / per-house caches all pass through here), so the warning is
    // installed exactly once, here. `:memory:` skips it: nobody points the
    // sqlite3 CLI at an in-process database.
    if (filePath !== ':memory:') ensureSentinelTable(this);
    this.register();
    // At open, before anyone trusts this handle: a data root that was already
    // poisoned by an earlier boot says so on the spot instead of at the next
    // storage tick.
    this.verifySidecarVisibility();
    } catch (error) {
      this.unregister();
      try { rollbackRegistration?.(); } finally { this.handle.close(); this.closed = true; }
      if (!rollbackRegistration) removeOwnedEmpty();
      throw error;
    }
  }

  /** Hit/miss counters and current size of this connection's statement cache. */
  statementCacheStats(): { hits: number; misses: number; size: number; capacity: number } {
    return { hits: this.statementHits, misses: this.statementMisses, size: this.statements.size, capacity: STATEMENT_CACHE_CAPACITY };
  }

  private statement(sql: string): Statement {
    const cached = this.statements.get(sql);
    if (cached) {
      // Re-insert to mark it most recently used.
      this.statements.delete(sql);
      this.statements.set(sql, cached);
      this.statementHits++;
      return cached;
    }
    // A prepare that throws caches nothing.
    const stmt = this.handle.prepare(sql);
    this.statementMisses++;
    this.statements.set(sql, stmt);
    if (this.statements.size > STATEMENT_CACHE_CAPACITY) {
      this.statements.delete(this.statements.keys().next().value!);
    }
    return stmt;
  }

  queryOne<T = Record<string, unknown>>(sql: string, params: Params = []): T | null {
    const stmt = this.statement(sql);
    const row = stmt.get(...(params as unknown[]));
    return (row as T | undefined) ?? null;
  }

  queryAll<T = Record<string, unknown>>(sql: string, params: Params = []): T[] {
    const stmt = this.statement(sql);
    return stmt.all(...(params as unknown[])) as T[];
  }

  execute(sql: string, params: Params = []): { changes: number; lastInsertRowid: number | bigint } {
    const stmt = this.statement(sql);
    const info = stmt.run(...(params as unknown[]));
    return { changes: info.changes, lastInsertRowid: info.lastInsertRowid };
  }

  transaction<T>(fn: (tx: HostDb) => T): T {
    const txFn = this.handle.transaction((arg: HostDb) => fn(arg));
    return txFn.immediate(this);
  }

  /** SQLite online backup preserves rowids and includes committed WAL pages. */
  async snapshotTo(destination: string): Promise<void> {
    if (this.closed) throw new Error('DATABASE_CLOSED');
    if (existsSync(destination)) throw new Error('SNAPSHOT_TARGET_EXISTS');
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    await this.handle.backup(destination);
    // The backup API closed its own connection to the destination, so this is a
    // quiesced file and the fsync is safe — but it is one caller away from the
    // trap, so it says out loud which file it expects to be nobody's live
    // database. A destination we still have open is a bug, not a slow path.
    assertNoLiveDatabaseDescriptor(destination, 'fsync');
    const fd = openSync(destination, 'r');
    try { fsyncSync(fd); } finally {closeSync(fd);}
    const directory = openSync(dirname(destination), 'r');
    try {fsyncSync(directory);} finally {closeSync(directory);}
  }

  close(): void {
    if (this.closed) return;
    this.unregister();
    this.statements.clear();
    this.handle.close();
    this.closed = true;
  }
}
