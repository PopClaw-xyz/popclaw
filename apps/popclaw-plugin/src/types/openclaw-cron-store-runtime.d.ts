/**
 * Ambient shim: `openclaw/plugin-sdk/cron-store-runtime` ships no type
 * declarations in openclaw 2026.8.2 (2026.7.1-2 had them) — the subpath
 * exports only dist/plugin-sdk/cron-store-runtime.js. The usage in
 * tools/dream-taste-tools.ts (`loadDreamCronStore`) is defensive import-on-use
 * with a null degrade, so `unknown` returns are all it needs: the call
 * site casts to its own CronJobLike shape anyway.
 *
 * Delete this file when upstream ships declarations for the subpath
 * (then `tsc` fails loudly on the duplicate module declaration — that
 * failure is the reminder).
 */
declare module 'openclaw/plugin-sdk/cron-store-runtime' {
  export function resolveCronStorePath(...args: unknown[]): string;
  export function loadCronStore(path: string, ...args: unknown[]): Promise<unknown>;
}
