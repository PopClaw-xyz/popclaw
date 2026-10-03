/**
 * S3 (three-act spec §3.1) — the two sources of naming material (wired up by
 * index.ts).
 *
 * 1. Persona authorization gate: only reads the file the owner explicitly
 *    specified via POPCLAW_OWNER_PERSONA_PATH — never auto-probes the openclaw
 *    directory (boundary discipline: the SDK does not expose soul assets, the
 *    path must be given explicitly by the owner; see memory
 *    feedback-openclaw-scope-boundary).
 * 2. Verified handles: lore-house GET /v1/profile/<popclaw_id>; failure/404
 *    always yields empty (the same fallback posture as commands/status.ts).
 */
// The persona authorization gate reads an arbitrary path the owner explicitly gave;
// HostAdapter has no arbitrary-path read surface (config/storage/inputs are all
// namespaced), so this gets the same exemption as taste-writer.ts.
// eslint-disable-next-line no-restricted-imports
import { readFile } from 'node:fs/promises';

export const PERSONA_ENV = 'POPCLAW_OWNER_PERSONA_PATH';

/** Truncation ceiling. Cut by UTF-16 code units, not strict byte count — sufficient for prompt-material purposes. */
const PERSONA_MAX_CHARS = 8 * 1024;

export async function readOwnerPersonaFromEnv(
  env: Record<string, string | undefined> = process.env,
): Promise<string | undefined> {
  const path = env[PERSONA_ENV]?.trim();
  if (!path) return undefined;
  try {
    const text = await readFile(path, 'utf-8');
    return text.length > PERSONA_MAX_CHARS ? text.slice(0, PERSONA_MAX_CHARS) : text;
  } catch {
    // File missing / unreadable: silent fallback — the authorization gate gave a path but it couldn't be read; don't block the naming flow.
    return undefined;
  }
}

export interface FetchVerifiedHandlesOptions {
  readonly loreHouseUrl: string;
  readonly popclawId: string;
  readonly fetchImpl?: typeof globalThis.fetch;
}

export async function fetchVerifiedHandles(
  opts: FetchVerifiedHandlesOptions,
): Promise<string[]> {
  const f = opts.fetchImpl ?? globalThis.fetch;
  const url =
    `${opts.loreHouseUrl.replace(/\/$/, '')}/v1/profile/` +
    encodeURIComponent(opts.popclawId);
  try {
    const resp = await f(url);
    if (!resp.ok) return [];
    const body = (await resp.json()) as {
      profiles?: Array<{ handle?: string }>;
    };
    return (body.profiles ?? [])
      .map((p) => (p.handle ?? '').trim())
      .filter((h) => h.length > 0);
  } catch {
    return [];
  }
}
