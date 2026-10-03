import { describe, expect, it, vi } from 'vitest';
import { SIGIL_LEN } from '@popclaw/algorithms';
import { InviteInitiator } from '../../../src/invite/invite-initiator.js';
import type { Signer } from '../../../src/identity/signer.js';
import type { EventBuilder } from '../../../src/event/event-builder.js';
import type { EventEgress, PushResult } from '../../../src/egress/event-egress.js';
import { deriveSigil } from '../../../src/invite/sigil.js';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { noDmCrypto } from '../../helpers/test-signer.js';

/** In-memory Signer backed by a fixed ed25519 keypair for deterministic tests. */
function testSigner(seed = new Uint8Array(32)): Signer {
  const kp = nacl.sign.keyPair.fromSeed(seed);
  return {
    publicKey: async () => kp.publicKey,
    sign: async (bytes: Uint8Array) => nacl.sign.detached(bytes, kp.secretKey),
    popclawId: async () => bs58.encode(kp.publicKey),
    ...noDmCrypto,
  };
}

describe('InviteInitiator', () => {
  it('builds, signs, and pushes an invite_request envelope; returns canonical sigil', async () => {
    const signer = testSigner();
    // Use the real EventBuilder so canonicalize/CID aren't stubbed.
    const { EventBuilder } = await import('../../../src/event/event-builder.js');
    const eventBuilder = new EventBuilder(signer, 'Tester');

    let capturedBytes: Uint8Array | null = null;
    const egress: EventEgress = {
      push: vi.fn(async (b: Uint8Array): Promise<PushResult> => {
        capturedBytes = b;
        return { status: 200, eventId: 'computed-by-server', deduplicated: false };
      }),
    };

    const init = new InviteInitiator({ signer, eventBuilder, egress });
    const r = await init.initiate({ platform: 'twitter', handle: 'blackfeather_ai' });

    expect(r.push.status).toBe(200);
    expect(r.pushedEventId).toBe('computed-by-server');
    // Canonical sigil = deriveSigil(popclawId)
    expect(r.expectedSigil).toBe(deriveSigil(await signer.popclawId()));
    expect(r.expectedSigil).toHaveLength(SIGIL_LEN);
    expect(egress.push).toHaveBeenCalledTimes(1);
    expect(capturedBytes).not.toBeNull();
    expect((capturedBytes as unknown as Uint8Array).length).toBeGreaterThan(0);
  });

  it('falls back to client-computed event_id when egress returns no event_id', async () => {
    const signer = testSigner(new Uint8Array(32).fill(7));
    const { EventBuilder } = await import('../../../src/event/event-builder.js');
    const eventBuilder = new EventBuilder(signer, 'Tester');

    const egress: EventEgress = {
      // simulate 4xx or missing-body response
      push: async (): Promise<PushResult> => ({ status: 503 }),
    };
    const init = new InviteInitiator({ signer, eventBuilder, egress });
    const r = await init.initiate({ platform: 'twitter', handle: 'blackfeather_ai' });
    expect(r.push.status).toBe(503);
    expect(r.pushedEventId).toMatch(/^[0-9a-f]{64}$/); // hex SHA-256 CID fallback
  });
});

describe('EventBuilder.buildInviteRequest replace flag (ADR-0026)', () => {
  async function build(opts: { platform: string; handle: string; replace?: boolean }) {
    const signer = testSigner();
    const { EventBuilder } = await import('../../../src/event/event-builder.js');
    const env = await new EventBuilder(signer, 'Tester').buildInviteRequest(opts);
    return (env as { inviteRequest: { replace?: boolean } }).inviteRequest;
  }

  it('omits replace by default (CID-compatible default false)', async () => {
    const ir = await build({ platform: 'x', handle: 'blackfeather_ai' });
    expect(ir.replace).toBeUndefined();
  });

  it('sets replace=true when the swap flag is passed', async () => {
    const ir = await build({ platform: 'x', handle: 'owl_scribe_7', replace: true });
    expect(ir.replace).toBe(true);
  });
});

describe('EventBuilder.buildInviteRequest proofUrl (ADR-0034)', () => {
  async function build(opts: { platform: string; handle: string; proofUrl?: string }) {
    const signer = testSigner();
    const { EventBuilder } = await import('../../../src/event/event-builder.js');
    const env = await new EventBuilder(signer, 'Tester').buildInviteRequest(opts);
    return (env as { inviteRequest: { proofUrl?: string } }).inviteRequest;
  }

  it('omits proofUrl by default (CID-compatible proto3 default "")', async () => {
    expect((await build({ platform: 'x', handle: 'blackfeather_ai' })).proofUrl).toBeUndefined();
    expect((await build({ platform: 'x', handle: 'blackfeather_ai', proofUrl: '' })).proofUrl).toBeUndefined();
  });

  it('carries proofUrl when supplied', async () => {
    const ir = await build({
      platform: 'x',
      handle: 'owl_scribe_7',
      proofUrl: 'https://x.com/owl_scribe_7/status/999',
    });
    expect(ir.proofUrl).toBe('https://x.com/owl_scribe_7/status/999');
  });
});

describe('InviteInitiator proofUrl passthrough (ADR-0034)', () => {
  it('forwards proofUrl to the event builder', async () => {
    const signer = testSigner();
    const built: Array<Record<string, unknown>> = [];
    const eventBuilder = {
      buildInviteRequest: vi.fn(async (o: Record<string, unknown>) => {
        built.push(o);
        return { actor: { popclawId: await signer.popclawId() }, timestamp: 1, inviteRequest: {} };
      }),
    } as unknown as EventBuilder;
    const egress: EventEgress = { push: async (): Promise<PushResult> => ({ status: 200 }) };
    await new InviteInitiator({ signer, eventBuilder, egress }).initiate({
      platform: 'x',
      handle: 'blackfeather_ai',
      proofUrl: 'https://x.com/blackfeather_ai/status/1',
    });
    expect(built[0]!['proofUrl']).toBe('https://x.com/blackfeather_ai/status/1');
  });
});
