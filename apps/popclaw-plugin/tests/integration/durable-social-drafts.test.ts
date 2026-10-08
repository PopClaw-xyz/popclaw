import {afterEach, describe, expect, it} from 'vitest';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {popclaw} from '@popclaw/contracts';
import {durableFixture, fixtureContext, fixtureKey} from '../helpers/durable-social-process.js';
import {draftToken} from '../helpers/draft-token.js';
import {decryptDmBody, decryptDmMedia} from '../../src/messaging/dm-crypto.js';
import {DurableSocialDrafts} from '../../src/tools/durable-social-drafts.js';
const roots: string[] = [];
const root = () => {const path = mkdtempSync(join(tmpdir(), 'popclaw-durable-test-')); roots.push(path); return path;};
afterEach(() => {for (const path of roots.splice(0)) rmSync(path, {recursive: true, force: true});});
const idOf = (text: string) => draftToken(text)!;
const eventIdOf = (text: string) => {
  try { return JSON.parse(text).event_id; }
  catch { return undefined; }
};
type Result = {result?: {text: string}; error?: string; effects: Array<{house: string; bytes: string}> | number};
const child = async (input: Record<string, unknown>): Promise<Result> => {
  const run = await promisify(execFile)(process.execPath, ['--import', 'tsx', 'tests/helpers/durable-social-process.ts', '--durable-operation', JSON.stringify(input)], {cwd: process.cwd(), timeout: 20000});
  return JSON.parse(run.stdout.trim().split('\n').at(-1)!);
};
describe('ordinary social draft persistence across real Node processes and SQLite', () => {
  it('allocates short unique IDs across concurrent creation and subsequent process restart without reusing an old manuscript', async () => {
    const dir = root();
    const mint = (body: string) => child({root: dir, name: 'popclaw_draft_message', params: {recipient: fixtureKey(5).id, body}});
    // Initialize the existing SQLite schema before concurrent ordinary calls.
    const first = idOf((await mint('Old manuscript')).result!.text);
    const concurrent = await Promise.all([mint('Concurrent A'), mint('Concurrent B'), mint('Concurrent C')]);
    const later = idOf((await mint('After process restart')).result!.text);
    const ids = [first, ...concurrent.map(r => idOf(r.result!.text)), later];
    expect(new Set(ids).size).toBe(5); for (const id of ids) expect(id).toMatch(/^message-s\d+$/);
    const sent = await child({root: dir, name: 'popclaw_send_draft', params: {draft_id: first}});
    const row = (sent.effects as Array<{bytes: string}>)[0]!;
    const env = popclaw.event.EventEnvelope.decode(popclaw.identity.SignedPayload.decode(Buffer.from(row.bytes, 'base64')).payload);
    expect(fixtureKey(5).signer.openDm(env.directMessage!, fixtureKey(3).id)).toMatchObject({ok: true, plaintext: 'Old manuscript'});
  }, 30000);
  it('normal same-House reads and another social send do not invalidate the earlier manuscript', async () => {
    const fx = durableFixture(root());
    const draft = async (body: string) => idOf((await fx.call('popclaw_draft_message', {recipient: fx.recipient.id, body})).text);
    const first = await draft('Earlier reviewed manuscript'), before = fx.db.queryOne('SELECT op_seq,session_id,installation_id FROM house_participation');
    const later = await draft('Another reviewed manuscript');
    (await fx.runtime()).worldFeedCache.lookup();
    await fx.call('popclaw_send_draft', {draft_id: later});
    expect(fx.db.queryOne('SELECT op_seq,session_id,installation_id FROM house_participation')).toEqual(before);
    expect(eventIdOf((await fx.call('popclaw_send_draft', {draft_id: first})).text)).toMatch(/^[a-f0-9]{64}$/);
    expect(fx.effects()).toHaveLength(2); fx.db.close();
  });
  it.each(['message', 'reply', 'post', 'feedback'] as const)('recovers %s after restart and waiting; retains exact target/body/bytes and consumes once', async kind => {
    const dir = root(), recipient = fixtureKey(5), body = 'Full retained manuscript.\nSecond paragraph.';
    const attachment = join(dir, 'letter.txt'); writeFileSync(attachment, 'original approved attachment');
    const name = kind === 'feedback' ? 'popclaw_feedback' : `popclaw_draft_${kind}`;
    const params = kind === 'message' ? {recipient: recipient.id, body, attachment_path: attachment}
      : kind === 'reply' ? {platform: 'x', post_id: 'post-a', body} : kind === 'feedback' ? {kind: 'need', body} : {body, reply_to_event_id: 'ab'.repeat(32)};
    const draft = await child({root: dir, name, params, pressure: 20});
    expect(draft.error).toBeUndefined(); const id = idOf(draft.result!.text);
    const reviewText = kind === 'message' ? JSON.parse(draft.result!.text).owner_text : draft.result!.text;
    expect(reviewText).toContain(body);
    expect(id).toMatch(/^(message|reply|post)-s\d+$/);
    expect(draft.effects).toEqual([]); writeFileSync(attachment, 'changed disk attachment');
    const sent = await child({root: dir, name: 'popclaw_send_draft', params: {draft_id: id}, advanceMs: 31 * 60000});
    expect(sent.error).toBeUndefined(); expect(sent.result!.text).not.toMatch(/unknown or expired|unavailable/);
    const rows = sent.effects as Array<{house: string; bytes: string}>; expect(rows).toHaveLength(1); expect(rows[0]!.house).toBe('house-fixture-invalid');
    const signed = popclaw.identity.SignedPayload.decode(Buffer.from(rows[0]!.bytes, 'base64'));
    const env = popclaw.event.EventEnvelope.decode(signed.payload);
    if (kind === 'message' || kind === 'feedback') {
      expect(env.directMessage?.toPopclawId).toBe(recipient.id);
      const clear = decryptDmBody(env.directMessage, fixtureKey(3).id, recipient.secretKey);
      expect(clear.ok && clear.plaintext).toContain(body);
      if (kind === 'message') {
        const dm = env.directMessage!;
        const media = decryptDmMedia({ciphertext: dm.mediaCiphertext, nonce: dm.mediaNonce}, fixtureKey(3).id, recipient.secretKey);
        expect(media.ok && new TextDecoder().decode(media.bytes)).toBe('original approved attachment');
      }
    } else if (kind === 'post') {expect(env.post?.blocks?.[0]?.content).toBe(body); expect(env.prevEventId).toBe('ab'.repeat(32));}
    else expect(env.reply?.body).toBe(body);
    const repeated = await child({root: dir, name: 'popclaw_send_draft', params: {draft_id: id}});
    expect(repeated.result!.text).toContain('already been used'); expect(repeated.effects).toHaveLength(1);
  }, 30000);
  it('CAS allows one of concurrent processes and unknown transport results remain spent after restart', async () => {
    const dir = root();
    const mint = async () => idOf((await child({root: dir, name: 'popclaw_draft_message', params: {recipient: fixtureKey(5).id, body: 'Concurrency manuscript'}})).result!.text);
    const id = await mint();
    const results = await Promise.all([child({root: dir, name: 'popclaw_send_draft', params: {draft_id: id}}), child({root: dir, name: 'popclaw_send_draft', params: {draft_id: id}})]);
    expect(results.filter(r => typeof eventIdOf(r.result?.text ?? '') === 'string')).toHaveLength(1);
    const unknown = await mint();
    const uncertain = await child({root: dir, name: 'popclaw_send_draft', params: {draft_id: unknown}, options: {unknown: true}});
    expect(uncertain.result?.text ?? uncertain.error).toContain('SYNTHETIC_TRANSPORT_UNKNOWN_AFTER_EFFECT');
    expect(Array.isArray(uncertain.effects) ? uncertain.effects.length : uncertain.effects).toBe(2);
    const repeated = await child({root: dir, name: 'popclaw_send_draft', params: {draft_id: unknown}});
    expect(repeated.result!.text).toContain('already been used'); expect(repeated.effects).toHaveLength(2);
  }, 30000);
  it('does not persist callbacks, refuses a changed review copy, and isolates existing stdio consumer scopes', async () => {
    const dir = root(), fx = durableFixture(dir, {mode: 'local-stdio', scope: 'client-a'});
    const id = idOf((await fx.call('popclaw_draft_message', {recipient: fx.recipient.id, body: 'Long manuscript '.repeat(80)})).text);
    const store = new DurableSocialDrafts(fx.db, fx.owner.id), saved = store.load(id)!;
    expect(saved.review?.file).not.toBeNull();
    const payload = fx.db.queryOne<{payload: string}>('SELECT payload FROM social_chat_drafts WHERE draft_id=?', [id])!.payload;
    expect(payload).not.toMatch(/assertInvocationCurrent|secretKey|ownerContinuation|function/);
    writeFileSync(saved.review!.file!.path, 'Changed copy, not the approved manuscript'); fx.db.close();
    const other = durableFixture(dir, {mode: 'local-stdio', scope: 'client-b'});
    expect((await other.call('popclaw_send_draft', {draft_id: id})).text).toContain('different conversation'); other.db.close();
    const fresh = durableFixture(dir, {mode: 'local-stdio', scope: 'client-a'});
    expect((await fresh.call('popclaw_send_draft', {draft_id: id})).text).toContain('review copy changed');
    expect(fresh.effects()).toHaveLength(0); expect(new DurableSocialDrafts(fresh.db, fresh.owner.id).load(id)).not.toBeNull(); fresh.db.close();
  });
  it('rechecks the new invocation after async signing, spends once on revocation and never revives it', async () => {
    const dir = root(), draft = await child({root: dir, name: 'popclaw_draft_message', params: {recipient: fixtureKey(5).id, body: 'Current invocation only'}});
    const id = idOf(draft.result!.text); let current = true;
    const fx = durableFixture(dir, {revokeDuringSign: () => {current = false;}});
    const ctx = fixtureContext({assertInvocationCurrent: () => {if (!current) throw new Error('ACTUAL_HOST_REVOKED_AFTER_AWAIT');}});
    await expect(fx.call('popclaw_send_draft', {draft_id: id}, ctx)).rejects.toThrow('ACTUAL_HOST_REVOKED_AFTER_AWAIT');
    expect(fx.effects()).toHaveLength(0); fx.db.close();
    const repeated = await child({root: dir, name: 'popclaw_send_draft', params: {draft_id: id}});
    expect(repeated.result!.text).toContain('already been used'); expect(repeated.effects).toEqual([]);
  });
  it('fails honestly on a storage write failure and detects persisted material corruption before consuming', async () => {
    const dir = root(), fx = durableFixture(dir);
    const id = idOf((await fx.call('popclaw_draft_message', {recipient: fx.recipient.id, body: 'Saved manuscript'})).text);
    fx.db.execute("UPDATE social_chat_drafts SET payload='changed stored bytes' WHERE draft_id=?", [id]);
    expect((await fx.call('popclaw_send_draft', {draft_id: id})).text).toContain('draft material changed');
    expect(fx.effects()).toHaveLength(0);
    fx.db.execute('DROP TABLE social_chat_drafts');
    await expect(fx.call('popclaw_draft_message', {recipient: fx.recipient.id, body: 'Cannot be saved'})).rejects.toThrow('Draft not saved');
    expect(fx.effects()).toHaveLength(0); fx.db.close();
  });
  it('retains identity, conversation scope, current revocation, attachment integrity and House generation', async () => {
    const dir = root(), fx = durableFixture(dir);
    const id = idOf((await fx.call('popclaw_draft_message', {recipient: fx.recipient.id, body: 'Bound manuscript'})).text);
    fx.db.close();
    for (const options of [{owner: 9}, {scope: 'other-client', mode: 'local-stdio'}]) {
      const refused = await child({root: dir, name: 'popclaw_send_draft', params: {draft_id: id}, options});
      expect(refused.effects).toEqual([]);
    }
    for (const context of [{sessionId: 'other-session'}, {requesterSenderId: 'other-human'}, {messageChannel: 'other'}, {agentAccountId: 'other'}, {deliveryContext: {to: 'other'}}]) {
      const refused = await child({root: dir, name: 'popclaw_send_draft', params: {draft_id: id}, context});
      expect(refused.result!.text).toContain('different conversation'); expect(refused.effects).toEqual([]);
    }
    const revived = durableFixture(dir), ctx = fixtureContext({assertInvocationCurrent: () => {throw Error('ACTUAL_HOST_REFUSED');}});
    await expect(revived.call('popclaw_send_draft', {draft_id: id}, ctx)).rejects.toThrow('ACTUAL_HOST_REFUSED');
    expect(new DurableSocialDrafts(revived.db, revived.owner.id).load(id)).not.toBeNull(); revived.db.close();
    const changed = await child({root: dir, name: 'popclaw_send_draft', params: {draft_id: id}, options: {generation: 2}});
    expect(changed.error).toContain('SOCIAL_DRAFT_HOUSE_CHANGED'); expect(changed.effects).toBe(0);
  }, 30000);
});
