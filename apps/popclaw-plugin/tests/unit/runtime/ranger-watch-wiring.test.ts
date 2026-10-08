/**
 * Ranger ranger_mode wiring.
 *
 * When `ranger_mode === true`, `Ranger.start()` must push a
 * `RangerRegistration` envelope (capabilities=["x"], availabilityScore
 * elided per Invariant #1). Timers are set up but don't fire before
 * `stop()` returns, so the only observed push is the registration.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { popclaw } from '@popclaw/contracts';
import { InMemoryHostAdapter } from '../../../src/host/host-adapter.in-memory.js';
import { Keystore } from '../../../src/identity/keystore.js';
import { MasterKeySigner } from '../../../src/identity/master-key-signer.js';
import { Ranger } from '../../../src/runtime/ranger.js';
import { PluginConfig } from '../../../src/config/schema.js';
import type { EventEgress, PushResult } from '../../../src/egress/event-egress.js';
import type { EventIngress } from '../../../src/ingress/event-ingress.js';

type Ns = {
  identity: {
    SignedPayload: {
      decode(b: Uint8Array): { payload: Uint8Array };
    };
  };
  event: {
    EventEnvelope: {
      decode(b: Uint8Array): Record<string, unknown>;
    };
  };
};

describe('Ranger with ranger_mode=true', () => {
  // Capabilities are derived from the env-built scraper registry. Configure a
  // commercial X backend so the ranger advertises the 'x' capability; the
  // commercial-only build returns no 'x' scraper when zero creds are set.
  let prevTwitterApiIoKey: string | undefined;
  beforeEach(() => {
    prevTwitterApiIoKey = process.env.POPCLAW_TWITTERAPI_IO_KEY;
    process.env.POPCLAW_TWITTERAPI_IO_KEY = 'test-key';
  });
  afterEach(() => {
    if (prevTwitterApiIoKey === undefined) delete process.env.POPCLAW_TWITTERAPI_IO_KEY;
    else process.env.POPCLAW_TWITTERAPI_IO_KEY = prevTwitterApiIoKey;
  });

  it('pushes a RangerRegistration envelope on start()', async () => {
    const host = new InMemoryHostAdapter();
    const pushed: Uint8Array[] = [];
    const egress: EventEgress = {
      push: async (bytes: Uint8Array): Promise<PushResult> => {
        pushed.push(bytes);
        return { status: 200, deduplicated: false };
      },
    };
    const ingress: EventIngress = {
      start: async (_onEnvelope) => {
        void _onEnvelope;
      },
      stop: async () => {},
    };

    const key = await new Keystore(host).loadOrGenerate();
    const signer = new MasterKeySigner(key);

    // Zod-parse so the watch default block hydrates.
    const config = PluginConfig.parse({
      lore_houses: ['http://example.invalid'],
      scraper: { interval_ms: 1_000 },
      ranger_mode: true,
    });

    const ranger = new Ranger({
      host,
      config,
      signer,
      nickname: 'Tester',
      egress,
      ingress,
    });
    await ranger.start();
    // The watch tick fires after `tick_interval_ms` (default 10s) and the
    // heartbeat after 60s; neither should have fired in the microseconds
    // between start and stop. The only observed push is RangerRegistration.
    await ranger.stop();

    expect(pushed.length).toBeGreaterThanOrEqual(1);

    // Decode the first pushed envelope; assert the oneof is rangerRegistration.
    const ns = popclaw as unknown as Ns;
    const signed = ns.identity.SignedPayload.decode(pushed[0]!);
    const envelope = ns.event.EventEnvelope.decode(signed.payload);
    expect(envelope.rangerRegistration).toBeTruthy();

    const reg = envelope.rangerRegistration as {
      capabilities?: string[];
      availabilityScore?: number;
    };
    expect(reg.capabilities).toEqual(['x']);
    // Invariant #1: availabilityScore=0 (proto3 default) must not be on the
    // wire. pbjs either omits the key entirely or leaves it at the default 0
    // after decode — both are acceptable. What we MUST NOT see is a non-zero
    // value leaking in from the plugin.
    if (reg.availabilityScore !== undefined) {
      expect(reg.availabilityScore).toBe(0);
    }
  });

  it('does not emit RangerRegistration when ranger_mode is false', async () => {
    const host = new InMemoryHostAdapter();
    const pushed: Uint8Array[] = [];
    const egress: EventEgress = {
      push: async (bytes: Uint8Array): Promise<PushResult> => {
        pushed.push(bytes);
        return { status: 200, deduplicated: false };
      },
    };
    const ingress: EventIngress = {
      start: async (_onEnvelope) => {
        void _onEnvelope;
      },
      stop: async () => {},
    };

    const key = await new Keystore(host).loadOrGenerate();
    const signer = new MasterKeySigner(key);

    const config = PluginConfig.parse({
      lore_houses: ['http://example.invalid'],
      scraper: { interval_ms: 1_000 },
      // ranger_mode omitted → Zod default false
    });

    const ranger = new Ranger({
      host,
      config,
      signer,
      nickname: 'Tester',
      egress,
      ingress,
    });
    await ranger.start();
    await ranger.stop();

    expect(pushed.length).toBe(0);
  });
});
