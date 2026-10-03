import { isConfirmWord, isDenyWord, isProceedKeyword, isYouDecide } from './answer-keywords.js';
import { isPlaceholderNickname } from './identity-writer.js';
import { parseNameAnswer } from './name-answer.js';

export interface ArrivalAnswerInput {
  readonly candidates: readonly string[];
  readonly pendingName?: string;
  readonly action: 'next' | 'skip';
  /** The owner's answer, already trimmed by handleAdvance. */
  readonly answer: string;
}

export type ArrivalDecision = (
  | { kind: 'offerCandidates' }
  | { kind: 'repeatCandidates' }
  | { kind: 'repeatConfirmation'; name: string }
  | { kind: 'askConfirmation'; name: string }
  | { kind: 'adopt'; name: string; fromCandidate: boolean }
  | { kind: 'retry'; reason: 'digit' | 'sentence' | 'tooLong' | 'placeholder' }
) & {
  /** Clear the old pending draft before executing this decision. A replacement
   *  requires a separate write, so a failed clear cannot install a new name. */
  invalidatePending: boolean;
};

/**
 * Synchronous naming policy, with no draft writes or identity effects.
 * Free text only asks for confirmation; an explicit yes is bound to the exact
 * persisted pending value. Parsing and validity stay in the shared name rules.
 */
export function interpretArrivalAnswer({ candidates, pendingName, action, answer }: ArrivalAnswerInput): ArrivalDecision {
  if (candidates.length === 0) return { kind: 'offerCandidates', invalidatePending: false };
  // Skip precedes confirmation: use the first candidate even with a pending name.
  if (action === 'skip') return { kind: 'adopt', name: candidates[0]!, fromCandidate: true, invalidatePending: false };

  const invalidatePending = pendingName !== undefined;
  if (pendingName !== undefined) {
    // `1` answers the confirmation card, never the original candidates card.
    if (answer === '1' || isConfirmWord(answer) || isProceedKeyword(answer)) {
      return { kind: 'adopt', name: pendingName, fromCandidate: candidates.includes(pendingName), invalidatePending: false };
    }
    if (isDenyWord(answer)) return { kind: 'repeatCandidates', invalidatePending: true };
    if (!answer) return { kind: 'repeatConfirmation', name: pendingName, invalidatePending: false };
  } else if (isDenyWord(answer) || isConfirmWord(answer)) {
    return { kind: 'repeatCandidates', invalidatePending: false };
  }

  if (!answer || isYouDecide(answer) || isProceedKeyword(answer)) {
    return { kind: 'adopt', name: candidates[0]!, fromCandidate: true, invalidatePending };
  }
  if (/^\d+$/.test(answer)) {
    const picked = candidates[Number(answer) - 1];
    return picked
      ? { kind: 'adopt', name: picked, fromCandidate: true, invalidatePending }
      : { kind: 'retry', reason: 'digit', invalidatePending };
  }
  if (isPlaceholderNickname(answer)) return { kind: 'retry', reason: 'placeholder', invalidatePending };
  const typed = candidates.find((c) => c.toLowerCase() === answer.toLowerCase());
  if (typed !== undefined) return { kind: 'adopt', name: typed, fromCandidate: true, invalidatePending };
  const parsed = parseNameAnswer(answer);
  if (parsed.kind === 'unclear') return { kind: 'retry', reason: parsed.reason, invalidatePending };
  if (parsed.kind === 'candidate') {
    const picked = candidates[parsed.index - 1];
    return picked
      ? { kind: 'adopt', name: picked, fromCandidate: true, invalidatePending }
      : { kind: 'retry', reason: 'digit', invalidatePending };
  }
  return { kind: 'askConfirmation', name: parsed.name, invalidatePending };
}
