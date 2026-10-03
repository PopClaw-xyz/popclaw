// MUST stay byte-identical to apps/popclaw-canvas/src/signing.ts.
// canvasSigningBytes is pinned by tests/canvas/canvas-config.test.ts;
// pullSigningBytes / pairClaimSigningBytes by
// tests/unit/canvas/intent-pull-client.test.ts.
// The leading domain tag is load-bearing: without it this entry's first field
// is the title, and the bytes collide exactly with pullSigningBytes below —
// one signature satisfying both checks, so a credential minted to READ an
// owner's intents also authorises PUBLISHING as them. No tag may be a prefix
// of another. ⚠️ Changing these bytes is a break; both ends move together.
export function canvasSigningBytes(title: string, html: string): Uint8Array {
  return new TextEncoder().encode(`canvas-upload\0${title}\0${html}`);
}

// Canonical bytes a follow-intent pull is signed over: domain tag + owner +
// nonce + ts. MUST stay byte-identical to
// apps/popclaw-canvas/src/signing.ts. Same \0 separator discipline
// as canvasSigningBytes (the spec prose's colon form is illustrative only).
export function pullSigningBytes(owner: string, nonce: string, ts: number): Uint8Array {
  return new TextEncoder().encode(`intents-pull\0${owner}\0${nonce}\0${ts}`);
}

// Canonical bytes a reader-pass claim is signed over: domain tag + code + id +
// ts. MUST stay byte-identical to
// apps/popclaw-canvas/src/signing.ts. Same \0 separator discipline
// (ruling B: the spec prose's colon form is illustrative only).
export function pairClaimSigningBytes(code: string, id: string, ts: number): Uint8Array {
  return new TextEncoder().encode(`pair-claim\0${code}\0${id}\0${ts}`);
}

/** The follow state of one author on one page, as far as the viewer's own
 *  plugin can tell. `unknown` is a real answer: a house that could not be
 *  reached is not the same as a person who is not followed. */
export type SyncState = 'follows' | 'none' | 'unknown';

/** What a plugin signs when it answers "what is my state on this page".
 *  Every field is NUL-free by construction and the verifier re-checks it. */
export interface SyncReply {
  readonly requestId: string;
  readonly canvasId: string;
  readonly pageDigest: string;
  readonly viewer: string;
  readonly notBeforeMs: number;
  readonly notAfterMs: number;
  readonly canvasOrigin: string;
  /** Sorted by author, deduped. The verifier rejects any other order. */
  readonly states: ReadonlyArray<readonly [author: string, state: SyncState]>;
}

/**
 * Canonical bytes a page-state sync reply is signed over.
 * MUST stay byte-identical to apps/popclaw-canvas/src/signing.ts.
 *
 * Purpose and version live in the leading tag, by the rule the other domains
 * now follow: one key signs all of them, so the only thing keeping them apart
 * is that their bytes cannot coincide.
 *
 * Bound to more than the answer. `requestId` ties it to one challenge Canvas
 * issued and will not accept twice; `pageDigest` to the exact bytes of the
 * page it is about; `viewer` to the person it is about; the validity window
 * to when; and `canvasOrigin` to WHICH Canvas asked — without that last one a
 * second deployment could replay a reply harvested from the first, and the
 * whole point of the answer is that it is nobody else's business.
 *
 * `count` is carried explicitly so a verifier rebuilding these bytes from a
 * parsed body has to agree with itself about how many pairs it read.
 */
export function syncReplySigningBytes(r: SyncReply): Uint8Array {
  const pairs = r.states.map(([author, state]) => `${author}=${state}`).join('\0');
  return new TextEncoder().encode(
    `canvas-sync-reply-v1\0${r.requestId}\0${r.canvasId}\0${r.pageDigest}\0${r.viewer}` +
      `\0${r.notBeforeMs}\0${r.notAfterMs}\0${r.states.length}` +
      (r.states.length > 0 ? `\0${pairs}` : '') +
      `\0${r.canvasOrigin}`,
  );
}
