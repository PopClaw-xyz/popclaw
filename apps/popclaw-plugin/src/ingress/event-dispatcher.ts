import type { InboundEnvelope } from './event-ingress.js';

/**
 * Payload-oneof case names used by pbjs-generated `EventEnvelope`.
 * Matches `EventEnvelope.payload` union string in the .d.ts.
 */
export type PayloadType =
  | 'feed'
  | 'invite_request'
  | 'quest_dispatch'
  | 'quest_result'
  | 'invite_verified'
  | 'ranger_registration'
  | 'watch_dispatch'
  | 'watch_heartbeat'
  | 'watch_cancel';

export type EventHandler = (envelope: InboundEnvelope, payload: unknown) => void | Promise<void>;

/**
 * Routes incoming `EventEnvelope`s to registered handlers by payload oneof case.
 *
 * pbjs exposes the oneof as camelCase fields on the envelope object
 * (`inviteRequest` / `questDispatch` / etc.). Our public API uses
 * snake_case names that match the proto field names (plan strategy note §4).
 */
export class EventDispatcher {
  private handlers = new Map<PayloadType, EventHandler[]>();

  on(type: PayloadType, handler: EventHandler): void {
    const list = this.handlers.get(type) ?? [];
    list.push(handler);
    this.handlers.set(type, list);
  }

  async dispatch(inbound: InboundEnvelope): Promise<void> {
    const env = inbound.envelope;
    const type = classify(env);
    if (!type) return;
    const payload = extractPayload(env, type);
    if (payload == null) return;
    const list = this.handlers.get(type);
    if (!list || list.length === 0) return;
    await Promise.all(list.map((h) => h(inbound, payload)));
  }
}

function classify(envelope: Record<string, unknown>): PayloadType | null {
  if (envelope['feed'] != null) return 'feed';
  if (envelope['inviteRequest'] != null) return 'invite_request';
  if (envelope['questDispatch'] != null) return 'quest_dispatch';
  if (envelope['questResult'] != null) return 'quest_result';
  if (envelope['inviteVerified'] != null) return 'invite_verified';
  if (envelope['rangerRegistration'] != null) return 'ranger_registration';
  if (envelope['watchDispatch'] != null) return 'watch_dispatch';
  if (envelope['watchHeartbeat'] != null) return 'watch_heartbeat';
  if (envelope['watchCancel'] != null) return 'watch_cancel';
  return null;
}

function extractPayload(envelope: Record<string, unknown>, type: PayloadType): unknown {
  switch (type) {
    case 'feed':
      return envelope['feed'];
    case 'invite_request':
      return envelope['inviteRequest'];
    case 'quest_dispatch':
      return envelope['questDispatch'];
    case 'quest_result':
      return envelope['questResult'];
    case 'invite_verified':
      return envelope['inviteVerified'];
    case 'ranger_registration':
      return envelope['rangerRegistration'];
    case 'watch_dispatch':
      return envelope['watchDispatch'];
    case 'watch_heartbeat':
      return envelope['watchHeartbeat'];
    case 'watch_cancel':
      return envelope['watchCancel'];
  }
}
