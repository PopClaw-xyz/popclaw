/**
 * /popclaw inbox [--limit=N]
 *
 * List recent direct messages received from other popclaw
 * users. Reads via `InboxStore.recent()` (the `inbox` table in the social DB).
 *
 * Lists received messages without a per-conversation policy filter.
 *
 * ⚠️ The bond-context trailer line (2026-07-29, bonds/bond-context.ts) is **deliberately not added here**.
 * It's for **proactive notifications**: in that moment the owner sees only a name and needs a quick reminder
 * of who this person is. This list is already dense (N items × one line each); adding a bond line to every
 * entry would just crush it. If you really want to look closely at someone, `/popclaw bond` and `find_bonds`
 * exist exactly for that.
 */

import type { InboxStore, InboxItem } from '../messaging/inbox-store.js';
import { displayNamed, type NameChain } from '../identity/person-name.js';
import { timeContext } from '../time/time-context.js';
import { renderCopy, type Lang } from '../lexicon/index.js';
import { ownerLang } from '../lexicon/owner-language.js';

export interface PopclawInboxArgs {
  positional: string[];
  flags: Record<string, string>;
}

export interface PopclawInboxDeps {
  store: InboxStore;
  /** The unique name chain (alias > self-reported name > handle); if not injected, only reports `#sigil`. */
  nameOf?: NameChain;
  /** S3 rollout — defaults to `ownerLang()` (S1 process-wide singleton). */
  lang?: Lang;
}

const DEFAULT_LIMIT = 20;

export async function runPopclawInboxCommand(
  args: PopclawInboxArgs,
  deps: PopclawInboxDeps,
): Promise<{ text: string }> {
  const limitRaw = args.flags.limit;
  const limit = limitRaw ? Math.max(1, Math.min(200, Number.parseInt(limitRaw, 10) || DEFAULT_LIMIT)) : DEFAULT_LIMIT;
  const items = deps.store.recent(limit);

  if (items.length === 0) {
    return { text: '(inbox is empty — no popclaw users have sent you a DM yet)' };
  }

  const lang = deps.lang ?? ownerLang();
  const lines: string[] = [`📥 ${items.length} DM${items.length === 1 ? '' : 's'} (newest first):`, ''];
  for (const it of items) {
    lines.push(formatItem(it, deps.nameOf, lang));
  }
  return { text: lines.join('\n') };
}

function formatItem(it: InboxItem, nameOf: NameChain | undefined, lang: Lang): string {
  // `name#sigil`; if the registry has no match, only reports `#sigil` (ADR-0032). This used to
  // fall back to the id's `first6…last4` -- that string was meaningless to the owner and didn't
  // even let them tell whether it was the same person.
  // #281: the sender's own name is the chain's lowest tier — a bond-book name
  // still wins, and the sigil suffix means a borrowed name is visible as one.
  const sender = displayNamed(it.fromPopclawId, nameOf, it.senderNickname);
  const when = formatTs(it.ts);
  const replyMarker = it.inReplyToPostId
    ? ` (re: ${it.inReplyToPlatform || '?'}:${it.inReplyToPostId})`
    : '';
  // If there's an image, give the on-disk path as-is -- the agent can view/forward it directly, and the owner can open it directly.
  const media = it.mediaPath ? `      ${renderCopy(lang, 'inbox.media', { path: it.mediaPath })}` : '';
  // A pure-image DM has an empty body string -- that line is omitted entirely (otherwise the list would show a line of 6 spaces).
  const bodyLine = it.body ? `      ${it.body}` : '';
  return [`  [${when}] ${sender}${replyMarker}`, bodyLine, media].filter(Boolean).join('\n');
}

function formatTs(ts: number): string {
  if (!Number.isFinite(ts)) return String(ts);
  // `YYYY-MM-DD HH:MM`, in the owner's local timezone (ADR-0045: all display goes through timeContext).
  const c = timeContext(ts);
  return `${c.ymd} ${c.hm}`;
}
