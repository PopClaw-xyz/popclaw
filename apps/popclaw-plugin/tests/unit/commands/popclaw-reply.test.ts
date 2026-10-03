import { describe, it, expect, vi } from 'vitest';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { MasterKeySigner } from '../../../src/identity/master-key-signer.js';
import type { MasterKey } from '../../../src/identity/keystore.js';
import { runPopclawReplyCommand } from '../../../src/commands/popclaw-reply.js';
import { popclaw } from '@popclaw/contracts';

function makeSigner(): MasterKeySigner {
  const seed = new Uint8Array(32);
  for (let i = 0; i < 32; i++) seed[i] = i;
  const kp = nacl.sign.keyPair.fromSeed(seed);
  const key: MasterKey = {
    seed,
    publicKey: kp.publicKey,
    secretKey: kp.secretKey,
    popclawId: bs58.encode(kp.publicKey),
  };
  return new MasterKeySigner(key);
}

const cacheItem = (over: Record<string, unknown> = {}) => ({
  handle: 'karpathy',
  textPreview: 'foo',
  authorPopclawId: 'AuthorXYZ',
  ...over,
});

const cacheStub = (item: ReturnType<typeof cacheItem> | null) => ({
  lookup: vi.fn().mockReturnValue(item),
});

describe('runPopclawReplyCommand', () => {
  it('signs + pushes a Reply envelope; reply contains correct PostRef and body', async () => {
    const signer = makeSigner();
    const cache = cacheStub(cacheItem({ authorPopclawId: 'AuthorXYZ' }));
    const egress = { push: vi.fn().mockResolvedValue(undefined) };

    const out = await runPopclawReplyCommand(
      { positional: ['12345', 'great', 'point', 'about', 'RLHF'] },
      { signer, egress, cache, nickname: 'TestNick' },
    );
    expect(out.text).toContain('@karpathy');
    expect(egress.push).toHaveBeenCalledTimes(1);

    const sentBytes = egress.push.mock.calls[0]![0] as Uint8Array;
    const sp = popclaw.identity.SignedPayload.decode(sentBytes);
    const env = popclaw.event.EventEnvelope.decode(sp.payload);
    expect(env.reply).toBeTruthy();
    expect(env.reply!.body).toBe('great point about RLHF');
    expect(env.reply!.inReplyTo!.platform).toBe('x');
    expect(env.reply!.inReplyTo!.platformPostId).toBe('12345');
    expect(env.reply!.inReplyTo!.authorPopclawId).toBe('AuthorXYZ');
  });

  it('accepts <platform>:<postId> form and uses that platform', async () => {
    const signer = makeSigner();
    const cache = cacheStub(cacheItem());
    const egress = { push: vi.fn().mockResolvedValue(undefined) };
    await runPopclawReplyCommand(
      { positional: ['instagram:99', 'hi'] },
      { signer, egress, cache, nickname: 'TestNick' },
    );
    expect(cache.lookup).toHaveBeenCalledWith('instagram', '99');
    const sp = popclaw.identity.SignedPayload.decode(egress.push.mock.calls[0]![0] as Uint8Array);
    const env = popclaw.event.EventEnvelope.decode(sp.payload);
    expect(env.reply!.inReplyTo!.platform).toBe('instagram');
    expect(env.reply!.inReplyTo!.platformPostId).toBe('99');
  });

  it('returns usage when args missing', async () => {
    const signer = makeSigner();
    const cache = cacheStub(cacheItem());
    const egress = { push: vi.fn() };
    const out = await runPopclawReplyCommand({ positional: [] }, { signer, egress, cache, nickname: 'TestNick' });
    expect(out.text.toLowerCase()).toMatch(/usage/);
    expect(egress.push).not.toHaveBeenCalled();
  });

  it('returns helpful error when post is not in cache', async () => {
    const signer = makeSigner();
    const cache = cacheStub(null);
    const egress = { push: vi.fn() };
    const out = await runPopclawReplyCommand(
      { positional: ['unknown-id', 'body'] },
      { signer, egress, cache, nickname: 'TestNick' },
    );
    expect(out.text).toMatch(/not found|cannot reply/i);
    expect(egress.push).not.toHaveBeenCalled();
  });

  it('omits authorPopclawId in PostRef when post author is non-popclaw (proto3 default elision)', async () => {
    const signer = makeSigner();
    // Cache item exists but author isn't a known popclaw user.
    const cache = cacheStub(cacheItem({ authorPopclawId: '' }));
    const egress = { push: vi.fn().mockResolvedValue(undefined) };
    await runPopclawReplyCommand(
      { positional: ['9999', 'hello'] },
      { signer, egress, cache, nickname: 'TestNick' },
    );
    const sp = popclaw.identity.SignedPayload.decode(egress.push.mock.calls[0]![0] as Uint8Array);
    const env = popclaw.event.EventEnvelope.decode(sp.payload);
    // pbjs decode of an absent string field gives '' — same as prost would.
    expect(env.reply!.inReplyTo!.authorPopclawId).toBe('');
  });
});
