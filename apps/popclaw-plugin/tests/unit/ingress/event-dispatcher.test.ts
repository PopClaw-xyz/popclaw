import { describe, expect, it, vi } from 'vitest';
import { EventDispatcher } from '../../../src/ingress/event-dispatcher.js';
import type { InboundEnvelope } from '../../../src/ingress/event-ingress.js';

function envelopeWithFeed(): InboundEnvelope {
  return {
    eventId: 'e1',
    envelope: {
      eventId: 'e1',
      platform: 'twitter',
      feed: { blocks: [], originalUrl: 'https://example.invalid/' },
    },
  };
}

function envelopeWithQuestDispatch(): InboundEnvelope {
  return {
    eventId: 'e2',
    envelope: {
      eventId: 'e2',
      platform: 'twitter',
      target: { scope: 2, targetIds: ['QmA', 'QmB', 'QmC'] },
      questDispatch: {
        taskId: '00000000-0000-0000-0000-000000000001',
        kind: 1,
        expiresAt: 0,
        verifyInvite: {
          platform: 'twitter',
          handle: 'u',
          applicantPopclawId: new Uint8Array(),
          expectedSigil: 'abc123',
        },
      },
    },
  };
}

function envelopeWithInviteVerified(): InboundEnvelope {
  return {
    eventId: 'e3',
    envelope: {
      eventId: 'e3',
      platform: 'twitter',
      inviteVerified: {
        taskId: '00000000-0000-0000-0000-000000000001',
        platform: 'twitter',
        handle: 'u',
        approveCount: 2,
        rejectCount: 1,
      },
    },
  };
}

describe('EventDispatcher', () => {
  it('routes feed events to feed handlers only', async () => {
    const d = new EventDispatcher();
    const feedH = vi.fn();
    const questH = vi.fn();
    d.on('feed', feedH);
    d.on('quest_dispatch', questH);

    await d.dispatch(envelopeWithFeed());
    expect(feedH).toHaveBeenCalledTimes(1);
    expect(questH).not.toHaveBeenCalled();
  });

  it('routes quest_dispatch events and passes the payload', async () => {
    const d = new EventDispatcher();
    const h = vi.fn();
    d.on('quest_dispatch', h);
    await d.dispatch(envelopeWithQuestDispatch());
    expect(h).toHaveBeenCalledTimes(1);
    const [, payload] = h.mock.calls[0]!;
    expect((payload as { taskId: string }).taskId).toBe('00000000-0000-0000-0000-000000000001');
  });

  it('routes invite_verified events', async () => {
    const d = new EventDispatcher();
    const h = vi.fn();
    d.on('invite_verified', h);
    await d.dispatch(envelopeWithInviteVerified());
    expect(h).toHaveBeenCalledTimes(1);
    const [, payload] = h.mock.calls[0]!;
    expect((payload as { approveCount: number }).approveCount).toBe(2);
  });

  it('silently drops envelopes with no payload oneof', async () => {
    const d = new EventDispatcher();
    const h = vi.fn();
    d.on('feed', h);
    const empty: InboundEnvelope = {
      eventId: 'empty',
      envelope: { eventId: 'empty', platform: '' },
    };
    await d.dispatch(empty);
    expect(h).not.toHaveBeenCalled();
  });

  it('supports multiple handlers per type', async () => {
    const d = new EventDispatcher();
    const a = vi.fn();
    const b = vi.fn();
    d.on('feed', a);
    d.on('feed', b);
    await d.dispatch(envelopeWithFeed());
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('awaits async handlers before returning', async () => {
    const d = new EventDispatcher();
    let resolved = false;
    d.on('feed', async () => {
      await new Promise((r) => setTimeout(r, 10));
      resolved = true;
    });
    await d.dispatch(envelopeWithFeed());
    expect(resolved).toBe(true);
  });

  it.each([
    ['ranger_registration', 'rangerRegistration'],
    ['watch_dispatch', 'watchDispatch'],
    ['watch_heartbeat', 'watchHeartbeat'],
    ['watch_cancel', 'watchCancel'],
  ] as const)('routes %s', async (type, field) => {
    const dispatcher = new EventDispatcher();
    const handler = vi.fn();
    dispatcher.on(type, handler);
    await dispatcher.dispatch({
      eventId: 'evt',
      envelope: { [field]: { sample: 'payload' } } as Record<string, unknown>,
    });
    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: 'evt' }),
      { sample: 'payload' },
    );
  });
});
