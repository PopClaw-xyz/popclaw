import {afterEach, expect, it, vi} from 'vitest';
import {deliverDraftPreview, draftPreviewStats, _draftPreviewStatsForTest, confirmDiscipline} from '../../../src/tools/draft-preview-delivery.js';
afterEach(() => _draftPreviewStatsForTest.reset());
it('uses the full original-chat tool result without global approval routing or an unproven direct push', async () => {
  const send = vi.fn();
  const context = {senderIsOwner: true, requesterSenderId: 'owner', sessionId: 'session',
    deliveryContext: {channel: 'telegram', to: 'chat', accountId: 'account'}, delivery: {send}};
  const result = await deliverDraftPreview(context, 'Full manuscript');
  expect(result).toEqual({status: 'unavailable', reason: 'PREVIEW_DIRECT_SCOPE_UNAVAILABLE'});
  expect(send).not.toHaveBeenCalled();
  expect(draftPreviewStats().unknown).toBe(0);
});
it('missing delivery capability does not suppress the normal tool-result preview', async () => {
  expect(await deliverDraftPreview({}, 'Full manuscript')).toEqual({status: 'unavailable'});
});
it('keeps one ordinary confirmation and honest UNKNOWN handling in draft guidance', () => {
  const text = confirmDiscipline('en');
  expect(text).toContain('ordinary chat'); expect(text).toContain('original conversation');
  expect(text).toContain('A changed manuscript'); expect(text).toContain('never retry automatically');
  expect(text).not.toMatch(/\/approve|Control UI|allow-once/);
});
