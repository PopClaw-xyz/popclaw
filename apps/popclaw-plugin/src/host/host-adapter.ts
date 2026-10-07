import type { HostDb } from './host-db.js';

/**
 * HostAdapter — the plugin's single integration surface with the platform.
 *
 * Business modules MUST NOT import node:*. All file, network, time, and
 * logging IO flows through this interface. Platform hosts (OpenClaw,
 * Hermes, local dev) provide their own implementations; see
 * LocalHostAdapter for the production dev-box variant, and
 * InMemoryHostAdapter for tests.
 */
export interface HostAdapter {
  readonly storage: HostStorage;
  readonly config: HostConfig;
  readonly logger: HostLogger;
  readonly clock: HostClock;
  readonly timer: HostTimer;
  readonly db: HostDb; // ADR-0013, O-3a — SQLite gateway for persistent plugin state
}

export type Namespace = 'identity' | 'social' | 'houses' | 'cache' | 'config';

export interface WriteOptions {
  /** Synchronous caller check immediately before file publication, after IO preparation. */
  assertCommitAllowed?: () => void;
  /**
   * POSIX file mode for the written file (e.g. `0o600` for secrets). File-backed
   * adapters also create any MISSING directory in the chain at 0o700 — directories
   * that already exist keep their mode (in practice `<root>/vault` and
   * `<root>/vault/social` are pre-created by LocalHostDb at the default mode, so
   * only the leaf ends up 0700). Adapters with no filesystem ignore it.
   */
  mode?: number;
  /**
   * Fail with `EEXIST` instead of overwriting (O_EXCL). For the one write that
   * must never clobber: minting the master key. Two hosts booting a fresh data
   * root at the same moment would otherwise each generate a keypair and the
   * later write would silently bury the earlier identity — unrecoverable, since
   * there is no revocation path. Callers catch EEXIST and re-read the winner.
   * Adapters with no filesystem may ignore it (they are single-process).
   */
  exclusive?: boolean;
}

export interface HostStorage {
  read(ns: Namespace, key: string): Promise<Uint8Array | null>;
  write(ns: Namespace, key: string, bytes: Uint8Array, opts?: WriteOptions): Promise<void>;
  delete(ns: Namespace, key: string): Promise<void>;
  list(ns: Namespace, prefix?: string): Promise<string[]>;
  /**
   * Absolute path `key` resolves to on disk. Optional — present on file-backed
   * adapters so a log line can name the exact file (same convention as
   * `HostConfig.pathFor`).
   */
  pathFor?(ns: Namespace, key: string): string;
  /**
   * If the file carries permission bits outside `mode`, chmod it down to `mode`.
   * Returns the PREVIOUS mode when it changed something, else null — the caller
   * needs the old bits to tell "was actually readable by others" (0o077 set) from
   * "merely over-broad but private" (e.g. 0700). Optional; callers must treat it
   * as best-effort (absent implementation, exotic FS, Windows).
   */
  tightenPermissions?(ns: Namespace, key: string, mode: number): Promise<number | null>;
}

export interface HostConfig {
  loadJson(name: string): Promise<unknown>;
  saveJson(name: string, value: unknown): Promise<void>;
  /**
   * Absolute path `name` resolves to on disk. Optional — present on the real
   * file-backed adapter so a "config missing" error can name the exact file to
   * create (the in-memory test adapter omits it). See bug report "host-c dispatch chain ③".
   */
  pathFor?(name: string): string;
  /**
   * A cheap change marker for `name` (inode, mtime and size of the file on the
   * file-backed adapter — every write is a tmp+rename, so a new inode even
   * within one timestamp tick), and a synchronous read of it. Optional: they let a value that
   * another process may rewrite be re-read on access only when it changed
   * (the owner's name, `plugin-bootstrap.ts`). Absent → callers keep their
   * in-process value.
   */
  versionOf?(name: string): string | null;
  loadJsonSync?(name: string): unknown;
}

export interface HostLogger {
  info(obj: Record<string, unknown>, msg?: string): void;
  warn(obj: Record<string, unknown>, msg?: string): void;
  error(obj: Record<string, unknown>, msg?: string): void;
}

export interface HostClock {
  now(): Date;
}

export interface CancelHandle {
  cancel(): void;
}

export interface HostTimer {
  schedule(delayMs: number, cb: () => void): CancelHandle;
}
