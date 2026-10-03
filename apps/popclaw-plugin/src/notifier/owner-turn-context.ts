/**
 * What an owner turn's prompt gets from popclaw beyond routing: the L2
 * notifications (the delivery leg, issue #221), the follow doorbell's block
 * (doorbell spec §6.4), and the order they are laid down in.
 *
 * The OpenClaw adapter in host/openclaw-prompt-hooks.ts owns
 * the host wiring, the earlier passengers (routing, language signal,
 * attachment notice, trace) and the outer try/catch; it reads its slots at
 * call time and hands the live values straight to these synchronous steps,
 * so nothing is captured at registration and nothing awaits in between.
 */

import { handoffDrainedL2 } from './l2-handoff.js';
import type { Notifier } from './notifier.js';
import type { NameChain } from '../identity/person-name.js';
import { renderNotifications } from './mcp-notice.js';
import type { ProposalsStore } from '../bonds/proposals-store.js';
import type { PendingFollowStore } from '../social-graph/pending-follow-store.js';
import { buildPendingInjection, injectionStrings } from '../newspaper/follow-injection.js';
import { ownerLang } from '../lexicon/owner-language.js';

type Log = (message: string) => void;

/**
 * The L2 delivery leg. On the owner's turn: drain, hand the batch to the
 * post-drain policy, claim a surfaced doorbell batch after rendering. Off the
 * owner's turn: leave the queue alone and say it was held.
 *
 * Synchronous on purpose: drain, render and claim must not have an await
 * between them. `drain()` is transactional, so the caller runs this after
 * every passenger that can throw.
 */
export function deliverOwnerTurnL2(deps: {
  l2Notifier: Notifier | undefined;
  ownerTurn: boolean;
  trigger: string | undefined;
  l2Proposals: ProposalsStore | undefined;
  l2NameOf: NameChain | undefined;
  /** MUST be the one instance the timer leg claims through (doorbell spec §6.4). */
  pendingFollowsForHook: PendingFollowStore | undefined;
  log: Log;
}): string {
  const { l2Notifier, ownerTurn, trigger, l2Proposals, l2NameOf, pendingFollowsForHook, log } = deps;
  let l2Block = '';
  if (l2Notifier && ownerTurn && l2Notifier.count('L2') > 0) {
    const l2Queue = l2Notifier;
    const l2Items = l2Queue.drain('L2');
    // The post-drain policy (settled-proposal drop + render-or-requeue)
    // lives in l2-handoff.ts so
    // both the policy and its failure budget are test-pinned; this
    // hook supplies only its passengers. The policy never re-queues a
    // dropped row — decided is decided — and neither does a render
    // failure resurrect one.
    l2Block = handoffDrainedL2(l2Items, {
      ...(l2Proposals ? { proposals: l2Proposals } : {}),
      render: (live) => renderNotifications(live, l2NameOf),
      requeue: (it) => {
        l2Queue.enqueue({ level: 'L2', kind: it.kind, payload: it.payload });
      },
      log: (m) => log(`${m} trigger=${trigger ?? '?'}`),
      // ── The L2 leg's mutex claim (doorbell spec §6.4) ──
      // This drain just delivered the follow_intent pointer line,
      // so the batch it describes is now surfaced: claim it through
      // the SAME store instance the timer leg claims through —
      // whoever fires first wins, the loser's claimSurface returns
      // 0 and stays silent. No text is re-sent on this path: the
      // queued item's own rendering above IS the message; the claim
      // only marks the batch so the timer leg doesn't double-ask.
      afterRender: (live) => {
        if (live.some((it) => it.kind === 'follow_intent')) {
          try {
            const claimed = pendingFollowsForHook?.claimSurface() ?? 0;
            if (claimed > 0) {
              // Bare call on purpose: the store owns its own clock
              // (unix seconds); the default exists for exactly this
              // call site (pending-follow-store's ruling 4).
              log(`popclaw: doorbell L2 claimed batch n=${claimed}`);
            }
          } catch (e2) {
            // The line is already rendered into this turn's
            // injection — do NOT re-queue an already-delivered
            // message. A failed claim only means the timer leg may
            // ask once more: the same degradation as a failed L1 send.
            log(
              `popclaw: doorbell L2 claim failed (timer leg may ask again) — ${String(e2)}`,
            );
          }
        }
      },
    });
  } else if (l2Notifier && !ownerTurn && l2Notifier.count('L2') > 0) {
    // Not the owner's turn (cron / heartbeat / memory / sub-agent), so
    // the queue is left alone. Logged because "the gate never opens" and
    // "there is nothing queued" must not look the same in a log.
    log(
      `popclaw: L2 held n=${l2Notifier.count('L2')} trigger=${trigger ?? '?'} (not the owner's turn)`,
    );
  }
  return l2Block;
}

/**
 * The follow doorbell's context block: owner-turn gated and read-only on the
 * store. Never throws — it runs after the drain, where a throw would cost the
 * owner the notifications just taken; the worst case is an empty string.
 */
export function pendingFollowsBlock(deps: {
  pendingFollowsForHook: PendingFollowStore | undefined;
  ownerTurn: boolean;
  log: Log;
}): string {
  const { pendingFollowsForHook, ownerTurn, log } = deps;
  let pendingBlock = '';
  if (pendingFollowsForHook && ownerTurn) {
    try {
      const rows = pendingFollowsForHook.listPending();
      pendingBlock = buildPendingInjection(rows, injectionStrings(ownerLang()));
      if (pendingBlock) {
        const mode = rows.some((r) => r.first_surfaced_ts === null) ? 'full' : 'pointer';
        log(`popclaw: doorbell injection mode=${mode} n=${rows.length}`);
      }
    } catch (err) {
      pendingBlock = '';
      log(`popclaw: doorbell injection skipped (non-fatal) — ${String(err)}`);
    }
  }
  return pendingBlock;
}

/** The routing result fields this composition reads. */
export interface RoutingInjection {
  prependContext?: string;
  appendSystemContext?: string;
}

/**
 * Lay the turn's context down: attachment notice, L2 block, doorbell block,
 * routing prepend — in that order — plus routing's system append. Nothing to
 * say → undefined. Picks fields explicitly: routing's `hits` are evidence for
 * logs only, and the host recognizes only its own fields.
 */
export function composeTurnContext(parts: {
  notice: string | undefined;
  l2Block: string;
  pendingBlock: string;
  injection: RoutingInjection | undefined;
}): { appendSystemContext?: string; prependContext?: string } | undefined {
  const { notice, l2Block, pendingBlock, injection } = parts;
  const prependContext = [notice, l2Block, pendingBlock, injection?.prependContext]
    .filter(Boolean)
    .join('\n');
  if (!injection?.appendSystemContext && !prependContext) return undefined;
  return {
    ...(injection?.appendSystemContext
      ? { appendSystemContext: injection.appendSystemContext }
      : {}),
    ...(prependContext ? { prependContext } : {}),
  };
}
