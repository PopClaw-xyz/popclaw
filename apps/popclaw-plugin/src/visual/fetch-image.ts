/**
 * Fetch a small image over plain HTTP(S) for inline display (tool output
 * media, avatars). Bounded by a 15s timeout; anything but a 2xx image/*
 * with non-empty bytes reads as null — never a throw. Relocated unchanged
 * from the retired newspaper avatar-inline module.
 */
export interface FetchedImage {
  readonly bytes: Uint8Array;
  readonly type: string;
}

export async function fetchImageOverHttp(url: string): Promise<FetchedImage | null> {
  try {
    const r = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(15_000) });
    if (!r.ok) return null;
    const type = (r.headers.get('content-type') ?? '').split(';')[0]!.trim();
    if (!type.startsWith('image/')) return null;
    const bytes = new Uint8Array(await r.arrayBuffer());
    return bytes.byteLength ? { bytes, type } : null;
  } catch {
    return null;
  }
}
