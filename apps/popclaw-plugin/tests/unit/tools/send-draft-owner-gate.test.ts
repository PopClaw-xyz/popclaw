/**
 * `popclaw_send_draft` sends nothing until the OWNER has approved this call.
 *
 * The defect these tests close: the tool took a `draft_id` and nothing else,
 * so the same model that wrote the draft could turn round and confirm it. On
 * real hardware, 2026-09-21, it did exactly that — a letter went to a
 * lore-house contact that the owner had never been shown. "The owner confirms
 * before anything is sent" was prompt discipline, and prompt discipline is not
 * a mechanism.
 *
 * The approval binds to an IMMUTABLE SNAPSHOT of what will be sent — recipient,
 * house, complete body, attachments, and the digest of the preview that was
 * delivered to the owner at draft time — not to a `confirmed: true` the model
 * supplies and not to the draft id alone. Every assertion below is on the
 * egress push spy: "no error was thrown" is not evidence that nothing was sent.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { popclaw } from '@popclaw/contracts';
import { MasterKeySigner } from '../../../src/identity/master-key-signer.js';
import { registerFeedbackCadenceTools } from '../../../src/tools/feedback-cadence-tools.js';
import { registerWriteTools } from '../../../src/tools/write-tools.js';
import { registerPopclawTools } from '../../../src/tools/register-tools.js';
import { makeToolCollector } from '../../../src/tools/mcp-adapter.js';
import type { ToolsCtx } from '../../../src/tools/tools-context.js';
import {
  DRAFT_TTL_MS, _draftsForTest, draftDigest, makeDraftToken, noteDraftPreview, noteDraftToolOutput,
  peekDraftSnapshot, putDraft, setDraftReviewFiles, takeDraft, type DraftAttachmentSnapshot, type DraftReviewFiles,
} from '../../../src/tools/draft-store.js';
import {
  SEND_DRAFT_TOOL, describeSendDraft, sendDraftApprovalSubject, sendDraftRefusalText,
} from '../../../src/tools/send-draft-subject.js';
import {
  APPROVAL_DESCRIPTION_BUDGET, APPROVAL_TITLE_BUDGET, FOLDED_ALTERNATIVE_UNPRESENTABLE,
  OWNER_APPROVAL_UNAVAILABLE_REASONS,
  consumeOwnerApproval, hasInvisibleCharacter, ownerApprovalAfterToolCall, ownerApprovalBeforeToolCall,
  registerOwnerApprovalSubject, resetOwnerApprovals, setOwnerApprovalSurface,
} from '../../../src/host/owner-approval.js';
import { OWNER_APPROVAL_ROUTE_REFUSALS } from '../../../src/host/owner-approval-route.js';
import {
  MCP_APPROVAL_PROFILE, MCP_APPROVAL_DISPLAY_BUDGET, MCP_APPROVAL_DISPLAY_BUDGET_BYTES, MCP_APPROVAL_MAX_ROWS, buildApprovalDialog, createMcpOwnerApproval,
} from '../../../src/host/mcp-owner-approval.js';
import { L_ENVELOPE_MAX_BYTES } from '../../../src/protocol/public-envelope.js';
import { kb } from '../../../src/messaging/dm-media.js';
import { createDraftReviewFiles } from '../../../src/host/draft-review-files.js';
import { fenceFor, renderReviewCopy, reviewLink } from '../../../src/tools/draft-review.js';
import { scriptOwnerApproval, scriptOwnerDecision } from '../../helpers/owner-approval-script.js';
import { ownerLang, setOwnerLang } from '../../../src/lexicon/owner-language.js';
import { renderCopy, type Lang } from '../../../src/lexicon/index.js';
import { displayWidth } from '../../../src/host/mcp-owner-authorization.js';
import { CONFIRM_DESCRIPTION_COLUMNS, MCP_APPROVAL_DIALOG_BUDGET } from '../../../src/host/mcp-owner-approval.js';

function keyed(byte: number): { id: string; signer: MasterKeySigner } {
  const seed = new Uint8Array(32).fill(byte);
  const kp = nacl.sign.keyPair.fromSeed(seed);
  const id = bs58.encode(kp.publicKey);
  return { id, signer: new MasterKeySigner({ seed, ...kp, popclawId: id }) };
}

const OWNER = keyed(3);
const ALICE = keyed(5);
const CONTACT = keyed(7);
const FULL_EVENT = 'ab'.repeat(32);

const guide = ['---', 'world: popclaw.me', 'feedback:', '  contact: Longtu', `  popclaw_id: ${CONTACT.id}`, '---', 'body'].join('\n');

interface Tool {
  readonly name: string;
  readonly description?: string;
  execute(callId: string, params: unknown): Promise<{ text: string }>;
}

/** `house` is what `inboxStore.houseOf` answers — on a real data root that is
 *  the slug of the house the recipient last wrote in from, e.g.
 *  `127-0-0-1-8112` for a local test house. `people` are extra entries in the
 *  bond book, so a recipient resolves with the nickname a real one carries. */
function setup(opts: {
  readonly house?: string;
  readonly people?: ReadonlyArray<{ popclawId: string; nickname: string }>;
  /** Register as the MCP root does: with a review directory (in `dir`). */
  readonly review?: boolean | DraftReviewFiles;
} = {}): {
  call(name: string, params: unknown, callId?: string): Promise<{ text: string }>;
  tool(name: string): Tool;
  pushed: Uint8Array[];
  dir: string;
  review: DraftReviewFiles | null;
} {
  const dir = mkdtempSync(join(tmpdir(), 'popclaw-send-gate-'));
  const pushed: Uint8Array[] = [];
  const push = vi.fn(async (bytes: Uint8Array) => {
    pushed.push(bytes);
    return { status: 200, eventId: FULL_EVENT };
  });
  const pushTo = vi.fn(async (_house: string | undefined, bytes: Uint8Array) => push(bytes));

  const runtime = async () => ({
    boot: {
      signer: OWNER.signer,
      nickname: 'Owner',
      popclawId: OWNER.id,
      webBaseUrl: 'https://fixture.invalid',
      loreHouseUrl: 'http://home-house:9000',
      loreHouseUrls: ['http://home-house:9000'],
    },
    egress: { push, pushTo },
    inboxStore: { houseOf: () => opts.house ?? 'house-home', get: () => undefined },
    guideClient: { fetchGuideText: async () => guide },
    paths: { houseGuideFile: (slug: string) => join(dir, `${slug}.md`) },
    worldFeedCache: {
      lookup: () => ({ platform: 'x', postId: 'p1', houseSlug: 'house-home', handle: 'someone', textPreview: 'hi' }),
      findFullEventId: () => ({ full: undefined, ambiguous: [] }),
    },
    bondsStore: { list: () => [
      { popclawId: ALICE.id, nickname: 'Alice', remarkName: '' },
      ...(opts.people ?? []).map((p) => ({ ...p, remarkName: '' })),
    ] },
    knownFollowers: { allFollowerIds: () => [ALICE.id] },
  });

  const tools = new Map<string, Tool>();
  const api = {
    registerTool: (tool: unknown) => {
      const resolved = typeof tool === 'function' ? (tool as (ctx: unknown) => Tool)({ agentId: 'test' }) : (tool as Tool);
      tools.set(resolved.name, resolved);
    },
  };
  const review = opts.review === true
    ? createDraftReviewFiles(join(dir, 'review'), { staleAfterMs: DRAFT_TTL_MS })
    : opts.review || null;
  const ctx = { api, runtime, deps: { api, runtime, ...(review ? { draftReviewFiles: review } : {}) }, total: 4 } as unknown as ToolsCtx;
  registerFeedbackCadenceTools(ctx);
  registerWriteTools(ctx);

  return {
    call: (name, params, callId = 'call-1') => tools.get(name)!.execute(callId, params),
    tool: (name) => tools.get(name)!,
    pushed,
    dir,
    review,
  };
}

const tokenOf = (draft: { text: string }): string => {
  const token = draft.text.match(/draft_id: (\S+)/)?.[1];
  expect(token, 'the draft must carry a draft_id').toBeTruthy();
  return token!;
};

/** A minimal but real PNG header plus filler, so `loadDmAttachment` accepts it. */
const png = (fill: number, size: number): Buffer =>
  Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(size, fill)]);

const recipientOf = (bytes: Uint8Array): string => {
  const signed = popclaw.identity.SignedPayload.decode(bytes);
  return popclaw.event.EventEnvelope.decode(signed.payload).directMessage?.toPopclawId ?? '';
};

beforeEach(() => {
  // Clears the seam's subjects too, so registration inside setup() is what
  // puts the send_draft descriptor back — nothing leaks in from another file.
  resetOwnerApprovals();
  _draftsForTest.clear();
  setOwnerLang('en', 'config');
});
afterEach(() => {
  resetOwnerApprovals();
  _draftsForTest.clear();
  setDraftReviewFiles(null);
  setOwnerLang(undefined);
});

// ---------------------------------------------------------------------------
// (a) the defect itself: draft, then confirm your own draft
// ---------------------------------------------------------------------------

describe('a model that drafts and immediately confirms', () => {
  it('pushes nothing when no owner decision exists for this call', async () => {
    const fx = setup();
    const draft = await fx.call('popclaw_draft_message', { recipient: 'Alice', body: 'hello' });
    const token = tokenOf(draft);
    expect(fx.pushed).toHaveLength(0);

    await fx.call('popclaw_send_draft', { draft_id: token });

    expect(fx.pushed).toHaveLength(0);
  });

  it('leaves the draft where it is, so the owner can still approve it later', async () => {
    const fx = setup();
    const token = tokenOf(await fx.call('popclaw_draft_message', { recipient: 'Alice', body: 'hello' }));

    await fx.call('popclaw_send_draft', { draft_id: token });

    expect(peekDraftSnapshot(token), 'the draft must survive a refusal').not.toBeNull();
    // And the control: the same draft, once approved, does go out.
    await scriptOwnerApproval(SEND_DRAFT_TOOL, { draft_id: token }, 'call-2');
    await fx.call('popclaw_send_draft', { draft_id: token }, 'call-2');
    expect(fx.pushed).toHaveLength(1);
  });

  // THE SENTENCE IS THE OWNER LANGUAGE; THE REASON CODE RIDES BESIDE IT. An
  // earlier round of these two tests forbade the code outright, and that is how
  // a whole family of distinct refusals arrived on real hardware as one
  // sentence nobody could diagnose. What must stay out is exception text, class
  // names and file positions — none of which is a named reason.
  it('says why in the owner language, with no exception text and no class names', async () => {
    const fx = setup();
    const token = tokenOf(await fx.call('popclaw_draft_message', { recipient: 'Alice', body: 'hello' }));
    const refused = await fx.call('popclaw_send_draft', { draft_id: token });
    expect(refused.text).toMatch(/approv/i);
    expect(refused.text).not.toMatch(/Error|undefined|\bat \w+\.ts:/);
    expect(refused.text).toContain('(reason: APPROVAL_SURFACE_ABSENT)');
  });

  it('says it in zh-CN too', async () => {
    setOwnerLang('zh-CN', 'config');
    const fx = setup();
    const token = tokenOf(await fx.call('popclaw_draft_message', { recipient: 'Alice', body: '你好' }));
    const refused = await fx.call('popclaw_send_draft', { draft_id: token });
    expect(refused.text).toMatch(/授权|确认/);
    expect(refused.text).toContain('(reason: APPROVAL_SURFACE_ABSENT)');
    expect(refused.text).not.toMatch(/ORIGIN_NOT_OWNER_DIRECT/);
  });
});

// ---------------------------------------------------------------------------
// (b) approved once, and only once
// ---------------------------------------------------------------------------

describe('an approved draft', () => {
  it('pushes exactly once, to the recipient the snapshot names', async () => {
    const fx = setup();
    const token = tokenOf(await fx.call('popclaw_draft_message', { recipient: 'Alice', body: 'hello' }));
    const snapshot = peekDraftSnapshot(token)!;

    await scriptOwnerApproval(SEND_DRAFT_TOOL, { draft_id: token }, 'call-1');
    await fx.call('popclaw_send_draft', { draft_id: token });

    expect(fx.pushed).toHaveLength(1);
    expect(recipientOf(fx.pushed[0]!)).toBe(ALICE.id);
    expect(snapshot.recipientId).toBe(ALICE.id);
    expect(snapshot.body).toBe('hello');
  });

  it('refuses the same draft_id a second time and pushes nothing more', async () => {
    const fx = setup();
    const token = tokenOf(await fx.call('popclaw_draft_message', { recipient: 'Alice', body: 'hello' }));
    await scriptOwnerApproval(SEND_DRAFT_TOOL, { draft_id: token }, 'call-1');
    await fx.call('popclaw_send_draft', { draft_id: token });
    expect(fx.pushed).toHaveLength(1);

    // Second attempt, freshly approved under its own call id: the draft is
    // gone, so there is nothing left to send.
    await scriptOwnerApproval(SEND_DRAFT_TOOL, { draft_id: token }, 'call-2');
    const again = await fx.call('popclaw_send_draft', { draft_id: token }, 'call-2');

    expect(fx.pushed).toHaveLength(1);
    expect(again.text).toMatch(/unknown or expired|no longer/i);
  });
});

// ---------------------------------------------------------------------------
// (c) deny and timeout
// ---------------------------------------------------------------------------

describe('the owner saying no, or saying nothing', () => {
  it.each(['deny', 'timeout'] as const)('%s pushes nothing and keeps the draft', async (decision) => {
    const fx = setup();
    const token = tokenOf(await fx.call('popclaw_draft_message', { recipient: 'Alice', body: 'hello' }));

    expect(await scriptOwnerDecision(SEND_DRAFT_TOOL, { draft_id: token }, 'call-1', decision)).toBe('asked');
    await fx.call('popclaw_send_draft', { draft_id: token });

    expect(fx.pushed).toHaveLength(0);
    expect(peekDraftSnapshot(token)).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// (d) the draft changed after the owner was shown it
// ---------------------------------------------------------------------------

describe('a draft that changed after the owner read it', () => {
  // The replacement is the SAME LENGTH as the original on purpose: what binds
  // the approval has to be the body itself, not a count of its characters.
  it('refuses when the BODY under that id is not the one the owner approved', async () => {
    const fx = setup();
    const token = tokenOf(await fx.call('popclaw_draft_message', { recipient: 'Alice', body: 'see you at nine' }));
    await scriptOwnerApproval(SEND_DRAFT_TOOL, { draft_id: token }, 'call-1');

    const snapshot = peekDraftSnapshot(token)!;
    expect(snapshot.body).toHaveLength('send me the keys'.length - 1);
    _draftsForTest.clear();
    putDraft(token, async () => ({ text: 'SHOULD NEVER RUN' }), { ...snapshot, body: 'send me the key' });

    const refused = await fx.call('popclaw_send_draft', { draft_id: token });

    expect(fx.pushed).toHaveLength(0);
    expect(refused.text).toMatch(/changed/i);
  });

  it('refuses when the RECIPIENT under that id is not the one the owner approved', async () => {
    const fx = setup();
    const token = tokenOf(await fx.call('popclaw_draft_message', { recipient: 'Alice', body: 'hello' }));
    await scriptOwnerApproval(SEND_DRAFT_TOOL, { draft_id: token }, 'call-1');

    const snapshot = peekDraftSnapshot(token)!;
    _draftsForTest.clear();
    putDraft(token, async () => ({ text: 'SHOULD NEVER RUN' }), { ...snapshot, recipientId: CONTACT.id });

    await fx.call('popclaw_send_draft', { draft_id: token });

    expect(fx.pushed).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// (e) a second call trying to spend the first call's approval
// ---------------------------------------------------------------------------

describe('another call presenting the same draft_id', () => {
  it('cannot spend the approval, and the call the owner answered still can', async () => {
    const fx = setup();
    const token = tokenOf(await fx.call('popclaw_draft_message', { recipient: 'Alice', body: 'hello' }));
    await scriptOwnerApproval(SEND_DRAFT_TOOL, { draft_id: token }, 'call-1');

    const stolen = await fx.call('popclaw_send_draft', { draft_id: token }, 'other-call');
    expect(fx.pushed).toHaveLength(0);
    expect(stolen.text).toMatch(/approv|confirm/i);

    await fx.call('popclaw_send_draft', { draft_id: token }, 'call-1');
    expect(fx.pushed).toHaveLength(1);
  });

  it('refuses a call the host gave no identity for', async () => {
    const fx = setup();
    const token = tokenOf(await fx.call('popclaw_draft_message', { recipient: 'Alice', body: 'hello' }));
    await scriptOwnerApproval(SEND_DRAFT_TOOL, { draft_id: token }, 'call-1');

    await fx.call('popclaw_send_draft', { draft_id: token }, '');

    expect(fx.pushed).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// (f) every kind that reaches send_draft
// ---------------------------------------------------------------------------

describe('every draft kind the send door accepts', () => {
  const kinds: Array<{ label: string; tool: string; params: unknown }> = [
    { label: 'dm', tool: 'popclaw_draft_message', params: { recipient: 'Alice', body: 'hello' } },
    { label: 'reply', tool: 'popclaw_draft_reply', params: { platform: 'x', post_id: 'p1', body: 'ack' } },
    { label: 'post', tool: 'popclaw_draft_post', params: { body: 'a thought' } },
    { label: 'feedback', tool: 'popclaw_feedback', params: { kind: 'need', body: 'I could not do X' } },
  ];

  it.each(kinds)('$label pushes nothing without an approval', async ({ tool, params }) => {
    const fx = setup();
    const token = tokenOf(await fx.call(tool, params));

    await fx.call('popclaw_send_draft', { draft_id: token });

    expect(fx.pushed).toHaveLength(0);
    expect(peekDraftSnapshot(token)).not.toBeNull();
  });

  it.each(kinds)('$label pushes once with one', async ({ tool, params }) => {
    const fx = setup();
    const token = tokenOf(await fx.call(tool, params));

    await scriptOwnerApproval(SEND_DRAFT_TOOL, { draft_id: token }, 'call-1');
    await fx.call('popclaw_send_draft', { draft_id: token });

    expect(fx.pushed).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The snapshot is what gets sent
// ---------------------------------------------------------------------------

describe('the immutable snapshot', () => {
  it.each([
    { label: 'dm', tool: 'popclaw_draft_message', params: { recipient: 'Alice', body: 'the real body' } as Record<string, unknown> },
    { label: 'reply', tool: 'popclaw_draft_reply', params: { platform: 'x', post_id: 'p1', body: 'the real body' } as Record<string, unknown> },
    { label: 'post', tool: 'popclaw_draft_post', params: { body: 'the real body' } as Record<string, unknown> },
  ])('$label sends the body it was drafted with even after the params object is mutated', async ({ tool, params }) => {
    const fx = setup();
    const token = tokenOf(await fx.call(tool, params));
    // The model still holds the object it passed in. Writing to it must not
    // reach the parked send.
    params.body = 'TAMPERED';
    params.recipient = CONTACT.id;

    await scriptOwnerApproval(SEND_DRAFT_TOOL, { draft_id: token }, 'call-1');
    await fx.call('popclaw_send_draft', { draft_id: token });

    expect(fx.pushed).toHaveLength(1);
    const signed = popclaw.identity.SignedPayload.decode(fx.pushed[0]!);
    expect(new TextDecoder().decode(signed.payload)).not.toContain('TAMPERED');
    expect(peekDraftSnapshot(token)).toBeNull();
  });

  it('records the attachment and the preview that was delivered', async () => {
    const fx = setup();
    const file = join(fx.dir, 'photo.png');
    writeFileSync(file, Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'));
    const token = tokenOf(await fx.call('popclaw_draft_message', { recipient: 'Alice', body: 'look', attachment_path: file }));

    const snapshot = peekDraftSnapshot(token)!;
    expect(snapshot.attachments).toHaveLength(1);
    expect(snapshot.attachments[0]!.name).toBe('photo.png');
    expect(snapshot.attachments[0]!.digest).toMatch(/^[0-9a-f]{16,}$/);
    expect(snapshot.recipientLabel).toContain('Alice#');
    expect(snapshot.house).toBe('house-home');
    // No credible owner-delivery capability in this fixture, so the preview
    // was never pushed — and the snapshot must say so rather than imply it was.
    expect(snapshot.preview?.status).toBe('unavailable');
    expect(snapshot.preview?.digest).toMatch(/^[0-9a-f]{16,}$/);
  });
});

// ---------------------------------------------------------------------------
// The attachment the owner approved is the attachment that is sent
// ---------------------------------------------------------------------------

describe('the approved attachment', () => {
  // Found by review: the parked draft used to carry the PATH, and the command
  // layer re-read it at send time. A 64-byte file approved and overwritten
  // with 4096 bytes before the send produced one push carrying the swapped
  // file, with the canonical subject unchanged — a path is not content, so
  // nothing the owner approved had bound it.
  const attachmentOf = (bytes: Uint8Array): Uint8Array => {
    const signed = popclaw.identity.SignedPayload.decode(bytes);
    const dm = popclaw.event.EventEnvelope.decode(signed.payload).directMessage!;
    const opened = ALICE.signer.openDmMedia(
      { ciphertext: dm.mediaCiphertext, nonce: dm.mediaNonce }, OWNER.id,
    ) as { ok: boolean; bytes?: Uint8Array };
    expect(opened.ok, 'the recipient must be able to open the attachment').toBe(true);
    return opened.bytes!;
  };

  it('sends the bytes that were digested, not whatever is at the path later', async () => {
    const fx = setup();
    const file = join(fx.dir, 'photo.png');
    const approved = png(0x11, 56);
    writeFileSync(file, approved);
    const token = tokenOf(await fx.call('popclaw_draft_message', { recipient: 'Alice', body: 'look', attachment_path: file }));
    const digest = peekDraftSnapshot(token)!.attachments[0]!.digest;

    await scriptOwnerApproval(SEND_DRAFT_TOOL, { draft_id: token }, 'call-1');
    // The swap the reviewer performed: same path, different content, after the
    // owner has said yes.
    writeFileSync(file, png(0x22, 4096));
    await fx.call('popclaw_send_draft', { draft_id: token });

    expect(fx.pushed).toHaveLength(1);
    expect(Buffer.from(attachmentOf(fx.pushed[0]!))).toEqual(approved);
    expect(digest).toBe(draftDigest(approved));
  });

  it('still sends it when the file is gone by the time the owner confirms', async () => {
    const fx = setup();
    const file = join(fx.dir, 'gone.png');
    const approved = png(0x33, 40);
    writeFileSync(file, approved);
    const token = tokenOf(await fx.call('popclaw_draft_message', { recipient: 'Alice', body: 'look', attachment_path: file }));

    await scriptOwnerApproval(SEND_DRAFT_TOOL, { draft_id: token }, 'call-1');
    rmSync(file);
    await fx.call('popclaw_send_draft', { draft_id: token });

    // The draft holds the bytes, so a vanished path is no longer an event:
    // there is nothing left to re-read and nothing left to go wrong.
    expect(fx.pushed).toHaveLength(1);
    expect(Buffer.from(attachmentOf(fx.pushed[0]!))).toEqual(approved);
  });

  // R1: the reviewer mutated `canonicalize` to drop attachments and the whole
  // suite stayed green. Three ways two drafts can differ only by what rides
  // with them, and each has to be a different subject.
  const attached = (name: string, fill: number): DraftAttachmentSnapshot => {
    const bytes = new Uint8Array(png(fill, 16));
    return { name, digest: draftDigest(bytes), mime: 'image/png', bytes };
  };

  it('binds the attachments: a different name, content or order is a different subject', async () => {
    const fx = setup();
    const token = tokenOf(await fx.call('popclaw_draft_message', { recipient: 'Alice', body: 'hello' }));
    const base = peekDraftSnapshot(token)!;
    const one = attached('a.png', 0x01);
    const two = attached('b.png', 0x02);

    const subjectWith = (attachments: DraftAttachmentSnapshot[]): string => {
      _draftsForTest.clear();
      putDraft(token, async () => ({ text: 'x' }), { ...base, attachments });
      return sendDraftApprovalSubject.canonicalize({ draft_id: token });
    };

    const none = subjectWith([]);
    const withOne = subjectWith([one]);
    const renamed = subjectWith([{ ...one, name: 'invoice.png' }]);
    // The CONTENT, not a digest field someone could write anything into: the
    // subject is recomputed from the bytes, so this is the only way to differ.
    const reContented = subjectWith([attached('a.png', 0x03)]);
    const ordered = subjectWith([one, two]);
    const reordered = subjectWith([two, one]);

    expect(new Set([none, withOne, renamed, reContented, ordered, reordered]).size).toBe(6);
  });

  it('a digest field rewritten on its own is NOT a different subject — the bytes are', async () => {
    const fx = setup();
    const token = tokenOf(await fx.call('popclaw_draft_message', { recipient: 'Alice', body: 'hello' }));
    const base = peekDraftSnapshot(token)!;
    const one = attached('a.png', 0x01);

    const subjectWith = (attachment: DraftAttachmentSnapshot): string => {
      _draftsForTest.clear();
      putDraft(token, async () => ({ text: 'x' }), { ...base, attachments: [attachment] });
      return sendDraftApprovalSubject.canonicalize({ draft_id: token });
    };

    // Claiming different bytes is not having them, and the subject follows
    // what will actually be sent rather than what the record says about it.
    expect(subjectWith({ ...one, digest: 'f'.repeat(32) })).toBe(subjectWith(one));
  });

  it('refuses to send when the attachment under the id changed after approval', async () => {
    const fx = setup();
    const file = join(fx.dir, 'photo.png');
    writeFileSync(file, png(0x44, 48));
    const token = tokenOf(await fx.call('popclaw_draft_message', { recipient: 'Alice', body: 'look', attachment_path: file }));
    await scriptOwnerApproval(SEND_DRAFT_TOOL, { draft_id: token }, 'call-1');

    const snapshot = peekDraftSnapshot(token)!;
    _draftsForTest.clear();
    putDraft(token, async () => ({ text: 'SHOULD NEVER RUN' }), {
      ...snapshot,
      attachments: [attached(snapshot.attachments[0]!.name, 0xee)],
    });

    const refused = await fx.call('popclaw_send_draft', { draft_id: token });

    expect(fx.pushed).toHaveLength(0);
    expect(refused.text).toBe(`${renderCopy(ownerLang(), 'sendDraft.refused.changed')} (reason: SUBJECT_CHANGED)`);
  });

  /**
   * The residual the reviewer probed: the attachment object is frozen but a
   * `Uint8Array` cannot be, so anything holding one could rewrite it in place.
   * Before this, the stored DIGEST was what the subject carried, so the
   * mutated bytes went out under an unchanged subject.
   *
   * `canonicalize` now hashes the bytes that are actually there, so the bytes
   * are the subject: touching them moves it, and the send refuses.
   */
  it('a caller that rewrites the stored bytes in place changes the subject, and nothing is sent', async () => {
    const fx = setup();
    const file = join(fx.dir, 'photo.png');
    writeFileSync(file, png(0x55, 64));
    const token = tokenOf(await fx.call('popclaw_draft_message', { recipient: 'Alice', body: 'look', attachment_path: file }));
    await scriptOwnerApproval(SEND_DRAFT_TOOL, { draft_id: token }, 'call-1');

    // Exactly the reviewer's probe: reach in through the public read and
    // rewrite the buffer the draft is holding.
    peekDraftSnapshot(token)!.attachments[0]!.bytes.fill(0x99);

    const refused = await fx.call('popclaw_send_draft', { draft_id: token });

    expect(fx.pushed).toHaveLength(0);
    expect(refused.text).toBe(`${renderCopy(ownerLang(), 'sendDraft.refused.changed')} (reason: SUBJECT_CHANGED)`);
  });

  // R2: the reviewer made the closure read `params.recipient` live and the
  // suite stayed green — with the DM then going to another contact.
  it('sends to the snapshot recipient even after the params object is rewritten', async () => {
    const fx = setup();
    const params: Record<string, unknown> = { recipient: 'Alice', body: 'hello' };
    const token = tokenOf(await fx.call('popclaw_draft_message', params));
    expect(peekDraftSnapshot(token)!.recipientId).toBe(ALICE.id);

    // The model still holds the object it passed in.
    params.recipient = CONTACT.id;
    params.body = 'TAMPERED';

    await scriptOwnerApproval(SEND_DRAFT_TOOL, { draft_id: token }, 'call-1');
    await fx.call('popclaw_send_draft', { draft_id: token });

    expect(fx.pushed).toHaveLength(1);
    expect(recipientOf(fx.pushed[0]!)).toBe(ALICE.id);
    expect(recipientOf(fx.pushed[0]!)).not.toBe(CONTACT.id);
  });
});

// ---------------------------------------------------------------------------
// The draft table is bounded
// ---------------------------------------------------------------------------

describe('what the draft table holds on to', () => {
  // A draft carries its attachment's bytes now, so an unbounded table is
  // unbounded memory. The reviewer made forty draft calls with a 1 MiB
  // attachment and forty megabytes stayed resident, because nothing dropped an
  // expired draft until the next one was minted.
  const live = (tokens: readonly string[]): number =>
    tokens.filter((t) => peekDraftSnapshot(t) !== null).length;

  it('keeps at most MAX_LIVE_DRAFTS, evicting the oldest first', async () => {
    const fx = setup();
    const tokens: string[] = [];
    for (let i = 0; i < 20; i++) {
      tokens.push(tokenOf(await fx.call('popclaw_draft_message', { recipient: 'Alice', body: `draft ${i}` })));
    }

    expect(live(tokens)).toBe(16);
    // The oldest four went; the newest sixteen are the survivors.
    expect(tokens.slice(0, 4).every((t) => peekDraftSnapshot(t) === null)).toBe(true);
    expect(tokens.slice(4).every((t) => peekDraftSnapshot(t) !== null)).toBe(true);
  });

  it('an evicted draft is answered exactly like an expired one, and sends nothing', async () => {
    const fx = setup();
    const first = tokenOf(await fx.call('popclaw_draft_message', { recipient: 'Alice', body: 'the first' }));
    // Approved — and then pushed out of the table by newer drafts.
    await scriptOwnerApproval(SEND_DRAFT_TOOL, { draft_id: first }, 'call-1');
    for (let i = 0; i < 16; i++) {
      await fx.call('popclaw_draft_message', { recipient: 'Alice', body: `later ${i}` });
    }
    expect(peekDraftSnapshot(first)).toBeNull();

    const out = await fx.call('popclaw_send_draft', { draft_id: first });

    expect(fx.pushed).toHaveLength(0);
    // Not "its recipient or its text changed" — nobody changed anything. The
    // draft is gone, and that is what the agent is told.
    expect(out.text).toBe(`${renderCopy(ownerLang(), 'sendDraft.refused.noLongerThere')} (reason: SUBJECT_CHANGED)`);
  });

  /**
   * The cap was global, and the doors share one table: minting an invite and
   * then drafting sixteen DMs evicted the pending verification, which came
   * back as "unknown or expired confirm_token" with nothing to say why. A
   * house-entry token mints a seven-day website login key and would have gone
   * the same way. Those doors carry no attachment, so they were paying for a
   * memory bound they do not cause.
   */
  it('ordinary drafting cannot evict another door\'s parked work', async () => {
    const fx = setup();
    const invite = makeDraftToken('invite');
    putDraft(invite, async () => ({ text: 'VERIFICATION SUBMITTED' }));
    const houseEntry = makeDraftToken('house-entry');
    putDraft(houseEntry, async () => ({ text: 'LOGIN KEY' }));

    for (let i = 0; i < 16; i++) {
      await fx.call('popclaw_draft_message', { recipient: 'Alice', body: `draft ${i}` });
    }

    // Still confirmable through their own doors.
    expect(takeDraft(invite, ['invite'])).toBeTypeOf('function');
    expect(takeDraft(houseEntry, ['house-entry'])).toBeTypeOf('function');
  });

  it('counts each kind separately, so one kind cannot crowd out another', async () => {
    const fx = setup();
    const replies: string[] = [];
    for (let i = 0; i < 4; i++) {
      replies.push(tokenOf(await fx.call('popclaw_draft_reply', { platform: 'x', post_id: 'p1', body: `r${i}` })));
    }
    for (let i = 0; i < 20; i++) {
      await fx.call('popclaw_draft_message', { recipient: 'Alice', body: `m${i}` });
    }

    // Twenty DMs evict only DMs.
    expect(replies.every((t) => peekDraftSnapshot(t) !== null)).toBe(true);
  });

  it('drops an expired draft on a read, not only when the next one is minted', async () => {
    const fx = setup();
    const token = tokenOf(await fx.call('popclaw_draft_message', { recipient: 'Alice', body: 'hello' }));
    expect(peekDraftSnapshot(token)).not.toBeNull();

    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 30 * 60 * 1000 + 1);
    try {
      // No new draft is minted anywhere in here: the read itself must collect it.
      expect(peekDraftSnapshot(token)).toBeNull();
      await scriptOwnerApproval(SEND_DRAFT_TOOL, { draft_id: token }, 'expired-call');
      const out = await fx.call('popclaw_send_draft', { draft_id: token }, 'expired-call');
      expect(fx.pushed).toHaveLength(0);
      expect(out.text).toBe(`${renderCopy(ownerLang(), 'draft.expiredToken', { token })} (reason: SUBJECT_REFUSED/DRAFT_UNKNOWN_OR_EXPIRED)`);
    } finally {
      clock.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// (h) descriptor purity
// ---------------------------------------------------------------------------

describe('the send_draft approval subject', () => {
  it('canonicalizes deterministically and touches nothing', async () => {
    const fx = setup();
    const token = tokenOf(await fx.call('popclaw_draft_message', { recipient: 'Alice', body: 'hello' }));

    const first = sendDraftApprovalSubject.canonicalize({ draft_id: token });
    const second = sendDraftApprovalSubject.canonicalize({ draft_id: token });

    expect(first).toBe(second);
    expect(first).toContain('hello');
    expect(fx.pushed).toHaveLength(0);
    expect(peekDraftSnapshot(token), 'canonicalize must not consume the draft').not.toBeNull();
  });

  it('is total: junk and unknown ids get a stable sentinel, never a throw', () => {
    const cases: unknown[] = [undefined, null, {}, { draft_id: '' }, { draft_id: 'message-999' }, { draft_id: 42 }, 'nope'];
    for (const c of cases) {
      expect(() => sendDraftApprovalSubject.canonicalize(c)).not.toThrow();
      expect(sendDraftApprovalSubject.canonicalize(c)).toBe(sendDraftApprovalSubject.canonicalize(c));
    }
    // Two different unknown ids are two different subjects.
    expect(sendDraftApprovalSubject.canonicalize({ draft_id: 'message-1' }))
      .not.toBe(sendDraftApprovalSubject.canonicalize({ draft_id: 'message-2' }));
  });

  it('describes a DM completely enough to approve, inside the seam budget', async () => {
    const fx = setup();
    const file = join(fx.dir, 'photo.png');
    writeFileSync(file, Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'));
    const token = tokenOf(await fx.call('popclaw_draft_message', { recipient: 'Alice', body: 'Could we move tomorrow to 15:00?', attachment_path: file }));

    const described = describeSendDraft({ draft_id: token });

    expect(described.kind).toBe('ask');
    if (described.kind !== 'ask') return;
    const rows = described.description;
    expect(rows[0]).toMatch(/^To: Alice#/);
    // And in the MCP first-screen spelling, who it goes to is the first line.
    expect(described.firstScreen?.title).toMatch(/^To: Alice#/);
    // Name AND size: "photo.png" and "photo.png (2.9 KB)" are different
    // amounts of knowing what is about to leave the machine.
    expect(rows.join('\n')).toMatch(/photo\.png \([\d.]+ KB\)/);
    expect(rows.join('\n')).toContain('Could we move tomorrow to 15:00?');
    expect(rows.join('\n')).toContain('house-home');
    // What the seam will measure: the rows plus the breaks it joins them with.
    expect([...rows.join('\n')].length).toBeLessThanOrEqual(496);
    expect([...described.title].length).toBeLessThanOrEqual(64);
    // No row may carry a break of its own — the seam owns the joining.
    for (const row of rows) expect(row).not.toMatch(/[\n\r\u2028\u2029]/);
  });

  it('refuses an unknown draft by name instead of describing one', async () => {
    setup();
    const described = describeSendDraft({ draft_id: 'message-404' });
    expect(described.kind).toBe('refuse');
  });

  it('refuses rather than truncating a body that does not fit and was never shown', async () => {
    const fx = setup();
    const token = tokenOf(await fx.call('popclaw_draft_message', { recipient: 'Alice', body: 'x'.repeat(4000) }));
    // Park the same content again with no showing of any kind against it:
    // neither a delivered preview nor a tool result that carried the letter.
    const snapshot = peekDraftSnapshot(token)!;
    putDraft(token, async () => ({ text: 'x' }), { ...snapshot, preview: null, output: null });

    const described = describeSendDraft({ draft_id: token });
    expect(described.kind).toBe('refuse');

    // And the tool refuses too — nothing is sent on a prompt that cannot be built.
    await scriptOwnerApproval(SEND_DRAFT_TOOL, { draft_id: token }, 'call-1');
    await fx.call('popclaw_send_draft', { draft_id: token });
    expect(fx.pushed).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// A letter longer than the dialog, on a host that pushes no preview
// ---------------------------------------------------------------------------

describe('a long letter the draft tool showed in the host transcript', () => {
  // The MCP roots (Claude Code, Codex) resolve a tool factory with `{}`, so
  // `deliverDraftPreview` can never attempt a native push there and every
  // draft's preview status is `unavailable`. Before this, any letter too long
  // for the dialog was unapprovable on those hosts while the same letter sent
  // fine from OpenClaw. What DOES reach the person sitting at an MCP host is
  // the draft tool's own result, which carries the complete text.
  const LETTER = [
    'Ken — the order total was short by the shipping line, not by the tax rule.',
    '',
    '`calcTotal` multiplied unit price by quantity and returned that, so every',
    'order that carried shipping came out low by exactly the shipping amount.',
    'I changed the one line in work/r03/eng-project/order-total.mjs to add it,',
    'and left index.html alone.',
    '',
    `Verified by hand: ${'calcTotal(128, 3, 12) was 384 and is now 396. '.repeat(6)}`,
    '',
    'Nothing else in that directory was touched. Tell me if the shipping rule',
    'should be per-item rather than per-order and I will redo the arithmetic.',
  ].join('\n');

  const askFor = (token: string): { title: string; rows: readonly string[] } => {
    const described = describeSendDraft({ draft_id: token });
    expect(described.kind).toBe('ask');
    if (described.kind !== 'ask') throw new Error('unreachable');
    return { title: described.title, rows: described.description };
  };

  it('is far too long for the dialog, and the tool result carried it whole', async () => {
    const fx = setup();
    const token = tokenOf(await fx.call('popclaw_draft_message', { recipient: 'Alice', body: LETTER }));
    const snapshot = peekDraftSnapshot(token)!;

    expect([...LETTER].length).toBeGreaterThan(APPROVAL_DESCRIPTION_BUDGET);
    // Nothing was pushed anywhere: this fixture has no delivery capability,
    // exactly like an MCP root.
    expect(snapshot.preview?.status).toBe('unavailable');
    expect(snapshot.output?.digest).toMatch(/^[0-9a-f]{16,}$/);
  });

  it('asks, with rows that locate the manuscript and pin both of its ends', async () => {
    const fx = setup();
    const token = tokenOf(await fx.call('popclaw_draft_message', { recipient: 'Alice', body: LETTER }));

    const { title, rows } = askFor(token);
    const joined = rows.join('\n');

    // Who and where, exactly as a letter that fits is described.
    expect(joined).toContain('Alice#');
    expect(joined).toContain('house-home');
    // Which draft to go and read, and how long it should turn out to be.
    expect(joined).toContain(token);
    expect(joined).toContain(`${[...LETTER].length} chars`);
    // Both ends of the manuscript, so the owner can check that the copy they
    // expand starts and — the part a truncating host would lose — ENDS the
    // same way.
    const quotedRows = rows.filter((r) => r.startsWith('> '));
    expect(quotedRows).toHaveLength(2);
    expect(LETTER.startsWith(quotedRows[0]!.slice(2))).toBe(true);
    expect(LETTER.endsWith(quotedRows[1]!.replace(/^> (\[…\] )?/, ''))).toBe(true);
    // And it says, in this module's own words, that the middle is missing.
    expect(quotedRows[1]).toContain('[…]');
    // The title is the native prompt's first line, so that is where "go and
    // read it first" has to live. In the MCP first-screen spelling the
    // recipient takes that line and the instruction is the row under it.
    expect(title.toLowerCase()).toContain('read');
    const described = describeSendDraft({ draft_id: token });
    if (described.kind !== 'ask') throw new Error('unreachable');
    expect(described.firstScreen?.title).toMatch(/^To: Alice#/);
    expect(described.firstScreen?.description[0]).toBe(title);
  });

  it('never claims the owner has already seen it', async () => {
    const fx = setup();
    const token = tokenOf(await fx.call('popclaw_draft_message', { recipient: 'Alice', body: LETTER }));

    const { rows } = askFor(token);

    // Not "in your preview since 22:40", and not "shown to you" either: the
    // only honest thing to say is where the text is and that it is not here.
    expect(rows.join('\n')).not.toMatch(/in your preview/);
    expect(rows.join('\n')).not.toMatch(/\bseen\b|\bread it\b/);
  });

  it.each(['en', 'zh-CN'])('fits the folded MCP dialog a Claude Code owner answers, in %s', async (lang) => {
    setOwnerLang(lang, 'config');
    const fx = setup();
    const body = lang === 'en' ? LETTER : `${'下周的交付窗口请先确认一下我再回他们，因为他们给的那个时段和固定评审撞上了。'.repeat(12)}收尾一句。`;
    const token = tokenOf(await fx.call('popclaw_draft_message', { recipient: 'Alice', body }));

    const { title, rows } = askFor(token);

    // Every ceiling the folded layout imposes: one field per row, none wider
    // than a field description renders, and a summary line that fits on its
    // own. Over any of them, `buildApprovalDialog` returns null and the letter
    // is unapprovable on that host — which is the defect this closes.
    expect(rows.length).toBeLessThanOrEqual(MCP_APPROVAL_DIALOG_BUDGET.maxFields);
    for (const row of rows) {
      expect(displayWidth(row), `row over the folded field width: ${row}`)
        .toBeLessThanOrEqual(MCP_APPROVAL_DIALOG_BUDGET.fieldDescriptionColumns);
    }
    expect(displayWidth(title)).toBeLessThanOrEqual(MCP_APPROVAL_DIALOG_BUDGET.summaryLineColumns);
    expect([...title].length).toBeLessThanOrEqual(APPROVAL_TITLE_BUDGET);
    expect([...rows.join('\n')].length).toBeLessThanOrEqual(APPROVAL_DESCRIPTION_BUDGET);
    for (const row of rows) expect(row).not.toMatch(/[\n\r\u2028\u2029]/);
  });

  it('explains a rendering only where there is one to explain', async () => {
    const fx = setup();
    const legend = renderCopy('en', 'sendDraft.approval.escapedInvisible');
    // The zero-width joiner sits deep in the middle, which is the part this
    // layout does not show. Spending one of five rows on a legend for text
    // nobody is reading here would say nothing true about what is on screen.
    const middle = tokenOf(await fx.call('popclaw_draft_message', {
      recipient: 'Alice',
      body: LETTER.replace('and left index.html alone.', 'and left index\u200d.html alone.'),
    }));
    expect(askFor(middle).rows).not.toContain(legend);

    // At the very end it IS on screen — escaped into something visible, with
    // the trusted row that says what the owner is looking at.
    const atTheEnd = tokenOf(await fx.call('popclaw_draft_message', {
      recipient: 'Alice',
      body: `${LETTER}\u200d`,
    }));
    const { rows } = askFor(atTheEnd);
    expect(rows).toContain(legend);
    expect(rows.join('\n')).toContain('\u2039U+200D\u203a');
  });

  // Every one of these carries a character the seam calls invisible, so the
  // escape legend is owed — and the legend used to be the sixth row, which
  // `buildApprovalDialog` refuses, putting the letter straight back to
  // unsendable on Claude Code for the sake of an emoji in the signature.
  const invisible = [
    { label: 'a ZWJ emoji in the signature', suffix: ' \u{1f468}‍\u{1f4bb}', opening: null },
    { label: 'a soft hyphen at the very end', suffix: '­', opening: null },
    { label: 'an ideographic space before the sign-off', suffix: '　‍', opening: null },
    { label: 'a non-breaking space in the opening line', suffix: '', opening: 'Ken —' },
  ];

  it.each(invisible)('keeps the legend and still fits the folded dialog with $label', async ({ suffix, opening }) => {
    const fx = setup();
    const body = (opening === null ? LETTER : LETTER.replace('Ken —', opening)) + suffix;
    const token = tokenOf(await fx.call('popclaw_draft_message', { recipient: 'Alice', body }));

    const { title, rows } = askFor(token);

    // The owner is reading a rendering, and the row that says so is present.
    expect(rows).toContain(renderCopy('en', 'sendDraft.approval.escapedInvisible'));
    expect(rows.join('\n')).toMatch(/‹U\+[0-9A-F]{4,6}›/u);
    // Both ends are still there — squeezed onto one row, with the marker
    // between them, rather than the legend being dropped to make space.
    const quotedRows = rows.filter((r) => r.startsWith('> '));
    expect(quotedRows).toHaveLength(1);
    expect(quotedRows[0]).toContain('[…]');
    expect(quotedRows[0]).toContain('Ken');
    // The ends are shorter in this layout, but they are still the ends.
    expect(quotedRows[0]).toContain('arithmetic.');
    expect(title).not.toBe('');
    expect(rows.length).toBeLessThanOrEqual(MCP_APPROVAL_DIALOG_BUDGET.maxFields);
  });

  it('keeps the legend and still fits the folded dialog in zh-CN', async () => {
    setOwnerLang('zh-CN', 'config');
    const fx = setup();
    const body = `${'下周的交付窗口请先确认一下我再回他们，因为他们给的那个时段和固定评审撞上了。'.repeat(12)}收尾‍一句。`;
    const token = tokenOf(await fx.call('popclaw_draft_message', { recipient: 'Alice', body }));

    const { title, rows } = askFor(token);

    expect(rows).toContain(renderCopy('zh-CN', 'sendDraft.approval.escapedInvisible'));
    expect(rows.length).toBeLessThanOrEqual(MCP_APPROVAL_DIALOG_BUDGET.maxFields);
    for (const row of rows) {
      expect(displayWidth(row), `row over the folded field width: ${row}`)
        .toBeLessThanOrEqual(MCP_APPROVAL_DIALOG_BUDGET.fieldDescriptionColumns);
    }
    expect(title).not.toBe('');
  });

  it('records no showing for a draft that has no words in it', async () => {
    const fx = setup();
    const file = join(fx.dir, 'photo.png');
    writeFileSync(file, Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'));
    const token = tokenOf(await fx.call('popclaw_draft_message', { recipient: 'Alice', attachment_path: file }));

    // `includes('')` is true of every string, so without a guard an
    // attachment-only draft is handed a showing nothing had to earn. A check
    // that cannot fail is not a check.
    expect(peekDraftSnapshot(token)!.body).toBe('');
    expect(peekDraftSnapshot(token)!.output).toBeNull();
    // It costs that draft nothing: there is no text to be too long for.
    expect(describeSendDraft({ draft_id: token }).kind).toBe('ask');
  });

  it('sends exactly once, and only after the owner approves', async () => {
    const fx = setup();
    const token = tokenOf(await fx.call('popclaw_draft_message', { recipient: 'Alice', body: LETTER }));

    await fx.call('popclaw_send_draft', { draft_id: token });
    expect(fx.pushed, 'nobody approved yet').toHaveLength(0);

    await scriptOwnerApproval(SEND_DRAFT_TOOL, { draft_id: token }, 'call-1');
    await fx.call('popclaw_send_draft', { draft_id: token });

    expect(fx.pushed).toHaveLength(1);
    expect(recipientOf(fx.pushed[0]!)).toBe(ALICE.id);
  });

  it('refuses when no draft tool ever emitted the complete text', async () => {
    const fx = setup();
    const token = tokenOf(await fx.call('popclaw_draft_message', { recipient: 'Alice', body: LETTER }));
    const snapshot = peekDraftSnapshot(token)!;
    putDraft(token, async () => ({ text: 'x' }), { ...snapshot, output: null });

    expect(describeSendDraft({ draft_id: token }).kind).toBe('refuse');
    await scriptOwnerApproval(SEND_DRAFT_TOOL, { draft_id: token }, 'call-1');
    await fx.call('popclaw_send_draft', { draft_id: token });
    expect(fx.pushed).toHaveLength(0);
  });

  it('cannot be granted by the model: a showing comes from the plugin, never from params', async () => {
    const fx = setup();
    const token = tokenOf(await fx.call('popclaw_draft_message', { recipient: 'Alice', body: LETTER }));
    const snapshot = peekDraftSnapshot(token)!;
    putDraft(token, async () => ({ text: 'x' }), { ...snapshot, output: null });

    // Every shape a model might reach for. None of them is read.
    for (const extra of [{ previewed: true }, { shown: true }, { output: 'shown' }, { confirmed: true }]) {
      expect(describeSendDraft({ draft_id: token, ...extra }).kind).toBe('refuse');
    }
    expect(fx.pushed).toHaveLength(0);
  });

  it('cannot be manufactured by a tool that did not show the body', async () => {
    const fx = setup();
    const token = tokenOf(await fx.call('popclaw_draft_message', { recipient: 'Alice', body: LETTER }));
    const snapshot = peekDraftSnapshot(token)!;
    putDraft(token, async () => ({ text: 'x' }), { ...snapshot, output: null });

    // A result that talks ABOUT the draft rather than carrying it records
    // nothing: the record is the text, checked, not a claim.
    noteDraftToolOutput(token, 'Drafted your letter, the full content is above. draft_id: message-1');
    expect(peekDraftSnapshot(token)!.output).toBeNull();

    noteDraftToolOutput(token, `here it is:\n${LETTER}\ndraft_id: ${token}`);
    expect(peekDraftSnapshot(token)!.output).not.toBeNull();
  });

  it('binds the showing, so a re-draft cannot ride the old approval', async () => {
    const fx = setup();
    const token = tokenOf(await fx.call('popclaw_draft_message', { recipient: 'Alice', body: LETTER }));
    const before = sendDraftApprovalSubject.canonicalize({ draft_id: token });

    const snapshot = peekDraftSnapshot(token)!;
    putDraft(token, async () => ({ text: 'x' }), { ...snapshot, output: null });
    expect(sendDraftApprovalSubject.canonicalize({ draft_id: token })).not.toBe(before);

    // Approved against the version with no showing; the showing then arrives,
    // and the subject has moved — the approval no longer fits it.
    await scriptOwnerApproval(SEND_DRAFT_TOOL, { draft_id: token }, 'call-1');
    noteDraftToolOutput(token, `${LETTER}\ndraft_id: ${token}`);
    await fx.call('popclaw_send_draft', { draft_id: token });
    expect(fx.pushed).toHaveLength(0);
  });

  it('still prefers the delivered preview when there was one', async () => {
    const fx = setup();
    const token = tokenOf(await fx.call('popclaw_draft_message', { recipient: 'Alice', body: LETTER }));
    noteDraftPreview(token, 'preview text', 'unknown');

    const { rows } = askFor(token);

    // The excerpt layout, unchanged: a run of body rows under an opening
    // label, not the two-ended transcript pointer.
    expect(rows.filter((r) => r.startsWith('> ')).length).toBeGreaterThan(2);
    expect(rows.join('\n')).toContain('in your preview');
  });
});

// ---------------------------------------------------------------------------
// An ordinary letter, on the host that folds
// ---------------------------------------------------------------------------

/**
 * Eighty-seven characters over four lines — the reply a person actually writes.
 *
 * It fits the SEAM's budget several times over, so the whole-text layout wins
 * and the owner reads every word. That is right on a host that renders the
 * message whole, and it was fatal on the one that folds: seven rows is two more
 * fields than the folded dialog has, `buildApprovalDialog` answered null, and
 * `popclaw_send_draft` was refused on Claude Code. Measured on the production
 * functions 2026-09-23: a 25-character one-liner (4 rows) went through, a
 * 1269-character letter went through — because it had ALREADY fallen back to
 * the fixed five-row transcript pointer — and the ordinary letter in between
 * never reached that layout at all.
 *
 * So the whole layout stays exactly as it is, and a folded host that cannot
 * render it is offered the SAME snapshot in the pointer layout rather than
 * being refused. One question, one subject, nothing cut, and no host shrunk to
 * five rows for the sake of another host's dialog.
 */
describe('an ordinary multi-line letter on a host that folds the dialog', () => {
  const ORDINARY = [
    'I checked your screenshot.',
    'Shipping was missing.',
    'The total is now 396.',
    'The test passes.',
  ].join('\n');

  /** The MCP root as Claude Code reaches it: a client that declares form
   *  elicitation and is not Codex, so `rendersWholeMessage` is false and the
   *  folded layout is the one it is given. Every dialog it is shown is kept. */
  function foldedRoot(answer: 'accept' | 'decline' = 'accept', client = 'claude-code') {
    const dialogs: Array<{ message: string; rows: string[]; fields: string[]; confirmTitle?: string; confirmDescription?: string }> = [];
    const backend = createMcpOwnerApproval({
      server: { current: {
        getClientCapabilities: () => ({ elicitation: { form: {} } }),
        getClientVersion: () => ({ name: client, version: '2.1.278' }),
        elicitInput: async (params: unknown) => {
          const form = params as { message: string; requestedSchema: { properties: Record<string, unknown> } };
          // The explanation is the message — title, a blank line, then one
          // line per row — and the form's only property is the confirmation.
          dialogs.push({
            message: form.message,
            rows: form.message.split('\n').slice(2),
            fields: Object.keys(form.requestedSchema.properties),
            confirmTitle: (form.requestedSchema.properties['confirm'] as { title?: string } | undefined)?.title,
            confirmDescription: (form.requestedSchema.properties['confirm'] as { description?: string } | undefined)?.description,
          });
          return answer === 'accept' ? { action: 'accept', content: { confirm: true } } : { action: 'decline' };
        },
      } as never },
    });
    return { backend, dialogs };
  }

  /** One send over the folded MCP root, start to finish. */
  async function overTheFoldedRoot(fx: ReturnType<typeof setup>, token: string, answer: 'accept' | 'decline' = 'accept',
    client = 'claude-code') {
    const { backend, dialogs } = foldedRoot(answer, client);
    const callRef = backend.callRef({ requestId: `folded-${token}` });
    const out = await backend.aroundDispatch(SEND_DRAFT_TOOL, { draft_id: token }, callRef, undefined,
      () => fx.call('popclaw_send_draft', { draft_id: token }, callRef));
    backend.stop();
    return { dialogs, out };
  }

  it.each(['en', 'zh-CN'] as const)('names the draft number on a short letter too, in %s', async (lang) => {
    setOwnerLang(lang, 'config');
    const fx = setup();
    const drafted = await fx.call('popclaw_draft_message', { recipient: 'Alice', body: 'Short.' });
    const token = tokenOf(drafted);
    expect(drafted.text).toContain(`draft_id: ${token}`);

    const { dialogs } = await overTheFoldedRoot(fx, token);

    expect(dialogs[0]!.rows).toContain(renderCopy(lang, 'sendDraft.approval.draftId', { id: token }));
    expect(dialogs[0]!.rows).toContain('> Short.');
    expect(fx.pushed).toHaveLength(1);
  });

  // EVERY LAYOUT NAMES THE DRAFT BEING SENT. A decoy draft is made first so
  // the ids differ: the row must carry the id of the draft that goes out.
  it('names the draft being sent on the attachment-only layout', async () => {
    const fx = setup();
    const file = join(fx.dir, 'photo.png');
    writeFileSync(file, Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'));
    const decoy = tokenOf(await fx.call('popclaw_draft_message', { recipient: 'Alice', attachment_path: file }));
    const token = tokenOf(await fx.call('popclaw_draft_message', { recipient: 'Alice', attachment_path: file }));
    expect(token).not.toBe(decoy);

    const { dialogs } = await overTheFoldedRoot(fx, token);

    // No preview note on MCP: its root never pushes one.
    expect(dialogs[0]!.rows).toContain(renderCopy('en', 'sendDraft.approval.noBody'));
    expect(dialogs[0]!.message).not.toContain('preview');
    expect(dialogs[0]!.rows).toContain(`draft: ${token}`);
    expect(dialogs[0]!.rows.join('\n')).not.toContain(decoy);
    expect(fx.pushed).toHaveLength(1);
    expect(peekDraftSnapshot(token)).toBeNull();
    expect(peekDraftSnapshot(decoy)).not.toBeNull();
  });

  it('names the draft being sent on the native excerpt layout, and on the whole MCP layout', async () => {
    const fx = setup();
    const LONG = Array.from({ length: 40 }, (_, i) => `Line ${i + 1} of a letter too long to show whole.`).join('\n');
    const decoy = tokenOf(await fx.call('popclaw_draft_message', { recipient: 'Alice', body: LONG }));
    const token = tokenOf(await fx.call('popclaw_draft_message', { recipient: 'Alice', body: LONG }));
    expect(token).not.toBe(decoy);
    // A delivered preview is what licenses the excerpt layout — natively.
    noteDraftPreview(token, 'preview text', 'unknown');
    const native = describeSendDraft({ draft_id: token });
    if (native.kind !== 'ask') throw new Error('unreachable');
    expect(native.description.some((r) => r.startsWith('Text (') && r.includes('opening:'))).toBe(true);
    expect(native.description).toContain(`draft: ${token}`);

    const { dialogs } = await overTheFoldedRoot(fx, token);

    // The MCP dialog is never given the excerpt: the whole letter, by id.
    const rows = dialogs[0]!.rows;
    expect(rows.some((r) => r.startsWith('Text (') && r.includes('in full:'))).toBe(true);
    expect(rows).toContain('> Line 40 of a letter too long to show whole.');
    expect(rows).toContain(`draft: ${token}`);
    expect(rows.join('\n')).not.toContain(decoy);
    expect(fx.pushed).toHaveLength(1);
    expect(peekDraftSnapshot(token)).toBeNull();
  });

  it.each(['en', 'zh-CN'] as const)('labels the one input "send this draft", in %s', async (lang) => {
    setOwnerLang(lang, 'config');
    const fx = setup();
    const token = tokenOf(await fx.call('popclaw_draft_message', { recipient: 'Alice', body: ORDINARY }));

    const { dialogs } = await overTheFoldedRoot(fx, token);

    expect(dialogs[0]!.fields).toEqual(['confirm']);
    expect(dialogs[0]!.confirmTitle).toBe(renderCopy(lang, 'sendDraft.approval.confirm.dm'));
    expect(renderCopy(lang, 'sendDraft.approval.confirm.dm')).not.toBe(renderCopy(lang, 'ownerApproval.confirm.title'));
  });

  /**
   * WHERE THE FULL TEXT IS, ON THE ONE LINE THAT SHOWS WITHOUT EXPANDING.
   * One sentence for every MCP host, carrying the REAL draft id the approval
   * is bound to, and fitting the confirm field's single line (Claude Code cut
   * it at 81–91). The whole letter is in the dialog, which is true on every
   * host; Claude Code shows only the message's start and cannot expand it,
   * so its keys follow in a clause labelled as Claude Code's — ctrl+o opens
   * the transcript, where the draft tool's full output is, and returns.
   */
  it.each([
    ['en', 'claude-code'], ['zh-CN', 'claude-code'], ['en', 'codex'], ['zh-CN', 'codex'], ['en', 'some-other-host'],
  ] as const)('says under the one input that the draft is here in full, by its real id, in %s on %s', async (lang, client) => {
    setOwnerLang(lang, 'config');
    const fx = setup();
    const decoy = tokenOf(await fx.call('popclaw_draft_message', { recipient: 'Alice', body: 'Decoy.' }));
    const token = tokenOf(await fx.call('popclaw_draft_message', { recipient: 'Alice', body: ORDINARY }));

    const { dialogs } = await overTheFoldedRoot(fx, token, 'accept', client);

    const line = dialogs[0]!.confirmDescription!;
    expect(line).toBe(renderCopy(lang, 'sendDraft.approval.wholeHere', { id: token }));
    expect(line).toContain(token);
    expect(line).not.toContain(decoy);
    // Host-neutral first; Claude Code's keys only inside its own labelled
    // clause, after it, with all three steps.
    const cc = line.indexOf('Claude Code');
    expect(cc).toBeGreaterThan(line.indexOf(token));
    expect(line.slice(0, cc)).not.toContain('ctrl+o');
    expect(line.slice(cc).split('ctrl+o')).toHaveLength(3);
    expect(line).toMatch(lang === 'en' ? /Claude Code: ctrl\+o, g top, ctrl\+o back$/ : /Claude Code：ctrl\+o，g 到顶，ctrl\+o 返回$/);
    expect(line).not.toMatch(/\n/);
    expect(displayWidth(dialogs[0]!.confirmDescription!)).toBeLessThanOrEqual(CONFIRM_DESCRIPTION_COLUMNS);
    expect(fx.pushed).toHaveLength(1);
  });

  it.each(['en', 'zh-CN'] as const)('keeps the pointer inside the line budget with a long real id, in %s', (lang) => {
    for (const id of ['message-1', 'feedback-99999', 'message-999999']) {
      const hint = renderCopy(lang, 'sendDraft.approval.fullTextHint', { id });
      expect(hint).toContain(id);
      // Well inside 80, not just under it.
      expect(displayWidth(hint), `${lang} ${id}`).toBeLessThanOrEqual(CONFIRM_DESCRIPTION_COLUMNS - 2);
    }
    // The combined line wins for every realistic id, so it must carry all
    // three keys too, `ctrl+o back` included.
    for (const id of ['message-1', 'message-12345', 'feedback-12345']) {
      const line = renderCopy(lang, 'sendDraft.approval.declineAndFullText', { id });
      expect(line).toContain(id);
      expect(line.split('ctrl+o')).toHaveLength(3);
      expect(line).toMatch(lang === 'en' ? /ctrl\+o back/ : /ctrl\+o 返回/);
      // Decline's meaning, both halves: nothing is sent, and the draft is kept.
      if (lang === 'en') { expect(line).toMatch(/unsent/); expect(line).toMatch(/kept/); }
      else { expect(line).toContain('不发'); expect(line).toContain('留稿'); }
      expect(displayWidth(line), `${lang} ${id}`).toBeLessThanOrEqual(CONFIRM_DESCRIPTION_COLUMNS);
    }
    // The whole-letter line, with Claude Code's clause whole, for every
    // realistic id.
    for (const id of ['message-1', 'message-12345', 'feedback-12345', 'message-999999']) {
      const line = renderCopy(lang, 'sendDraft.approval.wholeHere', { id });
      expect(line).toContain(id);
      expect(line.split('ctrl+o')).toHaveLength(3);
      expect(displayWidth(line), `${lang} ${id}`).toBeLessThanOrEqual(CONFIRM_DESCRIPTION_COLUMNS);
    }
  });

  /** The surface the pointer points at: a draft taller than any screen comes
   *  back in the draft tool's own output WHOLE — every line, untruncated. */
  it('returns a 150-line draft whole in the draft tool output', async () => {
    const fx = setup();
    const body = Array.from({ length: 150 }, (_, i) => `line ${String(i + 1).padStart(3, '0')} of the long letter`).join('\n');
    const drafted = await fx.call('popclaw_draft_message', { recipient: 'Alice', body });
    expect(drafted.text).toContain(body);
    expect(drafted.text).toContain('line 001 of the long letter');
    expect(drafted.text).toContain('line 075 of the long letter');
    expect(drafted.text).toContain('line 150 of the long letter');
    const token = tokenOf(drafted);
    expect(drafted.text).toContain(`draft_id: ${token}`);
  });

  it('asks once and sends once, with the whole letter in the message and one input', async () => {
    const fx = setup();
    const token = tokenOf(await fx.call('popclaw_draft_message', { recipient: 'Alice', body: ORDINARY }));

    const { dialogs, out } = await overTheFoldedRoot(fx, token);

    expect(dialogs).toHaveLength(1);
    // The explanation is the message, which this host may fold and the owner
    // expands; the form holds one real input and nothing to type into.
    expect(dialogs[0]!.fields).toEqual(['confirm']);
    expect(dialogs[0]!.message.split('\n')[0]).toMatch(/^To: Alice#/);
    for (const line of ORDINARY.split('\n')) expect(dialogs[0]!.rows).toContain(`> ${line}`);
    expect(out.text).not.toMatch(/Not sent/);
    expect(fx.pushed).toHaveLength(1);
  });

  it('leaves the complete letter in front of a host that renders the message whole', async () => {
    const fx = setup();
    const token = tokenOf(await fx.call('popclaw_draft_message', { recipient: 'Alice', body: ORDINARY }));

    const described = describeSendDraft({ draft_id: token });
    expect(described.kind).toBe('ask');
    if (described.kind !== 'ask') return;

    // The primary layout is untouched: every line of the letter, quoted.
    for (const line of ORDINARY.split('\n')) expect(described.description).toContain(`> ${line}`);
    expect(described.description.length).toBeGreaterThan(MCP_APPROVAL_DIALOG_BUDGET.maxFields);
    const dialog = buildApprovalDialog(
      { title: described.title, description: described.description.join('\n'), lines: described.description, timeoutMs: 1 },
    );
    expect(dialog!.message).toContain('The total is now 396.');
    expect(dialog!.message).toContain('The test passes.');
  });

  // FIVE ROWS, FROM BOTH SIDES. Two header rows and the label row are spoken
  // for before the letter says anything, so a two-line body is the last one the
  // folded dialog can hold whole and a three-line body is the first that cannot.
  it('keeps the whole text in the folded dialog while it still fits five rows', async () => {
    const fx = setup();
    // To, house, draft number, text label, one body line: five rows.
    const token = tokenOf(await fx.call('popclaw_draft_message', { recipient: 'Alice', body: 'One line.' }));

    const described = describeSendDraft({ draft_id: token });
    if (described.kind !== 'ask') throw new Error('unreachable');
    expect(described.description).toHaveLength(MCP_APPROVAL_DIALOG_BUDGET.maxFields);
    // Nothing to fall back to: the folded host is given the letter itself.
    expect(described.folded).toBeUndefined();

    const { dialogs } = await overTheFoldedRoot(fx, token);
    expect(dialogs[0]!.rows).toContain('> One line.');
    expect(dialogs[0]!.rows).toContain(`draft: ${token}`);
    expect(fx.pushed).toHaveLength(1);
  });

  it('shows the whole letter, not the shorter spelling, once it is taller than five rows', async () => {
    const fx = setup();
    const token = tokenOf(await fx.call('popclaw_draft_message', {
      recipient: 'Alice', body: 'One line.\nTwo lines.',
    }));

    const described = describeSendDraft({ draft_id: token });
    if (described.kind !== 'ask') throw new Error('unreachable');
    // The registrant still offers its pointer layout; no MCP host is given it.
    expect(described.description).toHaveLength(MCP_APPROVAL_DIALOG_BUDGET.maxFields + 1);
    expect(described.folded?.description).toHaveLength(MCP_APPROVAL_DIALOG_BUDGET.maxFields);

    const mcp = describeSendDraft({ draft_id: token }, MCP_APPROVAL_PROFILE);
    if (mcp.kind !== 'ask') throw new Error('unreachable');
    expect(mcp.folded).toBeUndefined();
    const { dialogs } = await overTheFoldedRoot(fx, token);
    expect(dialogs[0]!.rows).toEqual([...mcp.firstScreen!.description]);
    expect(dialogs[0]!.rows).toContain('> Two lines.');
    expect(fx.pushed).toHaveLength(1);
  });

  it('needs no manuscript elsewhere when the message carries the whole letter', async () => {
    const fx = setup();
    const token = tokenOf(await fx.call('popclaw_draft_message', { recipient: 'Alice', body: ORDINARY }));
    // No showing of any kind against this snapshot: no preview was delivered
    // and no draft tool put the complete text in its own output here. The
    // pointer layout would have nothing to point at — but it is not used: the
    // complete text is in the dialog's own message.
    const snapshot = peekDraftSnapshot(token)!;
    putDraft(token, async () => ({ text: 'x' }), { ...snapshot, preview: null, output: null });

    const { dialogs, out } = await overTheFoldedRoot(fx, token);

    expect(dialogs).toHaveLength(1);
    for (const line of ORDINARY.split('\n')) expect(dialogs[0]!.rows).toContain(`> ${line}`);
    // The stored send (the stub `putDraft` installed) is what ran.
    expect(out.text).toBe('x');
  });
});

// ---------------------------------------------------------------------------
// The real long letter, on the real data root's house
// ---------------------------------------------------------------------------

/**
 * Claude Code, MCP root, build 0a79933f, 2026-09-24 08:34 CST.
 *
 * The long-letter acceptance DM — the R06 template with its first line set to
 * the run id, 962 characters of Chinese, line breaks and an emoji, plus a
 * 211-byte text attachment — to a recipient whose last letter came in through
 * the local test house. The draft tool returned the complete text, so the
 * pointer layout was owed. `popclaw_send_draft` answered
 * `SUBJECT_REFUSED/DRAFT_DESCRIPTION_TOO_LONG` instead, and no dialog was ever
 * shown.
 *
 * Nothing about the LETTER did that. The house on a real data root is the
 * slug of the house's origin, `127-0-0-1-8112`, four characters longer than
 * any fixture had used, and with the attachment beside it the one row that
 * says where the letter lands and what rides with it came to 65 display
 * columns. A folded field holds 64, so the fixed five-row layout — the one
 * that exists so a long letter can be approved on this host — refused on its
 * own header.
 */
describe('the R06 long letter over the folded MCP root', () => {
  const fixture = (name: string): string =>
    fileURLToPath(new URL(`../../fixtures/send-draft/${name}`, import.meta.url));
  const LETTER = readFileSync(fixture('r06-long-letter.txt'), 'utf8');
  const ATTACHMENT = fixture('R06-ATTACHMENT.txt');
  // Synthetic, but the same shape as the real one: a 44-character id and a
  // CJK nickname of the same display width.
  const KEN = { popclawId: keyed(9).id, nickname: '样例CEO收信' };
  const HOUSE = '127-0-0-1-8112';

  async function draft(fx: ReturnType<typeof setup>): Promise<string> {
    return tokenOf(await fx.call('popclaw_draft_message', {
      recipient: KEN.popclawId, body: LETTER, attachment_path: ATTACHMENT,
    }));
  }

  /** Claude Code as the MCP root sees it: form elicitation, not Codex. */
  async function overTheFoldedRoot(fx: ReturnType<typeof setup>, token: string,
    answer: { action: string; content?: Record<string, unknown> } = { action: 'accept', content: { confirm: true } }) {
    const dialogs: Array<{ message: string; rows: string[]; fields: string[]; confirmTitle?: string }> = [];
    const backend = createMcpOwnerApproval({
      server: { current: {
        getClientCapabilities: () => ({ elicitation: { form: {} } }),
        getClientVersion: () => ({ name: 'claude-code', version: '2.1.278' }),
        elicitInput: async (params: unknown) => {
          const form = params as { message: string; requestedSchema: { properties: Record<string, unknown> } };
          // The explanation is the message — title, a blank line, then one
          // line per row — and the form's only property is the confirmation.
          dialogs.push({
            message: form.message,
            rows: form.message.split('\n').slice(2),
            fields: Object.keys(form.requestedSchema.properties),
            confirmTitle: (form.requestedSchema.properties['confirm'] as { title?: string } | undefined)?.title,
          });
          return answer;
        },
      } as never },
    });
    const callRef = backend.callRef({ requestId: `r06-${token}` });
    const out = await backend.aroundDispatch(SEND_DRAFT_TOOL, { draft_id: token }, callRef, undefined,
      () => fx.call('popclaw_send_draft', { draft_id: token }, callRef));
    backend.stop();
    return { dialogs, out };
  }

  it('is the material that was measured: long, and shown whole by the draft tool', async () => {
    const fx = setup({ house: HOUSE, people: [KEN] });
    const token = await draft(fx);
    const snapshot = peekDraftSnapshot(token)!;

    expect(KEN.popclawId).toHaveLength(44);
    expect([...snapshot.body]).toHaveLength(962);
    expect(snapshot.body).toContain('🙂');
    expect(snapshot.house).toBe(HOUSE);
    expect(snapshot.attachments.map((a) => a.bytes.length)).toEqual([211]);
    expect(snapshot.preview?.status).toBe('unavailable');
    expect(snapshot.output).not.toBeNull();
  });

  it.each(['en', 'zh-CN'])('asks once and sends once, in %s', async (lang) => {
    setOwnerLang(lang, 'config');
    const fx = setup({ house: HOUSE, people: [KEN] });
    const token = await draft(fx);

    const { dialogs, out } = await overTheFoldedRoot(fx, token);

    expect(out.text).not.toMatch(/DRAFT_DESCRIPTION_TOO_LONG|Not sent/);
    expect(dialogs).toHaveLength(1);
    const { rows } = dialogs[0]!;
    // The whole letter, so far more rows than the old five — each still
    // within the row width.
    expect(rows.length).toBeGreaterThan(MCP_APPROVAL_DIALOG_BUDGET.maxFields);
    for (const row of rows) {
      expect(displayWidth(row), `row over the folded field width: ${row}`)
        .toBeLessThanOrEqual(MCP_APPROVAL_DIALOG_BUDGET.fieldDescriptionColumns);
    }
    expect(fx.pushed).toHaveLength(1);
    expect(recipientOf(fx.pushed[0]!)).toBe(KEN.popclawId);
  });

  it.each(['en', 'zh-CN'])('still names the house and the attachment whole, and both ends, in %s', async (lang) => {
    setOwnerLang(lang, 'config');
    const fx = setup({ house: HOUSE, people: [KEN] });
    const token = await draft(fx);

    const { dialogs } = await overTheFoldedRoot(fx, token);
    const joined = dialogs[0]!.message;

    // Nothing in a header row is shortened to make room: the house slug and
    // the attachment's name and size are the facts this approval is about.
    expect(joined).toContain(`${KEN.nickname}#`);
    expect(joined).toContain(HOUSE);
    expect(joined).toContain('R06-ATTACHMENT.txt (0.2 KB)');
    expect(joined).toContain(token);
    expect(joined).toContain('962');
    expect(joined).toContain('R06-CLAUDE-0A79933-L1');
    expect(joined).toContain('测试结束；无需研发，请勿自动回信。');
  });

  // A ZWJ emoji at the end of this letter is an ordinary signature: the whole
  // letter is still shown, the character escaped, and the legend on a trusted
  // row above the text.
  it.each(['en', 'zh-CN'] as const)('shows the whole letter and the legend with a ZWJ emoji at the end, in %s', async (lang) => {
    setOwnerLang(lang, 'config');
    const fx = setup({ house: HOUSE, people: [KEN] });
    const token = tokenOf(await fx.call('popclaw_draft_message', {
      recipient: KEN.popclawId, body: `${LETTER.trimEnd()} \u{1f469}\u200d\u{1f4bb}`, attachment_path: ATTACHMENT,
    }));

    const { dialogs, out } = await overTheFoldedRoot(fx, token);

    expect(out.text).not.toMatch(/DRAFT_DESCRIPTION_TOO_LONG|Not sent/);
    expect(dialogs).toHaveLength(1);
    const { rows } = dialogs[0]!;
    for (const row of rows) {
      expect(displayWidth(row), `row over the folded field width: ${row}`)
        .toBeLessThanOrEqual(MCP_APPROVAL_DIALOG_BUDGET.fieldDescriptionColumns);
    }
    const joined = rows.join('\n');
    // The owner is told they are reading a rendering, and what they read.
    expect(rows.at(-1)).toMatch(/\u2039U\+200D\u203a/);
    expect(rows).toContain(renderCopy(lang, 'sendDraft.approval.escapedInvisible'));
    expect(joined).toContain('测试结束；无需研发，请勿自动回信。');
    // And nothing above the ends was dropped to make room for it.
    expect(joined).toContain(HOUSE);
    expect(joined).toContain('R06-ATTACHMENT.txt (0.2 KB)');
    expect(joined).toContain(token);
    expect(fx.pushed).toHaveLength(1);
  });

  /**
   * WHAT THE OWNER SAW, AND WHAT THEY NOW SEE.
   *
   * On this letter the owner was shown five text boxes titled (1)…(5), typed
   * into the first, and could not tell what the form wanted. Later the
   * message pointed at the draft tool's output instead of carrying the text.
   * Now the message names THIS draft — its id, which the draft tool's own
   * output prints as `draft_id:` — and carries the text itself.
   */
  it.each(['en', 'zh-CN'] as const)('names this exact draft and carries its full text, with one input, in %s', async (lang) => {
    setOwnerLang(lang, 'config');
    const fx = setup({ house: HOUSE, people: [KEN] });
    const drafted = await fx.call('popclaw_draft_message', {
      recipient: KEN.popclawId, body: LETTER, attachment_path: ATTACHMENT,
    });
    const token = tokenOf(drafted);

    const { dialogs } = await overTheFoldedRoot(fx, token);
    const { message, fields } = dialogs[0]!;

    expect(fields).toEqual(['confirm']);
    expect(message.split('\n')).toContain(renderCopy(lang, 'sendDraft.approval.draftId', { id: token }));
    expect(message).not.toContain(renderCopy(lang, 'sendDraft.approval.bodyInToolOutput'));
    expect(message).toContain(renderCopy(lang, 'sendDraft.approval.bodyWhole', { chars: '962' }));
    // The id the message names is the one the draft tool printed.
    expect(drafted.text).toContain(`draft_id: ${token}`);
    expect(message).toContain('R06-ATTACHMENT.txt (0.2 KB)');
    expect(message).toContain(`${KEN.nickname}#`);
  });

  it.each([
    { label: 'decline', answer: { action: 'decline' } },
    { label: 'cancel', answer: { action: 'cancel' } },
    { label: 'accept with confirm false', answer: { action: 'accept', content: { confirm: false } } },
    { label: 'accept with confirm missing', answer: { action: 'accept', content: {} } },
  ])('sends nothing and keeps the draft on $label', async ({ answer }) => {
    const fx = setup({ house: HOUSE, people: [KEN] });
    const token = await draft(fx);

    const { dialogs, out } = await overTheFoldedRoot(fx, token, answer);

    expect(dialogs).toHaveLength(1);
    expect(out.text).toMatch(/Not sent/);
    expect(fx.pushed).toHaveLength(0);
    expect(peekDraftSnapshot(token), 'the draft must survive').not.toBeNull();
  });

  it('binds the draft as drafted and spends the approval once', async () => {
    const fx = setup({ house: HOUSE, people: [KEN] });
    const token = await draft(fx);
    const before = sendDraftApprovalSubject.canonicalize({ draft_id: token });

    const { out } = await overTheFoldedRoot(fx, token);

    expect(out.text).not.toMatch(/Not sent/);
    expect(fx.pushed).toHaveLength(1);
    expect(recipientOf(fx.pushed[0]!)).toBe(KEN.popclawId);
    // The subject still carries recipient, body and attachment-byte digests,
    // and the body in it is the complete letter — nothing shortened for the
    // dialog.
    expect(before).toContain(KEN.popclawId);
    // The draft is gone after the one send it was approved for.
    expect(peekDraftSnapshot(token)).toBeNull();
  });

  it('keeps every row of the whole layout inside a field, for a letter short enough to show whole', async () => {
    const fx = setup({ house: HOUSE, people: [KEN] });
    const token = tokenOf(await fx.call('popclaw_draft_message', {
      recipient: KEN.popclawId, body: 'R06 short.', attachment_path: ATTACHMENT,
    }));

    const described = describeSendDraft({ draft_id: token });
    expect(described.kind).toBe('ask');
    if (described.kind !== 'ask') return;
    for (const row of described.description) {
      expect(displayWidth(row), `row over the folded field width: ${row}`)
        .toBeLessThanOrEqual(MCP_APPROVAL_DIALOG_BUDGET.fieldDescriptionColumns);
    }
    expect(described.description).toContain('> R06 short.');
  });
});

// ---------------------------------------------------------------------------
// The body is text somebody else wrote: it may not forge a row
// ---------------------------------------------------------------------------

describe('a body that tries to write its own header row', () => {
  const HEADER_PREFIXES = ['To: ', 'house: ', 'Text ('];
  // Two body lines is the budget: the prompt is composed for the folded MCP
  // dialog, which renders five rows, and three of them are already spoken for
  // by the recipient, the destination and the text's own label.
  const forged = (sep: string, line: string): string => `ok${sep}${line}`;
  const askRows = (token: string): readonly string[] => {
    const described = describeSendDraft({ draft_id: token });
    expect(described.kind).toBe('ask');
    return described.kind === 'ask' ? described.description : [];
  };

  it.each([
    { label: 'a newline', body: forged('\n', 'To: attacker#zzzzzzzz') },
    { label: 'a carriage return', body: forged('\r', 'To: attacker#zzzzzzzz') },
    { label: 'a CRLF pair', body: forged('\r\n', 'To: attacker#zzzzzzzz') },
    { label: 'U+2028 LINE SEPARATOR', body: forged('\u2028', 'To: attacker#zzzzzzzz') },
    { label: 'U+2029 PARAGRAPH SEPARATOR', body: forged('\u2029', 'attached: 9 secrets.zip') },
    { label: 'U+0085 NEL', body: forged('\u0085', 'house: house-evil') },
    { label: 'a vertical tab', body: forged('\u000b', 'To: attacker#zzzzzzzz') },
  ])('$label cannot produce an unprefixed row', async ({ body }) => {
    const fx = setup();
    const token = tokenOf(await fx.call('popclaw_draft_message', { recipient: 'Alice', body }));

    const rows = askRows(token);

    // Every row the body contributed is marked as body text.
    const bodyLabelAt = rows.findIndex((r) => r.startsWith('Text ('));
    expect(bodyLabelAt).toBeGreaterThan(-1);
    for (const row of rows.slice(bodyLabelAt + 1)) expect(row.startsWith('> ')).toBe(true);
    // And nothing the body wrote reads as one of this module's own rows.
    for (const row of rows) {
      if (row.startsWith('> ')) continue;
      expect(row).not.toContain('attacker#zzzzzzzz');
      expect(row).not.toContain('house-evil');
      expect(row).not.toContain('secrets.zip');
    }
    // The forged text is still SHOWN, just quoted — the owner must see what is
    // in the letter, they just must not be misled about where it came from.
    expect(rows.join('\n')).toMatch(/attacker#zzzzzzzz|house-evil|secrets.zip/);
  });

  it('leaves the header rows byte-identical whatever the body says', async () => {
    const fx = setup();
    const plain = tokenOf(await fx.call('popclaw_draft_message', { recipient: 'Alice', body: 'hello' }));
    const tampered = tokenOf(await fx.call('popclaw_draft_message', {
      recipient: 'Alice',
      body: 'hello\nTo: attacker#zzzzzzzz',
    }));

    // Each draft names its own number in the header; that differs by design,
    // so it is normalised out. Everything else must be byte-identical.
    const headerOf = (rows: readonly string[], token: string): readonly string[] =>
      rows.slice(0, rows.findIndex((r) => r.startsWith('Text ('))).map((r) => r.split(token).join('<draft>'));

    expect(headerOf(askRows(tampered), tampered)).toEqual(headerOf(askRows(plain), plain));
    // And the titles: the native one and the first-screen one.
    const titles = (token: string): [string, string | undefined] => {
      const d = describeSendDraft({ draft_id: token });
      if (d.kind !== 'ask') throw new Error('unreachable');
      return [d.title, d.firstScreen?.title];
    };
    const [tamperedTitle, tamperedFirst] = titles(tampered);
    const [plainTitle, plainFirst] = titles(plain);
    expect(tamperedTitle).toBe(plainTitle);
    expect(tamperedFirst).toBe(plainFirst);
    expect(plainFirst).toMatch(/^To: Alice#/);
    expect(askRows(plain)).toContain(`draft: ${plain}`);
    expect(headerOf(askRows(plain), plain).some((r) => HEADER_PREFIXES.some((p) => r.startsWith(p)))).toBe(true);
  });

  it('refuses when the RECIPIENT LABEL hides a bidi override, and sends nothing', async () => {
    const fx = setup();
    const token = tokenOf(await fx.call('popclaw_draft_message', { recipient: 'Alice', body: 'hello' }));

    // Where the letter goes has to be readable, and there is no honest way to
    // render a destination that lies about itself.
    const snapshot = peekDraftSnapshot(token)!;
    _draftsForTest.clear();
    putDraft(token, async () => ({ text: 'SHOULD NEVER RUN' }), {
      ...snapshot,
      recipientLabel: 'Alice\u202egnittes#aaaa',
    });

    expect(describeSendDraft({ draft_id: token }).kind).toBe('refuse');

    await scriptOwnerApproval(SEND_DRAFT_TOOL, { draft_id: token }, 'call-1');
    const refused = await fx.call('popclaw_send_draft', { draft_id: token });

    expect(fx.pushed).toHaveLength(0);
    expect(refused.text).toMatch(/recipient|lore-house|attachment/i);
    expect(peekDraftSnapshot(token)).not.toBeNull();
  });

  it('refuses when an ATTACHMENT NAME hides a bidi override', async () => {
    const fx = setup();
    const token = tokenOf(await fx.call('popclaw_draft_message', { recipient: 'Alice', body: 'hello' }));
    const snapshot = peekDraftSnapshot(token)!;
    _draftsForTest.clear();
    putDraft(token, async () => ({ text: 'SHOULD NEVER RUN' }), {
      ...snapshot,
      attachments: [{ name: 'invoice\u202egnp.exe', digest: 'a'.repeat(32), mime: 'image/png', bytes: new Uint8Array([1]) }],
    });

    expect(describeSendDraft({ draft_id: token }).kind).toBe('refuse');
  });
});

// ---------------------------------------------------------------------------
// The body is escaped, not refused — and the escaping is one-to-one
// ---------------------------------------------------------------------------

describe('invisible characters inside the body', () => {
  const rowsFor = (token: string): readonly string[] => {
    const described = describeSendDraft({ draft_id: token });
    expect(described.kind).toBe('ask');
    return described.kind === 'ask' ? described.description : [];
  };

  // `escape` is null for a character the seam's invisible class does not cover:
  // U+FE0F is a nonspacing MARK, it paints the character before it rather than
  // nothing, and it was never at risk of being refused. Asserting an escape for
  // it would be testing a behaviour that must not exist.
  const cases = [
    { label: 'a ZWJ family emoji', body: 'dinner with \u{1f468}\u200d\u{1f469}\u200d\u{1f467} tonight?', escape: '\u2039U+200D\u203a' },
    { label: 'a variation selector', body: 'see the note \u2757\ufe0f please', escape: null },
    { label: 'a zero-width space', body: 'pay \u200b Alice', escape: '\u2039U+200B\u203a' },
    { label: 'a bidi override', body: 'send to \u202ereklaw', escape: '\u2039U+202E\u203a' },
  ];

  it.each(cases)('$label is approvable and sends exactly once', async ({ body }) => {
    const fx = setup();
    const token = tokenOf(await fx.call('popclaw_draft_message', { recipient: 'Alice', body }));

    expect(describeSendDraft({ draft_id: token }).kind).toBe('ask');
    await scriptOwnerApproval(SEND_DRAFT_TOOL, { draft_id: token }, 'call-1');

    // This synthetic nonce makes the family emoji's ciphertext contain the
    // ASCII bytes U+. Binary wire data must not be mistaken for rendered text.
    const nonce = new Uint8Array(nacl.box.nonceLength);
    nonce[0] = 19;
    const randomBytes = vi.spyOn(nacl, 'randomBytes').mockReturnValueOnce(nonce);
    try {
      await fx.call('popclaw_send_draft', { draft_id: token });
      expect(randomBytes).toHaveBeenCalledTimes(1);
      expect(randomBytes).toHaveBeenCalledWith(nacl.box.nonceLength);
    } finally {
      randomBytes.mockRestore();
    }

    expect(fx.pushed).toHaveLength(1);
    // What went on the wire is the real text, never the rendering.
    const signed = popclaw.identity.SignedPayload.decode(fx.pushed[0]!);
    const dm = popclaw.event.EventEnvelope.decode(signed.payload).directMessage!;
    expect(dm.toPopclawId).toBe(ALICE.id);
    if (!dm.nonce || !dm.ciphertext) throw new Error('sent draft must carry ciphertext and a nonce');
    expect(new Uint8Array(dm.nonce)).toEqual(nonce);
    if (body === cases[0]!.body) {
      expect(new TextDecoder().decode(dm.ciphertext)).toContain('U+');
    }
    const opened = ALICE.signer.openDm(dm, OWNER.id);
    expect(opened.ok).toBe(true);
    if (!opened.ok) throw new Error(`fixture recipient could not decrypt: ${opened.reason}`);
    expect(opened.plaintext).not.toContain('U+');
    expect(opened.plaintext).toBe(body);
    expect(opened.plaintextBytes).toEqual(new TextEncoder().encode(body));
  });

  it.each(cases)('$label is rendered honestly', async ({ body, escape }) => {
    const fx = setup();
    const token = tokenOf(await fx.call('popclaw_draft_message', { recipient: 'Alice', body }));
    const rows = rowsFor(token);
    const notice = rows.find((r) => r.includes('\u2039U+XXXX\u203a'));

    if (escape === null) {
      // Shown as itself, and no notice claiming a rendering that never happened.
      expect(rows.join('\n')).toContain(body);
      expect(notice).toBeUndefined();
      return;
    }
    // The hidden character is now visible, and a trusted HEADER row — one this
    // module wrote, not one the body could have contributed — says so.
    expect(rows.join('\n')).toContain(escape);
    expect(notice).toBeDefined();
    expect(notice!.startsWith('> ')).toBe(false);
  });

  it.each(['en', 'zh-CN'])('wraps every row inside the folded dialog width in %s', async (lang) => {
    setOwnerLang(lang, 'config');
    const fx = setup();
    // One long line with no breaks in it: whatever the owner reads, they read
    // it in rows a folded MCP client will actually render, or the dialog is
    // refused and popclaw_send_draft is unapprovable on that host.
    const body = lang === 'en'
      ? 'Please confirm the delivery window for next week before I answer them, because the slot they offered overlaps the standing review.'
      : '下周的交付窗口请先确认一下我再回他们，因为他们给的那个时段和固定评审撞上了，挪不开。';
    const token = tokenOf(await fx.call('popclaw_draft_message', { recipient: 'Alice', body }));

    const described = describeSendDraft({ draft_id: token });
    expect(described.kind).toBe('ask');
    if (described.kind !== 'ask') return;

    for (const row of described.description) {
      expect(displayWidth(row), `row over the folded field width: ${row}`)
        .toBeLessThanOrEqual(MCP_APPROVAL_DIALOG_BUDGET.fieldDescriptionColumns);
    }
    // Wrapping is a display act: it may add rows, it may not lose text.
    const shown = described.description.filter((r) => r.startsWith('> ')).map((r) => r.slice(2)).join('');
    expect(shown).toBe(body);
  });

  it('clips the last excerpt row between atoms, never through an escape token', async () => {
    const fx = setup();
    // Long enough that the excerpt must clip, with zero-width joiners packed
    // where the clip is going to land.
    const body = `${'x'.repeat(40)} ${'\u200d y '.repeat(60)}`;
    const token = tokenOf(await fx.call('popclaw_draft_message', { recipient: 'Alice', body }));
    // A delivered preview is what licenses an excerpt at all.
    noteDraftPreview(token, 'preview text', 'unknown');

    const described = describeSendDraft({ draft_id: token });
    expect(described.kind).toBe('ask');
    if (described.kind !== 'ask') return;

    const shown = described.description.filter((r) => r.startsWith('> ')).join('\n');
    expect(shown).toContain('\u2039U+200D\u203a');
    // Half a token is both unreadable and decodable as something it is not.
    // Every introducer in the output must open a complete token.
    const introducers = [...shown].filter((ch) => ch === '\u2039').length;
    const complete = [...shown.matchAll(/\u2039U\+[0-9A-F]{4,6}\u203a/gu)].length;
    expect(complete).toBe(introducers);
    expect(shown).not.toMatch(/\u2039U\+[0-9A-F]{0,6}$/u);
  });

  it('never renders the literal token and the real character the same way', async () => {
    const fx = setup();
    const real = tokenOf(await fx.call('popclaw_draft_message', { recipient: 'Alice', body: 'join \u200d here' }));
    const literal = tokenOf(await fx.call('popclaw_draft_message', { recipient: 'Alice', body: 'join \u2039U+200D\u203a here' }));
    const neither = tokenOf(await fx.call('popclaw_draft_message', { recipient: 'Alice', body: 'join here' }));

    const bodyOf = (t: string): string => rowsFor(t).filter((r) => r.startsWith('> ')).join('\n');

    // Three different letters, three different renderings. Two contents the
    // owner cannot tell apart is the deception this lane exists to close.
    expect(bodyOf(real)).not.toBe(bodyOf(literal));
    expect(bodyOf(real)).not.toBe(bodyOf(neither));
    expect(bodyOf(literal)).not.toBe(bodyOf(neither));
    // The introducer escapes itself, which is what makes the rendering
    // decodable and therefore one-to-one.
    expect(bodyOf(literal)).toContain('\u2039U+2039\u203a');
    expect(bodyOf(real)).toContain('\u2039U+200D\u203a');
  });

  it('binds the RAW bytes in canonicalize, never the escaped display string', async () => {
    const fx = setup();
    const token = tokenOf(await fx.call('popclaw_draft_message', { recipient: 'Alice', body: 'join here' }));
    const plain = sendDraftApprovalSubject.canonicalize({ draft_id: token });

    const snapshot = peekDraftSnapshot(token)!;
    _draftsForTest.clear();
    putDraft(token, async () => ({ text: 'x' }), { ...snapshot, body: 'join\u200d here' });
    const withZwj = sendDraftApprovalSubject.canonicalize({ draft_id: token });

    // Two bodies differing ONLY by an invisible character are two subjects.
    expect(withZwj).not.toBe(plain);
    // And the subject carries the character itself, not its rendering.
    expect(withZwj).toContain('\u200d');
    expect(withZwj).not.toContain('U+200D');
  });
});

// ---------------------------------------------------------------------------
// (g) the owner typing a slash command IS the owner acting
// ---------------------------------------------------------------------------

describe('the owner-typed slash lane', () => {
  // `/popclaw message` and `/popclaw feedback` never touch the draft table:
  // the person at the keyboard is the owner, and asking them to approve what
  // they just typed would be a second confirmation of the same act. Pinned
  // here because the gate above must not creep into this lane.
  it('/popclaw message sends without any approval record', async () => {
    const pushed: Uint8Array[] = [];
    const push = vi.fn(async (bytes: Uint8Array) => {
      pushed.push(bytes);
      return { status: 200, eventId: FULL_EVENT };
    });
    const { runPopclawMessageCommand } = await import('../../../src/commands/popclaw-message.js');

    await runPopclawMessageCommand({ positional: [ALICE.id, 'typed by hand'], flags: {} }, {
      signer: OWNER.signer,
      egress: { push, pushTo: async (_h: string | undefined, b: Uint8Array) => push(b) },
      nickname: 'Owner',
      resolveRecipient: async () => ({ kind: 'resolved', popclawId: ALICE.id, nickname: 'Alice', sigil: 'aaaaaaaa' }),
    } as unknown as Parameters<typeof runPopclawMessageCommand>[1]);

    expect(pushed).toHaveLength(1);
    expect(recipientOf(pushed[0]!)).toBe(ALICE.id);
  });

  it('/popclaw feedback (no draftDm wired) sends without any approval record', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'popclaw-send-gate-slash-'));
    writeFileSync(join(dir, 'house-home.md'), guide);
    const pushed: Uint8Array[] = [];
    const push = vi.fn(async (bytes: Uint8Array) => {
      pushed.push(bytes);
      return { status: 200, eventId: FULL_EVENT };
    });
    const { runPopclawFeedbackCommand } = await import('../../../src/commands/popclaw-feedback.js');

    const reply = await runPopclawFeedbackCommand({ positional: ['need', 'typed by hand'] }, {
      signer: OWNER.signer,
      egress: { push, pushTo: async (_h: string | undefined, b: Uint8Array) => push(b) },
      nickname: 'Owner',
      houseOfRecipient: () => undefined,
      fetchGuide: async () => guide,
      houseSlug: 'house-home',
      readHouseGuide: () => null,
      knownHouseSlugs: ['house-home'],
      buildStamp: 'test',
      // draftDm deliberately absent: this is the slash lane.
    } as unknown as Parameters<typeof runPopclawFeedbackCommand>[1]);

    expect(pushed).toHaveLength(1);
    expect(reply.text).not.toMatch(/draft_id/);
  });
});

// ---------------------------------------------------------------------------
// Both composition roots must fill the subject registry
// ---------------------------------------------------------------------------

describe('which roots reach the send_draft approval subject', () => {
  // The registry is module state a ROOT has to fill. `src/index.ts` and
  // `src/mcp.ts` both call `registerPopclawTools`, and the world lane already
  // shipped a defect where a subject was registered from one root only: in the
  // other process the registry was empty, the backend asked nobody anything,
  // and nothing failed or warned. Writing the registry directly — which every
  // other test here does — proves the seam works and proves nothing about
  // whether a real root ever fills it.
  const draftParams = { draft_id: 'message-1' };

  function registerAs(root: 'mcp' | 'native'): ReturnType<typeof makeToolCollector> {
    const c = makeToolCollector();
    registerPopclawTools({
      api: c.api,
      runtime: async () => ({}) as never,
      getOrchestrator: async () => ({}) as never,
      getWorldDeps: async () => ({}) as never,
      getWorldCommandContext: async () => ({}) as never,
      ...(root === 'native'
        ? { bindNativeWorldInvoke: () => async () => undefined as never }
        : { bindMcpWorldInvoke: () => async () => undefined as never }),
    } as unknown as Parameters<typeof registerPopclawTools>[0]);
    return c;
  }

  it('is unregistered until a root registers its tools', () => {
    expect(consumeOwnerApproval(SEND_DRAFT_TOOL, draftParams, 'root-1'))
      .toEqual({ decision: 'unavailable', reason: 'SUBJECT_NOT_REGISTERED' });
  });

  it.each(['mcp', 'native'] as const)("finds a descriptor after the %s root's tool registration has run", (root) => {
    const c = registerAs(root);
    setOwnerApprovalSurface(true);

    expect(c.tools.map((t) => t.name)).toContain(SEND_DRAFT_TOOL);
    // NOT `SUBJECT_NOT_REGISTERED`: a descriptor exists and the seam got past
    // the registry into this subject's own canonicalize. What it lands on
    // instead is only "nobody was asked about THIS call".
    expect(consumeOwnerApproval(SEND_DRAFT_TOOL, draftParams, 'root-1'))
      .toEqual({ decision: 'unavailable', reason: 'ORIGIN_NOT_OWNER_DIRECT' });
  });
});

// ---------------------------------------------------------------------------
// The grant is spent inside the tool body, on EVERY path out of it
// ---------------------------------------------------------------------------

describe('the unconsumed-grant guard never has anything to say about send_draft', () => {
  // Both roots now check, after a tool body settles, whether a grant the owner
  // gave was taken and never spent, and report it at error level naming the
  // tool. It is a real defect class — `popclaw_world_invoke` shipped it under
  // MCP, silently — and the contract it places on a registrant is: CONSUME
  // WITHIN YOUR OWN PROMISE. This tool consumes synchronously as its first
  // act, before the draft is even looked up, so the guard must stay silent on
  // every path out of the body, including the early ones.

  it('native root: an approved send leaves nothing for after_tool_call to report', async () => {
    const fx = setup();
    const token = tokenOf(await fx.call('popclaw_draft_message', { recipient: 'Alice', body: 'hello' }));
    await scriptOwnerApproval(SEND_DRAFT_TOOL, { draft_id: token }, 'call-1');

    await fx.call('popclaw_send_draft', { draft_id: token }, 'call-1');
    expect(fx.pushed).toHaveLength(1);

    const report = vi.fn();
    ownerApprovalAfterToolCall({ toolName: SEND_DRAFT_TOOL, toolCallId: 'call-1' }, { toolCallId: 'call-1' }, report);
    expect(report).not.toHaveBeenCalled();
  });

  /**
   * The early return that is easiest to get wrong, and the one place this
   * tool CANNOT spend the grant however it is written: the owner approved,
   * and by the time the body ran the draft was gone — the 30-minute TTL, or
   * the call that raced this one got there first.
   *
   * WHAT ACTUALLY HAPPENS, and it is not what it looks like from the tool's
   * side. `canonicalize` reads the live draft table, so with the draft gone it
   * answers its unknown-draft sentinel — which is a DIFFERENT subject from the
   * one the owner was shown. The seam therefore returns `SUBJECT_CHANGED` and
   * deliberately KEEPS the record: "the answer belongs to what it was given
   * for and nothing else". The grant is genuinely unspent, and the
   * after-dispatch guard drops it and reports.
   *
   * THE DECISION: leave it that way. The tool cannot consume a grant the seam
   * will not hand over — the only ways to silence the guard here would be to
   * take the draft before consuming (which is the gate inverted, and a
   * mutation this suite already turns red) or to call
   * `discardUnconsumedOwnerApproval` from a tool body, which is the registrant
   * quietly switching off a guard built to catch registrants. Nothing is sent,
   * the answer can never be spent afterwards, and the defect line is TRUE
   * about the fact it names — a grant went unspent. Its wording blames the
   * body for not calling `consumeOwnerApproval`, which on this path is the one
   * thing the body did do; that is a seam wording matter, filed rather than
   * worked around.
   */
  it('native root: a draft that vanished between approval and take sends nothing, and the grant dies with the call', async () => {
    const fx = setup();
    const token = tokenOf(await fx.call('popclaw_draft_message', { recipient: 'Alice', body: 'hello' }));
    await scriptOwnerApproval(SEND_DRAFT_TOOL, { draft_id: token }, 'call-1');
    _draftsForTest.clear();

    const out = await fx.call('popclaw_send_draft', { draft_id: token }, 'call-1');

    expect(fx.pushed).toHaveLength(0);
    // Gone, not edited: the sentence says which.
    expect(out.text).toBe(`${renderCopy(ownerLang(), 'sendDraft.refused.noLongerThere')} (reason: SUBJECT_CHANGED)`);

    // The guard does fire here, and it is right to: the answer was never
    // spent. It drops the grant, which is the half that matters.
    const report = vi.fn();
    ownerApprovalAfterToolCall({ toolName: SEND_DRAFT_TOOL, toolCallId: 'call-1' }, { toolCallId: 'call-1' }, report);
    expect(report).toHaveBeenCalledOnce();

    // And after that drop the answer is dead: no second attempt can spend it.
    expect(consumeOwnerApproval(SEND_DRAFT_TOOL, { draft_id: token }, 'call-1'))
      .toEqual({ decision: 'unavailable', reason: 'ALREADY_CONSUMED' });
  });

  it('native root: every other early return out of the body spends it too', async () => {
    const fx = setup();
    const report = vi.fn();
    for (const draftId of ['message-404', 'invite-1', '']) {
      await scriptOwnerApproval(SEND_DRAFT_TOOL, { draft_id: draftId }, `early-${draftId}`);
      await fx.call('popclaw_send_draft', { draft_id: draftId }, `early-${draftId}`);
      ownerApprovalAfterToolCall({ toolName: SEND_DRAFT_TOOL, toolCallId: `early-${draftId}` },
        { toolCallId: `early-${draftId}` }, report);
    }
    expect(fx.pushed).toHaveLength(0);
    expect(report).not.toHaveBeenCalled();
  });

  it('MCP root: aroundDispatch finds nothing unspent after an approved send', async () => {
    const fx = setup();
    const token = tokenOf(await fx.call('popclaw_draft_message', { recipient: 'Alice', body: 'hello' }));
    const logger = { error: vi.fn(), warn: vi.fn() };
    // A connected client that declares form elicitation and ticks the box.
    const backend = createMcpOwnerApproval({
      server: { current: {
        getClientCapabilities: () => ({ elicitation: { form: {} } }),
        getClientVersion: () => ({ name: 'vitest-folded-client', version: '1' }),
        elicitInput: async () => ({ action: 'accept', content: { confirm: true } }),
      } as never },
      logger,
    });
    const callRef = backend.callRef({ requestId: 7 });

    const out = await backend.aroundDispatch(SEND_DRAFT_TOOL, { draft_id: token }, callRef, undefined,
      () => fx.call('popclaw_send_draft', { draft_id: token }, callRef));

    expect(fx.pushed).toHaveLength(1);
    expect(out.text).not.toMatch(/Not sent/);
    // The whole point: the body consumed inside its own promise, so the
    // `finally` has no grant left to drop and nothing to report.
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
    backend.stop();
  });

  it('MCP root: a declined send is not a grant, so there is still nothing to report', async () => {
    const fx = setup();
    const token = tokenOf(await fx.call('popclaw_draft_message', { recipient: 'Alice', body: 'hello' }));
    const logger = { error: vi.fn(), warn: vi.fn() };
    const backend = createMcpOwnerApproval({
      server: { current: {
        getClientCapabilities: () => ({ elicitation: { form: {} } }),
        getClientVersion: () => ({ name: 'vitest-folded-client', version: '1' }),
        elicitInput: async () => ({ action: 'decline' }),
      } as never },
      logger,
    });
    const callRef = backend.callRef({ requestId: 9 });

    const out = await backend.aroundDispatch(SEND_DRAFT_TOOL, { draft_id: token }, callRef, undefined,
      () => fx.call('popclaw_send_draft', { draft_id: token }, callRef));

    expect(fx.pushed).toHaveLength(0);
    expect(out.text).toBe(renderCopy(ownerLang(), 'sendDraft.refused.denied'));
    expect(peekDraftSnapshot(token)).not.toBeNull();
    expect(logger.error).not.toHaveBeenCalled();
    backend.stop();
  });
});

// ---------------------------------------------------------------------------
// (5) what the tools tell the model
// ---------------------------------------------------------------------------

describe('what the draft tools tell the model', () => {
  it('popclaw_send_draft says the host asks the owner and that sending is not assured', () => {
    const fx = setup();
    const description = fx.tool('popclaw_send_draft').description ?? '';
    expect(description).toMatch(/ask/i);
    expect(description).toMatch(/owner/i);
    expect(description).toMatch(/never (claim|say|tell)/i);
  });

  it('the draft tools carry the same discipline', () => {
    const fx = setup();
    for (const name of ['popclaw_draft_message', 'popclaw_draft_reply', 'popclaw_draft_post']) {
      expect(fx.tool(name).description ?? '').toMatch(/popclaw_send_draft/);
    }
  });
});

// ---------------------------------------------------------------------------
// (6) a refusal that names itself
// ---------------------------------------------------------------------------

/**
 * On Ken, 2026-09-23, a WhatsApp self-chat with a pinned approval target
 * configured, the owner got "the draft could not be shown to the owner" and
 * nobody — not the agent, not the owner, not the thread reading the transcript
 * afterwards — could tell which refusal had fired. The seam had already done
 * its part: `consumeOwnerApproval` hands the tool body the named reason
 * (`owner-approval.ts`, the `originRefusals` lookup). It was this text that
 * threw the name away, because every reason it had not explicitly mapped fell
 * into one shared sentence.
 */
describe('a refusal names itself', () => {
  const reasonOf = (text: string): string | null => /\(reason: ([A-Z_/]+)\)/.exec(text)?.[1] ?? null;

  it.each(OWNER_APPROVAL_UNAVAILABLE_REASONS)('carries %s verbatim, in both languages', (reason) => {
    for (const lang of ['en', 'zh-CN'] as const) {
      const text = sendDraftRefusalText({ decision: 'unavailable', reason }, 'message-1', lang);
      expect(text, `${reason} is not in its own refusal text`).toContain(reason);
      // One machine-readable frame, not the reason smuggled into prose.
      expect(reasonOf(text)).toBe(reason);
    }
  });

  it('carries the descriptor\'s own detail alongside the seam\'s reason', () => {
    const text = sendDraftRefusalText(
      { decision: 'unavailable', reason: 'SUBJECT_REFUSED', detail: 'DRAFT_TEXT_NOT_SHOWABLE' }, 'message-1', 'en');
    expect(reasonOf(text)).toBe('SUBJECT_REFUSED/DRAFT_TEXT_NOT_SHOWABLE');
  });

  /**
   * EVERY DETAIL THE FRAME CAN CARRY, AND THE SHAPE IT MUST KEEP.
   *
   * The closed set of strings that can arrive as `detail` on a `SUBJECT_REFUSED`
   * outcome: this module's own four descriptor refusals, the four the seam's
   * screen produces, the two the backends produce, and the two a broken
   * registrant produces. A code outside `[A-Z_/]` would escape the frame that
   * every other test here matches on — and an exception class name, which is
   * what `DESCRIBE_THREW` used to append, is exactly such a code.
   */
  const EVERY_DETAIL = [
    'DRAFT_UNKNOWN_OR_EXPIRED', 'DRAFT_NOT_SHOWN_AND_TOO_LONG', 'DRAFT_DESCRIPTION_TOO_LONG',
    'DRAFT_TEXT_NOT_SHOWABLE', 'APPROVAL_PREVIEW_OVER_DISPLAY_BUDGET', 'REVIEW_COPY_CHANGED_OR_MISSING',
    'REVIEW_COPY_NOT_WRITTEN', 'REVIEW_PATH_NOT_SHOWABLE', 'REVIEW_DECISION_MISMATCH', 'BEFORE_ASK_THREW', 'DRAFT_FULL_TEXT_TOO_MANY_ROWS', 'DRAFT_ROW_TOO_WIDE',
    'APPROVAL_PROMPT_UNPRINTABLE', 'APPROVAL_PROMPT_TOO_LONG', 'APPROVAL_PROMPT_EMPTY',
    'APPROVAL_PROMPT_TOO_MANY_LINES',
    'APPROVAL_PROMPT_UNREADABLE_ON_HOST', FOLDED_ALTERNATIVE_UNPRESENTABLE,
    'CANONICALIZE_FAILED', 'DESCRIBE_THREW',
  ] as const;

  it.each(EVERY_DETAIL)('keeps the frame shape for detail %s', (detail) => {
    for (const lang of ['en', 'zh-CN'] as const) {
      const text = sendDraftRefusalText({ decision: 'unavailable', reason: 'SUBJECT_REFUSED', detail }, 'message-1', lang);
      expect(reasonOf(text)).toBe(`SUBJECT_REFUSED/${detail}`);
    }
  });

  /**
   * A REGISTRANT THAT THROWS SAYS SO, AND SAYS NOTHING ELSE.
   *
   * `refusalOf` used to append the error's constructor name, so a `TypeError`
   * inside `describe` printed `(reason: SUBJECT_REFUSED/DESCRIBE_THREW_TypeError)`
   * into the agent's transcript — an exception class in the one frame that
   * promises to carry none, and a string the frame's own shape does not admit.
   */
  it('tells the agent a descriptor threw, without naming the exception', async () => {
    const fx = setup();
    const token = tokenOf(await fx.call('popclaw_draft_message', { recipient: 'Alice', body: 'hello' }));
    registerOwnerApprovalSubject(SEND_DRAFT_TOOL, {
      canonicalize: sendDraftApprovalSubject.canonicalize,
      describe: () => { throw new TypeError('a registrant defect'); },
    });

    await scriptOwnerApproval(SEND_DRAFT_TOOL, { draft_id: token }, 'threw-1');
    const refused = await fx.call('popclaw_send_draft', { draft_id: token }, 'threw-1');

    expect(reasonOf(refused.text)).toBe('SUBJECT_REFUSED/DESCRIBE_THREW');
    expect(refused.text).not.toMatch(/TypeError|registrant defect/);
    expect(fx.pushed).toHaveLength(0);
    expect(peekDraftSnapshot(token), 'the draft must survive a refusal').not.toBeNull();
  });

  // The seam drops a folded rendering that fails its screen, and says so by
  // name at the moment that drop cost something. To the owner it is the same
  // fact as any other "it does not fit"; the code is what tells a reader the
  // defect is in the shorter layout rather than in their host.
  it('names a dropped folded rendering without changing what the owner reads', () => {
    const text = sendDraftRefusalText(
      { decision: 'unavailable', reason: 'SUBJECT_REFUSED', detail: FOLDED_ALTERNATIVE_UNPRESENTABLE },
      'message-1', 'en');
    expect(text).toContain(renderCopy('en', 'sendDraft.refused.tooLongToShow'));
    expect(reasonOf(text)).toBe(`SUBJECT_REFUSED/${FOLDED_ALTERNATIVE_UNPRESENTABLE}`);
  });

  // An owner's own decision is not a refusal and has no machine reason to
  // carry: appending one would be inventing a code for "they said no".
  it('leaves an answered denial alone', () => {
    expect(reasonOf(sendDraftRefusalText({ decision: 'denied' }, 'message-1', 'en'))).toBeNull();
  });
  // A timeout is NOT the owner's answer — it is the window closing first, and
  // on Claude Code the dialog can stay open after it, so an approval given
  // there is dropped. That fact gets a name (2026-09-26, the 146 s approval).
  it.each(['en', 'zh-CN'] as const)('names a timeout as the window closing first (%s)', (lang) => {
    expect(reasonOf(sendDraftRefusalText({ decision: 'timeout' }, 'message-1', lang)))
      .toBe('OWNER_APPROVAL_TIMED_OUT_BEFORE_ANSWER');
  });

  it.each(OWNER_APPROVAL_ROUTE_REFUSALS.filter(reason => reason !== 'OWNER_ROUTE_FORWARDING_DISABLED'))('keeps the existing route refusal presentation for %s', (reason) => {
    for (const lang of ['en', 'zh-CN'] as const) {
      const text = sendDraftRefusalText({ decision: 'unavailable', reason }, 'message-1', lang);
      expect(text).toBe(`${renderCopy(lang, 'sendDraft.refused.notTheApprovalChat')} (reason: ${reason})`);
      // It must never collapse back into the sentence that hid it.
      expect(text).not.toContain(renderCopy(lang, 'sendDraft.refused.cannotShow'));
    }
    // And it says what to compare, never how to get around the approval.
    expect(renderCopy('en', 'sendDraft.refused.notTheApprovalChat'))
      .toMatch(/configured|approval target/i);
    expect(renderCopy('en', 'sendDraft.refused.notTheApprovalChat'))
      .not.toMatch(/bypass|skip|without approval|disable/i);
    expect(renderCopy('zh-CN', 'sendDraft.refused.notTheApprovalChat')).not.toMatch(/绕过|跳过|关掉/);
  });

  it.each([
    ['en', /has not enabled plugin approval forwarding/, /chat.*does not replace/i, /may expire/],
    ['zh-CN', /尚未开启插件审批转发/, /普通聊天.*不能替代/, /有效期/],
  ] as const)('names disabled forwarding on the native send lane (%s) without promising draft survival', async (lang, disabled, chatConsent, expiry) => {
    setOwnerLang(lang, 'config');
    const fx = setup();
    const token = tokenOf(await fx.call('popclaw_draft_message', { recipient: 'Alice', body: 'hello' }));
    const callRef = 'forwarding-disabled';
    setOwnerApprovalSurface(true);
    const asked = await ownerApprovalBeforeToolCall(
      { toolName: SEND_DRAFT_TOOL, params: { draft_id: token }, toolCallId: callRef },
      {
        toolCallId: callRef, agentId: 'main', sessionKey: 'agent:main:whatsapp:direct:1',
        channelId: '+15555550101',
        requester: { channel: 'whatsapp', accountId: 'main', senderId: 'owner', senderIsOwner: true },
      },
      { readActiveConfig: () => ({}), resolveChannel: raw => raw === 'whatsapp' ? 'whatsapp' : undefined },
    );
    expect(asked).toBeUndefined();
    const refused = await fx.call(SEND_DRAFT_TOOL, { draft_id: token }, callRef);
    expect(reasonOf(refused.text)).toBe('OWNER_ROUTE_FORWARDING_DISABLED');
    expect(refused.text).toMatch(disabled);
    expect(refused.text).toMatch(chatConsent);
    expect(refused.text).toMatch(expiry);
    expect(refused.text).not.toMatch(/not the chat|不是.*聊天/);
    expect(fx.pushed).toHaveLength(0);
    expect(peekDraftSnapshot(token)).not.toBeNull();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + DRAFT_TTL_MS + 1);
    try {
      expect(peekDraftSnapshot(token), 'a refusal must not extend the draft TTL').toBeNull();
    } finally { clock.mockRestore(); }
  });

  /**
   * The Ken path end to end: a WhatsApp turn whose configured approval target
   * is some other address. The seam's origin guard refuses by name, the guard
   * leaves the name for this call, the tool body reads it back, and the agent
   * is told which refusal fired — with nothing sent.
   */
  it('reaches the tool result on the native lane, and sends nothing', async () => {
    const fx = setup();
    const token = tokenOf(await fx.call('popclaw_draft_message', { recipient: 'Alice', body: 'hello' }));
    const callRef = 'ken-1';
    setOwnerApprovalSurface(true);
    const asked = await ownerApprovalBeforeToolCall(
      { toolName: SEND_DRAFT_TOOL, params: { draft_id: token }, toolCallId: callRef },
      {
        toolCallId: callRef, agentId: 'main', sessionKey: 'agent:main:whatsapp:direct:1',
        channelId: '+15555550101',
        requester: { channel: 'whatsapp', accountId: 'main', senderId: 'owner', senderIsOwner: true },
      },
      {
        readActiveConfig: () => ({
          commands: { ownerAllowFrom: ['+15555550101'] },
          approvals: { plugin: { enabled: true, mode: 'targets', targets: [{ channel: 'whatsapp', to: '+10000000000', accountId: 'main' }] } },
        }),
        resolveChannel: (raw: string) => (raw === 'whatsapp' ? 'whatsapp' : undefined),
      },
    );

    expect(asked, 'a refused origin must never produce an approval request').toBeUndefined();
    const refused = await fx.call('popclaw_send_draft', { draft_id: token }, callRef);

    expect(refused.text).toContain('OWNER_ROUTE_TARGET_ADDRESS_NOT_THIS_TURN');
    expect(refused.text).toContain(renderCopy('en', 'sendDraft.refused.notTheApprovalChat'));
    expect(fx.pushed).toHaveLength(0);
    expect(peekDraftSnapshot(token), 'the draft must survive a refusal').not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The first screen: what a folding host shows with no keystroke
// ---------------------------------------------------------------------------

/**
 * Claude Code 2.1.283 (probes v3–v3.2) shows the message's FIRST LINE only and
 * cannot expand it, plus the confirm field's one description line, cut past
 * about 80 columns. Those two lines are the whole first screen, so they carry:
 * the recipient for a letter that has one, else the letter's own text; and
 * either how to change the draft or where the full text is.
 */
describe('the first screen of the approval dialog', () => {
  async function firstScreen(fx: ReturnType<typeof setup>, token: string) {
    let seen: { message: string; confirmTitle?: string; confirmDescription?: string } | undefined;
    const backend = createMcpOwnerApproval({
      server: { current: {
        getClientCapabilities: () => ({ elicitation: { form: {} } }),
        getClientVersion: () => ({ name: 'claude-code', version: '2.1.283' }),
        elicitInput: async (params: unknown) => {
          const form = params as { message: string; requestedSchema: { properties: Record<string, unknown> } };
          const confirm = form.requestedSchema.properties['confirm'] as { title?: string; description?: string };
          seen = { message: form.message, confirmTitle: confirm.title, confirmDescription: confirm.description };
          return { action: 'decline' };
        },
      } as never },
    });
    const callRef = backend.callRef({ requestId: `first-${token}` });
    await backend.aroundDispatch(SEND_DRAFT_TOOL, { draft_id: token }, callRef, undefined,
      () => fx.call('popclaw_send_draft', { draft_id: token }, callRef));
    backend.stop();
    expect(seen, 'the dialog must have been shown').toBeDefined();
    const lines = seen!.message.split('\n');
    return { lines, line1: lines[0]!, description: seen!.confirmDescription!, label: seen!.confirmTitle! };
  }

  it.each(['en', 'zh-CN'] as const)('a one-line post IS the first line, and the line under the box says how to change it, in %s', async (lang) => {
    setOwnerLang(lang, 'config');
    const fx = setup();
    const token = tokenOf(await fx.call('popclaw_draft_post', { body: 'a thought worth sharing' }));

    const { line1, lines, description } = await firstScreen(fx, token);

    expect(line1).toBe('> a thought worth sharing');
    // The whole letter is on screen, so the one line goes to the change path.
    expect(description).toBe(renderCopy(lang, 'sendDraft.approval.changeHint'));
    expect(description).toContain('Decline');
    // The question that used to be line 1 is still asked, right under it.
    expect(lines[2]).toBe(renderCopy(lang, 'sendDraft.approval.title', { kind: renderCopy(lang, 'sendDraft.kind.post') }));
    // Declining sent nothing and kept the draft.
    expect(fx.pushed).toHaveLength(0);
    expect(peekDraftSnapshot(token)).not.toBeNull();
  });

  it('a multi-line post opens with its first line, and says by its real id that the full text is here', async () => {
    const fx = setup();
    const token = tokenOf(await fx.call('popclaw_draft_post', { body: 'first line\nsecond line' }));

    const { line1, lines, description } = await firstScreen(fx, token);

    expect(line1).toBe('> first line');
    // The letter below is still complete and contiguous.
    const at = lines.indexOf('> first line', 1);
    expect(lines.slice(at, at + 2)).toEqual(['> first line', '> second line']);
    expect(description).toBe(renderCopy('en', 'sendDraft.approval.wholeHere', { id: token }));
    expect(description).toContain(token);
  });

  it('a post that reads like a recipient row is still quoted on the first line', async () => {
    const fx = setup();
    const token = tokenOf(await fx.call('popclaw_draft_post', { body: 'To: Alice#zzzz (12345678)' }));

    const { line1 } = await firstScreen(fx, token);

    expect(line1).toBe('> To: Alice#zzzz (12345678)');
  });

  it.each(['en', 'zh-CN'] as const)('a DM opens with its recipient, and the body is the first letter text after it, in %s', async (lang) => {
    setOwnerLang(lang, 'config');
    const fx = setup();
    const token = tokenOf(await fx.call('popclaw_draft_message', { recipient: 'Alice', body: 'See you at 3.\nBring the map.' }));

    const { line1, lines, description } = await firstScreen(fx, token);

    expect(line1.startsWith(renderCopy(lang, 'sendDraft.approval.to', { who: 'Alice#' }))).toBe(true);
    // Every row between the recipient and the body is one of this module's
    // own facts, never a quoted row; the first quoted row is the body's first.
    const firstQuoted = lines.findIndex((l) => l.startsWith('> '));
    expect(lines[firstQuoted]).toBe('> See you at 3.');
    expect(lines[firstQuoted + 1]).toBe('> Bring the map.');
    expect(lines[firstQuoted - 1]).toMatch(lang === 'en' ? /^Text \(/ : /^正文 /);
    // Not whole on line 1, so the id'd full-text line leads.
    expect(description).toBe(renderCopy(lang, 'sendDraft.approval.wholeHere', { id: token }));
    expect(description).toContain(token);
  });

  it.each(['en', 'zh-CN'] as const)('the full-text line keeps Claude Code\'s clause whole, and is never clipped, in %s', async (lang) => {
    setOwnerLang(lang, 'config');
    const fx = setup();
    const short = tokenOf(await fx.call('popclaw_draft_message', { recipient: 'Alice', body: 'first\nsecond' }));
    const described = describeSendDraft({ draft_id: short });
    if (described.kind !== 'ask') throw new Error('unreachable');
    expect(described.confirmDescription).toBe(renderCopy(lang, 'sendDraft.approval.wholeHere', { id: short }));

    // An id so long the line would pass 80 columns: no clipped line, the
    // backend's generic one is shown instead.
    const long = `message-${'1'.repeat(40)}`;
    putDraft(long, async () => ({ text: 'sent' }), peekDraftSnapshot(short)!);
    expect(displayWidth(renderCopy(lang, 'sendDraft.approval.wholeHere', { id: long }))).toBeGreaterThan(CONFIRM_DESCRIPTION_COLUMNS);
    const clipped = describeSendDraft({ draft_id: long });
    if (clipped.kind !== 'ask') throw new Error('unreachable');
    expect(clipped.confirmDescription).toBeUndefined();
  });

  const KINDS = [
    { kind: 'post', tool: 'popclaw_draft_post', params: { body: 'x' } },
    { kind: 'reply', tool: 'popclaw_draft_reply', params: { platform: 'x', post_id: 'p1', body: 'x' } },
    { kind: 'dm', tool: 'popclaw_draft_message', params: { recipient: 'Alice', body: 'x' } },
    { kind: 'feedback', tool: 'popclaw_feedback', params: { kind: 'need', body: 'x' } },
  ] as const;
  it.each((['en', 'zh-CN'] as const).flatMap((lang) => KINDS.map((k) => ({ ...k, lang }))))(
    'the box says, by kind, what ticking it means and what Accept does: $kind, $lang', async ({ kind, tool, params, lang }) => {
      setOwnerLang(lang, 'config');
      const fx = setup();
      const token = tokenOf(await fx.call(tool, params));

      const { label } = await firstScreen(fx, token);

      expect(label).toBe(renderCopy(lang, `sendDraft.approval.confirm.${kind}` as never));
      expect(label).toContain('Accept');
      expect([...label].length).toBeLessThanOrEqual(64);
      // Four different sentences: no kind borrows another's verb.
      const all = KINDS.map((k) => renderCopy(lang, `sendDraft.approval.confirm.${k.kind}` as never));
      expect(new Set(all).size).toBe(4);
    });

  it.each(['en', 'zh-CN'] as const)('a post that reads like a DM is told apart from one by the box, in %s', async (lang) => {
    setOwnerLang(lang, 'config');
    const fx = setup();
    const post = tokenOf(await fx.call('popclaw_draft_post', { body: 'To: Alice here is my home address' }));
    const dm = tokenOf(await fx.call('popclaw_draft_message', { recipient: 'Alice', body: 'here is my home address' }));

    const asPost = await firstScreen(fx, post);
    const asDm = await firstScreen(fx, dm);

    expect(asPost.line1).toBe('> To: Alice here is my home address');
    expect(asDm.line1.startsWith(renderCopy(lang, 'sendDraft.approval.to', { who: 'Alice#' }))).toBe(true);
    expect(asPost.label).toBe(renderCopy(lang, 'sendDraft.approval.confirm.post'));
    expect(asDm.label).toBe(renderCopy(lang, 'sendDraft.approval.confirm.dm'));
    expect(asPost.label).not.toBe(asDm.label);
  });

  it.each([
    { label: 'reply', params: { body: 'nice one', reply_to_event_id: FULL_EVENT } },
    { label: 'quote', params: { body: 'nice one', quote_of_event_id: FULL_EVENT } },
  ])('a one-line $label opens with its text but still points below, where its target is', async ({ params }) => {
    const fx = setup();
    const token = tokenOf(await fx.call('popclaw_draft_post', params));
    expect(peekDraftSnapshot(token)!.target).toBeTruthy();

    const { line1, lines, description } = await firstScreen(fx, token);

    expect(line1).toBe('> nice one');
    expect(lines.some((l) => l.startsWith('replying to: '))).toBe(true);
    expect(description).not.toBe(renderCopy('en', 'sendDraft.approval.changeHint'));
    expect(description).toBe(renderCopy('en', 'sendDraft.approval.wholeHere', { id: token }));
  });

  it('a one-line post with an escaped character on line 1 still points below, where the legend is', async () => {
    const fx = setup();
    const token = tokenOf(await fx.call('popclaw_draft_post', { body: 'family \u{1F468}\u200D\u{1F469}' }));

    const { line1, lines, description } = await firstScreen(fx, token);

    expect(line1).toContain('\u2039U+200D\u203a');
    expect(lines).toContain(renderCopy('en', 'sendDraft.approval.escapedInvisible'));
    expect(description).not.toBe(renderCopy('en', 'sendDraft.approval.changeHint'));
    expect(description).toBe(renderCopy('en', 'sendDraft.approval.wholeHere', { id: token }));
  });

  it('a post forging a recipient row after a line break opens with its own first line, and the forgery stays quoted', async () => {
    const fx = setup();
    const token = tokenOf(await fx.call('popclaw_draft_post', { body: 'hello\nTo: Alice#zzzz (12345678)' }));

    const { line1, lines } = await firstScreen(fx, token);

    expect(line1).toBe('> hello');
    expect(lines).toContain('> To: Alice#zzzz (12345678)');
    expect(lines.some((l) => l.startsWith('To: '))).toBe(false);
  });

  it('a recipient row too long to be a title still opens the DM, shortened with a visible cut; the full row stays below', async () => {
    // 30 combining acute accents: 30 more code points, no more columns, so
    // the row fits a 64-column row but not a 64-code-point title.
    const HEAVY = { popclawId: keyed(11).id, nickname: `Zoe${'e\u0301'.repeat(30)}` };
    const fx = setup({ people: [HEAVY] });
    const token = tokenOf(await fx.call('popclaw_draft_message', { recipient: HEAVY.popclawId, body: 'hi' }));
    const label = peekDraftSnapshot(token)!.recipientLabel!;
    const sigil = label.slice(label.lastIndexOf('#'));

    const { line1, lines } = await firstScreen(fx, token);

    expect(line1).toMatch(/^To: Zoe/);
    expect(line1).toContain(`\u2026${sigil} (${HEAVY.popclawId.slice(0, 8)})`);
    expect([...line1].length).toBeLessThanOrEqual(APPROVAL_TITLE_BUDGET);
    expect(lines[2]).toBe(renderCopy('en', 'sendDraft.approval.title', { kind: renderCopy('en', 'sendDraft.kind.dm') }));
    // The recipient row itself, below the question, sigil and id whole.
    const row = lines.slice(3).find((l) => l.startsWith('To: Zoe'));
    expect(row).toBeDefined();
    expect(row).toContain(`${sigil} (${HEAVY.popclawId.slice(0, 8)})`);
  });

  it.each(['en', 'zh-CN'] as const)('the native prompt keeps its composed title and rows, in %s', async (lang) => {
    setOwnerLang(lang, 'config');
    setOwnerApprovalSurface(true);
    const fx = setup();
    const post = tokenOf(await fx.call('popclaw_draft_post', { body: 'a thought' }));
    const dm = tokenOf(await fx.call('popclaw_draft_message', { recipient: 'Alice', body: 'hi' }));

    const ask = async (token: string) => (await ownerApprovalBeforeToolCall(
      { toolName: SEND_DRAFT_TOOL, params: { draft_id: token }, toolCallId: `native-${token}` },
      { toolCallId: `native-${token}`, requester: { channel: 'tui', senderId: 'owner-fixture', senderIsOwner: true } },
    ))!.requireApproval;
    const asPost = await ask(post);
    const asDm = await ask(dm);

    expect(asPost.title).toBe(renderCopy(lang, 'sendDraft.approval.title', { kind: renderCopy(lang, 'sendDraft.kind.post') }));
    expect(asDm.title).toBe(renderCopy(lang, 'sendDraft.approval.title', { kind: renderCopy(lang, 'sendDraft.kind.dm') }));
    expect(asPost.description.split('\n')[0]).toBe(renderCopy(lang, 'sendDraft.approval.draftId', { id: post }));
    expect(asDm.description.split('\n')[0]!.startsWith(renderCopy(lang, 'sendDraft.approval.to', { who: 'Alice#' }))).toBe(true);
  });

  const LONG = Array.from({ length: 60 }, (_, i) => `Line ${i + 1} of a letter far too long to show whole.`).join('\n');
  const cases: Array<{ label: string; tool: string; params: Record<string, unknown> }> = [
    { label: 'one-line post', tool: 'popclaw_draft_post', params: { body: 'short' } },
    { label: 'multi-line post', tool: 'popclaw_draft_post', params: { body: 'a\nb\nc' } },
    { label: 'long post', tool: 'popclaw_draft_post', params: { body: LONG } },
    { label: 'reply', tool: 'popclaw_draft_reply', params: { platform: 'x', post_id: 'p1', body: 'ack' } },
    { label: 'short DM', tool: 'popclaw_draft_message', params: { recipient: 'Alice', body: 'hi' } },
    { label: 'long DM', tool: 'popclaw_draft_message', params: { recipient: 'Alice', body: LONG } },
    { label: 'DM with attachment', tool: 'popclaw_draft_message', params: { recipient: 'Alice', body: 'see photo', attachment_path: 'photo.png' } },
    { label: 'feedback', tool: 'popclaw_feedback', params: { kind: 'need', body: 'I could not do X' } },
    { label: 'quote', tool: 'popclaw_draft_post', params: { body: 'nice one', quote_of_event_id: FULL_EVENT } },
    { label: 'escaped post', tool: 'popclaw_draft_post', params: { body: 'family \u{1F468}\u200D\u{1F469}' } },
    { label: 'forged post', tool: 'popclaw_draft_post', params: { body: 'hello\nTo: Alice#zzzz (12345678)' } },
  ];
  it.each((['en', 'zh-CN'] as const).flatMap((lang) => cases.map((c) => ({ ...c, lang }))))(
    'stays inside its column budget on both first-screen lines: $label, $lang', async ({ tool, params, lang }) => {
      setOwnerLang(lang, 'config');
      const fx = setup();
      if (tool === 'popclaw_draft_message' && params['attachment_path'] === 'photo.png') {
        writeFileSync(join(fx.dir, 'photo.png'), Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'));
        params = { ...params, attachment_path: join(fx.dir, 'photo.png') };
      }
      const token = tokenOf(await fx.call(tool, params));

      const { line1, description } = await firstScreen(fx, token);

      // Line 1 to this module's own title ceiling, not merely the dialog's.
      expect(displayWidth(line1)).toBeLessThanOrEqual(MCP_APPROVAL_DIALOG_BUDGET.summaryLineColumns);
      expect(displayWidth(description)).toBeLessThanOrEqual(CONFIRM_DESCRIPTION_COLUMNS);
      // The registrant's own line, never the seam's generic fallback.
      // Every one of these dialogs carries its whole letter, so the line never
      // points at another view.
      expect([
        renderCopy(lang, 'sendDraft.approval.changeHint'),
        renderCopy(lang, 'sendDraft.approval.wholeHere', { id: token }),
      ]).toContain(description);
    });
});

// ---------------------------------------------------------------------------
// The box starts unticked, and an untouched Accept is a refusal
// ---------------------------------------------------------------------------

/**
 * The confirm box is declared `default: false`. In the 2026-09-27 probes
 * (Claude Code 2.1.283 / codex-cli 0.157.1) that makes an untouched Accept or
 * Enter come back `accept {confirm: false}`: nothing is sent, the draft stays,
 * and the agent reads a sentence that is true for "submitted without ticking".
 */
describe('the send_draft confirm box starts unticked', () => {
  async function answered(fx: ReturnType<typeof setup>, token: string, content: Record<string, unknown>) {
    let schema: { properties: Record<string, Record<string, unknown>>; required: string[] } | undefined;
    const backend = createMcpOwnerApproval({
      server: { current: {
        getClientCapabilities: () => ({ elicitation: { form: {} } }),
        getClientVersion: () => ({ name: 'codex-mcp-client', version: '0.157.1' }),
        elicitInput: async (params: unknown) => {
          schema = (params as { requestedSchema: typeof schema }).requestedSchema;
          return { action: 'accept', content };
        },
      } as never },
    });
    const callRef = backend.callRef({ requestId: `unticked-${token}` });
    const out = await backend.aroundDispatch(SEND_DRAFT_TOOL, { draft_id: token }, callRef, undefined,
      () => fx.call('popclaw_send_draft', { draft_id: token }, callRef));
    backend.stop();
    return { schema: schema!, out };
  }

  it('declares default false on the one required boolean, and no default true anywhere', async () => {
    const fx = setup();
    const token = tokenOf(await fx.call('popclaw_draft_post', { body: 'x' }));

    const { schema } = await answered(fx, token, { confirm: false });

    expect(Object.keys(schema.properties)).toEqual(['confirm']);
    expect(schema.properties['confirm']!['type']).toBe('boolean');
    expect(schema.properties['confirm']!['default']).toBe(false);
    expect(schema.required).toEqual(['confirm']);
    expect(JSON.stringify(schema)).not.toMatch(/"default":\s*true/);
  });

  it.each(['en', 'zh-CN'] as const)('an Accept without a tick sends nothing, keeps the draft, and says so, in %s', async (lang) => {
    setOwnerLang(lang, 'config');
    const fx = setup();
    const token = tokenOf(await fx.call('popclaw_draft_message', { recipient: 'Alice', body: 'hello' }));

    const { out } = await answered(fx, token, { confirm: false });

    expect(fx.pushed).toHaveLength(0);
    expect(peekDraftSnapshot(token)).not.toBeNull();
    expect(out.text).toBe(renderCopy(lang, 'sendDraft.refused.denied'));
    // True for this case: it names submitting without ticking, not only a no.
    expect(out.text).toContain(lang === 'en' ? 'without ticking' : '没勾选');
  });

  it('an Accept with the box ticked sends exactly once', async () => {
    const fx = setup();
    const token = tokenOf(await fx.call('popclaw_draft_message', { recipient: 'Alice', body: 'hello' }));

    const { out } = await answered(fx, token, { confirm: true });

    expect(out.text).not.toMatch(/Not sent/);
    expect(fx.pushed).toHaveLength(1);
    expect(peekDraftSnapshot(token)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The MCP dialog carries the whole frozen draft (F1, 2026-09-27)
// ---------------------------------------------------------------------------

/**
 * A 975-character DM reached Codex desktop as its first line, `［……］` and its
 * last sentence, and the owner could not read what they were asked to
 * approve. The abbreviation was ours: the MCP dialog was composed to the
 * native OpenClaw budget (496 code points, 32 rows). The MCP backend now asks
 * for the whole draft — recipient, every attachment, the body verbatim under
 * the visible-escape rules — and refuses by name when the rendered preview
 * is over its display budget (a resource budget for the preview, not a claim
 * about what any host renders). The native budget and layouts are untouched.
 */
describe('the MCP dialog carries the whole draft', () => {
  const fixture = (name: string): string =>
    fileURLToPath(new URL(`../../fixtures/send-draft/${name}`, import.meta.url));
  /** The R06 template with the R2 run id on its first line — the 975-character
   *  letter the Codex desktop owner could not read (run
   *  CODEX-MAC-D2-0-34E8281-20260927-R2). */
  const LETTER = ['CODEX-MAC-D2-0-34E8281-20260927-R2',
    ...readFileSync(fixture('r06-long-letter.txt'), 'utf8').split('\n').slice(1)].join('\n').trimEnd();
  const ATTACHMENT = fixture('R06-ATTACHMENT.txt');
  const KEN = { popclawId: keyed(9).id, nickname: '样例CEO收信' };
  const HOUSE = '127-0-0-1-8112';
  const ABBREVIATIONS = ['［……］', '[…]', '[……]'];

  type Answer = { action: string; content?: Record<string, unknown> } | 'window';
  /** The MCP backend exactly as the root builds it, over a client that
   *  captures the `elicitInput` request it is sent. */
  async function overMcp(fx: ReturnType<typeof setup>, token: string,
    answer: Answer = { action: 'accept', content: { confirm: true } }) {
    const requests: Array<{ message: string; requestedSchema: { properties: Record<string, unknown> } }> = [];
    const elicitInput = vi.fn(async (params: unknown, options?: { signal?: AbortSignal }) => {
      requests.push(params as (typeof requests)[number]);
      if (answer !== 'window') return answer;
      // Never answered: our own window closes on it.
      return await new Promise<never>((_, reject) => {
        options?.signal?.addEventListener('abort', () => reject(options.signal!.reason));
      });
    });
    const backend = createMcpOwnerApproval({
      server: { current: {
        getClientCapabilities: () => ({ elicitation: { form: {} } }),
        getClientVersion: () => ({ name: 'codex-mcp-client', version: '0.155.0-alpha' }),
        elicitInput,
      } as never },
      logger: { warn: () => {} },
      ...(answer === 'window' ? { elicitTimeoutMs: 20 } : {}),
    });
    const callRef = backend.callRef({ requestId: `whole-${token}` });
    const out = await backend.aroundDispatch(SEND_DRAFT_TOOL, { draft_id: token }, callRef, undefined,
      () => fx.call('popclaw_send_draft', { draft_id: token }, callRef));
    backend.stop();
    return { requests, elicitInput, out };
  }

  /** The body as the dialog must render it: every line break a row boundary,
   *  every character of the seam's invisible class (and the introducer
   *  itself) as its visible token. Built here, independently of the module. */
  const escapedLines = (body: string): string[] => body.split('\n').map((line) =>
    [...line].map((ch) => (hasInvisibleCharacter(ch) || ch === '‹'
      ? `‹U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}›` : ch)).join(''));

  /**
   * THE WHOLE BODY, ROW BY ROW. After the body label every row is a quoted
   * body row and nothing else; walking them in order, each line of the letter
   * is exactly the concatenation of a run of consecutive rows (a line wider
   * than a row wraps onto more rows, and nothing is dropped or reordered),
   * and the last line ends on the last row of the message. The label row is
   * the label alone: no preview note, since an MCP root never pushes one.
   */
  function expectWholeBody(lines: readonly string[], body: string, lang: Lang): void {
    const label = renderCopy(lang, 'sendDraft.approval.bodyWhole', { chars: String([...body].length) });
    const at = lines.indexOf(label);
    expect(at, 'no whole-text label row, alone').toBeGreaterThan(0);
    for (const note of ['sendDraft.approval.notPreviewed', 'sendDraft.approval.previewedAt'] as const) {
      expect(lines.join('\n')).not.toContain(renderCopy(lang, note, { when: '' }).trim());
    }
    // Trusted-header isolation: nothing quoted above the label, only quoted
    // rows below it.
    expect(lines.slice(1, at).some((l) => l.startsWith('> '))).toBe(false);
    const rows = lines.slice(at + 1);
    for (const row of rows) expect(row.startsWith('> '), `unquoted row after the label: ${row}`).toBe(true);
    let i = 0;
    for (const line of escapedLines(body)) {
      let acc = rows[i++]!.slice(2);
      while (acc !== line) {
        expect(line.startsWith(acc) && i < rows.length, `row ${i} does not continue the line: ${line}`).toBe(true);
        acc += rows[i++]!.slice(2);
      }
    }
    expect(i, 'rows left over after the last line of the letter').toBe(rows.length);
  }

  it('is the letter the Codex desktop owner could not read: 975 characters, CJK, emoji and line breaks', () => {
    expect([...LETTER]).toHaveLength(975);
    expect(LETTER).toContain('🙂');
    expect(LETTER.split('\n').length).toBeGreaterThan(20);
  });

  it.each(['en', 'zh-CN'] as const)('sends the 975-character DM whole, row by row, with its recipient, in %s', async (lang) => {
    setOwnerLang(lang, 'config');
    const fx = setup({ house: HOUSE, people: [KEN] });
    const token = tokenOf(await fx.call('popclaw_draft_message', { recipient: KEN.popclawId, body: LETTER }));

    const { requests, out } = await overMcp(fx, token);

    expect(requests).toHaveLength(1);
    const { message } = requests[0]!;
    const lines = message.split('\n');
    // The recipient is the first line, by name and id.
    expect(lines[0]!.startsWith(renderCopy(lang, 'sendDraft.approval.to', { who: `${KEN.nickname}#` }))).toBe(true);
    expect(lines[0]!.endsWith(`(${KEN.popclawId.slice(0, 8)})`)).toBe(true);
    expect(lines).toContain(renderCopy(lang, 'sendDraft.approval.draftId', { id: token }));
    expectWholeBody(lines, LETTER, lang);
    for (const mark of ABBREVIATIONS) expect(message).not.toContain(mark);
    expect(message).not.toContain(renderCopy(lang, 'sendDraft.approval.bodyInToolOutput'));
    expect(fx.pushed).toHaveLength(1);
    expect(out.text).not.toMatch(/Not sent|没有发出/);
  });

  it.each(['en', 'zh-CN'] as const)('sends a DM with an attachment whole: recipient, every attachment and the body, in %s', async (lang) => {
    setOwnerLang(lang, 'config');
    const fx = setup({ house: HOUSE, people: [KEN] });
    const token = tokenOf(await fx.call('popclaw_draft_message', {
      recipient: KEN.popclawId, body: LETTER, attachment_path: ATTACHMENT,
    }));
    const { attachments } = peekDraftSnapshot(token)!;
    expect(attachments.length).toBeGreaterThan(0);

    const { requests } = await overMcp(fx, token);

    const { message } = requests[0]!;
    const lines = message.split('\n');
    expect(lines[0]!.startsWith(renderCopy(lang, 'sendDraft.approval.to', { who: `${KEN.nickname}#` }))).toBe(true);
    expect(lines[0]!.endsWith(`(${KEN.popclawId.slice(0, 8)})`)).toBe(true);
    expect(message).toContain(HOUSE);
    // Every attachment, by name and size, on a trusted row above the body.
    const label = lines.findIndex((l) => l.startsWith(renderCopy(lang, 'sendDraft.approval.bodyWhole', { chars: '975' })));
    for (const a of attachments) {
      const row = lines.findIndex((l) => l.includes(`${a.name} (${kb(a.bytes.length)})`));
      expect(row, `attachment ${a.name} not shown`).toBeGreaterThan(0);
      expect(row).toBeLessThan(label);
      expect(lines[row]!.startsWith('> ')).toBe(false);
    }
    expectWholeBody(lines, LETTER, lang);
    for (const mark of ABBREVIATIONS) expect(message).not.toContain(mark);
    expect(fx.pushed).toHaveLength(1);
  });

  it('escapes an invisible character in the body and still shows the whole letter', async () => {
    const fx = setup({ house: HOUSE, people: [KEN] });
    const body = `${LETTER} \u{1f469}‍\u{1f4bb}`;
    const token = tokenOf(await fx.call('popclaw_draft_message', { recipient: KEN.popclawId, body }));

    const { requests } = await overMcp(fx, token);

    const lines = requests[0]!.message.split('\n');
    expect(lines).toContain(renderCopy('en', 'sendDraft.approval.escapedInvisible'));
    expectWholeBody(lines, body, 'en');
  });

  it('is never handed an abbreviated layout, not even as an unused alternative', async () => {
    const fx = setup({ house: HOUSE, people: [KEN] });
    const token = tokenOf(await fx.call('popclaw_draft_message', { recipient: KEN.popclawId, body: LETTER }));
    noteDraftPreview(token, 'preview text', 'unknown');

    const whole = describeSendDraft({ draft_id: token }, MCP_APPROVAL_PROFILE);
    if (whole.kind !== 'ask') throw new Error('unreachable');
    expect(whole.folded).toBeUndefined();
    for (const mark of ABBREVIATIONS) expect(whole.description.join('\n')).not.toContain(mark);
    // The same draft, natively, is still abbreviated exactly as before.
    const native = describeSendDraft({ draft_id: token });
    if (native.kind !== 'ask') throw new Error('unreachable');
    expect(native.description.join('\n')).toContain('[…]');
  });

  it('takes its budget from the backend: nothing in the call parameters widens the native prompt', async () => {
    setOwnerApprovalSurface(true);
    const fx = setup({ house: HOUSE, people: [KEN] });
    const token = tokenOf(await fx.call('popclaw_draft_message', { recipient: KEN.popclawId, body: LETTER }));
    const params = { draft_id: token, budget: MCP_APPROVAL_DISPLAY_BUDGET, wholeTextOnly: true, descriptionMax: 1e9 };

    const native = (await ownerApprovalBeforeToolCall(
      { toolName: SEND_DRAFT_TOOL, params, toolCallId: 'native-budget' },
      { toolCallId: 'native-budget', requester: { channel: 'tui', senderId: 'owner-fixture', senderIsOwner: true } },
    ))!.requireApproval;

    expect([...native.description].length).toBeLessThanOrEqual(APPROVAL_DESCRIPTION_BUDGET);
    expect(native.description).toContain('[…]');
  });

  it.each([
    { label: 'accept with the box ticked', answer: { action: 'accept', content: { confirm: true } }, sends: true },
    { label: 'accept without the tick', answer: { action: 'accept', content: { confirm: false } }, sends: false },
    { label: 'decline', answer: { action: 'decline' }, sends: false },
    { label: 'cancel', answer: { action: 'cancel' }, sends: false },
    { label: 'the window closing', answer: 'window' as const, sends: false },
  ])('keeps the authorization boundary on the whole-text dialog: $label', async ({ answer, sends }) => {
    const fx = setup({ house: HOUSE, people: [KEN] });
    const token = tokenOf(await fx.call('popclaw_draft_message', {
      recipient: KEN.popclawId, body: LETTER, attachment_path: ATTACHMENT,
    }));

    const { elicitInput, out } = await overMcp(fx, token, answer as Answer);

    expect(elicitInput).toHaveBeenCalledTimes(1);
    if (sends) {
      expect(fx.pushed).toHaveLength(1);
      expect(recipientOf(fx.pushed[0]!)).toBe(KEN.popclawId);
      // One-shot: the draft is spent, and a second send asks again and sends nothing.
      expect(peekDraftSnapshot(token)).toBeNull();
      await overMcp(fx, token);
      expect(fx.pushed).toHaveLength(1);
    } else {
      expect(out.text).toMatch(/Not sent/);
      expect(fx.pushed).toHaveLength(0);
      expect(peekDraftSnapshot(token), 'the draft must survive').not.toBeNull();
    }
  });

  /** A draft whose body is `body`, sent through the MCP backend. */
  async function withBody(body: string) {
    const fx = setup({ house: HOUSE, people: [KEN] });
    const token = tokenOf(await fx.call('popclaw_draft_message', { recipient: KEN.popclawId, body: 'placeholder' }));
    putDraft(token, async () => ({ text: 'sent' }), { ...peekDraftSnapshot(token)!, body });
    return { fx, ...(await overMcp(fx, token)) };
  }
  const utf8 = (text: string): number => new TextEncoder().encode(text).length;

  it('refuses by name, and asks nothing, when the preview is over the display budget', async () => {
    const { fx, elicitInput, out } = await withBody('a'.repeat(MCP_APPROVAL_DISPLAY_BUDGET_BYTES + 1));

    expect(elicitInput).not.toHaveBeenCalled();
    expect(out.text).toContain(renderCopy('en', 'sendDraft.refused.previewOverBudget'));
    expect(out.text).toContain('SUBJECT_REFUSED/APPROVAL_PREVIEW_OVER_DISPLAY_BUDGET');
    expect(fx.pushed).toHaveLength(0);
  });

  /**
   * THE CONTRAST. The display budget is on the RENDERED preview, not the
   * letter: a `> ` prefix and a row break per line triple this body, whose
   * envelope is legal. It is refused by the preview's name, sends nothing, is
   * never offered an excerpt or two-ends layout instead — even with a
   * delivered preview and the draft tool's output both there, which is what
   * licenses those layouts natively — and the copy never calls the letter
   * invalid or oversized.
   */
  it('refuses a legal-envelope body whose rendered preview is over budget, without abbreviating it', async () => {
    const body = `${'a\n'.repeat(450_000)}end`;
    expect(utf8(body)).toBeLessThan(L_ENVELOPE_MAX_BYTES);
    const fx = setup({ house: HOUSE, people: [KEN] });
    const token = tokenOf(await fx.call('popclaw_draft_message', { recipient: KEN.popclawId, body: 'placeholder' }));
    putDraft(token, async () => ({ text: 'sent' }), { ...peekDraftSnapshot(token)!, body });
    noteDraftPreview(token, 'preview text', 'unknown');
    expect(peekDraftSnapshot(token)!.output).not.toBeNull();

    const described = describeSendDraft({ draft_id: token }, MCP_APPROVAL_PROFILE);
    expect(described).toEqual({ kind: 'refuse', reason: 'APPROVAL_PREVIEW_OVER_DISPLAY_BUDGET' });
    const { elicitInput, out } = await overMcp(fx, token);

    expect(elicitInput).not.toHaveBeenCalled();
    expect(out.text).toContain('SUBJECT_REFUSED/APPROVAL_PREVIEW_OVER_DISPLAY_BUDGET');
    expect(out.text).not.toMatch(/envelope|invalid|Shorten/i);
    expect(fx.pushed).toHaveLength(0);
    expect(peekDraftSnapshot(token), 'the draft must survive').not.toBeNull();
    // Natively the same draft is still abbreviated as before.
    const native = describeSendDraft({ draft_id: token });
    expect(native.kind).toBe('ask');
  });

  /** THE BUDGET'S OWN UNIT. It is in bytes; a CJK character is three of
   *  them. Counted in code points, this preview would pass at a third of its
   *  real size. */
  it('counts the display budget in UTF-8 bytes: a CJK preview just over it is refused', async () => {
    const body = '字'.repeat(Math.floor(MCP_APPROVAL_DISPLAY_BUDGET_BYTES / 3) + 1);
    expect(utf8(body)).toBeGreaterThan(MCP_APPROVAL_DISPLAY_BUDGET_BYTES);
    expect([...body].length).toBeLessThan(MCP_APPROVAL_DISPLAY_BUDGET_BYTES / 2);

    const { fx, elicitInput, out } = await withBody(body);

    expect(elicitInput).not.toHaveBeenCalled();
    expect(out.text).toContain('SUBJECT_REFUSED/APPROVAL_PREVIEW_OVER_DISPLAY_BUDGET');
    expect(fx.pushed).toHaveLength(0);
  });

  it('and a CJK letter comfortably under it is still shown whole', async () => {
    const body = '字'.repeat(480_000);

    const { requests } = await withBody(body);

    expect(requests).toHaveLength(1);
    const rows = requests[0]!.message.split('\n').filter((l) => l.startsWith('> '));
    expect(rows.map((r) => r.slice(2)).join('')).toBe(body);
  });

  it('holds the rendered preview to a 1 572 864-byte display budget, with its row limit named', () => {
    expect(MCP_APPROVAL_DISPLAY_BUDGET_BYTES).toBe(1_572_864);
    expect(MCP_APPROVAL_DISPLAY_BUDGET).toEqual({
      descriptionMax: MCP_APPROVAL_DISPLAY_BUDGET_BYTES, unit: 'utf8Bytes', maxLines: MCP_APPROVAL_MAX_ROWS,
    });
  });

  /** Rows joined back: a header row and the continuation rows under it. */
  const unwrapped = (lines: readonly string[]): string[] => lines.reduce<string[]>((acc, line) => {
    if (line.startsWith('\u21aa ') && acc.length > 0) acc[acc.length - 1] += line.slice(2);
    else acc.push(line);
    return acc;
  }, []);
  const WHATSAPP = 'WhatsApp Image 2026-09-27 at 10.15.32 (1).jpeg';
  const jpeg = Buffer.concat([Buffer.from('ffd8ffe000104a46494600', 'hex'), Buffer.alloc(64, 1)]);

  it.each(['en', 'zh-CN'] as const)('wraps the WhatsApp default filename instead of refusing a short DM, in %s', async (lang) => {
    setOwnerLang(lang, 'config');
    const fx = setup({ house: HOUSE, people: [KEN] });
    const file = join(fx.dir, WHATSAPP);
    writeFileSync(file, jpeg);
    const token = tokenOf(await fx.call('popclaw_draft_message', {
      recipient: KEN.popclawId, body: 'Photo from today.\nSee you soon.', attachment_path: file,
    }));

    const { requests, out } = await overMcp(fx, token);

    expect(requests).toHaveLength(1);
    const lines = requests[0]!.message.split('\n');
    // The filename crosses the row width, so it continues on a marked row…
    expect(lines.some((l) => l.startsWith('\u21aa '))).toBe(true);
    for (const l of lines) expect(displayWidth(l)).toBeLessThanOrEqual(MCP_APPROVAL_DIALOG_BUDGET.fieldDescriptionColumns);
    // …and joined back, the full name and size are there, on a trusted row.
    const row = unwrapped(lines).find((l) => l.includes(`${WHATSAPP} (`));
    expect(row, 'full filename not visible').toBeDefined();
    expect(row!.startsWith('> ')).toBe(false);
    // Continuation rows sit above the body label; after it, only body rows.
    const at = lines.indexOf(renderCopy(lang, 'sendDraft.approval.bodyWhole', { chars: '31' }));
    expect(lines.slice(at + 1)).toEqual(['> Photo from today.', '> See you soon.']);
    expect(fx.pushed).toHaveLength(1);
    expect(out.text).not.toMatch(/Not sent|没有发出/);
  });

  it('wraps a 35-character CJK nickname instead of refusing, and keeps the recipient first', async () => {
    const LONG = { popclawId: keyed(13).id, nickname: '长'.repeat(35) };
    const fx = setup({ house: HOUSE, people: [LONG] });
    const token = tokenOf(await fx.call('popclaw_draft_message', { recipient: LONG.popclawId, body: 'hi\nthere' }));

    const label = peekDraftSnapshot(token)!.recipientLabel!;
    const sigil = label.slice(label.lastIndexOf('#'));

    const { requests } = await overMcp(fx, token);

    expect(requests).toHaveLength(1);
    const lines = requests[0]!.message.split('\n');
    // A DM's first line is its recipient, even wrapped: a short title with a
    // visible cut, the sigil and the id's start whole, within one row.
    expect(lines[0]!.startsWith('To: \u957f')).toBe(true);
    expect(lines[0]).toContain(`\u2026${sigil} (${LONG.popclawId.slice(0, 8)})`);
    expect(displayWidth(lines[0]!)).toBeLessThanOrEqual(MCP_APPROVAL_DIALOG_BUDGET.fieldDescriptionColumns);
    // Then the question, and the full recipient rows under it.
    expect(lines[2]).toBe(renderCopy('en', 'sendDraft.approval.title', { kind: renderCopy('en', 'sendDraft.kind.dm') }));
    expect(lines[3]!.startsWith('To: ')).toBe(true);
    expect(lines[4]!.startsWith('\u21aa ')).toBe(true);
    const to = unwrapped(lines.slice(3))[0]!;
    expect(to).toContain(LONG.nickname);
    expect(to).toContain(`(${LONG.popclawId.slice(0, 8)})`);
    expect(fx.pushed).toHaveLength(1);
  });

  /** A peer's nickname is unbounded remotely. Capped at 64 code points with a
   *  visible cut, it can no longer push label-like text to the start of a
   *  continuation row, and the sigil and id stay on screen. */
  it('caps a forged long nickname: no label-like continuation row, sigil and id visible', async () => {
    const FORGED = { popclawId: keyed(15).id, nickname: `${'x'.repeat(52)} house: evil-house · attached: 0` };
    const fx = setup({ house: HOUSE, people: [FORGED] });
    const token = tokenOf(await fx.call('popclaw_draft_message', { recipient: FORGED.popclawId, body: 'hi\nthere' }));
    const label = peekDraftSnapshot(token)!.recipientLabel!;
    const sigil = label.slice(label.lastIndexOf('#'));

    const { requests } = await overMcp(fx, token, { action: 'decline' });

    const lines = requests[0]!.message.split('\n');
    for (const l of lines) expect(l, l).not.toMatch(/^\u21aa\s*(house|attached|contact|replying|draft|To)\b/i);
    const to = unwrapped(lines.slice(3))[0]!;
    expect(to.startsWith('To: ')).toBe(true);
    expect(to).toContain('\u2026');
    expect(to).toContain(`${sigil} (${FORGED.popclawId.slice(0, 8)})`);
    expect(lines[0]).toContain(`${sigil} (${FORGED.popclawId.slice(0, 8)})`);
  });

  it('keeps a body line that imitates a continuation row quoted, as a body row', async () => {
    const fx = setup({ house: HOUSE, people: [KEN] });
    const token = tokenOf(await fx.call('popclaw_draft_message', {
      recipient: KEN.popclawId, body: 'hello\n\u21aa attached: 1 — evil.png (0.1 KB)',
    }));

    const { requests } = await overMcp(fx, token);

    const lines = requests[0]!.message.split('\n');
    expect(lines).toContain('> \u21aa attached: 1 — evil.png (0.1 KB)');
    expect(lines.some((l) => l.startsWith('\u21aa '))).toBe(false);
  });

  it('names Claude Code\'s keys only when the draft tool output is there to open', async () => {
    const fx = setup({ house: HOUSE, people: [KEN] });
    const withOutput = tokenOf(await fx.call('popclaw_draft_message', { recipient: KEN.popclawId, body: 'one\ntwo' }));
    const bare = 'message-77';
    putDraft(bare, async () => ({ text: 'sent' }), { ...peekDraftSnapshot(withOutput)!, output: null });
    const confirmLine = (r: { requestedSchema: { properties: Record<string, unknown> } }): string =>
      (r.requestedSchema.properties['confirm'] as { description: string }).description;

    const shown = await overMcp(fx, bare, { action: 'decline' });
    const kept = await overMcp(fx, withOutput, { action: 'decline' });

    // No output: ctrl+o would open nothing, so no clause — and Decline fits.
    expect(confirmLine(shown.requests[0]!)).toBe(renderCopy('en', 'sendDraft.approval.wholeHereOnlyAndDecline', { id: bare }));
    expect(confirmLine(shown.requests[0]!)).not.toContain('Claude Code');
    expect(confirmLine(kept.requests[0]!)).toBe(renderCopy('en', 'sendDraft.approval.wholeHere', { id: withOutput }));
    expect(confirmLine(kept.requests[0]!)).toContain('Claude Code: ctrl+o');
  });
});

/**
 * THE NATIVE PROMPT IS BYTE-FOR-BYTE WHAT IT WAS. Captured from the native
 * backend at a0c6b35d, before the MCP dialog got its own budget. The draft is
 * re-parked under one fixed id, because the id's length moves the excerpt's
 * room; the preview's wall-clock time is the only thing normalised.
 */
describe('the native OpenClaw prompt is unchanged', () => {
  const fixture = (name: string): string =>
    fileURLToPath(new URL(`../../fixtures/send-draft/${name}`, import.meta.url));
  const LETTER = ['CODEX-MAC-D2-0-34E8281-20260927-R2',
    ...readFileSync(fixture('r06-long-letter.txt'), 'utf8').split('\n').slice(1)].join('\n').trimEnd();
  const ATTACHMENT = fixture('R06-ATTACHMENT.txt');
  const KEN = { popclawId: keyed(9).id, nickname: '样例CEO收信' };
  const HOUSE = '127-0-0-1-8112';

  async function nativePrompt(params: Record<string, unknown>, preview = false,
    who: { popclawId: string; nickname: string } = KEN, file?: { name: string; bytes: Buffer }): Promise<string> {
    setOwnerApprovalSurface(true);
    const fx = setup({ house: HOUSE, people: [who] });
    if (file) {
      writeFileSync(join(fx.dir, file.name), file.bytes);
      params = { ...params, attachment_path: join(fx.dir, file.name) };
    }
    const drafted = tokenOf(await fx.call('popclaw_draft_message', { recipient: who.popclawId, ...params }));
    if (preview) noteDraftPreview(drafted, 'preview text', 'unknown');
    const token = 'message-42';
    putDraft(token, async () => ({ text: 'sent' }), peekDraftSnapshot(drafted)!);
    const request = (await ownerApprovalBeforeToolCall(
      { toolName: SEND_DRAFT_TOOL, params: { draft_id: token }, toolCallId: `native-${token}` },
      { toolCallId: `native-${token}`, requester: { channel: 'tui', senderId: 'owner-fixture', senderIsOwner: true } },
    ))!.requireApproval;
    return `${request.title}\n--\n${request.description}`.replace(/\d{2}:\d{2}/g, '<hm>');
  }

  it.each(['en', 'zh-CN'] as const)('a short DM, in %s', async (lang) => {
    setOwnerLang(lang, 'config');
    expect(await nativePrompt({ body: 'See you at 3.\nBring the map.' })).toMatchSnapshot();
  });
  it.each(['en', 'zh-CN'] as const)('the 975-character DM, in %s', async (lang) => {
    setOwnerLang(lang, 'config');
    expect(await nativePrompt({ body: LETTER })).toMatchSnapshot();
  });
  it.each(['en', 'zh-CN'] as const)('the 975-character DM with an attachment, in %s', async (lang) => {
    setOwnerLang(lang, 'config');
    expect(await nativePrompt({ body: LETTER, attachment_path: ATTACHMENT })).toMatchSnapshot();
  });
  it.each(['en', 'zh-CN'] as const)('the 975-character DM with a delivered preview, in %s', async (lang) => {
    setOwnerLang(lang, 'config');
    expect(await nativePrompt({ body: LETTER }, true)).toMatchSnapshot();
  });

  // NEW CASES, not in the a0c6b35d set: there these were refused for a header
  // row too wide (DRAFT_DESCRIPTION_TOO_LONG). Now the row wraps, and the
  // native budget of 496 code points still bounds the whole.
  const WHATSAPP = 'WhatsApp Image 2026-09-27 at 10.15.32 (1).jpeg';
  const jpeg = Buffer.concat([Buffer.from('ffd8ffe000104a46494600', 'hex'), Buffer.alloc(64, 1)]);
  it.each(['en', 'zh-CN'] as const)('a short DM with the WhatsApp default filename wraps it, in %s', async (lang) => {
    setOwnerLang(lang, 'config');
    const prompt = await nativePrompt({ body: 'Photo from today.\nSee you soon.' }, false, KEN, { name: WHATSAPP, bytes: jpeg });
    const joined = prompt.replace(/\n\u21aa /g, '');
    expect(joined).toContain(`${WHATSAPP} (`);
    expect(prompt).toContain('\n\u21aa ');
    expect([...prompt.split('\n--\n')[1]!].length).toBeLessThanOrEqual(APPROVAL_DESCRIPTION_BUDGET);
    expect(prompt).toMatchSnapshot();
  });
  it.each(['en', 'zh-CN'] as const)('a short DM to a 35-character CJK nickname wraps it, in %s', async (lang) => {
    setOwnerLang(lang, 'config');
    const LONG = { popclawId: keyed(13).id, nickname: '长'.repeat(35) };
    const prompt = await nativePrompt({ body: 'hi\nthere' }, false, LONG);
    expect(prompt.replace(/\n\u21aa /g, '')).toContain(LONG.nickname);
    expect(prompt).toMatchSnapshot();
  });
});

// ---------------------------------------------------------------------------
// A long draft's review copy, then a compact dialog (F1 fallback, 2026-09-28)
// ---------------------------------------------------------------------------

/**
 * The whole-text MCP dialog failed on the Codex desktop app (it opened at
 * paragraph three and could not scroll back). On the MCP root a draft too
 * long for a compact dialog now gets a read-only review copy under the data
 * root, a link line in the draft tool's result, and a compact dialog that
 * names the copy. Short drafts and the native root are unchanged.
 */
describe('a long draft gets a review copy and a compact dialog on the MCP root', () => {
  const fixture = (name: string): string =>
    fileURLToPath(new URL(`../../fixtures/send-draft/${name}`, import.meta.url));
  const LETTER = ['CODEX-MAC-D2-1-REVIEW',
    ...readFileSync(fixture('r06-long-letter.txt'), 'utf8').split('\n').slice(1)].join('\n').trimEnd();
  const ATTACHMENT = fixture('R06-ATTACHMENT.txt');
  const KEN_KEYS = keyed(9);
  const KEN = { popclawId: KEN_KEYS.id, nickname: '样例CEO收信' };
  const HOUSE = '127-0-0-1-8112';

  type Answer = { action: string; content?: Record<string, unknown> } | 'window';
  async function overMcp(fx: ReturnType<typeof setup>, token: string,
    answer: Answer = { action: 'accept', content: { confirm: true } }) {
    const requests: Array<{ message: string; requestedSchema: { properties: Record<string, { description?: string }> } }> = [];
    const elicitInput = vi.fn(async (params: unknown, options?: { signal?: AbortSignal }) => {
      requests.push(params as (typeof requests)[number]);
      if (answer !== 'window') return answer;
      return await new Promise<never>((_, reject) => {
        options?.signal?.addEventListener('abort', () => reject(options.signal!.reason));
      });
    });
    const backend = createMcpOwnerApproval({
      server: { current: {
        getClientCapabilities: () => ({ elicitation: { form: {} } }),
        getClientVersion: () => ({ name: 'codex-mcp-client', version: '0.155.0-alpha' }),
        elicitInput,
      } as never },
      logger: { warn: () => {} },
      ...(answer === 'window' ? { elicitTimeoutMs: 20 } : {}),
    });
    const callRef = backend.callRef({ requestId: `review-${token}-${requests.length}-${Math.random()}` });
    const out = await backend.aroundDispatch(SEND_DRAFT_TOOL, { draft_id: token }, callRef, undefined,
      () => fx.call('popclaw_send_draft', { draft_id: token }, callRef));
    backend.stop();
    return { requests, elicitInput, out };
  }
  const reviewOf = (token: string) => peekDraftSnapshot(token)!.review!;
  const linkPath = (text: string): string | null => /\]\((\/[^)\s]+|<[^>]+>)\)\s*$/.exec(text)?.[1]?.replace(/^<|>$/g, '') ?? null;
  const unwrapped = (message: string): string => message.replace(/\n↪ /g, '');
  const dmText = (bytes: Uint8Array): string => {
    const signed = popclaw.identity.SignedPayload.decode(bytes);
    const dm = popclaw.event.EventEnvelope.decode(signed.payload).directMessage!;
    const opened = KEN_KEYS.signer.openDm({ ciphertext: dm.ciphertext, nonce: dm.nonce }, OWNER.id) as { ok: boolean; plaintext?: string };
    expect(opened.ok).toBe(true);
    return opened.plaintext!;
  };

  /** Lines outside fenced code blocks, CommonMark-style: a backtick fence
   *  closes only on a run at least as long as the one that opened it. */
  function outsideFences(md: string): { outside: string[]; fences: Array<{ fence: number; body: string[] }> } {
    const outside: string[] = [];
    const fences: Array<{ fence: number; body: string[] }> = [];
    let open: { fence: number; body: string[] } | null = null;
    for (const line of md.split('\n')) {
      if (open) {
        const close = /^ {0,3}(`+)\s*$/.exec(line);
        if (close && close[1]!.length >= open.fence) { fences.push(open); open = null; } else open.body.push(line);
        continue;
      }
      const start = /^ {0,3}(`{3,})([^`]*)$/.exec(line);
      if (start) { open = { fence: start[1]!.length, body: [] }; continue; }
      outside.push(line);
    }
    expect(open, 'a fence was left open').toBeNull();
    return { outside, fences };
  }

  async function draftLong(fx: ReturnType<typeof setup>, body = LETTER, extra: Record<string, unknown> = {}) {
    const drafted = await fx.call('popclaw_draft_message', { recipient: KEN.popclawId, body, ...extra });
    return { token: tokenOf(drafted), text: drafted.text };
  }

  it('writes the copy from the frozen snapshot: every body line verbatim, the header correct', async () => {
    const fx = setup({ house: HOUSE, people: [KEN], review: true });
    const { token } = await draftLong(fx, LETTER, { attachment_path: ATTACHMENT });
    const snapshot = peekDraftSnapshot(token)!;
    const review = reviewOf(token);
    expect(review.needed).toBe(true);
    const md = readFileSync(review.file!.path, 'utf8');

    expect(md).toBe(renderReviewCopy(snapshot, token, 'en'));
    const { outside, fences } = outsideFences(md);
    const [header, body] = fences;
    expect(body!.body.join('\n')).toBe(LETTER);
    expect(header!.body).toEqual([
      `draft: ${token}`,
      `to: ${snapshot.recipientLabel} (${KEN.popclawId.slice(0, 8)})`,
      `house: ${HOUSE}`,
      'attachments: ',
      `  - R06-ATTACHMENT.txt (0.2 KB, digest ${draftDigest(snapshot.attachments[0]!.bytes)})`,
      `text: ${[...LETTER].length} chars, digest ${draftDigest(LETTER)}`,
    ]);
    expect(outside.filter((l) => l.trim() !== '')).toEqual([
      renderCopy('en', 'draft.review.file.heading'),
      renderCopy('en', 'draft.review.file.bodyLabel'),
      renderCopy('en', 'draft.review.file.end', { id: token }),
    ]);
    // What the approval binds: this file's hash, recorded at write.
    expect(sendDraftApprovalSubject.canonicalize({ draft_id: token })).toContain(review.file!.sha256);
  });

  it('renders nothing untrusted: hostile Markdown in the body or the header stays inside fences', async () => {
    const HOSTILE = { popclawId: keyed(21).id, nickname: 'Eve`](http://evil.invalid)<img src=x>' };
    const fx = setup({ house: 'house](http://evil.invalid) `x`', people: [HOSTILE], review: true });
    const file = join(fx.dir, 'a ```b``` ![p](evil.invalid) <img>.png');
    writeFileSync(file, png(1, 64));
    const body = [
      'opening line', '```', 'inside a fence the body opened', '````', '~~~', '<details><summary>hidden</summary>text</details>',
      '![x](http://evil.invalid/t.png)', '[x](http://evil.invalid)', '# heading', '``````````', ...Array.from({ length: 40 }, (_, i) => `filler ${i}`),
    ].join('\n');
    const drafted = await fx.call('popclaw_draft_message', { recipient: HOSTILE.popclawId, body, attachment_path: file });
    const md = readFileSync(reviewOf(tokenOf(drafted)).file!.path, 'utf8');

    const { outside, fences } = outsideFences(md);
    // Two fences, and each is longer than any backtick run inside it.
    expect(fences).toHaveLength(2);
    for (const f of fences) expect(f.fence).toBeGreaterThan(Math.max(0, ...[...f.body.join('\n').matchAll(/`+/g)].map((m) => m[0].length)));
    expect(fences[1]!.body.join('\n')).toBe(body);
    // Outside the fences: only this module's own lines — no link, image or HTML.
    for (const line of outside) expect(line).not.toMatch(/\]\(|<[a-z]|!\[|evil/i);
    expect(fenceFor('a ```` b')).toBe('`````');
  });

  it('keeps the directory 0700 and the file 0600', async () => {
    const fx = setup({ house: HOUSE, people: [KEN], review: true });
    const { token } = await draftLong(fx);
    const path = reviewOf(token).file!.path;
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(fx.dir, 'review')).mode & 0o777).toBe(0o700);
  });

  it('hands the agent a link line with the absolute path, last in the tool result', async () => {
    const fx = setup({ house: HOUSE, people: [KEN], review: true });
    const { token, text } = await draftLong(fx);
    const path = reviewOf(token).file!.path;
    expect(path.startsWith('/')).toBe(true);
    expect(text.trimEnd().split('\n').at(-1)).toBe(`[Review draft ${token} — full text](${path})`);
    expect(text).toContain('Post the next line to the owner exactly as written');
    expect(linkPath(text)).toBe(path);
    // A path with spaces takes CommonMark's angle-bracket form.
    expect(reviewLink('message-1', '/a b/c.md', 'en')).toBe('[Review draft message-1 — full text](</a b/c.md>)');
  });

  it.each(['en', 'zh-CN'] as const)('asks compactly: id, digest, file and path, the opening row, no full text and no ctrl+o, in %s', async (lang) => {
    setOwnerLang(lang, 'config');
    const fx = setup({ house: HOUSE, people: [KEN], review: true });
    const { token } = await draftLong(fx, LETTER, { attachment_path: ATTACHMENT });
    const review = reviewOf(token);
    const digest8 = draftDigest(LETTER).slice(0, 8);

    const { requests } = await overMcp(fx, token, { action: 'decline' });

    const { message } = requests[0]!;
    const lines = message.split('\n');
    expect(lines[0]!.startsWith(renderCopy(lang, 'sendDraft.approval.to', { who: `${KEN.nickname}#` }))).toBe(true);
    expect(message).toContain(HOUSE);
    expect(message).toContain('R06-ATTACHMENT.txt (0.2 KB)');
    expect(lines).toContain(renderCopy(lang, 'sendDraft.approval.draftId', { id: token }));
    expect(lines).toContain(renderCopy(lang, 'sendDraft.approval.reviewDigest', { digest: digest8, name: review.file!.name }));
    expect(unwrapped(message)).toContain(renderCopy(lang, 'sendDraft.approval.reviewPath', { path: review.file!.path }));
    for (const l of lines) expect(displayWidth(l)).toBeLessThanOrEqual(MCP_APPROVAL_DIALOG_BUDGET.fieldDescriptionColumns);
    // The opening row only, then nothing: after the label, one body row.
    const label = lines.indexOf(renderCopy(lang, 'sendDraft.approval.bodyOpening', { chars: String([...LETTER].length) }));
    expect(lines.slice(label + 1)).toEqual([`> ${LETTER.split('\n')[0]}`]);
    expect(message).not.toContain(LETTER.split('\n').at(-1)!);
    expect(message).not.toContain('ctrl+o');
    const confirm = requests[0]!.requestedSchema.properties['confirm']!.description!;
    expect(confirm).toBe(renderCopy(lang, 'sendDraft.approval.reviewHint', { id: token, digest: digest8 }));
    expect(confirm).not.toContain('Claude Code');
    expect(displayWidth(confirm)).toBeLessThanOrEqual(CONFIRM_DESCRIPTION_COLUMNS);
  });

  it.each([
    { label: 'accept with the box ticked', answer: { action: 'accept', content: { confirm: true } }, sends: true },
    { label: 'accept without the tick', answer: { action: 'accept', content: { confirm: false } }, sends: false },
    { label: 'decline', answer: { action: 'decline' }, sends: false },
    { label: 'cancel', answer: { action: 'cancel' }, sends: false },
    { label: 'the window closing', answer: 'window' as const, sends: false },
  ])('keeps the authorization boundary on the compact dialog: $label', async ({ answer, sends }) => {
    const fx = setup({ house: HOUSE, people: [KEN], review: true });
    const { token } = await draftLong(fx);
    const path = reviewOf(token).file!.path;

    const { elicitInput } = await overMcp(fx, token, answer as Answer);

    expect(elicitInput).toHaveBeenCalledTimes(1);
    if (sends) {
      expect(fx.pushed).toHaveLength(1);
      expect(dmText(fx.pushed[0]!)).toBe(LETTER);
      expect(existsSync(path), 'sent: the copy goes with the draft').toBe(false);
    } else {
      expect(fx.pushed).toHaveLength(0);
      expect(existsSync(path), 'not sent: the copy stays until the TTL').toBe(true);
    }
  });

  it.each(['edited', 'deleted'] as const)('refuses before asking when the copy was %s, and sends nothing', async (how) => {
    const fx = setup({ house: HOUSE, people: [KEN], review: true });
    const { token } = await draftLong(fx);
    const path = reviewOf(token).file!.path;
    if (how === 'edited') writeFileSync(path, readFileSync(path, 'utf8').replace('REVIEW', 'REVIEWED'));
    else rmSync(path);

    const { out, elicitInput } = await overMcp(fx, token);

    // Refused before the owner is asked: no approval spent on a dead draft.
    expect(elicitInput).not.toHaveBeenCalled();
    expect(fx.pushed).toHaveLength(0);
    expect(out.text).toContain(renderCopy('en', 'sendDraft.refused.reviewCopyChanged'));
    expect(out.text).toContain('SUBJECT_REFUSED/REVIEW_COPY_CHANGED_OR_MISSING');
    expect(peekDraftSnapshot(token), 'the draft is kept').not.toBeNull();
  });

  /** The file is never the source: edited, it is refused; restored to the
   *  written bytes, the send carries the snapshot's text — and the text a
   *  forger put into the file never goes anywhere. */
  it('sends the snapshot, never the file: an edit is refused, and the letter that goes is the frozen one', async () => {
    const fx = setup({ house: HOUSE, people: [KEN], review: true });
    const { token } = await draftLong(fx);
    const path = reviewOf(token).file!.path;
    const written = readFileSync(path);
    writeFileSync(path, written.toString('utf8').replace('测试结束', 'FORGED-TEXT'));
    await overMcp(fx, token);
    expect(fx.pushed).toHaveLength(0);

    writeFileSync(path, written);
    await overMcp(fx, token);

    expect(fx.pushed).toHaveLength(1);
    expect(dmText(fx.pushed[0]!)).toBe(LETTER);
    expect(dmText(fx.pushed[0]!)).not.toContain('FORGED-TEXT');
  });

  it('never attaches the copy: the outgoing message carries only the draft\'s own attachments', async () => {
    const fx = setup({ house: HOUSE, people: [KEN], review: true });
    const { token } = await draftLong(fx);
    expect(peekDraftSnapshot(token)!.attachments).toEqual([]);

    await overMcp(fx, token);

    const dm = popclaw.event.EventEnvelope.decode(popclaw.identity.SignedPayload.decode(fx.pushed[0]!).payload).directMessage!;
    expect(dm.mediaCiphertext?.length ?? 0).toBe(0);
  });

  it('removes the copy when the draft expires or is evicted, and at the next start', async () => {
    const fx = setup({ house: HOUSE, people: [KEN], review: true });
    const expired = reviewOf((await draftLong(fx)).token).file!.path;
    vi.useFakeTimers({ now: Date.now() + DRAFT_TTL_MS + 1000, toFake: ['Date'] });
    try {
      peekDraftSnapshot('message-0');
      expect(existsSync(expired), 'expired: gone').toBe(false);
    } finally { vi.useRealTimers(); }

    const first = await draftLong(fx);
    const firstPath = reviewOf(first.token).file!.path;
    for (let i = 0; i < 16; i++) await fx.call('popclaw_draft_message', { recipient: KEN.popclawId, body: `short ${i}` });
    expect(peekDraftSnapshot(first.token)).toBeNull();
    expect(existsSync(firstPath), 'evicted: gone').toBe(false);

    // A new process: files older than a draft can live are cleared; a young
    // one (another root's live draft) is kept.
    const dir = join(fx.dir, 'review');
    writeFileSync(join(dir, 'message-1-old.md'), 'x');
    writeFileSync(join(dir, 'message-2-young.md'), 'y');
    const past = new Date(Date.now() - DRAFT_TTL_MS - 60_000);
    utimesSync(join(dir, 'message-1-old.md'), past, past);
    createDraftReviewFiles(dir, { staleAfterMs: DRAFT_TTL_MS });
    expect(existsSync(join(dir, 'message-1-old.md'))).toBe(false);
    expect(existsSync(join(dir, 'message-2-young.md'))).toBe(true);
  });

  /**
   * ONE PREDICATE, BOTH SIDES. For every kind of draft, the file exists
   * exactly when the dialog is compact — never a file without the compact
   * dialog, nor the reverse.
   */
  it('gives every draft both a file and the compact dialog, or neither', async () => {
    const fx = setup({ house: HOUSE, people: [KEN], review: true });
    const file = join(fx.dir, 'p.png');
    writeFileSync(file, png(2, 64));
    const drafts = [
      await fx.call('popclaw_draft_message', { recipient: KEN.popclawId, body: 'short' }),
      await fx.call('popclaw_draft_message', { recipient: KEN.popclawId, body: 'm'.repeat(250) }),
      await fx.call('popclaw_draft_message', { recipient: KEN.popclawId, attachment_path: file }),
      await fx.call('popclaw_draft_message', { recipient: KEN.popclawId, body: LETTER }),
      await fx.call('popclaw_draft_post', { body: 'a post' }),
      await fx.call('popclaw_draft_post', { body: LETTER }),
      await fx.call('popclaw_feedback', { kind: 'need', body: LETTER }),
    ].map(tokenOf);
    const seen: boolean[] = [];
    for (const token of drafts) {
      const review = reviewOf(token);
      const hasFile = review.file !== null && existsSync(review.file.path);
      const { requests } = await overMcp(fx, token, { action: 'decline' });
      expect(requests, `${token} was not asked`).toHaveLength(1);
      const compact = requests[0]!.message.includes('text digest: ');
      expect(compact, `${token}: file ${hasFile}, compact ${compact}`).toBe(hasFile);
      expect(review.needed).toBe(hasFile);
      seen.push(hasFile);
    }
    expect(seen).toContain(true);
    expect(seen).toContain(false);
  });

  it('leaves the native root alone: no file, no link, the same prompt', async () => {
    setOwnerApprovalSurface(true);
    const fx = setup({ house: HOUSE, people: [KEN] });
    const { token, text } = await draftLong(fx);
    expect(peekDraftSnapshot(token)!.review).toBeUndefined();
    expect(text).not.toContain('Review draft');
    expect(text).not.toContain('](/');
    const request = (await ownerApprovalBeforeToolCall(
      { toolName: SEND_DRAFT_TOOL, params: { draft_id: token }, toolCallId: 'native-review' },
      { toolCallId: 'native-review', requester: { channel: 'tui', senderId: 'owner-fixture', senderIsOwner: true } },
    ))!.requireApproval;
    expect(request.description).not.toContain('review');
  });

  it('keeps a short draft on the MCP root exactly as before: no file, the whole letter in the dialog', async () => {
    const fx = setup({ house: HOUSE, people: [KEN], review: true });
    const { token, text } = await draftLong(fx, 'Short and whole.');
    expect(reviewOf(token)).toEqual({ needed: false, lang: 'en', file: null });
    expect(text).not.toContain('Review draft');
    const { requests } = await overMcp(fx, token, { action: 'decline' });
    expect(requests[0]!.message.split('\n')).toContain('> Short and whole.');
    expect(requests[0]!.message).toContain('in full:');
  });
});

describe('a review copy that changes after the owner is asked, or never existed', () => {
  const fixture = (name: string): string =>
    fileURLToPath(new URL(`../../fixtures/send-draft/${name}`, import.meta.url));
  const LETTER = readFileSync(fixture('r06-long-letter.txt'), 'utf8').trimEnd();
  const KEN = { popclawId: keyed(9).id, nickname: '样例CEO收信' };

  function mcpBackend(onAsk: () => void) {
    const elicitInput = vi.fn(async () => { onAsk(); return { action: 'accept', content: { confirm: true } }; });
    const backend = createMcpOwnerApproval({
      server: { current: {
        getClientCapabilities: () => ({ elicitation: { form: {} } }),
        getClientVersion: () => ({ name: 'codex-mcp-client', version: '0' }),
        elicitInput,
      } as never },
      logger: { warn: () => {} },
    });
    return { backend, elicitInput };
  }
  async function send(fx: ReturnType<typeof setup>, token: string, onAsk: () => void = () => {}) {
    const { backend, elicitInput } = mcpBackend(onAsk);
    const callRef = backend.callRef({ requestId: `late-${token}-${Math.random()}` });
    const out = await backend.aroundDispatch(SEND_DRAFT_TOOL, { draft_id: token }, callRef, undefined,
      () => fx.call('popclaw_send_draft', { draft_id: token }, callRef));
    backend.stop();
    return { out, elicitInput };
  }

  /** Changed WHILE the dialog was open: the pre-ask check passed, so only the
   *  re-hash after approval can catch it — and it does. */
  it('re-checks after approval: a copy edited while the dialog was open is refused, nothing sent', async () => {
    const fx = setup({ people: [KEN], review: true });
    const token = tokenOf(await fx.call('popclaw_draft_message', { recipient: KEN.popclawId, body: LETTER }));
    const path = peekDraftSnapshot(token)!.review!.file!.path;

    const { out, elicitInput } = await send(fx, token, () => writeFileSync(path, 'edited during the dialog'));

    expect(elicitInput).toHaveBeenCalledTimes(1);
    expect(out.text).toContain('SUBJECT_REFUSED/REVIEW_COPY_CHANGED_OR_MISSING');
    expect(fx.pushed).toHaveLength(0);
  });

  it('names a copy that could not be written, refuses before asking, and sends nothing', async () => {
    const files = createDraftReviewFiles(join(mkdtempSync(join(tmpdir(), 'review-fail-')), 'review'), { staleAfterMs: DRAFT_TTL_MS });
    const failing: DraftReviewFiles = { ...files, write: () => { throw new Error('ENOSPC'); } };
    const fx = setup({ people: [KEN], review: failing });
    const drafted = await fx.call('popclaw_draft_message', { recipient: KEN.popclawId, body: LETTER });
    const token = tokenOf(drafted);
    expect(drafted.text).toContain(renderCopy('en', 'draft.review.writeFailed'));
    expect(peekDraftSnapshot(token)!.review).toEqual({ needed: true, lang: 'en', file: null, failed: 'write' });

    const { out, elicitInput } = await send(fx, token);

    expect(elicitInput).not.toHaveBeenCalled();
    expect(out.text).toContain(renderCopy('en', 'sendDraft.refused.reviewNotWritten'));
    expect(out.text).toContain('SUBJECT_REFUSED/REVIEW_COPY_NOT_WRITTEN');
    expect(out.text).not.toContain(renderCopy('en', 'sendDraft.refused.reviewCopyChanged'));
    expect(fx.pushed).toHaveLength(0);
  });

  /** A data root the owner named with an emoji (ZWJ), or with `<`: the
   *  review copy is not used, exactly as when its directory cannot be made.
   *  The long draft keeps the whole-text dialog and can be sent; the reason
   *  is logged, never shown to the owner as a refusal. */
  it.each([
    { label: 'a zero-width joiner', dir: 'review \u{1f469}‍\u{1f4bb}' },
    { label: 'an angle bracket', dir: 'review<x>' },
  ])('falls back to the whole-text dialog when the review path has $label, and logs why', async ({ dir }) => {
    const root = mkdtempSync(join(tmpdir(), 'review-path-'));
    const logged: string[] = [];
    const files = createDraftReviewFiles(join(root, dir), { staleAfterMs: DRAFT_TTL_MS, warn: (m) => logged.push(m) });
    const fx = setup({ people: [KEN], review: files });
    const drafted = await fx.call('popclaw_draft_message', { recipient: KEN.popclawId, body: LETTER });
    const token = tokenOf(drafted);
    expect(drafted.text).not.toContain('Review draft');
    expect(drafted.text).not.toContain('](');
    expect(peekDraftSnapshot(token)!.review).toBeUndefined();
    expect(readdirSync(join(root, dir))).toEqual([]);
    expect(logged.join('\n')).toContain('REVIEW_PATH_NOT_SHOWABLE');

    const { out, elicitInput } = await send(fx, token);
    const message = (elicitInput.mock.calls[0] as unknown as [{ message: string }])[0].message;

    expect(elicitInput).toHaveBeenCalledTimes(1);
    expect(message).toContain('in full:');
    expect(message).toContain(LETTER.split('\n').at(-1)!);
    expect(message).not.toContain('review file');
    expect(out.text).not.toMatch(/Not sent|REVIEW_PATH/);
    expect(fx.pushed).toHaveLength(1);
  });

  it('sweeps an orphan a previous process left, on the next write', async () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'review-orphan-')), 'review');
    let now = Date.now();
    const files = createDraftReviewFiles(dir, { staleAfterMs: DRAFT_TTL_MS, now: () => now });
    // Left by a process that died: not ours, and its draft is long gone.
    writeFileSync(join(dir, 'message-9-dead.md'), 'orphan');
    now += DRAFT_TTL_MS + 60_000;

    files.write('message-10-live.md', 'new');

    expect(existsSync(join(dir, 'message-9-dead.md'))).toBe(false);
    expect(existsSync(join(dir, 'message-10-live.md'))).toBe(true);
  });
});

describe('review presentation preserves the existing guard and send sequence', () => {
  it.each([
    { mode: 'absent', writes: 0, hashes: 0, asks: 1, sends: 1 },
    { mode: 'needed', writes: 1, hashes: 2, asks: 1, sends: 1 },
    { mode: 'not-needed', writes: 0, hashes: 0, asks: 1, sends: 1 },
    { mode: 'write-failed', writes: 1, hashes: 0, asks: 0, sends: 0 },
    { mode: 'changed-before-ask', writes: 1, hashes: 1, asks: 0, sends: 0 },
    { mode: 'changed-during-ask', writes: 1, hashes: 2, asks: 1, sends: 0 },
    { mode: 'denied', writes: 1, hashes: 1, asks: 1, sends: 0 },
  ])('$mode', async ({ mode, writes, hashes, asks, sends }) => {
    const fx = setup({ review: mode !== 'absent' });
    const write = fx.review ? vi.spyOn(fx.review, 'write') : null;
    const hash = fx.review ? vi.spyOn(fx.review, 'sha256') : null;
    if (mode === 'write-failed') write!.mockImplementation(() => { throw new Error('ENOSPC'); });
    const body = mode === 'not-needed' ? 'Short.' : 'Frozen draft body. '.repeat(80);
    const token = tokenOf(await fx.call('popclaw_draft_message', { recipient: 'Alice', body }));
    const file = peekDraftSnapshot(token)?.review?.file;
    if (mode === 'changed-before-ask') writeFileSync(file!.path, 'changed before asking');
    const elicitInput = vi.fn(async () => {
      if (mode === 'changed-during-ask') writeFileSync(file!.path, 'changed while awaiting approval');
      return mode === 'denied' ? { action: 'decline' } : { action: 'accept', content: { confirm: true } };
    });
    const backend = createMcpOwnerApproval({ server: { current: {
      getClientCapabilities: () => ({ elicitation: { form: {} } }),
      getClientVersion: () => ({ name: 'codex-mcp-client', version: 'fixture' }), elicitInput,
    } as never } });
    try {
      const params = { draft_id: token };
      await backend.aroundDispatch(SEND_DRAFT_TOOL, params, 'review-counts', undefined,
        () => fx.call(SEND_DRAFT_TOOL, params, 'review-counts'));
      expect(write?.mock.calls.length ?? 0).toBe(writes);
      expect(hash?.mock.calls.length ?? 0).toBe(hashes);
      expect(elicitInput).toHaveBeenCalledTimes(asks);
      expect(fx.pushed).toHaveLength(sends);
    } finally {
      backend.stop(); write?.mockRestore(); hash?.mockRestore();
      rmSync(fx.dir, { recursive: true, force: true });
    }
  });
});
