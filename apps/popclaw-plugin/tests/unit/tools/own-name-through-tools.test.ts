import { draftToken } from '../../helpers/draft-token.js';
/**
 * The rename and naming fixes, measured through the registered tools rather
 * than the commands underneath them: a runtime built from the real
 * `bootstrapPlugin` + `extendBoot`, and the real `registerPopclawTools`.
 * Each case here names the wiring line it pins; reverting that line turns it red.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { popclaw } from '@popclaw/contracts';
import { InMemoryHostAdapter } from '../../../src/host/host-adapter.in-memory.js';
import { bootstrapPlugin, extendBoot } from '../../../src/runtime/plugin-bootstrap.js';
import { persistNickname, NICKNAME_MAX_LENGTH } from '../../../src/onboarding/identity-writer.js';
import { bumpNamecardDeclaredAt } from '../../../src/messaging/my-namecard.js';
import { renderCopy } from '../../../src/lexicon/index.js';
import { ownerLang } from '../../../src/lexicon/owner-language.js';
import { registerPopclawTools } from '../../../src/tools/register-tools.js';
import { makeToolCollector } from '../../../src/tools/mcp-adapter.js';
import { _draftsForTest } from '../../../src/tools/draft-store.js';
import { InboxStore } from '../../../src/messaging/inbox-store.js';
import { SqliteNotifier } from '../../../src/notifier/sqlite-notifier.js';
import { BondsStore } from '../../../src/bonds/bonds-store.js';
import { makeNameChain } from '../../../src/identity/person-name.js';
import { PopclawPaths } from '../../../src/host/popclaw-paths.js';
import { deriveSigil } from '../../../src/invite/sigil.js';
import { sendDraftConfirmed } from '../../helpers/owner-approval-script.js';
import * as gather from '../../../src/newspaper/gather-materials.js';

vi.mock('../../../src/newspaper/gather-materials.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/newspaper/gather-materials.js')>();
  return { ...actual, gatherNewspaperMaterials: vi.fn(() => ({ kind: 'empty', message: 'no paper today' })) };
});

const NEW_NAME = 'CanaryMe-26e2';
const PEER_NAME = 'CanaryPeer-26e2';
const PEER = bs58.encode(nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(21)).publicKey);

type Tool = { name: string; execute: (c: string, p: unknown) => Promise<{ text: string }> };

function decode(bytes: Uint8Array) {
  return popclaw.event.EventEnvelope.decode(popclaw.identity.SignedPayload.decode(bytes).payload);
}

let root: string;
beforeEach(() => {
  _draftsForTest.clear();
  root = mkdtempSync(join(tmpdir(), 'popclaw-own-name-tools-'));
});
afterEach(() => {
  _draftsForTest.clear();
  rmSync(root, { recursive: true, force: true });
});

async function setup() {
  const host = new InMemoryHostAdapter({ config: { plugin: { lore_houses: ['http://lh.example'] } } });
  const raw = await bootstrapPlugin(host);
  // The same wrap the three roots apply (index.ts / mcp.ts / main.ts).
  const boot = extendBoot(raw, { signer: raw.signer });
  const pushed: Uint8Array[] = [];
  const egress = { push: vi.fn(async (b: Uint8Array) => { pushed.push(b); return { status: 200, eventId: 'e'.repeat(64) }; }) };
  const bondsStore = new BondsStore(host.db, () => 1000);
  const inboxStore = new InboxStore(host.db);
  const notifier = new SqliteNotifier(host.db);
  const nameOf = makeNameChain({ bond: (id) => bondsStore.get(id) });
  const collector = makeToolCollector();
  registerPopclawTools({socialSendHost: 'local-stdio',
    api: {
      ...collector.api,
      registerTool: (tool: unknown, opts?: unknown) =>
        collector.api.registerTool(typeof tool === 'function' ? (tool as (c: unknown) => unknown)({}) : tool, opts),
    } as Parameters<typeof registerPopclawTools>[0]['api'],
    runtime: (async () => ({
      host,
      boot,
      egress,
      bondsStore,
      inboxStore,
      notifier,
      nameOf,
      paths: new PopclawPaths(root),
      socialGraph: { following: () => [], followsIn: () => false },
      knownFollowers: { allFollowerIds: () => [] },
      worldFeedCache: {
        lookup: () => null,
        authorIds: () => [],
        findFullEventId: () => ({ full: null, ambiguous: [] }),
        findByEventIdPrefix: () => ({ item: null, ambiguous: [] }),
        recentForReading: () => [],
      },
    })) as unknown as Parameters<typeof registerPopclawTools>[0]['runtime'],
  });
  const find = (name: string): Tool => {
    const t = (collector.tools as unknown as Tool[]).find((x) => x.name === name);
    if (!t) throw new Error(`tool not found: ${name}`);
    return t;
  };
  return { host, boot, pushed, bondsStore, inboxStore, notifier, find };
}

describe('the owner renames, then acts through the tools (same process)', () => {
  it('a drafted post sent after the rename is signed with the new name', async () => {
    const { host, find, pushed } = await setup();
    await persistNickname(host, NEW_NAME, 'owner');
    const draft = await find('popclaw_draft_post').execute('d', { body: 'hello world' });
    const token = draft.text.match(/draft_id: (post-\d+)/)![1]!;
    await sendDraftConfirmed(find('popclaw_send_draft').execute, token);
    expect(pushed).toHaveLength(1);
    expect(decode(pushed[0]!).actor?.nickname).toBe(NEW_NAME);
  });

  it('the newspaper is gathered with the owner id and the current name, so the owner byline can be recognised', async () => {
    const { host, boot, find } = await setup();
    await persistNickname(host, NEW_NAME, 'owner');
    await find('popclaw_newspaper').execute('n', {});
    const deps = vi.mocked(gather.gatherNewspaperMaterials).mock.calls.at(-1)![0];
    expect(deps.ownerPopclawId).toBe(boot.popclawId);
    expect(deps.ownerNickname).toBe(NEW_NAME);
  });
});

describe('naming the other person through the tools', () => {
  it('the DM receipt names the recipient the owner approved', async () => {
    const { find, bondsStore } = await setup();
    bondsStore.setNickname(PEER, PEER_NAME);
    const draft = await find('popclaw_draft_message').execute('d', { recipient: PEER, body: 'hi' });
    expect(draft.text).toContain(`${PEER_NAME}#${deriveSigil(PEER)}`);
    const token = draftToken(draft.text)!;
    const sent = await sendDraftConfirmed(find('popclaw_send_draft').execute, token);
    expect(sent.text).toContain(`${PEER_NAME}#${deriveSigil(PEER)}`);
  });

  it('reading a message returns the sender name the notice used, not the envelope stamp', async () => {
    const { find, bondsStore, inboxStore } = await setup();
    bondsStore.setNickname(PEER, PEER_NAME);
    inboxStore.record({ ts: 100, fromPopclawId: PEER, toPopclawId: 'me', body: 'hello', receivedAtMs: 1000, senderNickname: 'ranger-3cwnCm' });
    const id = inboxStore.recent(1)[0]!.id;
    const read = JSON.parse((await find('popclaw_show_inbox').execute('r', { message_id: id })).text);
    expect(read.sender_nickname).toBe(PEER_NAME);
  });

  it('show_inbox lists a message whose notice the host acknowledged as acknowledged', async () => {
    const { find, inboxStore, notifier } = await setup();
    inboxStore.record({ ts: 100, fromPopclawId: PEER, toPopclawId: 'me', body: 'hello', receivedAtMs: 1000 });
    const msg = inboxStore.recent(1)[0]!;
    inboxStore.settleNotification(msg.id, 'queued', () => notifier.enqueue({ level: 'L1', kind: 'dm', payload: { messageId: msg.id } }));
    const [notice] = notifier.peekFor('claude-code');
    notifier.acknowledgeFor('claude-code', [notice!.id]);
    const list = JSON.parse((await find('popclaw_show_inbox').execute('l', {})).text);
    expect(list.messages[0].notification_state).toBe('acknowledged');
  });
});

describe('popclaw_set_name refuses a name the config cannot hold, with no side effects', () => {
  afterEach(() => vi.unstubAllGlobals());

  async function seeded() {
    const s = await setup();
    // The conformant "no card yet" answer for this identity, so the namecard
    // write guard lets a valid rename through to the push.
    const body = { popclaw_id: s.boot.popclawId, sigil: deriveSigil(s.boot.popclawId), profiles: [], house_follower_count: 0, house_post_count: 0, house_reply_received_count: 0 };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })));
    await persistNickname(s.host, 'OldName', 'auto');
    await bumpNamecardDeclaredAt(s.host, () => 1_700_000_000);
    const sign = vi.spyOn(s.boot.signer, 'sign');
    return { ...s, sign };
  }

  const overLimit = [
    ['33 ASCII units', 'A'.repeat(NICKNAME_MAX_LENGTH + 1)],
    ['33 CJK characters', '青'.repeat(NICKNAME_MAX_LENGTH + 1)],
    // 17 visible glyphs, 34 UTF-16 units: the cap counts the way the config schema does.
    ['17 emoji', '\u{1F426}'.repeat(17)],
  ] as const;

  it.each(overLimit)('refuses %s before persisting, bumping declared_at, signing or pushing', async (_label, name) => {
    const { host, find, pushed, sign } = await seeded();
    const before = structuredClone(await host.config.loadJson('plugin'));
    const r = await find('popclaw_set_name').execute('n', { nickname: name });
    expect(r.text).toBe(renderCopy(ownerLang(), 'name.tooLongRejected'));
    const after = (await host.config.loadJson('plugin')) as { ranger_profile: Record<string, unknown> };
    expect(after).toEqual(before);
    expect(after.ranger_profile.nickname).toBe('OldName');
    expect(after.ranger_profile.name_source).toBe('auto');
    expect(after.ranger_profile.namecard_declared_at).toBe(1_700_000_000);
    expect(sign).not.toHaveBeenCalled();
    expect(pushed).toHaveLength(0);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  const valid = [
    ['a CJK name', '青鸾'],
    ['a name with an internal space', 'Black Feather'],
    ['a mixed-script name', 'Kai青鸾-7'],
    ['a name exactly at the cap', 'B'.repeat(NICKNAME_MAX_LENGTH)],
    ['an emoji name', '\u{1F426}Blue'],
  ] as const;

  it.each(valid)('still renames to %s through the same entry, signed and pushed', async (_label, name) => {
    const { host, find, pushed, sign } = await seeded();
    const r = await find('popclaw_set_name').execute('n', { nickname: name });
    expect(r.text).toContain(name);
    const after = (await host.config.loadJson('plugin')) as { ranger_profile: Record<string, unknown> };
    expect(after.ranger_profile.nickname).toBe(name);
    expect(after.ranger_profile.name_source).toBe('owner');
    expect(after.ranger_profile.namecard_declared_at).toBeGreaterThan(1_700_000_000);
    expect(sign).toHaveBeenCalled();
    expect(pushed).toHaveLength(1);
    expect(decode(pushed[0]!).profile?.nickname).toBe(name);
  });

  it('the description no longer routes an onboarding naming answer to popclaw_set_name', async () => {
    const { find } = await setup();
    const d = (find('popclaw_set_name') as unknown as { description: string }).description;
    expect(d).not.toMatch(/as well when the owner wants to pick his own name during onboarding/);
    expect(d).toMatch(/popclaw_onboarding_continue/);
    const hint = (find('popclaw_set_name') as unknown as { parameters: { properties: { nickname: { description: string } } } })
      .parameters.properties.nickname.description;
    expect(hint).not.toMatch(/2-12/);
    expect(hint).toMatch(/1-32 characters/);
    expect(hint).toMatch(/not the sentence around it/);
  });

  it('the world guide does not send an onboarding naming answer to popclaw_set_name', () => {
    const collector = makeToolCollector();
    registerPopclawTools({socialSendHost: 'local-stdio',
      api: collector.api as Parameters<typeof registerPopclawTools>[0]['api'],
      runtime: vi.fn() as unknown as Parameters<typeof registerPopclawTools>[0]['runtime'],
      getWorldDeps: (async () => ({})) as unknown as Parameters<typeof registerPopclawTools>[0]['getWorldDeps'],
    });
    const guide = (collector.tools as unknown as Array<{ name: string; description: string }>).find(
      (t) => t.name === 'popclaw_world_guide',
    )!;
    expect(guide.description).not.toMatch(/changed anytime with popclaw_set_name/);
    expect(guide.description).toMatch(/while onboarding is in progress a naming answer goes to popclaw_onboarding_continue/);
  });
});
