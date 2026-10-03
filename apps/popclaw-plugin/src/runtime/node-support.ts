/**
 * Is this host's Node one of the lines popclaw actually supports?
 *
 * Why a runtime check and not just `engines` in package.json: OpenClaw installs
 * the plugin from a tarball, and nothing on that path enforces `engines` — the
 * field is advisory. The first real symptom of running below the floor is not
 * "install refused", it is a subtle wrong answer much later: node 22.19's ICU
 * silently rejects the `+08` offset strings the social log stores, so
 * `resolveTz` falls back to the system zone and the dreamer files a 07-31 entry
 * under 07-30 — no error anywhere (issue #332; that specific bug is fixed at the
 * source now, but it is the shape of what an unsupported runtime buys you).
 *
 * Kept as data + a pure function so a test can assert it stays in step with
 * `package.json` `engines.node` — one source of truth, checked, not duplicated
 * by hand.
 */

/** Minimum patch for each supported major; a major absent here is unsupported. */
export const SUPPORTED_NODE_LINES: ReadonlyArray<readonly [major: number, minMinor: number, minPatch: number]> = [
  [24, 16, 0],
  [26, 1, 0],
];

/** Human-readable form of the above, for the boot line and error text. */
export const SUPPORTED_NODE_TEXT = '>=24.16.0 <25 || >=26.1.0';

/** `v22.19.0` / `22.19.0` → `[22, 19, 0]`; null when unparseable. */
export function parseNodeVersion(v: string): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/**
 * `null` = supported (or unparseable — never block on our own parser).
 * Otherwise a one-line owner-facing reason.
 */
export function unsupportedNodeReason(version: string = process.version): string | null {
  const parsed = parseNodeVersion(version);
  if (!parsed) return null;
  const [maj, min, patch] = parsed;
  const line = SUPPORTED_NODE_LINES.find(([m]) => m === maj);
  if (!line) {
    return `Node ${version} is not a supported line (popclaw needs ${SUPPORTED_NODE_TEXT}).`;
  }
  const [, minMinor, minPatch] = line;
  if (min > minMinor || (min === minMinor && patch >= minPatch)) return null;
  return `Node ${version} is below the supported floor for its line (popclaw needs ${SUPPORTED_NODE_TEXT}).`;
}
