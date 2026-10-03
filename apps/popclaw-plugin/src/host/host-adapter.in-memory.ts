import { dirname, resolve } from 'node:path';
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
import { InMemoryHostDb } from './in-memory-host-db.js';
import { runMigrations } from './migrations.js';

export class InMemoryHostAdapter implements HostAdapter {
  readonly storage: InMemoryStorage = new InMemoryStorage();
  readonly config: InMemoryConfig;
  readonly logger: InMemoryLogger = new InMemoryLogger();
  readonly clock: ControllableClock;
  readonly timer: ControllableTimer;
  readonly db: InMemoryHostDb;

  constructor(opts: InMemoryHostOptions = {}) {
    this.config = new InMemoryConfig(opts.config ?? {});
    this.clock = new ControllableClock(opts.now ?? new Date());
    this.timer = new ControllableTimer();

    // ADR-0013 / O-3a: tests exercise real SQL against an in-memory SQLite
    // handle plus the same migrations the production adapter runs.
    this.db = new InMemoryHostDb();
    const migrationsDir = opts.migrationsDir ?? defaultMigrationsDir();
    runMigrations(this.db, migrationsDir);
  }
}

export interface InMemoryHostOptions {
  config?: Record<string, unknown>;
  now?: Date;
  /**
   * Optional override for the migrations directory. Defaults to the
   * `migrations/` folder shipped alongside this package, resolved relative
   * to this module's location (works whether vitest runs from the package
   * dir or repo root).
   */
  migrationsDir?: string;
}

/** See `local-host-adapter.ts:defaultMigrationsDir` — same convention. */
function defaultMigrationsDir(): string {
  const here = fileURLToPath(import.meta.url);
  const dir = dirname(here);
  return resolve(dir, '..', '..', 'migrations');
}

export class InMemoryStorage implements HostStorage {
  private readonly data = new Map<string, Uint8Array>();
  private readonly modes = new Map<string, number>();

  private k(ns: Namespace, key: string): string {
    return `${ns}::${key}`;
  }

  /** Test hook: the mode the last write requested, if any. No FS here to enforce it. */
  modeOf(ns: Namespace, key: string): number | undefined {
    return this.modes.get(this.k(ns, key));
  }

  async read(ns: Namespace, key: string): Promise<Uint8Array | null> {
    return this.data.get(this.k(ns, key)) ?? null;
  }
  async write(ns: Namespace, key: string, bytes: Uint8Array, opts?: WriteOptions): Promise<void> {
    this.data.set(this.k(ns, key), bytes);
    if (opts?.mode !== undefined) this.modes.set(this.k(ns, key), opts.mode);
  }
  async delete(ns: Namespace, key: string): Promise<void> {
    this.data.delete(this.k(ns, key));
  }
  async list(ns: Namespace, prefix?: string): Promise<string[]> {
    const out: string[] = [];
    const nsPrefix = `${ns}::`;
    for (const k of this.data.keys()) {
      if (!k.startsWith(nsPrefix)) continue;
      const bare = k.slice(nsPrefix.length);
      if (prefix === undefined || bare.startsWith(prefix)) out.push(bare);
    }
    return out.sort();
  }
}

export class InMemoryConfig implements HostConfig {
  private readonly bag: Record<string, unknown>;
  constructor(initial: Record<string, unknown> = {}) {
    // shallow-clone so mutations don't bleed across test instances
    this.bag = { ...initial };
  }
  async loadJson(name: string): Promise<unknown> {
    return this.bag[name] ?? null;
  }
  async saveJson(name: string, value: unknown): Promise<void> {
    this.bag[name] = value;
  }
}

export interface LogRecord {
  level: 'info' | 'warn' | 'error';
  msg: string;
  obj: Record<string, unknown>;
}

export class InMemoryLogger implements HostLogger {
  readonly records: LogRecord[] = [];
  info(obj: Record<string, unknown>, msg = ''): void {
    this.records.push({ level: 'info', msg, obj });
  }
  warn(obj: Record<string, unknown>, msg = ''): void {
    this.records.push({ level: 'warn', msg, obj });
  }
  error(obj: Record<string, unknown>, msg = ''): void {
    this.records.push({ level: 'error', msg, obj });
  }
}

export class ControllableClock implements HostClock {
  constructor(private current: Date) {}
  now(): Date {
    return new Date(this.current);
  }
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
  set(date: Date): void {
    this.current = new Date(date);
  }
}

interface ScheduledTask {
  delayMs: number;
  cb: () => void;
  cancelled: boolean;
}

export class ControllableTimer implements HostTimer {
  private readonly tasks: ScheduledTask[] = [];

  schedule(delayMs: number, cb: () => void): CancelHandle {
    const task: ScheduledTask = { delayMs, cb, cancelled: false };
    this.tasks.push(task);
    return { cancel: () => (task.cancelled = true) };
  }

  /** Flush all non-cancelled tasks whose delay <= ms, in delay order. */
  flush(ms: number): void {
    const ready = this.tasks.filter((t) => !t.cancelled && t.delayMs <= ms);
    ready.sort((a, b) => a.delayMs - b.delayMs);
    for (const t of ready) {
      t.cancelled = true;
      t.cb();
    }
  }

  pending(): number {
    return this.tasks.filter((t) => !t.cancelled).length;
  }
}
