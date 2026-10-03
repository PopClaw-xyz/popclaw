import { renderCopy, type Lang } from '../lexicon/index.js';
import { BROKEN_AFTER, type RoutingStats } from './stats.js';

/**
 * The **short multi-line summary** that tool routing (ADR-0043) reports about
 * itself: a self-sufficient conclusion line first, then detail/action lines
 * (ledger #013 — the old single line ran past a phone line in every state).
 * Still no dumping of raw data; details are left to per-call tracing via
 * `POPCLAW_ROUTING_TRACE=1`.
 *
 * Why this belongs in the check-up report: #374's failure mode was completely
 * silent — the hook was wired to the wrong namespace, L1/L2 fired zero times
 * for three weeks, and nothing in the logs looked abnormal. One command
 * should give the owner the conclusion, rather than making them go read
 * gateway logs.
 */
export function routingLine(s: RoutingStats, lang: Lang): string {
  if (s.mode === 'off') return renderCopy(lang, 'status.routing.off');
  if (s.mode === 'unavailable') return renderCopy(lang, 'status.routing.unavailable');
  if (s.fireCount > 0) {
    return renderCopy(lang, 'status.routing.ok', {
      hits: String(s.l2HitCount),
      turns: String(s.fireCount),
    });
  }
  // Wired up but never triggered once: enough inbound turns means the pipeline
  // is broken (before_dispatch is the control group), not enough yet just
  // means "freshly started" — the two must never be reported as the same thing.
  return renderCopy(
    lang,
    s.inboundCount >= BROKEN_AFTER ? 'status.routing.broken' : 'status.routing.pending',
    { turns: String(s.inboundCount) },
  );
}
