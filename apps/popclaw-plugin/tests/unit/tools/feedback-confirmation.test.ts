/**
 * `popclaw_feedback` drafts; only the owner's confirmation sends.
 *
 * Real hardware, 2026-09-21 (fifth pack e909d79b, OpenClaw UI): a world
 * action came back NATIVE_POLICY_REQUIRED and the model — nobody having
 * asked it to — called the feedback tool twice. The first call named
 * `127.0.0.1:8113` and was refused, and the refusal helpfully suggested
 * dropping the house argument; the model did exactly that, and the second
 * call SENT an encrypted letter to the home lore-house's contact
 * (`#z1hd04eb`, event 1d5be937…d029) carrying the error and the whole set of
 * fabricated test parameters. The owner had authorised one local check-in
 * and nothing else.
 *
 * Feedback is an outbound private message to a person, so it goes through
 * the same gate every other outbound private message goes through: the tool
 * produces a draft naming the recipient, the lore-house and the complete
 * text, and `popclaw_send_draft` is the only thing that pushes. The
 * owner-typed slash command is the owner acting and still sends directly,
 * exactly like `/popclaw message`.
 */
import { afterEach, beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { popclaw } from '@popclaw/contracts';
import { MasterKeySigner } from '../../../src/identity/master-key-signer.js';
import { registerFeedbackCadenceTools } from '../../../src/tools/feedback-cadence-tools.js';
import { registerWriteTools } from '../../../src/tools/write-tools.js';
import type { ToolsCtx } from '../../../src/tools/tools-context.js';
import { _draftsForTest } from '../../../src/tools/draft-store.js';
import { runPopclawFeedbackCommand } from '../../../src/commands/popclaw-feedback.js';
import { runPopclawMessageCommand } from '../../../src/commands/popclaw-message.js';
import { deriveSigil } from '../../../src/invite/sigil.js';
import { setOwnerLang } from '../../../src/lexicon/owner-language.js';
import { sendDraftApproved } from '../../helpers/owner-approval-script.js';
import { describeSendDraft } from '../../../src/tools/send-draft-subject.js';
import { renderCopy } from '../../../src/lexicon/index.js';

beforeAll(() => setOwnerLang('en', 'config'));
afterAll(() => setOwnerLang('zh-CN', 'config'));
afterEach(() => _draftsForTest.clear());

function keyed(byte: number): { id: string; signer: MasterKeySigner } {
  const seed = new Uint8Array(32).fill(byte);
  const kp = nacl.sign.keyPair.fromSeed(seed);
  const id = bs58.encode(kp.publicKey);
  return { id, signer: new MasterKeySigner({ seed, ...kp, popclawId: id }) };
}

const OWNER = keyed(1);
const HOME_CONTACT = keyed(9);
const OTHER_CONTACT = keyed(11);
const THIRD_CONTACT = keyed(13);

const guide = (contact: string, id: string): string =>
  ['---', 'world: popclaw.me', 'feedback:', `  contact: ${contact}`, `  popclaw_id: ${id}`, '---', 'body'].join('\n');

const HOME_GUIDE = guide('Longtu', HOME_CONTACT.id);

interface Tool {
  readonly name: string;
  readonly description?: string;
  execute(callId: string, params: unknown): Promise<{ text: string }>;
}

function setup(over: { homeGuide?: string | null; otherGuide?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'popclaw-fb-confirm-'));
  const guideFile = (slug: string): string => join(dir, `${slug}.md`);
  // The secondary lore-house's guide as the ADR-0041 handshake left it on disk.
  writeFileSync(guideFile('other-house-7001'), over.otherGuide ?? guide('Warden', OTHER_CONTACT.id), 'utf8');

  const pushed: Array<{ house: string | undefined; bytes: Uint8Array }> = [];
  const pushTo = vi.fn(async (house: string | undefined, bytes: Uint8Array) => {
    pushed.push({ house, bytes });
    return { status: 200, eventId: 'ab'.repeat(32) };
  });
  const push = vi.fn(async (bytes: Uint8Array) => pushTo(undefined, bytes));
  let homeGuide: string | null = over.homeGuide === undefined ? HOME_GUIDE : over.homeGuide;

  const runtime = async () => ({
    boot: {
      signer: OWNER.signer,
      nickname: 'Owner',
      popclawId: OWNER.id,
      loreHouseUrl: 'http://home-house:9000',
      loreHouseUrls: ['http://home-house:9000', 'http://other-house:7001'],
    },
    egress: { push, pushTo },
    inboxStore: { houseOf: () => undefined },
    guideClient: { fetchGuideText: async () => homeGuide },
    paths: { houseGuideFile: guideFile },
    worldFeedCache: {},
    bondsStore: { list: () => [] },
  });

  const tools = new Map<string, Tool>();
  const api = {
    registerTool: (tool: unknown) => {
      const resolved = typeof tool === 'function' ? (tool as (ctx: unknown) => Tool)({ agentId: 'test' }) : (tool as Tool);
      tools.set(resolved.name, resolved);
    },
  };
  const ctx = { api, runtime, deps: { api, runtime }, total: 4 } as unknown as ToolsCtx;
  registerFeedbackCadenceTools(ctx);
  registerWriteTools(ctx);

  const call = (name: string, params: unknown): Promise<{ text: string }> => tools.get(name)!.execute('test', params);
  // Confirming = the OWNER approving this exact letter through the
  // owner-approval seam, then the tool body running. Handing the draft_id back
  // is the model's half and on its own it sends nothing
  // (tools/send-draft-subject.ts).
  const confirm = (draft: { text: string }): Promise<{ text: string }> => {
    const token = draft.text.match(/draft_id: (\S+)/)?.[1];
    expect(token, 'the draft must carry a draft_id').toBeTruthy();
    return sendDraftApproved((id, params) => tools.get('popclaw_send_draft')!.execute(id, params), token!);
  };
  const recipientOf = (bytes: Uint8Array): string => {
    const signed = popclaw.identity.SignedPayload.decode(bytes);
    return popclaw.event.EventEnvelope.decode(signed.payload).directMessage!.toPopclawId ?? '';
  };
  return {
    call,
    confirm,
    confirmId: (token: string): Promise<{ text: string }> =>
      sendDraftApproved((id, params) => tools.get('popclaw_send_draft')!.execute(id, params), token),
    pushed,
    push,
    pushTo,
    recipientOf,
    tool: (name: string): Tool => tools.get(name)!,
    rewriteOtherHouseGuide: (contact: string, id: string): void =>
      writeFileSync(guideFile('other-house-7001'), guide(contact, id), 'utf8'),
    setHomeGuide: (md: string | null): void => {
      homeGuide = md;
    },
  };
}

describe('popclaw_feedback produces a draft, never a delivery', () => {
  it('one call sends nothing and names the recipient, the lore-house and the whole text', async () => {
    const fx = setup();

    const r = await fx.call('popclaw_feedback', {
      kind: 'bug',
      body: 'what I tried: a check-in; where I got stuck: NATIVE_POLICY_REQUIRED',
    });

    // The defect itself: a single tool call must not reach egress at all.
    expect(fx.pushed).toEqual([]);
    expect(fx.push).not.toHaveBeenCalled();
    expect(fx.pushTo).not.toHaveBeenCalled();
    // And what the owner is asked to confirm must be complete.
    expect(r.text).toMatch(/draft_id: \S+/);
    expect(r.text).toContain(`Longtu#${deriveSigil(HOME_CONTACT.id)}`);
    expect(r.text).toContain(HOME_CONTACT.id);
    expect(r.text).toContain('home-house-9000');
    expect(r.text).toContain('where I got stuck: NATIVE_POLICY_REQUIRED');
    expect(r.text).toContain('[feedback/v1] kind=bug');
  });

  // The control group for the assertion above: the same spy, the same
  // fixture, one confirmation — if egress were unreachable in this wiring,
  // this test would be red instead of the one above being falsely green.
  it('the confirmation step pushes exactly once, to the drafted recipient', async () => {
    const fx = setup();

    const draft = await fx.call('popclaw_feedback', { kind: 'need', body: 'batch postcards' });
    const sent = await fx.confirm(draft);

    expect(fx.pushed).toHaveLength(1);
    expect(fx.recipientOf(fx.pushed[0]!.bytes)).toBe(HOME_CONTACT.id);
    expect(sent.text).toContain('need feedback sent, encrypted');
  });

  // The prompt's house frame must not read as a route. The house named is the
  // one whose guide.md DECLARES the contact; which house relays the letter is
  // read live inside the send and this approval does not bind it.
  it('the approval prompt names the declaring house, not a route', async () => {
    const fx = setup();
    const draft = await fx.call('popclaw_feedback', { kind: 'need', body: 'batch postcards' });
    const token = draft.text.match(/draft_id: (\S+)/)![1]!;

    const described = describeSendDraft({ draft_id: token });
    expect(described.kind).toBe('ask');
    if (described.kind !== 'ask') return;

    const joined = described.description.join('\n');
    expect(joined).toContain(renderCopy('en', 'sendDraft.approval.declaringHouse', { house: 'home-house-9000' }));
    expect(joined).not.toContain(renderCopy('en', 'sendDraft.approval.house', { house: 'home-house-9000' }));
  });

  it('a draft is single-use: confirming twice sends once', async () => {
    const fx = setup();

    const draft = await fx.call('popclaw_feedback', { kind: 'bug', body: 'broken' });
    await fx.confirm(draft);
    const again = await fx.confirm(draft);

    expect(fx.pushed).toHaveLength(1);
    expect(again.text).toContain('unknown or expired');
  });

  it('a named lore-house that is not mounted stops the tool, and the refusal names no other contact', async () => {
    const fx = setup();

    const r = await fx.call('popclaw_feedback', { kind: 'bug', body: 'broken', house: '127.0.0.1:8113' });

    expect(fx.pushed).toEqual([]);
    expect(r.text).not.toMatch(/draft_id/);
    expect(r.text).toContain('No mounted lore-house');
    expect(r.text).toContain('127.0.0.1:8113');
    // The refusal that started the incident offered the home lore-house's
    // contact as the way around itself. It must offer nothing of the kind.
    expect(r.text).not.toMatch(/contact/i);
    expect(r.text).not.toContain(HOME_CONTACT.id);
    // Nothing was parked either — there is no draft to confirm.
    expect(await fx.confirmId('message-1')).toMatchObject({
      text: expect.stringContaining('unknown or expired'),
    });
  });

  it('a draft addressed to one lore-house cannot be sent to another', async () => {
    const fx = setup();

    const draft = await fx.call('popclaw_feedback', { kind: 'bug', body: 'their gameplay is broken', house: 'other-house-7001' });
    expect(draft.text).toContain('other-house-7001');
    expect(draft.text).toContain(OTHER_CONTACT.id);

    // Between drafting and confirming, that lore-house's cached guide names
    // a different contact, and the home guide changes too.
    fx.rewriteOtherHouseGuide('Usurper', THIRD_CONTACT.id);
    fx.setHomeGuide(guide('Usurper', THIRD_CONTACT.id));
    await fx.confirm(draft);

    expect(fx.pushed).toHaveLength(1);
    expect(fx.pushed[0]!.house).toBe('other-house-7001');
    expect(fx.recipientOf(fx.pushed[0]!.bytes)).toBe(OTHER_CONTACT.id);
  });

  it('says which lore-house the letter is addressed to even when the agent named none', async () => {
    const fx = setup();

    const draft = await fx.call('popclaw_feedback', { kind: 'need', body: 'x' });

    // Two lore-houses are mounted; the draft must state plainly whose
    // contact this is, not leave the owner to guess.
    expect(draft.text).toContain('home-house-9000');
  });

  it('a lore-house with no declared contact still refuses without a draft', async () => {
    const fx = setup({ homeGuide: '---\nworld: popclaw.me\n---\nbody' });

    const r = await fx.call('popclaw_feedback', { kind: 'bug', body: 'broken' });

    expect(fx.pushed).toEqual([]);
    expect(r.text).not.toMatch(/draft_id/);
    expect(r.text).toContain('names no feedback contact');
  });

  it('the tool description says it drafts, and forbids self-initiated letters', async () => {
    const fx = setup();
    const description = fx.tool('popclaw_feedback').description ?? '';

    expect(description).toContain('draft');
    expect(description).toContain('popclaw_send_draft');
    expect(description).toContain('only when the owner asks');
    expect(description).toContain('never call it on your own initiative');
  });
});

/**
 * The same guards on the other lane. Everything above runs with the owner
 * speaking English, which is the default (`owner-language.ts`) and the lane
 * the 2026-09-21 incident happened in — so an en-only assertion leaves the
 * Chinese copy free to say whatever it likes. Reviewer's mutation C: putting
 * the old "drop the house flag and it goes to the home lore-house's contact"
 * hint back into zh-CN.ts ALONE left the whole suite green.
 */
describe('the zh-CN lane', () => {
  beforeAll(() => setOwnerLang('zh-CN', 'config'));
  afterAll(() => setOwnerLang('en', 'config'));

  it('the unmounted-lore-house refusal names no contact and offers no way round itself', async () => {
    const fx = setup();

    const r = await fx.call('popclaw_feedback', { kind: 'bug', body: '坏了', house: '127.0.0.1:8113' });

    expect(fx.pushed).toEqual([]);
    expect(r.text).not.toMatch(/draft_id/);
    expect(r.text).toContain('没有挂着灯坊');
    expect(r.text).toContain('127.0.0.1:8113');
    // No contact of any lore-house, and a full stop rather than a retry recipe.
    expect(r.text).not.toContain('联系人');
    expect(r.text).not.toContain(HOME_CONTACT.id);
    expect(r.text).toContain('到此为止');
  });

  it('the draft preview renders whole: recipient, lore-house, and the letter itself', async () => {
    const fx = setup();

    const draft = await fx.call('popclaw_feedback', { kind: 'bug', body: '打卡提交不上去' });

    expect(fx.pushed).toEqual([]);
    expect(draft.text).toContain('bug 反馈草稿');
    expect(draft.text).toContain(`Longtu#${deriveSigil(HOME_CONTACT.id)}`);
    expect(draft.text).toContain(HOME_CONTACT.id);
    expect(draft.text).toContain('灯坊：home-house-9000');
    expect(draft.text).toContain('完整信件');
    expect(draft.text).toContain('打卡提交不上去');
    expect(draft.text).toMatch(/draft_id: \S+/);
  });

  it('a lore-house that declares no contact says in the draft where the letter went instead', async () => {
    const fx = setup({ otherGuide: '---\nworld: popclaw.me\n---\n正文' });

    const draft = await fx.call('popclaw_feedback', { kind: 'need', body: '想批量寄明信片', house: 'other-house-7001' });

    // The redirect is stated in words, and the real recipient is named in full —
    // the owner is never asked to confirm a destination they were not shown.
    expect(fx.pushed).toEqual([]);
    expect(draft.text).toContain('你点的是「other-house-7001」');
    expect(draft.text).toContain('没有声明联系人');
    expect(draft.text).toContain('灯坊：home-house-9000');
    expect(draft.text).toContain(HOME_CONTACT.id);
  });
});

describe('the owner typing the slash command is the owner acting', () => {
  const STAMP = '0.1.0 test';

  it('/popclaw feedback sends straight away, exactly as /popclaw message does', async () => {
    const pushes: Uint8Array[] = [];
    const egress = { push: async (bytes: Uint8Array) => void pushes.push(bytes) };
    const shared = { signer: OWNER.signer, egress, nickname: 'Owner' };

    await runPopclawMessageCommand({ positional: [HOME_CONTACT.id, 'hello'] }, shared);
    expect(pushes).toHaveLength(1);

    await runPopclawFeedbackCommand({ positional: ['bug', 'broken'] }, {
      ...shared,
      fetchGuide: async () => HOME_GUIDE,
      houseSlug: 'home-house-9000',
      buildStamp: STAMP,
    } as unknown as Parameters<typeof runPopclawFeedbackCommand>[1]);

    // No draft_id anywhere in the slash-command lane: the second push is the letter.
    expect(pushes).toHaveLength(2);
  });
});
