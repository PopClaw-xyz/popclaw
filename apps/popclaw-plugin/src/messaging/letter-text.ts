/**
 * Three things you can read out of a letter body: links, image links, and the
 * house's machine-readable header line.
 *
 * These used to live in `newspaper/gather-materials.ts` (the newspaper was the
 * first surface that had to open a letter). After the real-device report of
 * 2026-07-31 the L1 owner notification has to open the same letter: it writes
 * straight to the channel with no agent in the turn, so nothing else is there
 * to strip the header or spot the postcard image. One reader, shared.
 *
 * Comments here are English on purpose — the CJK ratchet
 * (`tests/unit/lexicon/cjk-ratchet.test.ts`) fails any NEW file under `src/`
 * containing Chinese, and its exempt list only ever shrinks.
 */

/** http(s) links in a body. Loose match; trailing CJK/latin punctuation is not part of the url. */
const URL_RE = /https?:\/\/[^\s<>"'）】」，。；！？]+/g;

export function urlsIn(body: string): string[] {
  // Sentence-final punctuation is not part of the url (`see https://a.example/x.` → 404).
  return [...new Set((body.match(URL_RE) ?? []).map((u) => u.replace(/[.,;:!?)\]]+$/, '')))];
}

/** Is this url an image (by extension, query ignored)? This is how a postcard image is spotted. */
export const IMAGE_URL_RE = /\.(jpe?g|png|webp|gif)(\?|#|$)/i;

/** Image links in a body, in order of appearance. */
export function imageUrlsIn(body: string): string[] {
  return urlsIn(body).filter((u) => IMAGE_URL_RE.test(u));
}

/** Home-letter header: the machine-readable first line the house shipped 2026-07-31.
 *  guide §3 is explicit that it must never be read out to the owner. */
const HOMELETTER_RE = /^\[homeletter\/v1\][ \t]*(.*)$/;
/** `key=value` inside the header: a value runs up to the NEXT `key=`, so `place=Kyoto in the rain` parses. */
const HEADER_KV_RE = /(\w+)=(.*?)(?=\s+\w+=|$)/g;

/**
 * Split off the machine header: fields go to the caller (the newspaper prints
 * them verbatim in a footnote), and that whole line leaves the body. No header
 * (old house / ordinary DM) → body untouched, byte for byte.
 */
export function splitHomeletterHeader(body: string): { header?: string; rest: string } {
  const nl = body.indexOf('\n');
  const m = (nl === -1 ? body : body.slice(0, nl)).match(HOMELETTER_RE);
  if (!m) return { rest: body };
  const fields = [...(m[1] ?? '').matchAll(HEADER_KV_RE)]
    .map(([, k, v]) => `${k}=${(v ?? '').trim()}`)
    .filter((s) => !s.endsWith('='));
  const rest = nl === -1 ? '' : body.slice(nl + 1);
  return { ...(fields.length ? { header: fields.join(' · ') } : {}), rest };
}
