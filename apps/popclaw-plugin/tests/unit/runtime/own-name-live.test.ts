/**
 * After a rename in the same process, everything signed afterwards carries the
 * new name. `boot.nickname` used to be a startup snapshot (and object spreads
 * of `boot` froze it again), so posts and DMs kept signing `ranger-xxxxxx` —
 * and a signed envelope cannot be corrected once readers have it.
 */
import { describe, it, expect, vi } from 'vitest';
import { popclaw } from '@popclaw/contracts';
import { InMemoryHostAdapter } from '../../../src/host/host-adapter.in-memory.js';
import { bootstrapPlugin, extendBoot } from '../../../src/runtime/plugin-bootstrap.js';
import { runPopclawNameCommand } from '../../../src/commands/popclaw-name.js';
import { runPopclawPostCommand } from '../../../src/commands/popclaw-post.js';
import { runPopclawMessageCommand } from '../../../src/commands/popclaw-message.js';
import { runPopclawReplyCommand } from '../../../src/commands/popclaw-reply.js';
import { buildAuthorBlock } from '../../../src/newspaper/author-block.js';
import { EventBuilder } from '../../../src/event/event-builder.js';
import type { WorldFeedCache } from '../../../src/ingress/world-feed-cache.js';

const NEW_NAME = 'CanaryMe-26e2';

function decode(bytes: Uint8Array) {
  return popclaw.event.EventEnvelope.decode(popclaw.identity.SignedPayload.decode(bytes).payload);
}

async function renamedBoot() {
  const host = new InMemoryHostAdapter({ config: { plugin: { lore_houses: ['http://lh.example'] } } });
  const raw = await bootstrapPlugin(host);
  // The same wrap index.ts / mcp.ts apply to the boot object.
  const boot = extendBoot(raw, { signer: raw.signer });
  const before = boot.nickname;
  const pushed: Uint8Array[] = [];
  const egress = { push: vi.fn(async (b: Uint8Array) => { pushed.push(b); return { status: 200, eventId: 'e'.repeat(64) }; }) };
  const named = await runPopclawNameCommand({ nickname: NEW_NAME }, {
    host,
    signer: boot.signer,
    egress: egress as never,
    popclawId: boot.popclawId,
    clock: { now: () => new Date('2026-09-26T00:00:00Z') },
    houseOrigins: [],
  });
  return { boot, before, named, namecard: pushed[0]! };
}

describe('a rename reaches every envelope signed after it (same process)', () => {
  it('boot.nickname follows the rename through the boot wrap', async () => {
    const { boot, before } = await renamedBoot();
    expect(before).toMatch(/^ranger-/);
    expect(boot.nickname).toBe(NEW_NAME);
  });

  it('the re-signed namecard declares the new name', async () => {
    const { namecard } = await renamedBoot();
    const env = decode(namecard);
    expect(env.actor?.nickname).toBe(NEW_NAME);
  });

  it('a post signed after the rename carries the new name', async () => {
    const { boot } = await renamedBoot();
    const egress = { push: vi.fn(async (_b: Uint8Array) => ({ status: 200, eventId: 'd'.repeat(64) })) };
    await runPopclawPostCommand({ positional: ['hello'], flags: {} }, {
      signer: boot.signer,
      egress,
      nickname: boot.nickname, // what write-tools reads from rt.boot at send time
      webBaseUrl: 'http://localhost:3000',
      cache: { findFullEventId: () => ({ full: null, ambiguous: [] }), findByEventIdPrefix: () => ({ item: null, ambiguous: [] }) } as unknown as WorldFeedCache,
    });
    expect(decode(egress.push.mock.calls[0]![0] as Uint8Array).actor?.nickname).toBe(NEW_NAME);
  });

  it('a DM signed after the rename carries the new name', async () => {
    const { boot } = await renamedBoot();
    const peer = await bootstrapPlugin(new InMemoryHostAdapter({ config: { plugin: { lore_houses: ['http://lh.example'] } } }));
    const egress = { push: vi.fn().mockResolvedValue(undefined) };
    await runPopclawMessageCommand({ positional: [peer.popclawId, 'hi'] }, { signer: boot.signer, egress, nickname: boot.nickname });
    expect(decode(egress.push.mock.calls[0]![0] as Uint8Array).actor?.nickname).toBe(NEW_NAME);
  });

  it('a reply signed after the rename carries the new name', async () => {
    const { boot } = await renamedBoot();
    const egress = { push: vi.fn(async (_b: Uint8Array) => ({ status: 200 })) };
    await runPopclawReplyCommand({ positional: ['12345', 'agreed'] }, {
      signer: boot.signer,
      egress,
      cache: { lookup: () => ({ handle: 'karpathy', textPreview: 'foo', authorPopclawId: 'AuthorXYZ' }) },
      nickname: boot.nickname,
    } as never);
    expect(decode(egress.push.mock.calls[0]![0]).actor?.nickname).toBe(NEW_NAME);
  });

  it("a reader's byline for that post shows the new name", async () => {
    const { boot } = await renamedBoot();
    const egress = { push: vi.fn(async (_b: Uint8Array) => ({ status: 200, eventId: 'd'.repeat(64) })) };
    await runPopclawPostCommand({ positional: ['hello'], flags: {} }, {
      signer: boot.signer,
      egress,
      nickname: boot.nickname,
      webBaseUrl: 'http://localhost:3000',
      cache: { findFullEventId: () => ({ full: null, ambiguous: [] }), findByEventIdPrefix: () => ({ item: null, ambiguous: [] }) } as unknown as WorldFeedCache,
    });
    const env = decode(egress.push.mock.calls[0]![0]);
    // A reader (not the owner, so no owner override) builds the byline from the envelope actor.
    const byline = buildAuthorBlock({
      platform: 'popclaw', platformPostId: 'p', eventId: 'e', platformPostCreatedAt: 1,
      authorPopclawId: env.actor?.popclawId ?? '', handle: '', originalUrl: '', textPreview: '',
      body: '', media: [], replyToAuthorHandle: '', replyCount: 0, markCount: 0,
      actorNickname: env.actor?.nickname ?? '', actorVerified: [], kind: 'post',
    } as never, 'https://popclaw.me');
    expect(byline.name).toBe(NEW_NAME);
    expect(byline.profileUrl).toContain(`/${NEW_NAME}/`);
  });

  it('the invite-request builder wired at boot reads the name at build time', async () => {
    const { boot } = await renamedBoot();
    const builder = new EventBuilder(boot.signer, () => boot.nickname);
    const env = await builder.buildInviteRequest({ platform: 'x', handle: 'someone' });
    expect((env.actor as { nickname: string }).nickname).toBe(NEW_NAME);
  });
});

describe('a rename reaches another process sharing the data root', () => {
  it("the other boot's nickname follows the persisted rename, no listener involved", async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { LocalHostAdapter } = await import('../../../src/host/local-host-adapter.js');
    const { persistNickname } = await import('../../../src/onboarding/identity-writer.js');
    const root = mkdtempSync(join(tmpdir(), 'popclaw-own-name-'));
    const logger = { info() {}, warn() {}, error() {} };
    // Two hosts over one root stand in for the gateway and an MCP server:
    // separate adapters, so the in-process listener of one never fires in the other.
    const gateway = new LocalHostAdapter({ dataRoot: root, logger });
    const mcp = new LocalHostAdapter({ dataRoot: root, logger });
    try {
      await gateway.config.saveJson('plugin', { lore_houses: ['http://lh.example'] });
      const gatewayBoot = await bootstrapPlugin(gateway);
      const mcpBoot = extendBoot(await bootstrapPlugin(mcp), {});
      expect(mcpBoot.nickname).toMatch(/^ranger-/);
      await persistNickname(gateway, NEW_NAME, 'owner');
      expect(gatewayBoot.nickname).toBe(NEW_NAME);
      expect(mcpBoot.nickname).toBe(NEW_NAME);
    } finally {
      gateway.db.close();
      mcp.db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('the cross-process re-read survives a bad read', () => {
  it('a config that could not be parsed is read again at the same version', async () => {
    const host = new InMemoryHostAdapter({ config: { plugin: { lore_houses: ['http://lh.example'] } } });
    const boot = await bootstrapPlugin(host);
    const before = boot.nickname;
    // A file-backed config caught mid-write: same version, first read throws.
    let reads = 0;
    Object.assign(host.config, {
      versionOf: () => 'ino:1:100',
      loadJsonSync: () => {
        reads += 1;
        if (reads === 1) throw new SyntaxError('Unexpected end of JSON input');
        return { ranger_profile: { nickname: NEW_NAME } };
      },
    });
    expect(boot.nickname).toBe(before);
    expect(boot.nickname).toBe(NEW_NAME);
    // Seen now: the same version is not read a third time.
    expect(boot.nickname).toBe(NEW_NAME);
    expect(reads).toBe(2);
  });
});

describe('the config change marker', () => {
  it('tells two same-size writes apart even when they share a timestamp', async () => {
    const { mkdtempSync, rmSync, statSync, utimesSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { LocalHostAdapter } = await import('../../../src/host/local-host-adapter.js');
    const root = mkdtempSync(join(tmpdir(), 'popclaw-own-name-ver-'));
    const host = new LocalHostAdapter({ dataRoot: root, logger: { info() {}, warn() {}, error() {} } });
    try {
      const path = host.config.pathFor!('plugin');
      const tick = new Date('2026-09-26T00:00:00Z');
      await host.config.saveJson('plugin', { ranger_profile: { nickname: 'NameAAAA' } });
      utimesSync(path, tick, tick);
      const first = host.config.versionOf!('plugin');
      await host.config.saveJson('plugin', { ranger_profile: { nickname: 'NameBBBB' } });
      utimesSync(path, tick, tick); // same tick, same size: only the inode moved
      expect(statSync(path).mtimeMs).toBe(tick.getTime());
      expect(host.config.versionOf!('plugin')).not.toBe(first);
    } finally {
      host.db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
