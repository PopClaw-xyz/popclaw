import { describe, expect, it, vi } from 'vitest';
import { runInviteCommand } from '../../../src/commands/invite.js';
import type { InviteInitiator } from '../../../src/invite/invite-initiator.js';
import type { Signer } from '../../../src/identity/signer.js';
import { noDmCrypto } from '../../helpers/test-signer.js';

function silentLogger() {
  return { info: vi.fn(), warn: vi.fn() };
}

function fakeSigner(popclawId = 'QmSomeApplicant'): Signer {
  return {
    publicKey: async () => new Uint8Array(32),
    sign: async (_b: Uint8Array) => new Uint8Array(64),
    popclawId: async () => popclawId,
    ...noDmCrypto,
  };
}

describe('runInviteCommand', () => {
  it('returns verified=true when /v1/profile shows the platform+handle after polling', async () => {
    const initiator = {
      initiate: vi.fn(async () => ({
        expectedSigil: 'abcdef',
        pushedEventId: 'event-1',
        push: { status: 200, eventId: 'event-1', deduplicated: false },
      })),
    } as unknown as InviteInitiator;

    // First fetch: 404; second fetch: matches.
    let calls = 0;
    const fetchMock: typeof globalThis.fetch = async () => {
      calls++;
      if (calls === 1) {
        return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          profiles: [{ platform: 'twitter', handle: 'blackfeather_ai' }],
        }),
      } as unknown as Response;
    };

    const logger = silentLogger();
    const result = await runInviteCommand(
      {
        initiator,
        signer: fakeSigner(),
        loreHouseUrl: 'http://localhost:8080',
        fetch: fetchMock,
        logger,
        now: () => 0,
        sleepMs: async (_ms) => {},
      },
      { platform: 'twitter', handle: 'blackfeather_ai', pollTimeoutSec: 60, pollIntervalMs: 10 },
    );

    expect(result.verified).toBe(true);
    expect(initiator.initiate).toHaveBeenCalledTimes(1);
    expect(calls).toBe(2);
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('"blackfeather_ai#abcdef"'));
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('APPROVED'));
  });

  it('returns verified=false and warns when push is rejected', async () => {
    const initiator = {
      initiate: vi.fn(async () => ({
        expectedSigil: 'abcdef',
        pushedEventId: undefined,
        push: { status: 429 },
      })),
    } as unknown as InviteInitiator;

    const fetchMock: typeof globalThis.fetch = async () => {
      throw new Error('should not be reached');
    };
    const logger = silentLogger();
    const result = await runInviteCommand(
      {
        initiator,
        signer: fakeSigner(),
        loreHouseUrl: 'http://localhost:8080',
        fetch: fetchMock,
        logger,
      },
      { platform: 'twitter', handle: 'blackfeather_ai' },
    );
    expect(result.verified).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('HTTP 429'));
  });

  it('returns verified=false on polling timeout', async () => {
    const initiator = {
      initiate: vi.fn(async () => ({
        expectedSigil: 'abcdef',
        pushedEventId: 'e',
        push: { status: 200, eventId: 'e', deduplicated: false },
      })),
    } as unknown as InviteInitiator;

    // Always 404
    const fetchMock: typeof globalThis.fetch = async () =>
      ({ ok: false, status: 404, json: async () => ({}) } as unknown as Response);

    let simulatedNow = 0;
    const logger = silentLogger();
    const result = await runInviteCommand(
      {
        initiator,
        signer: fakeSigner(),
        loreHouseUrl: 'http://localhost:8080',
        fetch: fetchMock,
        logger,
        now: () => simulatedNow,
        sleepMs: async (ms) => {
          simulatedNow += ms + 1;
        },
      },
      { platform: 'twitter', handle: 'blackfeather_ai', pollTimeoutSec: 1, pollIntervalMs: 300 },
    );
    expect(result.verified).toBe(false);
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('polling timeout'));
  });
});
