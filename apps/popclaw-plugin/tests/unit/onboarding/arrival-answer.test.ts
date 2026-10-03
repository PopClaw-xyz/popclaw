import { describe, expect, it } from 'vitest';
import { interpretArrivalAnswer, type ArrivalAnswerInput, type ArrivalDecision } from '../../../src/onboarding/arrival-answer.js';

const candidates = ['First', 'Second', 'Third'];
type Case = [label: string, input: Partial<ArrivalAnswerInput>, expected: ArrivalDecision];
const cases: Case[] = [
  ['offer before skip or confirmation', { candidates: [], pendingName: 'Pending', action: 'skip', answer: '1' }, { kind: 'offerCandidates', invalidatePending: false }],
  ['offer before free text', { candidates: [] }, { kind: 'offerCandidates', invalidatePending: false }],
  ['skip precedes pending', { pendingName: 'Pending', action: 'skip', answer: 'no' }, { kind: 'adopt', name: 'First', fromCandidate: true, invalidatePending: false }],
  ['empty answer chooses first', { answer: '' }, { kind: 'adopt', name: 'First', fromCandidate: true, invalidatePending: false }],
  ['delegate choice', { answer: 'you decide' }, { kind: 'adopt', name: 'First', fromCandidate: true, invalidatePending: false }],
  ['Chinese delegate choice', { answer: '你定' }, { kind: 'adopt', name: 'First', fromCandidate: true, invalidatePending: false }],
  ['proceed chooses first', { answer: 'continue' }, { kind: 'adopt', name: 'First', fromCandidate: true, invalidatePending: false }],
  ['first number', { answer: '1' }, { kind: 'adopt', name: 'First', fromCandidate: true, invalidatePending: false }],
  ['second number', { answer: '2' }, { kind: 'adopt', name: 'Second', fromCandidate: true, invalidatePending: false }],
  ['zero is no name', { answer: '0' }, { kind: 'retry', reason: 'digit', invalidatePending: false }],
  ['out of range is no name', { answer: '99' }, { kind: 'retry', reason: 'digit', invalidatePending: false }],
  ['large number is no name', { answer: '9'.repeat(400) }, { kind: 'retry', reason: 'digit', invalidatePending: false }],
  ['typed candidate preserves spelling', { answer: 'sEcOnD' }, { kind: 'adopt', name: 'Second', fromCandidate: true, invalidatePending: false }],
  ['English ordinal', { answer: 'the second one' }, { kind: 'adopt', name: 'Second', fromCandidate: true, invalidatePending: false }],
  ['Chinese ordinal', { answer: '第三个' }, { kind: 'adopt', name: 'Third', fromCandidate: true, invalidatePending: false }],
  ['ordinal outside supplied list', { candidates: ['First'], answer: 'the second one' }, { kind: 'retry', reason: 'digit', invalidatePending: false }],
  ['unresolved ordinal sentence', { answer: 'maybe the second one tomorrow' }, { kind: 'retry', reason: 'sentence', invalidatePending: false }],
  ['free name requires yes', { answer: 'Kuroba' }, { kind: 'askConfirmation', name: 'Kuroba', invalidatePending: false }],
  ['stated name requires yes', { answer: 'my name is Kuroba' }, { kind: 'askConfirmation', name: 'Kuroba', invalidatePending: false }],
  ['unknown language remains pending', { answer: 'Mi nombre es Kuroba' }, { kind: 'askConfirmation', name: 'Mi nombre es Kuroba', invalidatePending: false }],
  ['placeholder', { answer: 'ranger-123456' }, { kind: 'retry', reason: 'placeholder', invalidatePending: false }],
  ['too long', { answer: 'a'.repeat(33) }, { kind: 'retry', reason: 'tooLong', invalidatePending: false }],
  ['UTF-16 limit exceeded', { answer: '😀'.repeat(17) }, { kind: 'retry', reason: 'tooLong', invalidatePending: false }],
  ['UTF-16 boundary allowed', { answer: '😀'.repeat(16) }, { kind: 'askConfirmation', name: '😀'.repeat(16), invalidatePending: false }],
  ['sentence', { answer: 'I like this, maybe tomorrow!' }, { kind: 'retry', reason: 'sentence', invalidatePending: false }],
  ['pending empty repeats confirmation', { pendingName: 'Pending', answer: '' }, { kind: 'repeatConfirmation', name: 'Pending', invalidatePending: false }],
  ['pending 1 binds pending', { pendingName: 'Pending', answer: '1' }, { kind: 'adopt', name: 'Pending', fromCandidate: false, invalidatePending: false }],
  ['pending yes matching listed name', { pendingName: 'Second', answer: 'yes' }, { kind: 'adopt', name: 'Second', fromCandidate: true, invalidatePending: false }],
  ['pending preserves case-sensitive provenance', { pendingName: 'second', answer: 'yes' }, { kind: 'adopt', name: 'second', fromCandidate: false, invalidatePending: false }],
  ['pending new free name', { pendingName: 'Old', answer: 'New' }, { kind: 'askConfirmation', name: 'New', invalidatePending: true }],
  ['pending candidate number', { pendingName: 'Old', answer: '2' }, { kind: 'adopt', name: 'Second', fromCandidate: true, invalidatePending: true }],
  ['pending first ordinal picks list', { pendingName: 'Old', answer: 'the first one' }, { kind: 'adopt', name: 'First', fromCandidate: true, invalidatePending: true }],
  ['pending typed candidate', { pendingName: 'Old', answer: 'second' }, { kind: 'adopt', name: 'Second', fromCandidate: true, invalidatePending: true }],
  ['pending delegate invalidates', { pendingName: 'Old', answer: 'you decide' }, { kind: 'adopt', name: 'First', fromCandidate: true, invalidatePending: true }],
  ['pending out of range invalidates', { pendingName: 'Old', answer: '99' }, { kind: 'retry', reason: 'digit', invalidatePending: true }],
  ['pending placeholder invalidates', { pendingName: 'Old', answer: 'ranger-123456' }, { kind: 'retry', reason: 'placeholder', invalidatePending: true }],
  ['pending sentence invalidates', { pendingName: 'Old', answer: 'what should I pick' }, { kind: 'retry', reason: 'sentence', invalidatePending: true }],
  ['pending too long invalidates', { pendingName: 'Old', answer: '😀'.repeat(17) }, { kind: 'retry', reason: 'tooLong', invalidatePending: true }],
];

for (const answer of ['yes', 'yeah', '对', 'はい', 'no', '不', 'いいえ']) {
  cases.push([`no pending: ${answer}`, { answer }, { kind: 'repeatCandidates', invalidatePending: false }]);
}
for (const answer of ['yes', 'yeah', '对', 'はい', 'continue', '好的']) {
  cases.push([`confirm pending: ${answer}`, { pendingName: 'Pending', answer }, { kind: 'adopt', name: 'Pending', fromCandidate: false, invalidatePending: false }]);
}
for (const answer of ['no', '不', 'いいえ']) {
  cases.push([`deny pending: ${answer}`, { pendingName: 'Pending', answer }, { kind: 'repeatCandidates', invalidatePending: true }]);
}

describe('arrival answer policy', () => {
  it.each(cases)('%s', (_label, input, expected) => {
    const request = Object.freeze({ candidates: Object.freeze([...candidates]), action: 'next' as const, answer: 'New', ...input });
    const result = interpretArrivalAnswer(request);
    expect(result).toEqual(expected);
    expect(result).not.toBeInstanceOf(Promise);
  });
});
