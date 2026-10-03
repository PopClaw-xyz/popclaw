import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { makeIntentPullClient } from '../../../src/canvas/intent-pull-client.js';
import { ActionInactiveError, withAction } from '../../../src/runtime/house-lifecycle/action-context.js';
import type { Signer } from '../../../src/identity/signer.js';
import { noDmCrypto } from '../../helpers/test-signer.js';

const seam = vi.hoisted(() => ({ response: undefined as unknown, afterHeaders: () => {} }));
vi.mock('undici', () => ({ request: async () => { seam.afterHeaders(); return seam.response; } }));
afterEach(() => { seam.afterHeaders = () => {}; });
const signer: Signer = { ...noDmCrypto, publicKey: async () => new Uint8Array(32), popclawId: async () => 'owner', sign: async () => new Uint8Array(64) };

// undici's BodyReadable.destroy() emits an abort error for an unread body.
// Emit synchronously here so a missing listener deterministically replaces the
// original error; the real MCP process tests also exercise deferred emission.
class Body extends EventEmitter {
  text = vi.fn(async (): Promise<string> => { throw new Error('BODY-READ-FAILURE'); });
  destroyed = false;
  destroy() { this.destroyed = true; this.emit('error', new Error('UNREAD-BODY-ABORT')); }
}

describe('default intent pull response cleanup', () => {
  it('disposes an unread body without replacing the caught body-read failure', async () => {
    const body = new Body(); seam.response = { statusCode: 200, body };
    const client = makeIntentPullClient({ baseUrl: 'http://fixture.invalid', signer });
    await expect(client.pull('owner', 0)).rejects.toThrow('BODY-READ-FAILURE');
    expect(body.destroyed).toBe(true);
    expect(body.listenerCount('error')).toBe(0); // one-shot disposal listener consumed
  });
  it('preserves the captured cancellation when authority changes after headers and before body consumption', async () => {
    const body = new Body(); seam.response = { statusCode: 200, body };
    let active = true;
    seam.afterHeaders = () => { active = false; };
    const gate = { signal: new AbortController().signal, isActive: () => active };
    const client = makeIntentPullClient({ baseUrl: 'http://fixture.invalid', signer });
    await expect(withAction(gate, () => client.pull('owner', 0))).rejects.toBeInstanceOf(ActionInactiveError);
    expect(body.text).not.toHaveBeenCalled();
    expect(body.destroyed).toBe(true);
    expect(body.listenerCount('error')).toBe(0);
  });
});
