import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  NATIVE_APPROVAL_PROFILE, displayWidth, type ApprovalDialogProfile,
} from '../../../src/host/approval-presentation.js';
import {
  consumeOwnerApproval, registerOwnerApprovalSubject, resetOwnerApprovals,
} from '../../../src/host/owner-approval.js';
import { createMcpOwnerApproval, MCP_APPROVAL_PROFILE } from '../../../src/host/mcp-owner-approval.js';
import {
  describeSendDraft, needsReviewCopy, sendDraftApprovalSubject,
} from '../../../src/tools/send-draft-subject.js';
import {
  _draftsForTest, peekDraftSnapshot, putDraft, setDraftReviewFiles, type DraftSnapshot,
} from '../../../src/tools/draft-store.js';
import { withDraftReview } from '../../../src/tools/draft-review.js';
import { setOwnerLang } from '../../../src/lexicon/owner-language.js';

const ID = 'post-1';
const PARAMS = { draft_id: ID };
const TOOL = 'popclaw_send_draft';
const LONG = 'Complete text must remain available. '.repeat(30);
function draft(body: string, extra: Partial<DraftSnapshot> = {}): DraftSnapshot {
  const snapshot: DraftSnapshot = {
    kind: 'post', body, house: 'home', attachments: [], preview: null,
    output: { digest: 'output-digest', at: 0 }, ...extra,
  };
  putDraft(ID, async () => ({ text: body }), snapshot);
  return snapshot;
}
const wholeCompact: ApprovalDialogProfile = {
  ...NATIVE_APPROVAL_PROFILE, draftPresentation: 'whole-or-bound-review',
};
const roomyPreview: ApprovalDialogProfile = {
  ...MCP_APPROVAL_PROFILE, draftPresentation: 'preview-or-transcript',
};

beforeEach(() => { resetOwnerApprovals(); _draftsForTest.clear(); setOwnerLang('en'); });
afterEach(() => { resetOwnerApprovals(); _draftsForTest.clear(); setDraftReviewFiles(null); setOwnerLang('en'); });

describe('budget and draft presentation are independent inputs', () => {
  it('the same compact budget permits a transcript pointer only under its explicit content policy', () => {
    draft(LONG);
    const pointer = describeSendDraft(PARAMS, NATIVE_APPROVAL_PROFILE);
    expect(pointer.kind).toBe('ask');
    if (pointer.kind !== 'ask') throw new Error('Expected transcript pointer');
    expect(pointer.description.join('\n')).toContain('expand the output above');
    expect(describeSendDraft(PARAMS, wholeCompact)).toEqual({
      kind: 'refuse', reason: 'APPROVAL_PREVIEW_OVER_DISPLAY_BUDGET',
    });
  });

  it('a larger byte budget does not choose preview notes or folded alternatives', () => {
    draft(LONG);
    const preview = describeSendDraft(PARAMS, roomyPreview);
    const whole = describeSendDraft(PARAMS, MCP_APPROVAL_PROFILE);
    expect(preview.kind).toBe('ask'); expect(whole.kind).toBe('ask');
    if (preview.kind !== 'ask' || whole.kind !== 'ask') throw new Error('Expected whole layouts');
    expect(preview.description.join('\n')).toContain('not sent to your preview');
    expect(preview.folded).toBeDefined();
    expect(whole.description.join('\n')).not.toContain('not sent to your preview');
    expect(whole.folded).toBeUndefined();
    for (const result of [preview, whole]) {
      expect(result.description.filter(row => row.startsWith('> ')).map(row => row.slice(2)).join('')).toBe(LONG);
    }
  });

  it('resolves a numeric subject override inside the real MCP seam without replacing its host policy', async () => {
    draft(LONG);
    let resolved: ApprovalDialogProfile | undefined;
    registerOwnerApprovalSubject(TOOL, {
      ...sendDraftApprovalSubject,
      displayBudget: NATIVE_APPROVAL_PROFILE.budget,
      describe(params, profile) { resolved = profile; return describeSendDraft(params, profile); },
    });
    const elicitInput = vi.fn(async () => ({ action: 'accept', content: { confirm: true } }));
    const backend = createMcpOwnerApproval({ server: { current: {
      getClientCapabilities: () => ({ elicitation: { form: {} } }),
      getClientVersion: () => ({ name: 'test-host', version: '1' }), elicitInput,
    } as never } });
    // Parameters cannot widen the pinned budget or turn this into a native pointer.
    const spoofed = { ...PARAMS, profile: roomyPreview, budget: MCP_APPROVAL_PROFILE.budget,
      draftPresentation: 'preview-or-transcript', wholeTextOnly: false };
    try {
      await backend.beforeDispatch(TOOL, spoofed, 'mcp-override');
      expect(resolved?.budget).toBe(NATIVE_APPROVAL_PROFILE.budget);
      expect(resolved?.draftPresentation).toBe('whole-or-bound-review');
      expect(resolved?.layout).toBe(MCP_APPROVAL_PROFILE.layout);
      expect(elicitInput).not.toHaveBeenCalled();
      expect(consumeOwnerApproval(TOOL, spoofed, 'mcp-override')).toEqual({
        decision: 'unavailable', reason: 'SUBJECT_REFUSED', detail: 'APPROVAL_PREVIEW_OVER_DISPLAY_BUDGET',
      });
    } finally { backend.stop(); }
  });
});

describe('layout is explicit while the review-copy decision stays fixed', () => {
  it('uses the supplied row width without losing or splitting body text', () => {
    const body = 'Hello 界🙂 '.repeat(14);
    draft(body);
    const compactRows = describeSendDraft(PARAMS, {
      ...MCP_APPROVAL_PROFILE, layout: { ...MCP_APPROVAL_PROFILE.layout, rowColumns: 40 },
    });
    const normal = describeSendDraft(PARAMS, MCP_APPROVAL_PROFILE);
    if (compactRows.kind !== 'ask' || normal.kind !== 'ask') throw new Error('Expected whole layouts');
    expect(compactRows.description.length).toBeGreaterThan(normal.description.length);
    expect(compactRows.description.every(row => displayWidth(row) <= 40)).toBe(true);
    expect(compactRows.description.filter(row => row.startsWith('> ')).map(row => row.slice(2)).join('')).toBe(body);
  });

  it('uses the supplied first-line and confirmation widths independently', () => {
    draft('x'.repeat(55));
    const normal = describeSendDraft(PARAMS, MCP_APPROVAL_PROFILE);
    const narrow = describeSendDraft(PARAMS, {
      ...MCP_APPROVAL_PROFILE,
      layout: { ...MCP_APPROVAL_PROFILE.layout, firstLineColumns: 40, confirmDescriptionColumns: 10 },
    });
    if (normal.kind !== 'ask' || narrow.kind !== 'ask') throw new Error('Expected whole layouts');
    expect(normal.firstScreen?.title).toBe(`> ${'x'.repeat(55)}`);
    expect(normal.confirmDescription).toBeDefined();
    expect(narrow.firstScreen).toBeUndefined();
    expect(narrow.confirmDescription).toBeUndefined();
    expect(narrow.description).toEqual(normal.description);
  });

  it('retains the pointer row ceiling as an explicit layout decision', () => {
    draft(LONG, { kind: 'dm', recipientLabel: 'Alice#abcdefgh', recipientId: 'recipient-id' });
    const normal = describeSendDraft(PARAMS);
    expect(normal.kind).toBe('ask');
    expect(describeSendDraft(PARAMS, {
      ...NATIVE_APPROVAL_PROFILE, layout: { ...NATIVE_APPROVAL_PROFILE.layout, pointerMaxRows: 2 },
    })).toEqual({ kind: 'refuse', reason: 'DRAFT_DESCRIPTION_TOO_LONG' });
  });

  it('uses the recorded compact decision even when a roomy host could show the whole body', () => {
    const snapshot = draft(LONG);
    expect(needsReviewCopy(snapshot, ID, 'en')).toBe(true);
    draft(LONG, { review: { needed: true, lang: 'en', file: {
      path: '/review/post-1.md', name: 'post-1.md', sha256: 'review-sha',
    } } });
    const write = vi.fn(); const sha256 = vi.fn();
    setDraftReviewFiles({ dir: '/review', write, sha256, remove: vi.fn() });
    setOwnerLang('zh-CN'); // Ask in a new language; the mint decision still uses English.
    const result = describeSendDraft(PARAMS, {
      ...MCP_APPROVAL_PROFILE,
      layout: { ...MCP_APPROVAL_PROFILE.layout, rowColumns: 100, firstLineColumns: 100 },
    });
    if (result.kind !== 'ask') throw new Error('Expected bound review');
    expect(result.description.join('\n')).toContain('/review/post-1.md');
    expect(result.description.filter(row => row.startsWith('> '))).toHaveLength(1);
    expect(write).not.toHaveBeenCalled(); expect(sha256).not.toHaveBeenCalled();
  });

  it.each(['en', 'zh-CN'] as const)('keeps the mint language at a compact threshold (%s)', (mintLang) => {
    const snapshot = draft('x'.repeat(430));
    expect(needsReviewCopy(snapshot, ID, 'en')).toBe(true);
    expect(needsReviewCopy(snapshot, ID, 'zh-CN')).toBe(false);
    const write = vi.fn(() => ({ path: '/review/post-1.md', sha256: 'review-sha' }));
    const sha256 = vi.fn();
    setOwnerLang(mintLang);
    withDraftReview(ID, snapshot.body, { dir: '/review', write, sha256, remove: vi.fn() });
    const review = peekDraftSnapshot(ID)!.review!;
    expect(review.needed).toBe(mintLang === 'en');
    expect(review.lang).toBe(mintLang);
    expect(write).toHaveBeenCalledTimes(mintLang === 'en' ? 1 : 0);
    setOwnerLang(mintLang === 'en' ? 'zh-CN' : 'en');
    const result = describeSendDraft(PARAMS, MCP_APPROVAL_PROFILE);
    if (result.kind !== 'ask') throw new Error('Recorded language must prevent a decision mismatch');
    expect(result.description.join('\n').includes('/review/post-1.md')).toBe(review.needed);
    expect(write).toHaveBeenCalledTimes(mintLang === 'en' ? 1 : 0);
    expect(sha256).not.toHaveBeenCalled();
  });

  it('does not invent a review decision or write a missing review during composition', () => {
    draft(LONG);
    const write = vi.fn(); const sha256 = vi.fn();
    setDraftReviewFiles({ dir: '/review', write, sha256, remove: vi.fn() });
    expect(describeSendDraft(PARAMS, wholeCompact).kind).toBe('refuse');
    draft(LONG, { review: { needed: true, lang: 'en', file: null, failed: 'write' } });
    expect(describeSendDraft(PARAMS, MCP_APPROVAL_PROFILE)).toEqual({ kind: 'refuse', reason: 'REVIEW_COPY_NOT_WRITTEN' });
    expect(write).not.toHaveBeenCalled(); expect(sha256).not.toHaveBeenCalled();
  });
});
