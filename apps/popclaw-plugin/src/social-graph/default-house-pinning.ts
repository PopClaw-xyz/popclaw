/**
 * The configured houses are trusted on their own, so a fresh install works.
 *
 * Every identity-bearing read — the follower list, the DM inbox stream, the
 * relation snapshot and its evidence — needs a pinned binding before it can
 * say who is asking. A pin only ever came from the owner typing `popclaw
 * house add`, so an install that had done nothing else refused its own mail
 * and reported it as a scheme problem. The default houses are the ones the
 * owner already accepted by installing; pinning them is not a new decision,
 * it is the one the config already records.
 *
 * **It is the same act, not a shortcut past it.** This calls
 * `addHouseAndLogin` — the explicit command's own function — so the manifest
 * proof is fetched and verified exactly as it is for a typed command, and a
 * house that cannot prove its manifest is left unpinned and refused. Writing
 * the pin row here directly would make "trusted" mean "appeared in a config
 * file", which is precisely the sentence the proof exists to prevent.
 *
 * **A pin row is a decision, whichever way it points.** The only origins
 * touched are the ones with NO row at all. A house the owner left keeps its
 * pin and its ended participation (`house leave` ends participation and never
 * deletes the pin — leaving is not forgetting), so the row is already the
 * durable record that the owner has had their say here. Re-adding it would
 * log the owner back into a house they left, every restart, silently. The way
 * back in stays what it was: the explicit add, which re-activates.
 *
 * **Two roots boot on one data root.** The gateway and the MCP server can
 * both be starting, and either may win. Losing is not an error: the commit's
 * own CAS refuses the loser, and the pin it finds afterwards is the answer it
 * wanted. Only an origin still unpinned after a refusal is reported as one.
 */
import { cancelConfiguredFirstPin, type ConfiguredHousePinningStrategy } from '../runtime/house-lifecycle/configured-first-pin.js';
import type { HostDb } from '../host/host-db.js';
import { housePositionAdvances } from '../ingress/inbound-commit.js';
import { normalizeHouseOrigin } from '../runtime/house-lifecycle/control-client.js';
import { pinnedBinding } from '../world/house-binding-pin.js';
import { addHouseAndLogin, isLoopbackOrigin } from './relation-host.js';
import { createRelationWiring } from './relation-wiring.js';

/**
 * `pinned` — this call established the trust.
 * `already-decided` — a pin row was already there (trusted, blocked, or a
 * house the owner left), or another root won the race. Nothing to do.
 * `refused` — the house could not be reached or could not prove itself.
 */
export type HousePinOutcome = 'pinned' | 'already-decided' | 'refused';

export interface HousePinResult {
  readonly origin: string;
  readonly outcome: HousePinOutcome;
  /** The refusal code, for `refused` only. */
  readonly refusal?: string;
}

export interface DefaultHousePinningDeps {
  readonly db: HostDb;
  /** Positively selected by HouseRuntime; no failed-guard fallback. */
  readonly pinning: ConfiguredHousePinningStrategy;
  /** Rescan only; conveys no authority and never clears a logout fence. */
  readonly onParticipationChanged?: () => void;
  readonly current?: () => boolean;
  /** Whose mail this is — threaded into the wiring the login opens. */
  readonly recipientPopclawId: string;
  /** The configured houses, `config.lore_houses`. */
  readonly origins: readonly string[];
  /** Injection point for tests; the roots use the real fetch. */
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => number;
  /** Where a refusal goes. Never fatal: a house that is down is ordinary. */
  readonly warn?: (line: string) => void;
}

/** One pass over the configured houses. */
export async function pinConfiguredHouses(
  deps: DefaultHousePinningDeps,
): Promise<readonly HousePinResult[]> {
  const results: HousePinResult[] = [];
  for (const origin of deps.origins) {
    results.push(await pinOneHouse(deps, origin));
  }
  return results;
}

async function pinOneHouse(deps: DefaultHousePinningDeps, configured: string): Promise<HousePinResult> {
  // Canonicalised once, before anything is read or attempted. A pin is filed
  // under the canonical origin, and `lore_houses` holds whatever the owner
  // typed — so comparing the two raw makes an already-decided house look
  // untouched, and every boot logs back into a house the owner may have left.
  // An address with no canonical form is refused here rather than carried into
  // a login that could never name the house it reached.
  let origin: string;
  try {
    origin = normalizeHouseOrigin(configured);
  } catch (err) {
    deps.warn?.(`could not trust ${configured} automatically: ${String(err)}`);
    return { origin: configured, outcome: 'refused', refusal: 'HOUSE_ADDRESS_UNUSABLE' };
  }
  // Read locally and stop. Asking the house first and deciding afterwards
  // would turn "the owner left this house" into one more login attempt.
  if (pinnedBinding(deps.db, origin) !== undefined) {
    return { origin, outcome: 'already-decided' };
  }
  const firstPin = deps.pinning.mode === 'static'
    ? deps.pinning.firstPin.begin(deps.db, origin, deps.current)
    : deps.pinning.mode === 'public-v1'
      ? deps.pinning.proofPin.begin(deps.db, origin, deps.current)
      : undefined;
  if (!firstPin) return { origin, outcome: 'refused', refusal: 'HOUSE_FIRST_PIN_NOT_AUTHORIZED' };
  // No streams here either — the same comparator as the receiving assembly,
  // for the same reason it is passed in `commands/house.ts`.
  const wiring = createRelationWiring({
    db: deps.db,
    recipientPopclawId: deps.recipientPopclawId,
    advances: housePositionAdvances,
  });
  const result = await addHouseAndLogin(
    {
      db: deps.db,
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
      ...(deps.now ? { now: deps.now } : {}),
    },
    wiring,
    origin,
    // The same carve-out the typed command makes: loopback is this machine
    // (local test and dev houses); everything else stays https-or-refused.
    { firstPin, ...(firstPin.configuredHouseKey ? { configuredHouseKey: firstPin.configuredHouseKey } : {}),
      ...(isLoopbackOrigin(origin) ? { allowInsecureOrigin: true } : {}) },
  ).finally(() => cancelConfiguredFirstPin(firstPin));
  if (pinnedBinding(deps.db, origin) !== undefined) {
    try { deps.onParticipationChanged?.(); }
    catch (error) { deps.warn?.(`participation rescan failed: ${String(error)}`); }
  }
  if (result.ok) return { origin, outcome: 'pinned' };
  // The other root may have committed between the check above and this
  // commit's CAS — and a commit that landed while its own handle was
  // superseded also refuses with the pin written. A pin here means the house
  // is trusted, which is the whole thing this was trying to achieve.
  if (pinnedBinding(deps.db, origin) !== undefined) {
    return { origin, outcome: 'already-decided' };
  }
  deps.warn?.(`could not trust ${origin} automatically: ${result.refusal}`);
  return { origin, outcome: 'refused', refusal: result.refusal };
}

/**
 * Boot, then a few widening retries, then stop until the next boot.
 *
 * A house that is down at boot has to be picked up later, and a loop that
 * keeps asking forever is how a plugin with a stale URL in its config becomes
 * a background beacon. Bounded is the compromise: the delays run out, and the
 * next boot is the next chance.
 */
export const DEFAULT_PIN_RETRY_DELAYS_MS: readonly number[] = [30_000, 5 * 60_000, 30 * 60_000];

export interface DefaultHousePinningLoop {
  /** Stop retrying. Safe to call before, during or after `done`. */
  readonly stop: () => void;
  /** Resolves when nothing is left to retry or the delays are spent. Never rejects. */
  readonly done: Promise<void>;
}

export function startDefaultHousePinning(
  deps: DefaultHousePinningDeps & { readonly delaysMs?: readonly number[] },
): DefaultHousePinningLoop {
  const delays = deps.delaysMs ?? DEFAULT_PIN_RETRY_DELAYS_MS;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let wake: (() => void) | null = null;

  const stop = (): void => {
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = null;
    wake?.();
  };

  const done = (async () => {
    let pending = [...deps.origins];
    for (let attempt = 0; !stopped; attempt += 1) {
      const results = await pinConfiguredHouses({ ...deps, origins: pending, current: () => !stopped && (deps.current?.() ?? true) });
      pending = results.filter((r) => r.outcome === 'refused').map((r) => r.origin);
      const delay = delays[attempt];
      if (pending.length === 0 || delay === undefined || stopped) return;
      await new Promise<void>((resolve) => {
        wake = resolve;
        timer = setTimeout(resolve, delay);
        // Never worth keeping a process alive for (ADR-0035's discipline).
        if (typeof timer.unref === 'function') timer.unref();
      });
      wake = null;
    }
  })().catch((err: unknown) => {
    deps.warn?.(`default house pinning stopped: ${String(err)}`);
  });

  return { stop, done };
}
