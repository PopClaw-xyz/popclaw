/**
 * The owner's explicit house acts: add (trust + first login) and leave.
 *
 * These are THE entry points the reception chain was missing: without an
 * explicit add, no pin exists and no participation is live, and every process
 * on a fresh data root attaches nothing — mail and relations alike stay
 * undelivered, silently. The audit called that the structural gap; this is
 * its close.
 *
 * The acts themselves are the shared chain's, never reimplemented here:
 * addHouseAndLogin does trust + activation as ONE commit and hands back the
 * generation that commit wrote; leave ends the participation (both streams of
 * the house stop reading) while the pin, the relations and the cursors stay —
 * leaving is not forgetting.
 *
 * Receiving processes pick the new state up on their next attach (a running
 * gateway or MCP process attaches at startup; restart it, or run the daemon,
 * to start receiving). That is stated in the reply rather than hidden.
 */
import type { HostDb } from '../host/host-db.js';
import { endParticipation, housePositionAdvances } from '../ingress/inbound-commit.js';
import { pinnedBinding } from '../world/house-binding-pin.js';
import { addHouseAndLogin, isLoopbackOrigin } from '../social-graph/relation-host.js';
import { createRelationWiring } from '../social-graph/relation-wiring.js';

export interface HouseCommandDeps {
  readonly db: HostDb;
  readonly recipientPopclawId: string;
  /** Injection point for tests; the CLI uses the real fetch. */
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => number;
}

export interface HouseCommandReply {
  readonly text: string;
  readonly ok: boolean;
}

export async function runHouseAddCommand(
  origin: string,
  deps: HouseCommandDeps,
): Promise<HouseCommandReply> {
  if (!origin) return { text: 'usage: popclaw house add <https://house.example>', ok: false };
  // A wiring over the same db handle — addHouseAndLogin refuses a cross-db
  // splice, and a bare wiring is all the act needs (no streams here). The
  // transport comparator is handed in anyway: an assembly that differs from
  // the receiving one only by what it happens not to use today is how a guard
  // goes missing on the day something does.
  const wiring = createRelationWiring({
    db: deps.db,
    recipientPopclawId: deps.recipientPopclawId,
    advances: housePositionAdvances,
  });
  const result = await addHouseAndLogin(
    { db: deps.db, ...(deps.fetch ? { fetch: deps.fetch } : {}), ...(deps.now ? { now: deps.now } : {}) },
    wiring,
    origin,
    // Loopback is this machine (local test/dev houses) — the same carve-out
    // the startup confirm uses; everything else stays https-or-refused.
    isLoopbackOrigin(origin) ? { allowInsecureOrigin: true } : {},
  );
  if (!result.ok) {
    return { text: `⚠️ ${origin}: ${result.refusal}`, ok: false };
  }
  return {
    text:
      `✓ trusted ${origin} (house ${result.binding.houseKey}) and logged in as generation ` +
      `${result.handle.source.ownerGeneration}. Restart your running popclaw processes ` +
      `(gateway / MCP) to start receiving this house's mail and relations.`,
    ok: true,
  };
}

export async function runHouseLeaveCommand(
  origin: string,
  deps: HouseCommandDeps,
): Promise<HouseCommandReply> {
  if (!origin) return { text: 'usage: popclaw house leave <https://house.example>', ok: false };
  const pin = pinnedBinding(deps.db, origin);
  if (pin === undefined) {
    return { text: `⚠️ nothing is trusted at ${origin} — nothing to leave`, ok: false };
  }
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  endParticipation(deps.db, pin.houseKey, now);
  return {
    text:
      `✓ left ${origin}: both of its streams stop reading. The trust, your relations and ` +
      `the resume cursors stay — logging back in continues where you left off.`,
    ok: true,
  };
}
