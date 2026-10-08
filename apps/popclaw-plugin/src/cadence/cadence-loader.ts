/**
 * Read cadence/cadence.json + optional prompt-overrides.md, validate
 * against an explicit shape, and return a fully-populated CadenceConfig
 * with all defaults applied. Consumers select the delivery and notification
 * settings they support.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface CadenceConfig {
  schemaVersion: 1;
  delivery: {
    channels: string[];                      // ["openclaw"]
    primaryLanguage: string;                 // BCP-47 (e.g. "zh-CN", "en-US")
    /**
     * Owner-local timezone (IANA, e.g. `Asia/Shanghai`). **Unset = fall back to
     * the system tz at runtime** — never bake in a default: doing so would decide
     * on behalf of an owner who has never said a word (ADR-0045).
     */
    timezone?: string;
    summaryStyle: 'bullets' | 'paragraphs' | 'brief';
    tone: 'casual' | 'formal' | 'terse';
    includeSourceLinks: boolean;
    includeLineage: boolean;
  };
  filtering: {
    minScore: number;
    maxItemsPerDigest: number;
  };
  notifications: {
    /**
     * A verified stranger with at least this many external followers may
     * interrupt. `0` turns it off.
     *
     * Deliberately not in `filtering` — that block is digest scoring, and its
     * `minScore` is the cautionary tale of a key nobody consumes. This one is
     * read by the notification gate the moment it lands.
     *
     * The default is set high on purpose. The two mistakes are not equal:
     * missing one means the letter waits in the inbox, letting one through
     * wrongly means the owner's phone goes off for someone who bought their
     * way in — and a follower count is the single "unforgeable" signal that
     * can be bought (ADR-0046).
     */
    vipExternalFollowerThreshold: number;
  };
  promptOverrides: string;                   // empty if file absent
  /**
   * Which `delivery` keys cadence.json actually spelled out, as opposed to
   * the ones that are merely defaults. The language chain needs this signal:
   * an explicitly configured `primaryLanguage` wins over every guess, while
   * the default `en-US` must stay overridable (decision doc section 2.3).
   * Absent = nothing was loaded from disk.
   */
  explicitDelivery?: readonly string[];
}

/**
 * The one cadence file. Everything that reads, writes or *reports* it goes
 * through here — the 2026-07-31 incident was a second copy of this join
 * landing in `data/cadence/` instead of `config/cadence/`, on three machines,
 * with no error anywhere.
 */
export function cadenceFile(cadenceDir: string): string {
  return join(cadenceDir, 'cadence.json');
}

/** Is the file actually there? `false` means every value below is a default. */
export function cadenceFileFound(cadenceDir: string): boolean {
  return existsSync(cadenceFile(cadenceDir));
}

export function defaultCadence(): CadenceConfig {
  return {
    schemaVersion: 1,
    delivery: {
      channels: ['openclaw'],
      primaryLanguage: 'en-US',
      summaryStyle: 'bullets',
      tone: 'casual',
      includeSourceLinks: true,
      includeLineage: true,
    },
    filtering: {
      minScore: 0.4,
      maxItemsPerDigest: 10,
    },
    notifications: {
      vipExternalFollowerThreshold: 100_000,
    },
    promptOverrides: '',
  };
}

/**
 * Merge `patch` into cadence.json's `delivery` block and write it back.
 * **Every field already in the file survives** — including keys this loader
 * has never heard of: the owner hand-writes this file, and a tool write must
 * not quietly eat what it doesn't understand.
 *
 * Throws on a malformed cadence.json rather than overwriting it (losing the
 * owner's config to a typo'd brace would be worse than a failed tool call).
 */
export function writeCadenceDelivery(cadenceDir: string, patch: Record<string, unknown>): void {
  const cfgPath = cadenceFile(cadenceDir);
  let raw: Record<string, unknown> = {};
  if (existsSync(cfgPath)) {
    raw = JSON.parse(readFileSync(cfgPath, 'utf-8')) as Record<string, unknown>;
  }
  const delivery = (raw.delivery ?? {}) as Record<string, unknown>;
  raw.schemaVersion = raw.schemaVersion ?? 1;
  raw.delivery = { ...delivery, ...patch };
  mkdirSync(cadenceDir, { recursive: true });
  writeFileSync(cfgPath, `${JSON.stringify(raw, null, 2)}\n`, 'utf-8');
}

export interface CadenceLoaderLogger {
  warn(msg: string): void;
}

export interface CadenceLoaderOptions {
  /** The cadence directory itself (PopclawPaths.cadenceDir()). */
  readonly cadenceDir: string;
  readonly logger?: CadenceLoaderLogger;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const isString = (v: unknown): v is string => typeof v === 'string';
const isBoolean = (v: unknown): v is boolean => typeof v === 'boolean';
const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Validate only known fields; never rewrite the owner's file or log its contents. */
function mergeSection<T extends object>(
  target: T, raw: unknown,
  checks: { [K in keyof T]-?: (value: unknown) => value is T[K] },
  warn: () => void,
): string[] {
  const accepted: string[] = [];
  if (raw === undefined) return accepted;
  if (!isRecord(raw)) { warn(); return accepted; }
  for (const key in checks) {
    if (!Object.hasOwn(raw, key)) continue;
    const value = raw[key];
    if (checks[key](value)) {
      target[key] = value;
      accepted.push(key);
    } else { warn(); }
  }
  return accepted;
}

export class CadenceLoader {
  private readonly cadenceDir: string;
  private readonly logger: CadenceLoaderLogger;

  constructor(opts: CadenceLoaderOptions) {
    this.cadenceDir = opts.cadenceDir;
    this.logger = opts.logger ?? { warn: () => {} };
  }

  async load(): Promise<CadenceConfig> {
    const out = defaultCadence();

    const cfgPath = cadenceFile(this.cadenceDir);
    if (existsSync(cfgPath)) {
      let raw: unknown;
      try {
        raw = JSON.parse(readFileSync(cfgPath, 'utf-8'));
      } catch (err) {
        this.logger.warn(`cadence-loader: malformed cadence.json (${String(err)}); using defaults`);
        return out;
      }
      if (!isRecord(raw)) {
        this.logger.warn('cadence-loader: cadence.json must be an object; using defaults');
      } else {
        const warn = () => this.logger.warn('cadence-loader: invalid config field or section; keeping its default');
        const explicit = mergeSection(out.delivery, raw.delivery, {
          channels: (v): v is string[] => Array.isArray(v) && v.every(isString),
          primaryLanguage: isString,
          timezone: isString,
          summaryStyle: (v): v is CadenceConfig['delivery']['summaryStyle'] => v === 'bullets' || v === 'paragraphs' || v === 'brief',
          tone: (v): v is CadenceConfig['delivery']['tone'] => v === 'casual' || v === 'formal' || v === 'terse',
          includeSourceLinks: isBoolean,
          includeLineage: isBoolean,
        }, warn);
        if (isRecord(raw.delivery)) out.explicitDelivery = explicit;
        mergeSection(out.filtering, raw.filtering, { minScore: isNumber, maxItemsPerDigest: isNumber }, warn);
        mergeSection(out.notifications, raw.notifications, { vipExternalFollowerThreshold: isNumber }, warn);
      }
    }

    const overridesPath = join(this.cadenceDir, 'prompt-overrides.md');
    if (existsSync(overridesPath)) {
      out.promptOverrides = readFileSync(overridesPath, 'utf-8').trim();
    }

    return out;
  }
}
