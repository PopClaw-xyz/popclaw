/**
 * Hard gate: while onboarding is in progress, the plugin directly claims the
 * owner's **closed-set short replies**, and the agent does not run this turn.
 *
 * Incident (2026-07-29, host-c's machine): the agent had its own question
 * pending before `/popclaw start` ("should I put out a paper edition for
 * review?"). After the naming card appeared, the owner replied "1", and the
 * agent attributed that "1" to its own more-recent pending question and went
 * off to render the paper — the naming got hijacked. One input box, two
 * conversations; the "short replies route to onboarding first" note in the
 * tool description is only a soft constraint, and it loses to the agent's
 * own context.
 *
 * The gate only grabs the **conflict-prone** class: bare numbers + the
 * existing closed-set keywords + "mark N / not for me N". Free text is
 * always passed through — a self-chosen name is free text, but free text
 * could equally be the owner saying something else to the agent entirely,
 * and that routing decision is left to the agent. Slash commands have their
 * own channel and are also passed through.
 *
 * Hooked into the SDK's `before_dispatch` rather than `inbound_claim`:
 * verified across two versions — 2026.6.6 (the SDK the plugin pins) and
 * 2026.7.1 (this machine's gateway) — `inbound_claim` only runs when the
 * session is exclusively held by a plugin binding (the only call site in
 * dispatch-*.js is runInboundClaimForPluginOutcome), so an ordinary owner DM
 * never reaches it at all; `before_dispatch` is the point every ordinary
 * inbound message must pass through, and returning `{handled:true, text}`
 * means the text goes straight to the owner and the agent does not run this
 * turn (in the same dispatch code path, that goes through sendFinalPayload +
 * recordProcessed("completed", reason:"before_dispatch_handled")).
 */

import type { OnboardingStage } from './stages.js';
import {
  isProceedKeyword,
  isConfirmWord,
  isDenyWord,
  isYouDecide,
  isBailKeyword,
  isRenameRequest,
  isSkipWord,
  matchMark,
  matchMeh,
} from './answer-keywords.js';

// The three "skip" / "mark N" / "not for me N" word-lists all live in
// answer-keywords.ts (the cross-language union, S5) — here we only borrow
// the same matcher, never write a second copy of the regex: one divergence
// between two copies was already one too many.
export { isSkipWord } from './answer-keywords.js';

/**
 * Whether this inbound message should be claimed by onboarding. Pure
 * function, no side effects.
 *
 * @param stage Current act; `null` / idle / completed = always pass through (once graduated, never touched again).
 */
export function classifyOnboardingClaim(
  stage: OnboardingStage | null,
  content: string,
  namePending: boolean | (() => boolean) = false,
): 'claim' | 'pass' {
  if (stage === null || stage === 'idle' || stage === 'completed') return 'pass';

  const a = content.trim();
  if (a.length === 0) return 'pass';
  if (a.startsWith('/')) return 'pass';

  if (/^\d{1,2}$/.test(a)) return 'claim';
  if (isSkipWord(a)) return 'claim';
  if (isProceedKeyword(a)) return 'claim';
  if (isYouDecide(a)) return 'claim';
  if (isBailKeyword(a)) return 'claim';
  if (isRenameRequest(a)) return 'claim';
  if (matchMark(a) !== null || matchMeh(a) !== null) return 'claim';
  // A plain-chat yes / no to the name confirmation card (either lane) must
  // reach the card, not the agent (N1) — but only while a name is actually
  // pending on it. Anywhere else these words are ordinary conversation.
  if (stage === 'arrival' && (isConfirmWord(a) || isDenyWord(a)) && readPending(namePending)) return 'claim';

  return 'pass';
}

/** Read lazily, and a failure reads as "nothing pending": it can only ever
 *  narrow what the gate claims, never stop it claiming a bare `1`. */
function readPending(namePending: boolean | (() => boolean)): boolean {
  if (typeof namePending === 'boolean') return namePending;
  try {
    return namePending() === true;
  } catch {
    return false;
  }
}

export interface OnboardingClaimDeps {
  /** Current act; if the orchestrator isn't up yet → returns null (the gate is entirely inactive). */
  readonly stage: () => OnboardingStage | null;
  /** Whether a name is waiting on the naming confirmation card. Absent = never. */
  readonly namePending?: () => boolean;
  readonly advance: (action: 'next' | 'skip', answer: string) => Promise<{ text: string }>;
  readonly log?: (msg: string) => void;
}

/** The handful of fields we actually use from the SDK's `before_dispatch` event. */
export interface InboundClaimEventLike {
  readonly content?: string;
  readonly body?: string;
  readonly isGroup?: boolean;
}

/**
 * `before_dispatch` handler. Claim → `{handled:true, text}`; everything else
 * returns `undefined` (= pass through). **Any exception is swallowed and
 * returns undefined**: a fast-path gate must never break normal chat.
 */
export async function claimOnboardingInbound(
  event: InboundClaimEventLike,
  deps: OnboardingClaimDeps,
): Promise<{ handled: true; text: string } | undefined> {
  try {
    if (event.isGroup === true) return undefined;
    const content = (event.content ?? event.body ?? '').trim();
    const stage = deps.stage();
    if (classifyOnboardingClaim(stage, content, deps.namePending ?? false) === 'pass') return undefined;

    const result = await deps.advance(isSkipWord(content) ? 'skip' : 'next', content);
    deps.log?.(`popclaw: onboarding claimed inbound "${content}" at stage ${stage}`);
    return { handled: true, text: result.text };
  } catch {
    return undefined;
  }
}
