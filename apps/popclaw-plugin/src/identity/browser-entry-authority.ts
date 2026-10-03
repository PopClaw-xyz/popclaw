/**
 * "May this machine mint a browser key for that house, and for which site?"
 *
 * One decider, the same shape as `read-authority.ts`: the pin first, because
 * without a verified binding there is no key whose word the declaration could
 * be; then the declaration that belongs to THAT pin's key; then the
 * declaration's own rules. A refusal here is by name and goes no further —
 * there is no second place to look, no guide to fall back on, and no value a
 * caller may supply instead.
 *
 * Split out so it can be run TWICE over one operation: once to build a
 * preview, and once again at the moment of signing. The second run is not a
 * formality. Between the two the owner may have blocked the house, the house
 * may have re-keyed, or a fresh manifest may have moved the site the link
 * leads to — and the owner said yes to what the first run showed them.
 */

import type { HostDb } from '../host/host-db.js';
import { normalizeHouseOrigin } from '../runtime/house-lifecycle/control-client.js';
import { pinnedBinding, type HouseBindingPin } from '../world/house-binding-pin.js';
import {
  declarationCheckedAt,
  declarationFingerprint,
  readVerifiedDeclaration,
} from '../world/house-read-declaration.js';
import { confirmHouseTrust } from '../world/house-trust.js';
import {
  selectBrowserEntry,
  type BrowserEntryOptions,
  type BrowserEntryRefusal,
  type VerifiedBrowserEntry,
} from './browser-entry.js';

/** Why no link can be minted. `HOUSE_NOT_PINNED` also covers a blocked pin. */
export type BrowserEntryAuthorityRefusal = 'HOUSE_NOT_PINNED' | BrowserEntryRefusal;

export type BrowserEntryDecision =
  | { readonly refusal: BrowserEntryAuthorityRefusal; readonly origin: string }
  | {
      readonly origin: string;
      readonly pin: HouseBindingPin;
      readonly entry: VerifiedBrowserEntry;
      /**
       * The whole declaration row's fingerprint, not just the entrance's.
       *
       * What the owner agreed to is "this identity, at this house, for this
       * site" — and every part of that is decided by the same projected row,
       * so the re-check compares the row, not the field it happens to read.
       */
      readonly fingerprint: string;
    };

/**
 * Decide, without signing anything.
 *
 * The origin is canonicalised once, here, and the pin, the declaration and
 * the audience are all read under that one string — the same discipline
 * `decideReadAuthority` follows, and for the same reason: a raw spelling
 * finds no pin at all at a house this machine genuinely trusts.
 */
export function decideBrowserEntry(
  db: HostDb,
  configuredOrigin: string,
  opts: BrowserEntryOptions = {},
): BrowserEntryDecision {
  let origin: string;
  try {
    origin = normalizeHouseOrigin(configuredOrigin);
  } catch {
    return { refusal: 'HOUSE_NOT_PINNED', origin: configuredOrigin };
  }
  const pin = pinnedBinding(db, origin);
  if (pin === undefined || pin.blockedReason !== undefined) {
    return { refusal: 'HOUSE_NOT_PINNED', origin };
  }
  const declaration = readVerifiedDeclaration(db, pin);
  const choice = selectBrowserEntry(declaration?.browserEntry, opts);
  if ('refusal' in choice) return { refusal: choice.refusal, origin };
  return { origin, pin, entry: choice.entry, fingerprint: declarationFingerprint(declaration) };
}

/** A "no entrance" verified this recently is believed without a re-check. */
export const REFRESH_THROTTLE_SECONDS = 60;

/** What a re-check needs from the caller. Absent `manifestFetch` = no re-check. */
export interface BrowserEntryRefreshOptions extends BrowserEntryOptions {
  /**
   * The house's own guarded read lane for `origin`. The re-check fetches the
   * manifest through it and nothing else; the proof is still verified against
   * the pin inside `confirmHouseTrust`, so the lane carries bytes, not trust.
   */
  readonly manifestFetch?: (origin: string) => typeof globalThis.fetch;
  readonly now?: () => number;
}

/** A decision, plus — when a stale answer is all there is — why it stayed stale. */
export type RefreshedBrowserEntryDecision =
  | BrowserEntryDecision
  | {
      readonly refusal: 'BROWSER_ENTRY_NOT_DECLARED';
      readonly origin: string;
      /** The re-check did not complete; the refusal rests on the last verified check. */
      readonly refreshFailed: string;
    };

/**
 * `decideBrowserEntry`, but a "not declared" read from the local projection
 * is re-checked ONCE before it is believed.
 *
 * The projection is a snapshot of the last verified manifest, and a house can
 * open its browser door after that snapshot was taken. Only that one refusal
 * is re-checked: a pin that is missing or blocked is refused before anything
 * leaves this machine, and a declaration that exists but is unusable is the
 * house's current word already. The re-check is `confirmHouseTrust` itself —
 * the same fetch, the same proof verified against the SAME pinned key, the
 * same transaction and projection write every reconnect uses — so it can
 * agree with the pin or refuse; it can never pin, never unblock, and never
 * take a declaration from bytes that did not verify.
 */
export async function decideBrowserEntryRefreshing(
  db: HostDb,
  configuredOrigin: string,
  opts: BrowserEntryRefreshOptions = {},
): Promise<RefreshedBrowserEntryDecision> {
  const first = decideBrowserEntry(db, configuredOrigin, opts);
  if (!('refusal' in first) || first.refusal !== 'BROWSER_ENTRY_NOT_DECLARED') return first;
  // A declaration verified within the last minute IS the house's current
  // word, not a stale snapshot. Without this an agent retrying in a loop
  // would buy one manifest fetch and one write transaction per call.
  const checkedAt = declarationCheckedAt(db, first.origin);
  const now = opts.now?.() ?? Math.floor(Date.now() / 1000);
  if (checkedAt !== undefined && now - checkedAt < REFRESH_THROTTLE_SECONDS) return first;
  if (opts.manifestFetch === undefined) {
    return { refusal: first.refusal, origin: first.origin, refreshFailed: 'HOUSE_REFRESH_UNAVAILABLE' };
  }
  let refused: string | undefined;
  try {
    const confirmed = await confirmHouseTrust(db, first.origin, {
      fetch: opts.manifestFetch(first.origin),
      ...(opts.allowInsecureOrigin?.(first.origin) ? { allowInsecureOrigin: true } : {}),
      ...(opts.now ? { now: opts.now } : {}),
    });
    if (!confirmed.ok) refused = String(confirmed.refusal);
  } catch (err) {
    refused = err instanceof Error ? err.message : String(err);
  }
  // Decide again either way. A failed re-check is not always a no-op: a house
  // serving another incarnation is a verified disagreement with the pin, and
  // the confirm BLOCKS the pin. That outcome is the answer, and it must not
  // be reported as a stale "no entrance" with a login hint.
  const again = decideBrowserEntry(db, first.origin, opts);
  if (refused !== undefined && 'refusal' in again && again.refusal === 'BROWSER_ENTRY_NOT_DECLARED') {
    return { refusal: again.refusal, origin: again.origin, refreshFailed: refused };
  }
  return again;
}
