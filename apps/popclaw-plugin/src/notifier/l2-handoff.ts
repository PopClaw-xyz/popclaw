/**
 * The L2 delivery leg for plugin hosts (issue #221).
 *
 * ADR-0012 defines L2 as "write the queue, **wait for the owner's next turn**",
 * and the amendment that added `followed_you` says why: being followed is good
 * news but not a task, and *the interruption count is held by other people, not
 * by the owner* — so it must be batched. That rules out the fix the issue text
 * proposed ("drain on the cadence heartbeat"): a timer turns L2 into L1, which
 * is the exact abuse the ADR exists to prevent.
 *
 * So the leg hangs off the moment the owner actually speaks: the plugin host's
 * `before_prompt_build` hook. Pending L2 goes in front of the model as context,
 * and the agent relays it in its own words — which is `notifier.ts`'s own
 * contract, verbatim: `drain() is called on owner's next interaction`.
 *
 * ## Why the gate is not optional
 *
 * That hook fires for **every** prompt build — cron runs, heartbeats, memory
 * flushes, sub-agent turns. Draining on any of those hands the owner's
 * notifications to a machine turn nobody reads, and `drain()` is transactional:
 * once marked delivered, the batch is gone. So the gate is fail-closed — an
 * unrecognised trigger drains nothing and the items simply wait.
 *
 * ## The ceiling, stated honestly
 *
 * "Injected into the prompt" is not "the agent told the owner". If the turn is
 * discarded, that batch is lost. That is acceptable **here specifically**
 * because every L2 kind's underlying fact is durable somewhere else — echoes in
 * `reply_pings`, new followers in the known-follower set and the social log,
 * bond proposals in their own store behind `/popclaw review`. What a lost batch
 * costs is the reminder, never the fact.
 *
 * ponytail: no per-item acknowledgement. If L2 ever carries something whose only
 * copy is the queue row, this needs two-phase (hand off → confirm) instead.
 */

/** Triggers that mean a human started this run. Anything else — `cron`,
 *  `heartbeat`, `memory`, `overflow`, or a value we have never seen — is a
 *  machine turn and must not consume the owner's queue. */
const OWNER_INITIATED = new Set(['user', 'manual']);

/** A sub-agent's session key carries a `subagent:` segment (host convention). */
function isSubagentSession(sessionKey: string | undefined): boolean {
  return sessionKey !== undefined && sessionKey.includes('subagent:');
}

export interface L2HandoffContext {
  readonly trigger?: string;
  readonly sessionKey?: string;
}

/**
 * Whether this turn is the owner's own — the only kind allowed to drain L2.
 *
 * Fail-closed on purpose: `trigger` is typed as a bare `string` in the 7.1 SDK,
 * so a host that reports something new must cost us a queued batch, never a
 * silently swallowed one.
 */
export function isOwnerTurn(ctx: L2HandoffContext | undefined): boolean {
  if (!ctx) return false;
  if (isSubagentSession(ctx.sessionKey)) return false;
  return ctx.trigger !== undefined && OWNER_INITIATED.has(ctx.trigger);
}

// ---------------------------------------------------------------------------
// The leg AFTER the drain: what happens
// to a batch the gate already let through. Kept here — the L2 policy home — so
// both the settled-proposal drop and the render-failure budget are test-pinned
// independent of the two host legs that use them (index.ts, mcp-notice.ts).
// ---------------------------------------------------------------------------

import type { NotificationItem } from './types.js';
import { BOND_TIERS, type BondTier } from '../bonds/bond-tier.js';

/** The proposals-store surface the delivery paths need — one live check. */
export interface ProposalLiveness {
  hasPendingFor(popclawId: string, toTier: BondTier): boolean;
}

/**
 * Drop `bond_proposal` items whose underlying proposal is no longer pending: a
 * proposal decided between enqueue and hand-off — via `/popclaw review` or the
 * decide tool — must not reach the owner as a fresh suggestion about a question
 * already answered. The fact stays durable behind `/popclaw review`; only the
 * reminder is dropped.
 *
 * Never throws and never drops on doubt: this runs between `drain()` (rows
 * already marked delivered) and the render try/catch, so a throw here would
 * cost the owner the whole batch. No store, a store that errors, a payload we
 * don't recognize (missing/unknown tier, null payload) — all mean DELIVER,
 * same as no store at all.
 */
export function dropSettledBondProposals(
  items: NotificationItem[],
  proposals?: ProposalLiveness,
): NotificationItem[] {
  if (!proposals) return items;
  return items.filter((it) => {
    if (it.kind !== 'bond_proposal') return true;
    try {
      const id = it.payload['popclawId'];
      const tier = it.payload['toTier'];
      if (typeof id !== 'string' || typeof tier !== 'string') return true;
      if (!(BOND_TIERS as readonly string[]).includes(tier)) return true;
      return proposals.hasPendingFor(id, tier as BondTier);
    } catch {
      return true;
    }
  });
}

/** What a host leg supplies to `handoffDrainedL2` — its passengers, not policy. */
export interface L2HandoffDeps {
  /** The proposals store for the settled-proposal drop; absent = deliver as-is. */
  proposals?: ProposalLiveness;
  /** Render the LIVE batch into the owner-facing context block. */
  render: (live: NotificationItem[]) => string;
  /** Put one item back after a failed render — the "leave it in the queue" rule. */
  requeue: (item: NotificationItem) => void;
  /**
   * One line per outcome (handed off / dropped / re-queued). info, never warn:
   * hosts send warn/error to the stderr black hole, and these lines are the
   * only way a real machine can answer "did the leg ever run?".
   */
  log: (message: string) => void;
  /**
   * A passenger that rides after a SUCCESSFUL render (the doorbell mutex
   * claim). Runs outside the requeue budget: a throwing callback must not
   * re-queue an already-delivered batch — callers keep their own try/catch.
   */
  afterRender?: (live: NotificationItem[]) => void;
}

/**
 * Post-drain policy of the L2 leg: filter out settled proposals, render what
 * is left, and on a render that throws put the LIVE items back verbatim —
 * dropped rows never resurrect. Returns the context block ('' = nothing to
 * say; an all-settled batch is silence, and that silence is the point).
 */
export function handoffDrainedL2(items: NotificationItem[], deps: L2HandoffDeps): string {
  const live = dropSettledBondProposals(items, deps.proposals);
  if (live.length === 0) {
    if (items.length > 0) {
      deps.log(`popclaw: L2 dropped n=${items.length} (settled before hand-off)`);
    }
    return '';
  }
  let block: string;
  try {
    block = deps.render(live);
    deps.log(
      `popclaw: L2 handed off n=${live.length}` +
        (live.length < items.length ? ` dropped=${items.length - live.length} (settled)` : ''),
    );
  } catch (e) {
    // Rendering blew up AFTER the rows were marked delivered. Put them back
    // verbatim — the same "leave it in the queue" rule the L1 leg follows on
    // a failed send. Only the LIVE items: settled is settled.
    for (const it of live) {
      deps.requeue(it);
    }
    deps.log(`popclaw: L2 handoff re-queued n=${live.length} — ${String(e)}`);
    return '';
  }
  deps.afterRender?.(live);
  return block;
}
