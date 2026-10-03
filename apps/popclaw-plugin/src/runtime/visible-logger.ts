import type { PluginLogger } from 'openclaw/plugin-sdk/plugin-entry';

/**
 * Bends the host logger's `warn` / `error` into the `info` channel.
 *
 * Why this layer is needed: the step where OpenClaw's subsystem logger writes to the console is
 * `level === 'error' || 'fatal' ? console.error : level === 'warn' ? console.warn : console.log`
 * — both warn and error land on **stderr**, and the gateway process's steady state is
 * `fd 2 → /dev/null` (confirmed locally with lsof: across 200k lines of gateway.log, not a
 * single popclaw warn/error appears). `info` is the only channel empirically confirmed to
 * reach gateway.log.
 *
 * The cost was real: on 2026-07-28→29, "image-attached notifications kept getting judged
 * partial_failed → the whole batch got requeued → every new DM dragged all the old DMs along
 * and resent them" burned two days unnoticed — the code's "loudly give up" line was shouting
 * into a black hole, and it was finally caught by the owner eyeballing Telegram directly.
 *
 * Level semantics are preserved via the `popclaw[warn]:` / `popclaw[error]:` prefix (also a
 * grep anchor). The real root cause is in the host's stderr routing, which the plugin layer
 * can't control — this is just a workaround, don't let it be forgotten.
 */
// The real SDK `PluginLogger` is string-only (debug optional), so no
// object-stringify shim is needed here.
export function visibleLogger(logger: PluginLogger): PluginLogger {
  return {
    // The SDK's `debug` is an optional member — treat a missing one as "this level doesn't exist".
    debug: (m: string) => logger.debug?.(m),
    info: (m: string) => logger.info(m),
    warn: (m: string) => logger.info(`popclaw[warn]: ${m}`),
    error: (m: string) => logger.info(`popclaw[error]: ${m}`),
  };
}
