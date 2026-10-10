/**
 * ADR-0040 act 2 wiring: exercise ranger.ts's actual registration, not routeInviteVerified directly.
 * invite_verified used to be silently discarded: classification already recognized it, but
 * dispatcher.on was missing. Pure routing tests cannot detect an absent hook or wrong payload, so
 * inject a real envelope through ingress here.
 */
import { describe, it, expect, vi } from 'vitest';
import bs58 from 'bs58';
import { InMemoryHostAdapter } from '../../../src/host/host-adapter.in-memory.js';
import { Keystore } from '../../../src/identity/keystore.js';
import { MasterKeySigner } from '../../../src/identity/master-key-signer.js';
import { Ranger } from '../../../src/runtime/ranger.js';
import { PluginConfig } from '../../../src/config/schema.js';
import { SqliteNotifier } from '../../../src/notifier/sqlite-notifier.js';
import { PendingInvitesStore, type InviteNotifyWiring } from '../../../src/invite/pending-invites.js';
import type { EventEgress, PushResult } from '../../../src/egress/event-egress.js';
import type { EnvelopeHandler, EventIngress } from '../../../src/ingress/event-ingress.js';

const OWNER_BYTES = new Uint8Array(32).fill(7);
const OWNER = bs58.encode(OWNER_BYTES);
const STRANGER_BYTES = new Uint8Array(32).fill(8);

/** Boot a real Ranger and hand back the ingress callback it registered. */
async function startRanger(): Promise<{
  deliver: EnvelopeHandler;
  notifier: SqliteNotifier;
  pending: PendingInvitesStore;
  notifyOwner: ReturnType<typeof vi.fn>;
  stop: () => Promise<void>;
}> {
  const host = new InMemoryHostAdapter();
  const notifier = new SqliteNotifier(host.db, () => 1000);
  const pending = new PendingInvitesStore(host.db, () => 1000);
  const notifyOwner = vi.fn();
  const inviteNotify: InviteNotifyWiring = {
    ownerPopclawId: OWNER,
    pending,
    notifier,
    notifyOwner,
    profileUrl: 'https://popclaw.me/blackfeather_ai/abcd1234',
  };

  let deliver: EnvelopeHandler | undefined;
  const ingress: EventIngress = {
    start: async (onEnvelope) => {
      deliver = onEnvelope;
    },
    stop: async () => {},
  };
  const egress: EventEgress = {
    push: async (): Promise<PushResult> => ({ status: 200, deduplicated: false }),
  };

  const signer = new MasterKeySigner(await new Keystore(host).loadOrGenerate());
  const ranger = new Ranger({
    host,
    config: PluginConfig.parse({ lore_houses: ['http://example.invalid'] }),
    signer,
    nickname: 'Tester',
    egress,
    ingress,
    // Holder shape: production creates Ranger before notification wiring, filling the reference later (index.ts).
    inviteNotify: { current: inviteNotify },
  });
  await ranger.start();
  if (!deliver) throw new Error('ranger never subscribed to the ingress');
  return { deliver, notifier, pending, notifyOwner, stop: () => ranger.stop() };
}

/** An inbound envelope shaped the way pbjs hands one over (camelCase oneof). */
function inviteVerifiedEnvelope(applicant: Uint8Array) {
  return {
    eventId: 'ev-1',
    envelope: {
      inviteVerified: {
        taskId: 'task-1',
        applicantPopclawId: applicant,
        platform: 'x',
        handle: 'blackfeather_ai',
        followerCount: 30281,
      },
    },
  };
}

describe('Ranger invite_verified wiring (ADR-0040 幕二)', () => {
  it('routes my invite_verified to one L1 ranger_verify_done + a delivery kick', async () => {
    const r = await startRanger();
    r.pending.add({ taskId: 'task-1', platform: 'x', handle: 'blackfeather_ai' });

    await r.deliver(inviteVerifiedEnvelope(OWNER_BYTES));

    const items = r.notifier.drain('L1');
    expect(items).toHaveLength(1);
    expect(items[0]!.kind).toBe('ranger_verify_done');
    expect(items[0]!.payload).toMatchObject({
      platform: 'x',
      handle: 'blackfeather_ai',
      followerCount: 30281,
      profileUrl: 'https://popclaw.me/blackfeather_ai/abcd1234',
    });
    expect(r.notifyOwner).toHaveBeenCalledOnce();
    await r.stop();
  });

  it("stays silent for someone else's verification (世界流里人人可见)", async () => {
    const r = await startRanger();
    await r.deliver(inviteVerifiedEnvelope(STRANGER_BYTES));
    expect(r.notifier.count('L1')).toBe(0);
    expect(r.notifyOwner).not.toHaveBeenCalled();
    await r.stop();
  });
});
