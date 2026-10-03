import { describe, expect, it, vi } from 'vitest';
import { EventDispatcher } from '../../../src/ingress/event-dispatcher.js';
import { QuestHandler } from '../../../src/quest/quest-handler.js';
import type { InboundEnvelope } from '../../../src/ingress/event-ingress.js';
import type { VerifyInviteHandler } from '../../../src/quest/verify-invite-handler.js';
import type { ScrapeContentHandler } from '../../../src/quest/scrape-content-handler.js';
import type { Signer } from '../../../src/identity/signer.js';
import { noDmCrypto } from '../../helpers/test-signer.js';

function fakeSigner(id: string): Signer {
  return {
    publicKey: async () => new Uint8Array(32),
    sign: async () => new Uint8Array(64),
    popclawId: async () => id,
    ...noDmCrypto,
  };
}

function envAddressedTo(ids: string[], kind = 1, taskId = 'tsk-1'): InboundEnvelope {
  const envelope: Record<string, unknown> = {
    eventId: taskId,
    platform: 'twitter',
    timestamp: 0,
    actor: { popclawId: 'QmLH' },
    target: { scope: 2, targetIds: ids },
    questDispatch: {
      taskId,
      kind,
      expiresAt: 0,
    },
  };
  const qd = envelope['questDispatch'] as Record<string, unknown>;
  if (kind === 1) {
    qd['verifyInvite'] = {
      platform: 'twitter',
      handle: 'u',
      applicantPopclawId: new Uint8Array(32),
      expectedSigil: 'abc123',
    };
  } else if (kind === 2) {
    qd['scrapeContent'] = {
      platform: 'twitter',
      handle: 'u',
      sinceTimestamp: 0,
      maxItems: 20,
    };
  }
  return { eventId: taskId, envelope };
}

describe('QuestHandler', () => {
  it('routes VERIFY_INVITE to verifyInvite handler when self is in target_ids', async () => {
    const dispatcher = new EventDispatcher();
    const vh = { handle: vi.fn() } as unknown as VerifyInviteHandler;
    const sh = { handle: vi.fn() } as unknown as ScrapeContentHandler;
    const q = new QuestHandler({
      dispatcher,
      signer: fakeSigner('QmSelf'),
      verifyInvite: vh,
      scrapeContent: sh,
    });
    await q.start();
    await dispatcher.dispatch(envAddressedTo(['QmSelf', 'QmX', 'QmY']));
    expect(vh.handle).toHaveBeenCalledTimes(1);
    expect(sh.handle).not.toHaveBeenCalled();
  });

  it('does nothing when self is NOT in target_ids', async () => {
    const dispatcher = new EventDispatcher();
    const vh = { handle: vi.fn() } as unknown as VerifyInviteHandler;
    const sh = { handle: vi.fn() } as unknown as ScrapeContentHandler;
    const q = new QuestHandler({
      dispatcher,
      signer: fakeSigner('QmSelf'),
      verifyInvite: vh,
      scrapeContent: sh,
    });
    await q.start();
    await dispatcher.dispatch(envAddressedTo(['QmA', 'QmB', 'QmC']));
    expect(vh.handle).not.toHaveBeenCalled();
    expect(sh.handle).not.toHaveBeenCalled();
  });

  it('routes SCRAPE_CONTENT (kind=2) to scrapeContent handler', async () => {
    const dispatcher = new EventDispatcher();
    const vh = { handle: vi.fn() } as unknown as VerifyInviteHandler;
    const sh = { handle: vi.fn() } as unknown as ScrapeContentHandler;
    const q = new QuestHandler({
      dispatcher,
      signer: fakeSigner('QmSelf'),
      verifyInvite: vh,
      scrapeContent: sh,
    });
    await q.start();
    await dispatcher.dispatch(envAddressedTo(['QmSelf'], 2));
    expect(sh.handle).toHaveBeenCalledTimes(1);
    expect(vh.handle).not.toHaveBeenCalled();
  });

  it('ignores unknown QuestKind values and logs a warning', async () => {
    const dispatcher = new EventDispatcher();
    const vh = { handle: vi.fn() } as unknown as VerifyInviteHandler;
    const sh = { handle: vi.fn() } as unknown as ScrapeContentHandler;
    const warn = vi.fn();
    const q = new QuestHandler({
      dispatcher,
      signer: fakeSigner('QmSelf'),
      verifyInvite: vh,
      scrapeContent: sh,
      loggerWarn: warn,
    });
    await q.start();
    const env = envAddressedTo(['QmSelf'], 999);
    await dispatcher.dispatch(env);
    expect(vh.handle).not.toHaveBeenCalled();
    expect(sh.handle).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('999'));
  });
});
