/**
 * OpenClaw host adapter. Reuses `LocalHostAdapter` by rooting all file IO
 * under `<openclaw-state>/popclaw/`. Business modules see the same
 * namespaced FS layout whether running in OpenClaw or in the dev CLI,
 * so Plan 5's scope (identity/keystore/scraper/egress/ingress/ranger/etc.)
 * needs zero changes to work under OpenClaw.
 */
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/plugin-entry';
import type { HostAdapter } from './host-adapter.js';
import { LocalHostAdapter, type LocalHostOptions } from './local-host-adapter.js';
import { PopclawPaths } from './popclaw-paths.js';
import { pinoHostLogger } from '../runtime/logger.js';

/**
 * Declare only the one slot this adapter reads — the host's state root. The
 * signature is lifted off the SDK type, so an SDK change still breaks the build,
 * but callers (tests included) don't have to fake all ~100 registration surfaces
 * of `OpenClawPluginApi`.
 */
type StateDirHost = {
  runtime: {
    state: { resolveStateDir: OpenClawPluginApi['runtime']['state']['resolveStateDir'] };
  };
};

export function createOpenClawHostAdapter(api: StateDirHost, beforeDbInitialize?: LocalHostOptions['beforeDbInitialize']): HostAdapter {
  const dataRoot = PopclawPaths.resolveRoot(process.env, api.runtime.state.resolveStateDir());
  return new LocalHostAdapter({
    dataRoot,
    beforeDbInitialize,
    logger: pinoHostLogger((process.env.LOG_LEVEL ?? 'info') as 'info'),
  });
}
