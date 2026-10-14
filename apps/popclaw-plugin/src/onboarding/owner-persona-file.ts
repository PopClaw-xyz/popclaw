/** Optional operator/full-build naming material; never probes host directories. */
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

