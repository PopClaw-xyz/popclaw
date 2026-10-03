import { assertActionActive, questAction, runAction, type ActionGate } from '../runtime/house-lifecycle/action-context.js';
/**
 * QuestHandler — subscribes to EventDispatcher `quest_dispatch` events and
 * routes to kind-specific handlers when the envelope addresses *us*.
 *
 * "Addresses us" = `EventEnvelope.target.targetIds` (base58 popclaw_ids,
 * per plan strategy note §4 — assignee list lives on the OUTER envelope's
 * Recipient, not inside QuestDispatchPayload). We compute our own popclaw_id
 * once at `start()` time and compare string-wise against each event.
 *
 * Non-addressed events are silently dropped. Unknown QuestKind values are
 * logged-and-dropped (forward-compat: Phase 3 may add new kinds this
 * Plan 5 plugin doesn't know how to handle).
 */

import type { EventDispatcher } from '../ingress/event-dispatcher.js';
import type { Signer } from '../identity/signer.js';
import type { InboundEnvelope } from '../ingress/event-ingress.js';
import type { VerifyInviteHandler } from './verify-invite-handler.js';
import type { ScrapeContentHandler } from './scrape-content-handler.js';

const QUEST_KIND_VERIFY_INVITE = 1;
const QUEST_KIND_SCRAPE_CONTENT = 2;

export interface QuestHandlerDeps {
  readonly gate?: ActionGate;
  readonly now?: () => number;
  readonly dispatcher: EventDispatcher;
  readonly signer: Signer;
  readonly verifyInvite: VerifyInviteHandler;
  readonly scrapeContent: ScrapeContentHandler;
  readonly loggerWarn?: (msg: string) => void;
}

export class QuestHandler {
  constructor(private readonly deps: QuestHandlerDeps) {}

  async start(): Promise<void> {
    assertActionActive(this.deps.gate);
    const selfId = await this.deps.signer.popclawId();
    assertActionActive(this.deps.gate);
    this.deps.dispatcher.on('quest_dispatch', async (inbound, payload) => {
      if (!this.isSelfAddressed(inbound, selfId)) return;
      const dispatch = payload as Record<string, unknown>;
      await runAction(questAction(this.deps.gate, dispatch['expiresAt'], this.deps.now), () => this.route(inbound, dispatch));
    });
  }

  private isSelfAddressed(inbound: InboundEnvelope, selfId: string): boolean {
    const target = inbound.envelope['target'] as { targetIds?: string[] } | undefined;
    const ids = target?.targetIds ?? [];
    return ids.includes(selfId);
  }

  private async route(inbound: InboundEnvelope, payload: Record<string, unknown>): Promise<void> {
    const kind = payload['kind'] as number;
    switch (kind) {
      case QUEST_KIND_VERIFY_INVITE: {
        const sub = payload['verifyInvite'] as Record<string, unknown> | undefined;
        if (sub) await this.deps.verifyInvite.handle(inbound, sub);
        break;
      }
      case QUEST_KIND_SCRAPE_CONTENT: {
        const sub = payload['scrapeContent'] as Record<string, unknown> | undefined;
        if (sub) await this.deps.scrapeContent.handle(inbound, sub);
        break;
      }
      default:
        this.deps.loggerWarn?.(`quest-handler: unknown QuestKind=${kind}, ignoring`);
        break;
    }
  }
}
