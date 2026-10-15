/** Naming inputs: optional full-build persona source and public verified handles. */
export { PERSONA_ENV, readOwnerPersonaFromEnv } from './owner-persona-file.js';

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
