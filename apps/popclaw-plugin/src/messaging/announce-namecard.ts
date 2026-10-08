/**
 * Namecard self-heal (D1, namecard-rebroadcast-proposal §2.3/§2.4, issue #280).
 *
 * "Mount a house, and you are present" — the same tick that refreshes the ADR-0041 house handshake
 * also asks each mounted house "do you have my namecard?" and pushes one if
 * not. This is what makes a house DB rebuild, a newly-mounted house, or a
 * P-006 reinstall self-heal within one tick instead of staying invisible
 * forever (no code path previously re-announced an already-issued namecard).
 *
 * Check-first, not blind re-push: `signMyNamecard` output is byte-identical
 * across repeated calls (declared_at is pinned, my-namecard.ts), so a blind
 * re-push would be "free" from the house's event-dedup point of view — but
 * the house's ingestion still appends the raw signed bytes to an audit table
 * BEFORE dedup runs. A GET we're already paying for elsewhere (status.ts hits
 * the same endpoint) avoids that growth entirely.
 *
 * This loop performs the SAME whole-row profile upsert (ADR-0008) as a manual
 * rename, so it runs under the SAME fail-closed evidence rules
 * (namecard-write-guard.ts): a push happens only on affirmative evidence —
 * a conformant body whose `card` key is omitted (the fixed server's explicit
 * "no Profile yet", see profiles.rs skip_serializing_if), or a complete
 * clean card that is older than ours. Unreadable answers (404, partial or
 * wrong-typed cards, wrong identity, invalid JSON, redirects, transport
 * failures) produce ZERO pushes: the earlier push-if-absent shortcut is
 * gone, because "absent" cannot be proven by an answer we cannot read.
 */
import type { PushResult } from '../egress/event-egress.js';
import { hostDbSlug } from '../ingress/host-slug.js';
import { readHouseProfileEvidence } from './namecard-write-guard.js';
import type { MyNamecard } from './my-namecard.js';

export interface AnnounceNamecardDeps {
  /** `null` = no namecard to declare yet (placeholder guard, my-namecard.ts). */
  readonly card: MyNamecard | null;
  /** Same signed bytes pushed to every house — the namecard is a public artifact. */
  readonly signedBytes: Uint8Array;
  readonly popclawId: string;
  readonly pushTo: (houseSlug: string, bytes: Uint8Array) => Promise<PushResult>;
  readonly fetch?: typeof globalThis.fetch;
  readonly logger?: { info(m: string): void; warn(m: string): void };
}

/**
 * One house: read the evidence, then push only on affirmative proof of
 * "nothing to lose". Never throws — a house being unreachable or
 * misbehaving must not take down the tick it shares with the handshake
 * refresh. Returns whether a push was attempted (log/test signal only, per
 * spec — not whether the house accepted it).
 */
export async function ensureNamecardOnHouse(
  houseUrl: string,
  deps: Omit<AnnounceNamecardDeps, 'card'> & { card: MyNamecard },
): Promise<boolean> {
  const log = deps.logger ?? { info: () => {}, warn: () => {} };

  const evidence = await readHouseProfileEvidence(houseUrl, deps.popclawId, {
    oneLineIntro: deps.card.oneLineIntro,
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
  });
  if (evidence.status === 'blocked') {
    const line = `popclaw: namecard self-heal — ${houseUrl} ${evidence.kind} (${evidence.detail}); zero pushes this round (non-fatal)`;
    if (evidence.kind === 'unowned') log.warn(line);
    else log.info(line);
    return false;
  }
  const shouldPush =
    evidence.status === 'no-card' ||
    evidence.declaredAtMs < deps.card.declaredAt * 1000 ||
    (evidence.declaredAtMs === deps.card.declaredAt * 1000 &&
      (evidence.nickname !== deps.card.nickname || evidence.oneLineIntro !== (deps.card.oneLineIntro ?? '')));

  if (!shouldPush) return false;
  try {
    await deps.pushTo(hostDbSlug(houseUrl), deps.signedBytes);
  } catch (err) {
    log.info(`popclaw: namecard self-heal — push to ${houseUrl} failed (non-fatal), will retry next tick: ${String(err)}`);
  }
  return true;
}

/**
 * All mounted houses, each best-effort (one house misbehaving only drops
 * itself). Placeholder guard: `deps.card === null` skips the entire loop —
 * zero requests, never seeds a `ranger-xxxxxx` into any house's directory.
 */
export async function announceNamecardToHouses(
  houseUrls: readonly string[],
  deps: AnnounceNamecardDeps,
): Promise<void> {
  if (!deps.card) return;
  const card = deps.card;
  await Promise.all(houseUrls.map((url) => ensureNamecardOnHouse(url, { ...deps, card })));
}
