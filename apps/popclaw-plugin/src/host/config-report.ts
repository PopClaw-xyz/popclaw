/**
 * "Where does my config live, and what is actually in effect right now."
 *
 * The 2026-07-31 incident this exists for: `cadence.delivery.primaryLanguage`
 * is the owner's only explicit language switch, and it got written to
 * `data/cadence/` while the loader reads `config/cadence/`. Three machines,
 * no error, no log line — one of them served an English newspaper to a Chinese
 * owner for weeks. The failure was silent AND permanent, and a release is
 * exactly when fresh machines get installed and paths get mixed up.
 *
 * So both diagnostic surfaces (`/popclaw status`'s footer and the `/popclaw
 * doctor` report) print the same three facts: the **absolute** path of the
 * cadence file, whether it is actually there, and the language/timezone in
 * effect **with where each came from**. Provenance is the half that turns a
 * value into a diagnosis: `en-US (default)` means nobody ever told us,
 * `en-US (you set it)` means the config is being read and says so.
 *
 * Reads the process-wide registers the composition roots filled at boot
 * (`ownerLangTag` / `ownerTz`), so it needs no wiring beyond the cadence dir.
 */

import { cadenceFile, cadenceFileFound } from '../cadence/cadence-loader.js';
import { ownerLangTag, ownerLangSource, type LangSource } from '../lexicon/owner-language.js';
import { configuredOwnerTz, ownerTz } from '../time/time-context.js';

export interface ConfigReport {
  /** Absolute path — the whole point; a relative one would hide the bug. */
  readonly cadencePath: string;
  /** `false` = no file there, so language and timezone below are defaults. */
  readonly cadenceFound: boolean;
  /** BCP-47 tag in effect (not the lexicon lane). */
  readonly langTag: string;
  /** `undefined` = nothing has been observed or configured at all. */
  readonly langSource: LangSource | undefined;
  readonly tz: string;
  /** Whether `tz` came from cadence rather than the machine clock. */
  readonly tzConfigured: boolean;
}

export function configReport(cadenceDir: string): ConfigReport {
  return {
    cadencePath: cadenceFile(cadenceDir),
    cadenceFound: cadenceFileFound(cadenceDir),
    langTag: ownerLangTag(),
    langSource: ownerLangSource(),
    tz: ownerTz(),
    tzConfigured: configuredOwnerTz() !== undefined,
  };
}

/**
 * Lexicon key for "where this language came from", shared by both surfaces so
 * status and the doctor report can never disagree about the same fact. The two
 * observation lanes (`guess`/`agent`) collapse into one label: to the owner
 * "I worked it out from how you write" is one story, not two.
 */
export function langSourceCopyKey(source: LangSource | undefined): string {
  if (source === 'config') return 'config.src.owner';
  if (source === 'guess' || source === 'agent') return 'config.src.observed';
  if (source === 'env') return 'config.src.host';
  return 'config.src.default';
}

export function tzSourceCopyKey(r: Pick<ConfigReport, 'tzConfigured'>): string {
  return r.tzConfigured ? 'config.src.owner' : 'config.src.machine';
}
