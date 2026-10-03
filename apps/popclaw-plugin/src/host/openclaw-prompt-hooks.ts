/**
 * Complete OpenClaw prompt sequence. Registration performs no IO and never
 * ignites runtime. The root owns slot assignment/reset and lifecycle; this
 * adapter reads current slots on each turn. Use the typed api.on surface.
 * All throwing passengers precede transactional L2 drain. Drain/render/claim
 * stay synchronous; the pending-follow passenger keeps its independent catch.
 * See ../../docs/openclaw-prompt-hooks.md for the sequence and host rationale.
 */
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/plugin-entry';
import type { PopclawPaths } from './popclaw-paths.js';
import type { Notifier } from '../notifier/notifier.js';
import type { NameChain } from '../identity/person-name.js';
import type { ProposalsStore } from '../bonds/proposals-store.js';
import type { PendingFollowStore } from '../social-graph/pending-follow-store.js';
import { configuredRoutingHouseOrigins } from '../routing/native-world-config.js';
import { buildInjection, recentAttachmentNotice } from '../routing/inject.js';
import { isOwnerTurn } from '../notifier/l2-handoff.js';
import { composeTurnContext, deliverOwnerTurnL2, pendingFollowsBlock } from '../notifier/owner-turn-context.js';
import { loadHouseLexicon } from '../routing/house-lexicon.js';
import { markRoutingMode, noteRoutingFire, noteRoutingL2Hits, routingStats, type RoutingMode } from '../routing/stats.js';
import { formatRoutingTrace, ROUTING_TRACE, sampleOwnerText } from '../routing/trace.js';
import { trace, traceStatusLabel } from '../observability/trace.js';
import { hostToolResultCap, noteContextTokenBudget } from '../newspaper/host-budget.js';
import { recentInboundAttachments } from '../notifier/media-staging.js';
import { observeOwnerText } from '../lexicon/owner-language.js';

/** Narrow lazy capabilities, not a runtime bag. Readers do not boot runtime. */
export interface OpenClawPromptHookPorts {
  routingPaths(): PopclawPaths;
  runtimeConfig(): unknown;
  readonly inboundMediaDirs: readonly string[];
  notifierForTurn(): Notifier | undefined;
  proposalsForTurn(): ProposalsStore | undefined;
  namesForTurn(): NameChain | undefined;
  pendingFollowsForTurn(): PendingFollowStore | undefined;
}

// A file older than ten minutes no longer occupies each turn's attention.
const RECENT_ATTACHMENT_WINDOW_MS = 10 * 60 * 1000;

/** Registration verdict is separate from the registered handler's return fields. */
export function registerOpenClawPromptHooks(
  api: Pick<OpenClawPluginApi, 'on' | 'logger'>,
  ports: OpenClawPromptHookPorts,
): RoutingMode {
  let routingMode: RoutingMode = process.env.POPCLAW_TOOL_ROUTING === 'off' ? 'off' : 'wired';
  // Registered even with the power-cut gate on: the attachment notice is
  // not routing policy (see below), so turning routing off must not turn it off too.
  try {
    let l1Logged = false;
    // Budgets are session-specific; a workshop must not retune its parent chat.
    // Announce once per verbatim session key, capped at 64 to bound this set.
    // Synchronization continues after the announcement cap is reached.
    const budgetAnnounced = new Set<string>();
    const BUDGET_ANNOUNCE_CAP = 64;
    api.on('model_call_started', (event) => {
      const tokens = (event as { contextTokenBudget?: number }).contextTokenBudget;
      // Bucketed by sessionKey (dedicated-session cut 1, 2026-09-03): the chat
      // session and the newspaper workshop can sit on different models, and a
      // single process-wide number let whichever had a model call last re-tune
      // the other's page trimming. No sessionKey on the event → default bucket.
      const sessionKey = (event as { sessionKey?: string }).sessionKey;
      noteContextTokenBudget(sessionKey, tokens);
      // The bucket key verbatim, quoted: the page builders log the key THEY looked up
      // under, and the whole point is that a human can compare the two character by
      // character. An event with no sessionKey reads as `""` — which is the default
      // bucket, the very thing it lands in.
      const announceKey = sessionKey ?? '';
      if (tokens && !budgetAnnounced.has(announceKey) && budgetAnnounced.size < BUDGET_ANNOUNCE_CAP) {
        budgetAnnounced.add(announceKey);
        // info, never warn: an MCP host swallows warn and error entirely, and this line is
        // the only way a real machine can be checked for "did the hook ever fire".
        api.logger.info(
          `popclaw: newspaper budget synced — session "${announceKey}" — context ${tokens} tokens → ${hostToolResultCap(tokens)} units per tool result`,
        );
      }
    });

    let routingPaths: PopclawPaths | undefined;
    api.on('before_prompt_build', (event, ctx) => {
      // Chain self-reporting: whether or not the injection actually succeeds,
      // the fact that "the host really did call me" is itself evidence.
      noteRoutingFire();
      const fire = routingStats().fireCount;
      // A broken routing hook must never affect the conversation: the whole
      // handler is wrapped in try/catch, and the worst case is that nothing gets injected.
      try {
        const l2Notifier = ports.notifierForTurn();
        // A free per-turn live language signal: what language the owner's
        // words this turn were written in (S1). Zero LLM calls, zero IO
        // (only writes a small file when the language actually changes), and
        // doesn't affect the injection below.
        const lang = observeOwnerText(event?.prompt ?? '');
        routingPaths ??= ports.routingPaths();
        const house = loadHouseLexicon(routingPaths);
        const injection = buildInjection(event?.prompt ?? '', { extra: house, knownHouseOrigins: configuredRoutingHouseOrigins(ports.runtimeConfig()) });
        // "The owner just handed you a file" is placed directly in front of
        // the model (rationale in recentAttachmentNotice). Merged in with the
        // routing injection: still reported even when routing is turned off —
        // this line is a fact, not routing policy.
        const files = recentInboundAttachments(ports.inboundMediaDirs, {
          limit: 3,
          newerThanMs: RECENT_ATTACHMENT_WINDOW_MS,
        });
        const notice = recentAttachmentNotice(files, Date.now());
        // The host sends warn/error to /dev/null; info is the only visible
        // level (ADR-0043 §6): without these two lines, "the hook is gated
        // off by allowPromptInjection" and "working normally" look identical
        // in the log, and a real-hardware A/B test can't tell them apart. L1
        // only logs once, on first injection; a miss doesn't spam the log.
        const hits = injection?.hits ?? [];
        if (injection && !l1Logged) {
          api.logger.info('popclaw: routing L1 injected');
          l1Logged = true;
        }
        if (hits.length) {
          noteRoutingL2Hits(hits.length);
          api.logger.info(`popclaw: routing L2 hit=${hits.map((h) => h.tool).join(',')}`);
        }
        // Lazy trace formatting costs nothing when disabled. Record constants and
        // counts; owner text sampling obeys the existing trace privacy switch.
        trace(ROUTING_TRACE, (m) => api.logger.info(m), () =>
          formatRoutingTrace({
            fire,
            l1: Boolean(injection),
            l2: hits,
            house: {
              entries: house.length,
              slugs: [...new Set(house.flatMap((e) => (e.from ? [e.from] : [])))],
            },
            lang,
            attachments: notice ? files.length : 0,
            envelope: {
              stripped: routingStats().envelopeStripped,
              seen: routingStats().envelopeSeen,
            },
            ownerTextSample: sampleOwnerText(event?.prompt),
          }),
        );
        // composeTurnContext picks the host's fields explicitly — `hits` is
        // only evidence for the logs/trace above.
        // ── The fourth passenger: L2's delivery leg (issue #221) ──
        // LAST of the throw-entitled passengers, deliberately. `drain()` is
        // transactional — once it marks a batch delivered it is gone — so it
        // must sit after every passenger that can throw. Anything above this
        // line failing costs an injection; a throw between drain and return
        // would cost the owner their notifications, so every passenger after
        // the drain (the fifth one below) keeps its own try/catch and can
        // only ever degrade to an empty string.
        const ownerTurn = isOwnerTurn(ctx);
        // Read current optional slots before drain; registration never captures them.
        const l2Proposals = ports.proposalsForTurn();
        const l2NameOf = ports.namesForTurn();
        const pendingFollowsForHook = ports.pendingFollowsForTurn();
        const l2Block = deliverOwnerTurnL2({
          l2Notifier,
          ownerTurn,
          trigger: ctx?.trigger,
          l2Proposals,
          l2NameOf,
          pendingFollowsForHook,
          log: (m) => api.logger.info(m),
        });

        // ── The fifth passenger: the follow doorbell's context injection
        // (doorbell spec §6.4) ──
        // Owner-turn gated like its L2 sibling above, and READ-ONLY on the
        // store: the L2 claim just above (or the timer leg's) is what moves
        // a batch to "surfaced" — this block only reflects the resulting
        // state (un-surfaced → full list + rules; surfaced → pointer + one
        // compact name line; nothing pending → ''). Own try/catch on
        // purpose: this sits in the post-drain window, where a throw would
        // cost the owner the notifications just drained — worst case here
        // is an empty string.
        const pendingBlock = pendingFollowsBlock({
          pendingFollowsForHook,
          ownerTurn,
          log: (m) => api.logger.info(m),
        });

        return composeTurnContext({ notice, l2Block, pendingBlock, injection });
      } catch (err) {
        api.logger.warn(`popclaw: routing hook failed (non-fatal): ${String(err)}`);
        return undefined;
      }
    });
  } catch (err) {
    // Reaching here = the host failed even the typed-hook registration
    // surface. register() must not throw (ADR-0035); just leave evidence:
    // L1/L2, the live language signal, and the attachment notice are all
    // gone for this deployment.
    routingMode = 'unavailable';
    api.logger.error(`popclaw: before_prompt_build registration failed — ${String(err)}`);
  }
  markRoutingMode(routingMode);
  api.logger.info(
    `${
      routingMode === 'wired'
        ? 'popclaw: routing wired via api.on(before_prompt_build)'
        : routingMode === 'off'
          ? 'popclaw: routing off (POPCLAW_TOOL_ROUTING=off)'
          : 'popclaw: routing unavailable (hook registration failed) — L1/L2 off'
      // Whether this machine is leaving a trace is spelled out on the same
      // line; otherwise someone has to guess "didn't happen, or wasn't recorded?" again.
    } · trace=${traceStatusLabel()}`,
  );

  return routingMode;
}
