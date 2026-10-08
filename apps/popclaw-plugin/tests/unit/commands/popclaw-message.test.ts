import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { MasterKeySigner } from '../../../src/identity/master-key-signer.js';
import type { MasterKey } from '../../../src/identity/keystore.js';
import { runPopclawMessageCommand } from '../../../src/commands/popclaw-message.js';
import type { PushResult } from '../../../src/egress/event-egress.js';
import type { SocialLogEntry, SocialLogRecorder } from '../../../src/social-log/social-log.js';
import { DM_ENCRYPTED_BODY_PLACEHOLDER } from '../../../src/messaging/sign-message.js';
// D8: assert through the same renderer the command uses, never a literal.
import { kb } from '../../../src/messaging/dm-media.js';
import { renderCopy } from '../../../src/lexicon/index.js';
import { ownerLang } from '../../../src/lexicon/owner-language.js';
import { popclaw } from '@popclaw/contracts';
import { deriveSigil } from '../../../src/invite/sigil.js';

function makeSigner(seedByte = 1): MasterKeySigner {
  const seed = new Uint8Array(32);
  for (let i = 0; i < 32; i++) seed[i] = (i + seedByte) & 0xff;
  const kp = nacl.sign.keyPair.fromSeed(seed);
  const key: MasterKey = {
    seed,
    publicKey: kp.publicKey,
    secretKey: kp.secretKey,
    popclawId: bs58.encode(kp.publicKey),
  };
  return new MasterKeySigner(key);
}

describe('runPopclawMessageCommand', () => {
  it('signs + pushes a DirectMessage envelope', async () => {
    const signer = makeSigner();
    const recipient = makeSigner(99);
    const recipientId = await recipient.popclawId();
    const egress = { push: vi.fn().mockResolvedValue(undefined) };

    const out = await runPopclawMessageCommand(
      { positional: [recipientId, 'hey,', 'want', 'to', 'chat?'] },
      { signer, egress, nickname: 'TestNick' },
    );
    expect(out.text).toContain('Letter sent');
    expect(egress.push).toHaveBeenCalledTimes(1);

    const sentBytes = egress.push.mock.calls[0]![0] as Uint8Array;
    const sp = popclaw.identity.SignedPayload.decode(sentBytes);
    const env = popclaw.event.EventEnvelope.decode(sp.payload);
    expect(env.directMessage).toBeTruthy();
    expect(env.directMessage!.toPopclawId).toBe(recipientId);
    // #227: 正文只在密文里；field 4 只剩占位串，灯坊读不到一个字。
    expect(env.directMessage!.body).toBe(DM_ENCRYPTED_BODY_PLACEHOLDER);
    const opened = recipient.openDm(env.directMessage!, await signer.popclawId());
    expect(opened.ok && opened.plaintext).toBe('hey, want to chat?');
  });

  it('encrypts the exact manuscript including outer whitespace and blank lines', async () => {
    const signer = makeSigner(), recipient = makeSigner(99);
    const body = '  Original words.\n\nSecond paragraph.\ndraft_id: message-999  ';
    const egress = {push: vi.fn().mockResolvedValue({status: 200})};
    const result = await runPopclawMessageCommand({positional: [await recipient.popclawId(), body]}, {signer, egress, nickname: 'Owner'});
    const signed = popclaw.identity.SignedPayload.decode(egress.push.mock.calls[0]![0]);
    const dm = popclaw.event.EventEnvelope.decode(signed.payload).directMessage!;
    const opened = recipient.openDm(dm, await signer.popclawId());
    expect(opened.ok && opened.plaintext).toBe(body);
    expect(result.eventId).toBeTruthy();
    expect(result.text).not.toContain(result.eventId!);
    expect(result.text).not.toContain(body);
  });

  it('rejects "to" that does not look like a popclaw_id (and never points at reply)', async () => {
    const signer = makeSigner();
    const egress = { push: vi.fn() };
    const out = await runPopclawMessageCommand(
      { positional: ['paulg', 'hello'] },                  // X handle, not popclaw_id
      { signer, egress, nickname: 'TestNick' },
    );
    expect(out.text).toMatch(/popclaw_id/i);
    // 认人（ADR-0028 修订）：错误文案不再把主人赶去 /popclaw reply。
    expect(out.text).not.toMatch(/reply/i);
    expect(egress.push).not.toHaveBeenCalled();
  });

  it('人用形式（名号#印信）经解析器落到完整 popclaw_id 上签名', async () => {
    const signer = makeSigner();
    const recipient = makeSigner(99);
    const recipientId = await recipient.popclawId();
    const egress = { push: vi.fn().mockResolvedValue(undefined) };
    const resolveRecipient = vi.fn(async () => ({
      kind: 'resolved' as const,
      popclawId: recipientId,
      nickname: 'Blackfeather',
      sigil: '7t4k2n9q',
    }));

    const out = await runPopclawMessageCommand(
      { positional: ['Blackfeather#7t4k2n9q', 'hey'] },
      { signer, egress, nickname: 'TestNick', resolveRecipient },
    );

    expect(resolveRecipient).toHaveBeenCalledWith('Blackfeather#7t4k2n9q');
    const sentBytes = egress.push.mock.calls[0]![0] as Uint8Array;
    const sp = popclaw.identity.SignedPayload.decode(sentBytes);
    const env = popclaw.event.EventEnvelope.decode(sp.payload);
    expect(env.directMessage!.toPopclawId).toBe(recipientId);
    expect(out.text).toContain('Blackfeather#7t4k2n9q');
  });

  // Real host (abc3177): the approval dialog said `CanaryPeer-26e2#sigil`, the
  // receipt said only `#sigil` — the draft lane hands over a full id, and a
  // full id skipped naming entirely. The receipt names who the owner approved.
  it('a full id with an approved recipient: the receipt names them as the approval did', async () => {
    const signer = makeSigner();
    const recipient = makeSigner(99);
    const recipientId = await recipient.popclawId();
    const egress = { push: vi.fn().mockResolvedValue(undefined) };
    const out = await runPopclawMessageCommand(
      { positional: [recipientId, 'hi'] },
      {
        signer,
        egress,
        nickname: 'TestNick',
        approvedRecipient: { popclawId: recipientId, nickname: 'CanaryPeer-26e2', sigil: deriveSigil(recipientId) },
      },
    );
    expect(out.text).toContain(`CanaryPeer-26e2#${deriveSigil(recipientId)}`);
  });

  it('已解析出的收件人不再回头问灯坊核对（省一次往返，灯坊挂了也不挂假横幅）', async () => {
    const signer = makeSigner();
    const recipient = makeSigner(99);
    const recipientId = await recipient.popclawId();
    const egress = { push: vi.fn().mockResolvedValue(undefined) };
    const verifyRecipient = vi.fn(async () => ({ status: 'offline' as const, sigil: 'x' }));

    const out = await runPopclawMessageCommand(
      { positional: ['Blackfeather#7t4k2n9q', 'hey'] },
      {
        signer,
        egress,
        nickname: 'TestNick',
        verifyRecipient,
        resolveRecipient: async () => ({
          kind: 'resolved' as const,
          popclawId: recipientId,
          nickname: 'Blackfeather',
          sigil: '7t4k2n9q',
        }),
      },
    );

    expect(verifyRecipient).not.toHaveBeenCalled();
    expect(out.text).not.toContain('未能连灯坊核对');
    expect(egress.push).toHaveBeenCalledTimes(1);
  });

  it('完整 id + 灯坊认得 → 回执也给 名号#印信', async () => {
    const signer = makeSigner();
    const recipient = makeSigner(99);
    const recipientId = await recipient.popclawId();
    const egress = { push: vi.fn().mockResolvedValue(undefined) };
    const out = await runPopclawMessageCommand(
      { positional: [recipientId, 'hi'] },
      {
        signer,
        egress,
        nickname: 'TestNick',
        verifyRecipient: async () => ({ status: 'verified', nickname: 'Blackfeather', sigil: '7t4k2n9q' }),
      },
    );
    expect(out.text).toContain('Blackfeather#7t4k2n9q');
    expect(out.text).not.toContain(recipientId);
  });

  it('歧义 → 列候选、不发', async () => {
    const signer = makeSigner();
    const egress = { push: vi.fn() };
    const out = await runPopclawMessageCommand(
      { positional: ['白鹭', 'hey'] },
      {
        signer,
        egress,
        nickname: 'TestNick',
        resolveRecipient: async () => ({
          kind: 'ambiguous' as const,
          candidates: [
            { popclawId: 'ID1', nickname: 'Blackfeather', sigil: 'aaaaaaaa', profiles: [] },
            { popclawId: 'ID2', nickname: '白鹭小居士', sigil: 'bbbbbbbb', profiles: [] },
          ],
        }),
      },
    );
    expect(out.text).toContain('Blackfeather#aaaaaaaa');
    expect(out.text).toContain('ID2');
    expect(egress.push).not.toHaveBeenCalled();
  });

  it('查无此人 → 诚实说，不假装发出', async () => {
    const signer = makeSigner();
    const egress = { push: vi.fn() };
    const out = await runPopclawMessageCommand(
      { positional: ['张三', 'hey'] },
      {
        signer,
        egress,
        nickname: 'TestNick',
        resolveRecipient: async () => ({ kind: 'notFound' as const, ref: '张三' }),
      },
    );
    expect(out.text).toContain('张三');
    expect(out.text).not.toMatch(/reply/i);
    expect(egress.push).not.toHaveBeenCalled();
  });

  it('rejects sending to self', async () => {
    const signer = makeSigner();
    const myId = await signer.popclawId();
    const egress = { push: vi.fn() };
    const out = await runPopclawMessageCommand(
      { positional: [myId, 'note to self'] },
      { signer, egress, nickname: 'TestNick' },
    );
    // D8: through the same renderer the command uses. The sentence used to be
    // a hardcoded English literal; it is `person.thatIsYou` in both locales now
    // that the owner is resolvable by name and can reach this by accident.
    expect(out.text).toBe(renderCopy(ownerLang(), 'person.thatIsYou'));
    expect(egress.push).not.toHaveBeenCalled();
  });

  it('returns usage when args missing', async () => {
    const signer = makeSigner();
    const egress = { push: vi.fn() };
    const out = await runPopclawMessageCommand({ positional: [] }, { signer, egress, nickname: 'TestNick' });
    expect(out.text.toLowerCase()).toMatch(/usage/);
    expect(egress.push).not.toHaveBeenCalled();
  });

  it('warns but still sends when verifyRecipient says unknown (typo)', async () => {
    const signer = makeSigner();
    const recipient = makeSigner(99);
    const recipientId = await recipient.popclawId();
    const egress = { push: vi.fn().mockResolvedValue(undefined) };
    const out = await runPopclawMessageCommand(
      { positional: [recipientId, 'hi', 'there'] },
      {
        signer,
        egress,
        nickname: 'TestNick',
        verifyRecipient: async () => ({ status: 'unknown', sigil: 'abc123' }),
      },
    );
    expect(out.text).toContain(renderCopy(ownerLang(), 'message.recipientUnknown', { sigil: 'abc123' }));
    expect(out.text).toContain('abc123');
    expect(egress.push).toHaveBeenCalledTimes(1); // still sent
  });

  it('no warning when verifyRecipient says verified', async () => {
    const signer = makeSigner();
    const recipient = makeSigner(99);
    const recipientId = await recipient.popclawId();
    const egress = { push: vi.fn().mockResolvedValue(undefined) };
    const out = await runPopclawMessageCommand(
      { positional: [recipientId, 'hi'] },
      {
        signer,
        egress,
        nickname: 'TestNick',
        verifyRecipient: async () => ({ status: 'verified', nickname: 'n', sigil: 's' }),
      },
    );
    expect(out.text).not.toMatch(/可能打错了/);
    expect(out.text).toContain('Letter sent');
    expect(egress.push).toHaveBeenCalledTimes(1);
  });

  /**
   * A push the house REFUSED must not be reported as a letter that arrived.
   *
   * ServerPushEgress does not throw on a non-2xx — it returns the receipt with
   * that status on it (egress/server-push-egress.ts). This command used to
   * drop the receipt on the floor, so a rejected DM still printed
   * "✉️ sent DM … event_id: …" and still wrote `dm_sent` into the social log:
   * a success message worth nothing as evidence, and a log that records
   * letters nobody ever received. The relation producer already reads the
   * receipt it is handed (social-graph/relation-assembly.ts).
   */
  describe('a receipt the house refused', () => {
    class RecordingLog implements SocialLogRecorder {
      entries: SocialLogEntry[] = [];
      record(entry: SocialLogEntry): void { this.entries.push(entry); }
    }

    const send = async (result: PushResult) => {
      const signer = makeSigner();
      const recipient = makeSigner(99);
      const socialLog = new RecordingLog();
      const egress = { push: vi.fn().mockResolvedValue(result) };
      const out = await runPopclawMessageCommand(
        { positional: [await recipient.popclawId(), 'did', 'this', 'arrive?'] },
        { signer, egress, nickname: 'TestNick', socialLog },
      );
      return { out, egress, entries: socialLog.entries };
    };

    it.each([
      [{ status: 400, detail: 'to_popclaw_id is empty' } as PushResult],
      [{ status: 403 } as PushResult],
      [{ status: 503, detail: 'upstream unavailable' } as PushResult],
    ])('reports %j as a failure and writes no dm_sent row', async (result) => {
      const { out, egress, entries } = await send(result);
      // The letter was signed and offered — the push did happen.
      expect(egress.push).toHaveBeenCalledTimes(1);
      expect(out.text).not.toContain('Letter sent');
      expect(out.text).toContain(renderCopy(ownerLang(), 'message.notAccepted', {
        status: String(result.status),
        why: result.detail ? renderCopy(ownerLang(), 'message.notAccepted.reason', { detail: result.detail }) : '',
      }));
      expect(out.eventId).toBeUndefined();
      expect(entries).toEqual([]);
    });

    it('positive control: a 2xx receipt still reports sent and still logs dm_sent', async () => {
      const { out, egress, entries } = await send({ status: 202, eventId: 'accepted-event' });
      expect(egress.push).toHaveBeenCalledTimes(1);
      expect(out.text).toContain('Letter sent');
      expect(out.eventId).toBeTruthy();
      expect(entries.map((e) => e.kind)).toEqual(['dm_sent']);
    });
  });

  // #231：斜杠命令 `--image` 与 popclaw_draft_message 的 image_path 是同一条路。
  describe('--image', () => {
    function tmpImage(name: string, bytes: Uint8Array): string {
      const p = join(mkdtempSync(join(tmpdir(), 'popclaw-msg-img-')), name);
      writeFileSync(p, bytes);
      return p;
    }

    it('attaches the picture the recipient can open, and says so in the receipt', async () => {
      const signer = makeSigner();
      const recipient = makeSigner(99);
      const egress = { push: vi.fn().mockResolvedValue(undefined) };
      const bytes = new Uint8Array([0x47, 0x49, 0x46, 1, 2]);

      const out = await runPopclawMessageCommand(
        { positional: [await recipient.popclawId(), '看这个'], flags: { image: tmpImage('c.gif', bytes) } },
        { signer, egress, nickname: 'TestNick' },
      );
      expect(out.text).toContain('📎 Attachment: c.gif (' + kb(bytes.length) + ')');

      const sp = popclaw.identity.SignedPayload.decode(egress.push.mock.calls[0]![0] as Uint8Array);
      const dm = popclaw.event.EventEnvelope.decode(sp.payload).directMessage!;
      const opened = recipient.openDmMedia(
        { ciphertext: dm.mediaCiphertext, nonce: dm.mediaNonce },
        await signer.popclawId(),
      );
      expect(opened.ok && opened.mime).toBe('image/gif');
      expect(opened.ok && Array.from(opened.bytes)).toEqual(Array.from(bytes));
    });

    // 纯图无字（2026-07-29 真机）：微信里甩张表情包从来不用配字，「正文必填」
    // 是文字时代遗产。有图就够了。
    it('纯图无正文也能发出：收件人解出图，正文是空串', async () => {
      const signer = makeSigner();
      const recipient = makeSigner(99);
      const egress = { push: vi.fn().mockResolvedValue(undefined) };
      const bytes = new Uint8Array([0x47, 0x49, 0x46, 9, 9]);

      const out = await runPopclawMessageCommand(
        { positional: [await recipient.popclawId()], flags: { image: tmpImage('meme.gif', bytes) } },
        { signer, egress, nickname: 'TestNick' },
      );
      expect(out.text).toContain('Letter sent');
      expect(out.text).toContain('📎 Attachment: meme.gif (' + kb(bytes.length) + ')');
      expect(out.text.toLowerCase()).not.toMatch(/usage/);
      expect(egress.push).toHaveBeenCalledTimes(1);

      const sp = popclaw.identity.SignedPayload.decode(egress.push.mock.calls[0]![0] as Uint8Array);
      const payload = sp.payload;
      const dm = popclaw.event.EventEnvelope.decode(payload).directMessage!;
      // 灯坊零改动的依据：field 4 仍是占位串（非空）→ 「body 或 ciphertext 至少
      // 其一」那道闸照过；真正的空正文在密文里。
      expect(dm.body).toBe(DM_ENCRYPTED_BODY_PLACEHOLDER);
      const senderId = await signer.popclawId();
      expect(recipient.openDm(dm, senderId)).toMatchObject({ ok: true, plaintext: '' });
      const opened = recipient.openDmMedia(
        { ciphertext: dm.mediaCiphertext, nonce: dm.mediaNonce },
        senderId,
      );
      expect(opened.ok && Array.from(opened.bytes)).toEqual(Array.from(bytes));
      // prost 重编码 == 我们编的 → CID 不漂移（空正文没有引入 proto3 默认值）。
      const reencoded = popclaw.event.EventEnvelope.encode(
        popclaw.event.EventEnvelope.decode(payload),
      ).finish();
      expect(Array.from(reencoded)).toEqual(Array.from(payload));
    });

    it('正文与图都没有 → usage，egress 零调用', async () => {
      const signer = makeSigner();
      const recipient = makeSigner(99);
      const egress = { push: vi.fn() };
      const out = await runPopclawMessageCommand(
        { positional: [await recipient.popclawId()] },
        { signer, egress, nickname: 'TestNick' },
      );
      expect(out.text.toLowerCase()).toMatch(/usage/);
      expect(egress.push).not.toHaveBeenCalled();
    });

    // 防退化：带正文那条老路的 canonical bytes 一个字节都不许变。
    it('带正文的既有路径 canonical bytes 不变（prost 重编码逐字节相等）', async () => {
      const signer = makeSigner();
      const recipient = makeSigner(99);
      const egress = { push: vi.fn().mockResolvedValue(undefined) };
      await runPopclawMessageCommand(
        { positional: [await recipient.popclawId(), '看这个'], flags: { image: tmpImage('c.gif', new Uint8Array([0x47, 1])) } },
        { signer, egress, nickname: 'TestNick' },
      );
      const sp = popclaw.identity.SignedPayload.decode(egress.push.mock.calls[0]![0] as Uint8Array);
      const reencoded = popclaw.event.EventEnvelope.encode(
        popclaw.event.EventEnvelope.decode(sp.payload),
      ).finish();
      expect(Array.from(reencoded)).toEqual(Array.from(sp.payload));
    });

    it('refuses before touching egress when the picture is unusable', async () => {
      const signer = makeSigner();
      const recipient = makeSigner(99);
      const egress = { push: vi.fn() };
      for (const flags of [
        { image: '/definitely/not/here.png' },
        { image: tmpImage('x.heic', new Uint8Array([1])) },
      ]) {
        const out = await runPopclawMessageCommand(
          { positional: [await recipient.popclawId(), 'hi'], flags },
          { signer, egress, nickname: 'TestNick' },
        );
        expect(out.text).toMatch(/⚠️/);
        expect(out.text).not.toContain('Letter sent');
      }
      expect(egress.push).not.toHaveBeenCalled();
    });
  });
});
