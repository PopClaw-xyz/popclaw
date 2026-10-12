/** A presentation unit over the immutable issue, never a selection or publication limit. */
import { needsEditorial, numberedPulse, type IssueData, type PulseItem } from './issue.js';
import { pageBudgetNow } from './host-budget.js';
import { weightedChars } from './reading-weight.js';

const MAX_ITEMS = 12;
const SOURCE_UNITS = 12_000;

/** Preserve material order and whole sources. One oversized source is read through continuations. */
export function writingPacket(issue: IssueData, pending: readonly number[], sessionKey?: string): { p: PulseItem; n: number }[] {
  const wanted = new Set(pending);
  const unitBudget = Math.min(SOURCE_UNITS, Math.max(1, Math.floor(pageBudgetNow(sessionKey) / 4)));
  const packet: { p: PulseItem; n: number }[] = [];
  let used = 0;
  for (const entry of numberedPulse(issue.pulse)) {
    if (!wanted.has(entry.n) || !needsEditorial(entry.p)) continue;
    const weight = weightedChars(entry.p.text);
    if (packet.length && (packet.length >= MAX_ITEMS || used + weight > unitBudget)) break;
    packet.push(entry);
    used += weight;
  }
  return packet;
}
