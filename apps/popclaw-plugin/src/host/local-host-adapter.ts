/**
 * LocalHostAdapter — production-grade HostAdapter backed by node:fs.
 * Intended for local dev and bare-metal deployments. OpenClaw / Hermes
 * plugins would provide their own adapter classes.
 *
 * Layout rooted at `dataRoot` via PopclawPaths (config/data/vault):
 *   <dataRoot>/vault/social/identity/   <dataRoot>/vault/social/my-social-assets.db
 *   <dataRoot>/config/                   (unused storage namespaces map under data/)
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { promises as fsp, readFileSync, statSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  CancelHandle,
  HostAdapter,
  HostClock,
  HostConfig,
  HostLogger,
  HostStorage,
  HostTimer,
  Namespace,
  WriteOptions,
} from './host-adapter.js';
import type { HostDb } from './host-db.js';
import { LocalHostDb } from './local-host-db.js';
import { runMigrations } from './migrations.js';
import { PopclawPaths } from './popclaw-paths.js';

export interface LocalHostOptions {
  dataRoot: string;
  logger: HostLogger;
  /**
   * Optional override for the migrations directory. Defaults to the
   * `migrations/` folder shipped alongside this package (resolved relative
   * to the compiled module's location — works for both dev (`src/host/`)
   * and bundled (`dist/bundled/index.js`) layouts since the package.json
   * `files` array ships `migrations/` at the package root in both cases).
   */
  migrationsDir?: string;
  /** Register under the maintenance transaction before any initialization writes. */
  beforeDbInitialize?: (db: HostDb) => (() => void);
}

export class LocalHostAdapter implements HostAdapter {
  readonly storage: HostStorage;
  readonly config: HostConfig;
  readonly logger: HostLogger;
  readonly clock: HostClock = { now: () => new Date() };
  readonly timer: HostTimer;
  readonly db: HostDb;

  constructor(opts: LocalHostOptions) {
    this.logger = opts.logger;
    const paths = new PopclawPaths(opts.dataRoot);
    // Storage namespaces → buckets: 'identity' is the keypair (vault/social);
    // 'config' holds notify-target.json (OwnerNotifyTargetStore) and belongs in
    // the config bucket next to plugin.json — NOT under data/. Other namespaces
    // ('social'/'cache', currently unwritten) fall through to data/<ns>.
    this.storage = new LocalStorage(opts.logger, (ns) =>
      ns === 'identity' ? paths.identityDir()
      : ns === 'config' ? paths.config()
      : join(paths.data(), ns),
    );
    this.config = new LocalConfig(paths.config());
    this.timer = new NodeTimer();

    // ADR-0013 / O-3a: SQLite-backed persistent state. Migrations are
    // applied idempotently on every boot.
    const dbPath = paths.socialDb();
    let release: (() => void) | undefined;
    this.db = new LocalHostDb(dbPath, {beforeInitialize: opts.beforeDbInitialize
      ? db => (release = opts.beforeDbInitialize!(db)) : undefined});
    const migrationsDir = opts.migrationsDir ?? defaultMigrationsDir();
    try { runMigrations(this.db, migrationsDir); }
    catch (error) { try {release?.();} finally {this.db.close();} throw error; }
  }
}

/**
 * Resolve `<pluginRoot>/migrations` relative to this module's location.
 *
 * - Dev (tsx runs `src/main.ts`): this file = `src/host/local-host-adapter.ts`
 *   → `<plugin>/migrations`.
 * - Bundled (esbuild emits `dist/bundled/index.js`): this file = inlined
 *   into `dist/bundled/index.js` → `<plugin>/migrations` (one level up
 *   from `dist/bundled/`, then into `migrations/`).
 *
 * The package.json `files` array ships `migrations/` at the package root
 * so both layouts resolve to the same directory.
 */
function defaultMigrationsDir(): string {
  const here = fileURLToPath(import.meta.url);
  const dir = dirname(here);
  // Walk up to the package root and into `migrations`.
  // From src/host/local-host-adapter.ts → ../../migrations
  // From dist/bundled/index.js          → ../../migrations
  return resolve(dir, '..', '..', 'migrations');
}

class LocalStorage implements HostStorage {
  constructor(
    private readonly logger: HostLogger,
    private readonly nsDir: (ns: Namespace) => string,
  ) {}
  private p(ns: Namespace, key: string): string {
    return join(this.nsDir(ns), key);
  }
  async read(ns: Namespace, key: string): Promise<Uint8Array | null> {
    try {
      const buf = await fsp.readFile(this.p(ns, key));
      return new Uint8Array(buf);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }
  pathFor(ns: Namespace, key: string): string {
    return this.p(ns, key);
  }
  async write(ns: Namespace, key: string, bytes: Uint8Array, opts?: WriteOptions): Promise<void> {
    const path = this.p(ns, key);
    const mode = opts?.mode;
    // Any directory we have to CREATE for a secret starts at 0700. Existing ones
    // keep their mode — mkdir doesn't chmod, so `<root>/vault{,/social}` (already
    // made by LocalHostDb) stay at the default; only the leaf is ours.
    await fsp.mkdir(dirname(path), mode === undefined ? { recursive: true } : { recursive: true, mode: 0o700 });
    if (opts?.exclusive) {
      // Create-or-refuse, but with the bytes already in place.
      //
      // `wx` (O_CREAT|O_EXCL) also refuses to clobber, and it was not enough:
      // O_EXCL makes the NAME appear first and the content arrive in a separate
      // write, so for one syscall's width the file exists and is empty. The
      // keystore's whole EEXIST recovery -- "someone else minted first, adopt
      // their key" -- runs inside exactly that window, re-reads zero bytes and
      // dies on JSON.parse. Its one designed recovery path failed precisely in
      // the case it was written for (two hosts first-running one data root,
      // which this project supports on purpose). Worse, a process killed in
      // that same gap leaves a 0-byte master.key behind, and since the file
      // then "exists" nothing ever mints again: a permanent brick whose only
      // cure is deleting a file called master.key.
      //
      // link() is the same atomic create-or-EEXIST, taken on a name whose
      // content is already complete. A crash now strands a temp file nobody
      // reads instead of a poisoned real one. Same directory, because link
      // cannot cross filesystems.
      const tmp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
      try {
        await fsp.writeFile(tmp, bytes, mode === undefined ? {} : { mode });
        // chmod before it has its real name, not after: a secret must never be
        // reachable under the name others look for while still world-readable.
        if (mode !== undefined) await fsp.chmod(tmp, mode);
        try {
          await fsp.link(tmp, path); // EEXIST = someone else won; the caller decides
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'EEXIST') throw err;
          // Not every filesystem has hard links. exFAT has none at all, and
          // some SMB/FUSE mounts refuse them -- link() there fails with EPERM
          // or ENOTSUP before it ever gets to decide who won. A plugin that
          // ships to arbitrary machines cannot let that turn a first run into
          // a bare EPERM nobody can read.
          //
          // Fall back to the O_EXCL write this replaced. That reopens the
          // create/write gap on exactly those filesystems -- a rare race is
          // still better than an install that cannot start -- so it says so out
          // loud rather than degrading quietly.
          this.logger.warn(
            { path, code: (err as NodeJS.ErrnoException).code },
            'popclaw: this filesystem has no hard links, so a secret is being created the ' +
              'older two-step way. Two processes first-running the same data root at the same ' +
              'instant could see it half-written; a single host is unaffected.',
          );
          await fsp.writeFile(path, bytes, mode === undefined ? { flag: 'wx' as const } : { flag: 'wx' as const, mode });
          if (mode !== undefined) await fsp.chmod(path, mode);
        }
      } finally {
        await fsp.unlink(tmp).catch(() => {});
      }
      return;
    }
    await fsp.writeFile(path, bytes, mode === undefined ? {} : { mode });
    // writeFile's `mode` only applies when it creates the file, and umask can
    // shave bits off it — chmod unconditionally so a rewrite can't leave an
    // older, looser mode in place.
    if (mode !== undefined) await fsp.chmod(path, mode);
  }
  async tightenPermissions(ns: Namespace, key: string, mode: number): Promise<number | null> {
    const path = this.p(ns, key);
    const current = (await fsp.stat(path)).mode & 0o777;
    if ((current & ~mode) === 0) return null; // already at least this strict
    await fsp.chmod(path, mode);
    return current;
  }
  async delete(ns: Namespace, key: string): Promise<void> {
    try {
      await fsp.unlink(this.p(ns, key));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
  async list(ns: Namespace, prefix?: string): Promise<string[]> {
    const base = this.nsDir(ns);
    let names: string[] = [];
    try {
      names = await fsp.readdir(base);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    return names
      .filter((n) => prefix === undefined || n.startsWith(prefix))
      .sort();
  }
}

class LocalConfig implements HostConfig {
  constructor(private readonly configDir: string) {}

  private configPath(name: string): string {
    return join(this.configDir, `${name}.json`);
  }

  pathFor(name: string): string {
    return this.configPath(name);
  }

  versionOf(name: string): string | null {
    try {
      const st = statSync(this.configPath(name));
      return `${st.ino}:${st.mtimeMs}:${st.size}`;
    } catch {
      return null;
    }
  }

  loadJsonSync(name: string): unknown {
    try {
      return JSON.parse(readFileSync(this.configPath(name), 'utf-8'));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async loadJson(name: string): Promise<unknown> {
    const path = this.configPath(name);
    try {
      const text = await fsp.readFile(path, 'utf-8');
      return JSON.parse(text);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async saveJson(name: string, value: unknown): Promise<void> {
    const dest = this.configPath(name);
    await fsp.mkdir(dirname(dest), { recursive: true });
    const tmp = `${dest}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await fsp.writeFile(tmp, JSON.stringify(value, null, 2) + '\n', {encoding: 'utf-8', flag: 'wx'});
      await fsp.rename(tmp, dest);
    } finally {
      await fsp.rm(tmp, {force: true});
    }
  }
}

class NodeTimer implements HostTimer {
  schedule(delayMs: number, cb: () => void): CancelHandle {
    const h = setTimeout(cb, delayMs);
    return {
      cancel: () => clearTimeout(h),
    };
  }
}

/** Host-owned async context: keeps node APIs outside business modules. */
export function createHostAsyncScope<T>(): {
  getStore(): T | undefined;
  run<R>(store: T, work: () => R): R;
} {
  const storage = new AsyncLocalStorage<T>();
  return {
    getStore: () => storage.getStore(),
    run: (store, work) => storage.run(store, work),
  };
}
