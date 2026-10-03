/**
 * One place that decides how long "waiting on a lore-house" is long enough.
 *
 * Neither of the two HTTP stacks we use caps a request by default: Node's
 * `fetch` has no timeout at all, and undici's `request` defaults
 * headersTimeout/bodyTimeout to 300s. So one wedged house can hang a caller
 * for five minutes — a command that never answers, timer ticks piling up
 * behind each other, every non-SSE leg tied to the same rope.
 *
 * A timeout throws into each call site's EXISTING error path (returns null /
 * "lore-house unreachable" / retry on the next tick). No retry logic lives
 * here.
 */

/** Reads: GET profile / resolve / world-feed snapshot / guide / manifest. */
export const LORE_HOUSE_TIMEOUT_MS = 10_000;

/**
 * Writes (POST push / canvas), widened because both legs carry a large body:
 * a mirror post with media, a whole newspaper's HTML. The upload alone can
 * take tens of seconds, and undici's headersTimeout is measured from "request
 * sent" to "response headers received" — the server does not reply until the
 * body is in, so the 10s read budget would kill healthy large uploads.
 */
export const LORE_HOUSE_UPLOAD_TIMEOUT_MS = 30_000;
