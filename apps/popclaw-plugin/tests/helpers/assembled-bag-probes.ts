/**
 * Behaviour probes over a runtime bag built by the REAL production root path
 * (tests/unit/runtime/assembly/assemble-runtime-{mcp,gateway}.test.ts). They
 * replace source-text pins that could only say "this expression is spelled
 * here" (runtime-contract, dm-handler-parity): these say what the assembled
 * runtime actually does, on either root.
 */
import { vi } from 'vitest';
import { persistNickname } from '../../src/onboarding/identity-writer.js';
import type { HostAdapter } from '../../src/host/host-adapter.js';
import type { EventBuilder } from '../../src/event/event-builder.js';
import type { HouseRuntime } from '../../src/runtime/house-lifecycle/house-runtime.js';
import type { HouseStore } from '../../src/ingress/world-feed-store.js';
import type { HouseGate } from '../../src/runtime/house-lifecycle/manager.js';
import type { InboxStore } from '../../src/messaging/inbox-store.js';
import type { SocialLogRecorder } from '../../src/social-log/social-log.js';

type ResourceConfig = Parameters<HouseRuntime['configureResources']>[0];

/** The slots these probes read, typed loosely: the two roots' bag types differ. */
export interface ProbedBag {
  readonly host: HostAdapter;
  readonly boot: { readonly nickname: string; readonly popclawId: string };
  readonly initiator: unknown;
  readonly markService: unknown;
  readonly orchestrator: unknown;
  readonly inviteWatch: unknown;
  readonly inboxStore: InboxStore;
  readonly socialLog: SocialLogRecorder;
}

/**
 * Rename through the real persistence path (what popclaw_set_name and
 * onboarding call), then read the owner's name back from every surface the
 * assembly wires to read it AT USE TIME: the boot wrap itself, the invite
 * request builder, the mark signer, the onboarding canvas deps and the
 * profile URL of an invitation outcome. A value captured at wiring time (or an
 * object spread of the boot) still says `before` here.
 */
export async function ownerNameAfterRename(bag: ProbedBag, next: string) {
  const before = bag.boot.nickname;
  await persistNickname(bag.host, next, 'owner');
  const builder = (bag.initiator as { deps: { eventBuilder: EventBuilder } }).deps.eventBuilder;
  const invite = await builder.buildInviteRequest({ platform: 'x', handle: 'c4-probe' });
  return {
    before,
    boot: bag.boot.nickname,
    inviteRequest: (invite['actor'] as { nickname: string }).nickname,
    markSigner: (bag.markService as { deps: { nickname: string } }).deps.nickname,
    onboardingCanvas: (bag.orchestrator as { deps: { canvas?: { nickname: string } } }).deps.canvas?.nickname,
    profileUrl: (bag.inviteWatch as { profileUrl: () => string }).profileUrl(),
  };
}

/**
 * One DM, delivered twice (an SSE backfill replay) through the inbox hook the
 * root's real `configureResources` call handed the house runtime. Returns what
 * the inbox holds and which `dm_received` entries the social log was given.
 */
export async function deliverDmTwice(bag: ProbedBag, config: ResourceConfig, house: { slug: string; baseUrl: string }) {
  const logged = vi.spyOn(bag.socialLog, 'record');
  const envelope = new Uint8Array([0x0a, 0x04, 0xc4, 0xc4, 0xc4, 0xc4]);
  const dm = { fromPopclawId: 'c4-peer-popclaw-id', toPopclawId: bag.boot.popclawId, ts: 4242 };
  const gate = { origin: house.baseUrl, generation: 1, signal: new AbortController().signal, isActive: () => true } as unknown as HouseGate;
  for (let i = 0; i < 2; i++) {
    // The DM policy's follow-up (offline here) is not what these probes read.
    await Promise.resolve(config.onInbox!(house as unknown as HouseStore, gate, dm, envelope, 'C4Peer', { originalText: 'c4 hello' }))
      .catch(() => {});
  }
  const stored = bag.inboxStore.recent(10);
  const dmReceived = logged.mock.calls.map(([entry]) => entry).filter(entry => entry.kind === 'dm_received');
  logged.mockRestore();
  return { envelope, stored, dmReceived };
}
