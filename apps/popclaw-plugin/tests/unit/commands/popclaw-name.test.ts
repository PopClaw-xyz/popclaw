import { describe, it, expect } from 'vitest';
import { InMemoryHostAdapter } from '../../../src/host/host-adapter.in-memory.js';
import { runPopclawNameCommand } from '../../../src/commands/popclaw-name.js';
import { readNameSource } from '../../../src/onboarding/identity-writer.js';
// D8: assert through the same renderer the command uses, never a literal.
import { renderCopy } from '../../../src/lexicon/index.js';
import { ownerLang } from '../../../src/lexicon/owner-language.js';

function deps(host: InMemoryHostAdapter, pushStatus = 200) {
  return {
    host,
    signer: { publicKey: async () => new Uint8Array(32), sign: async () => new Uint8Array(64), popclawId: async () => 'aaaaaa11bbbbbb22' } as any,
    egress: { push: async () => ({ status: pushStatus }) } as any,
    popclawId: 'aaaaaa11bbbbbb22',
    clock: { now: () => new Date('2026-06-15T00:00:00Z') },
    houseOrigins: [],
    fetch: (async () => new Response(JSON.stringify({ popclaw_id: 'x', sigil: 'abc234', profiles: [], house_follower_count: 0, house_post_count: 0, house_reply_received_count: 0 }), { status: 200 })) as typeof fetch,
  };
}

describe('runPopclawNameCommand', () => {
  it('persists the new name with source=owner and confirms', async () => {
    const host = new InMemoryHostAdapter();
    const r = await runPopclawNameCommand({ nickname: '青鸾' }, deps(host));
    expect(r.text).toContain('青鸾');
    const loaded = (await host.config.loadJson('plugin')) as { ranger_profile: { nickname: string } };
    expect(loaded.ranger_profile.nickname).toBe('青鸾');
    expect(await readNameSource(host)).toBe('owner');
  });

  it('rejects empty name with usage', async () => {
    const host = new InMemoryHostAdapter();
    const r = await runPopclawNameCommand({ nickname: '   ' }, deps(host));
    expect(r.text.toLowerCase()).toContain('usage');
  });

  it('rejects a ranger-xxxxxx placeholder name', async () => {
    const host = new InMemoryHostAdapter();
    const r = await runPopclawNameCommand({ nickname: 'ranger-7gXkQz' }, deps(host));
    expect(r.text).toBe(renderCopy(ownerLang(), 'name.placeholderRejected'));
  });

  it('rejects a bare-digit name (mis-typed menu choice)', async () => {
    const host = new InMemoryHostAdapter();
    const r = await runPopclawNameCommand({ nickname: '2' }, deps(host));
    expect(r.text).toBe(renderCopy(ownerLang(), 'name.digitsRejected'));
    // not persisted
    const loaded = (await host.config.loadJson('plugin')) as { ranger_profile?: { nickname?: string } } | null;
    expect(loaded?.ranger_profile?.nickname).not.toBe('2');
  });

  it('surfaces push failure honestly (name kept locally)', async () => {
    const host = new InMemoryHostAdapter();
    const r = await runPopclawNameCommand({ nickname: '青鸾' }, deps(host, 503));
    expect(r.text).toContain('503');
  });
});
