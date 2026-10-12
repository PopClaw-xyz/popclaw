import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerPopclawTools } from '../../../src/tools/register-tools.js';
import { withOpenClawNotifyRoute } from '../../../src/host/openclaw-notify-route.js';
import { actionFetch, withAction } from '../../../src/runtime/house-lifecycle/action-context.js';
import { setOwnerLang } from '../../../src/lexicon/owner-language.js';
import { _draftsForTest } from '../../../src/tools/draft-store.js';

const identity = { popclawId: 'DNtEiuFHd6MRzVv1PXuzphGzaWqbLu9rAkLpjKLgkcnH', nickname: 'Owner', webBaseUrl: 'https://example.test' };
type Tool = { name: string; execute: (id: string, params: unknown, signal?: AbortSignal) => Promise<{text: string; isError?: boolean}> };
function fixture() {
  let currentIdentity: typeof identity | null = identity;
  let tracked = false;
  let houseActive = true;
  const house = {signal: new AbortController().signal, isActive: () => houseActive};
  let beforeEgress: (() => Promise<void>) | undefined;
  const network = vi.fn(async () => new Response('{}'));
  const initiate = vi.fn(async (_opts: unknown) => {
    await beforeEgress?.();
    await actionFetch(undefined, network as typeof fetch)('https://offline.invalid');
    return { expectedSigil: 'abcdef', pushedEventId: 'event', push: {status: 200, eventId: 'event', deduplicated: false, ...(tracked ? {taskId:'tracked'} : {})} };
  });
  const watchNetwork = vi.fn(async () => new Response(JSON.stringify({state:'APPROVED', platform:'x', handle:'first'})));
  const pending = {add: vi.fn(), get: vi.fn(), claimResolved: vi.fn(() => true)};
  const notify = vi.fn();
  const captureRoute = vi.fn(), setRoute = vi.fn();
  const runtime = vi.fn(async () => ({
    boot: identity, initiator: {initiate}, pendingInvites: pending, inviteWatch: {ownerPopclawId: identity.popclawId, pending, notifier:{enqueue:vi.fn()}, notifyOwner:notify, loreHouseUrl:'https://offline.invalid', fetch:actionFetch(undefined, watchNetwork as typeof fetch)},
    ownerNotifyTargetStore: {captureIfUnset: captureRoute}, ownerSession: {set: setRoute},
  })) as unknown as Parameters<typeof registerPopclawTools>[0]['runtime'];
  const runCommand = vi.fn(async (work: () => Promise<unknown>) => withAction(house, work));
  const notice = vi.fn(async () => { throw new Error('NO NOTICE'); });
  const getter = vi.fn(async () => currentIdentity);
  const factories: unknown[] = [];
  const raw = { registerTool: (tool: unknown) => { factories.push(tool); }, logger: {info: vi.fn()} };
  const api = withOpenClawNotifyRoute(raw, runtime as unknown as Parameters<typeof withOpenClawNotifyRoute>[1], vi.fn());
  registerPopclawTools({ api, runtime, runCommand, socialSendHost: 'native', nativeToolNotices: true,
    getToolNoticeContext: notice, getInviteShareIdentity: getter });
  const context = (session: string) => ({agentId: 'main', sessionId: session, sessionKey: 'agent:main:'+session,
    senderIsOwner: true, requesterSenderId: 'owner', deliveryContext: {channel: 'test', to: 'owner'},
    assertInvocationCurrent: vi.fn()});
  const tool = (ctx: ReturnType<typeof context>) => {
    for (const f of factories) {
      const descriptor = f as {contextVersion?: number; create?: (c: unknown) => unknown};
      const resolved = descriptor.contextVersion === 2 ? descriptor.create!(ctx) : typeof f === 'function' ? f(ctx) : f;
      const found = (Array.isArray(resolved) ? resolved : [resolved]).find((x: Tool) => x?.name === 'popclaw_invite');
      if (found) return found as Tool;
    }
    throw new Error('Tool not registered');
  };
  return {context, tool, runtime, getter, notice, runCommand, initiate, network, captureRoute, setRoute, watchNetwork, notify,
    track: () => {tracked = true;}, closeHouse: () => {houseActive = false;},
    setIdentity: (value: typeof identity | null) => {currentIdentity = value;},
    delay: (fn: () => Promise<void>) => {beforeEgress = fn;} };
}
const prepare = (tool: Tool, handle = 'first') => tool.execute('prepare', {platform: 'x', handle});
beforeEach(() => { _draftsForTest.clear(); setOwnerLang('en', 'config'); });

describe('native invitation preparation and owner posting acknowledgement', () => {
  it('prepares editable copy and the fixed link without runtime, command, notice or submission IO', async () => {
    const fx = fixture(); const t = fx.tool(fx.context('one'));
    const result = JSON.parse((await prepare(t, 'SongyuKite')).text);
    expect(result).toMatchObject({status: 'prepared', handle: 'SongyuKite', after_posting: {arguments: {posted: true, platform: 'x', handle: 'SongyuKite'}}});
    expect(result.invite_url).toMatch(/^https:\/\/popclaw.me\/invite\/[a-z0-9]+$/);
    expect(result.display_text).toContain('```text\n'+result.postable_copy+'\n```');
    expect(result.guidance).toContain('@SongyuKite');
    expect(result.postable_copy).toContain(result.invite_url);
    expect(fx.captureRoute).not.toHaveBeenCalled(); expect(fx.setRoute).not.toHaveBeenCalled();
    expect(fx.runtime).not.toHaveBeenCalled(); expect(fx.runCommand).not.toHaveBeenCalled(); expect(fx.notice).not.toHaveBeenCalled(); expect(fx.initiate).not.toHaveBeenCalled();
  });
  it('submits ordinary posted once using the newest successful target in this chat, without another preview', async () => {
    const fx = fixture(); const ctx = fx.context('one');
    await prepare(fx.tool(ctx), 'first'); await prepare(fx.tool(ctx), 'second');
    const result = await fx.tool(fx.context('one')).execute('posted', {posted: true});
    expect(result.text).not.toContain('confirm_token'); expect(fx.initiate).toHaveBeenCalledOnce();
    expect(fx.captureRoute).toHaveBeenCalledOnce(); expect(fx.setRoute).toHaveBeenCalledWith('agent:main:one', expect.objectContaining({channel:'test', to:'owner'}));
    expect(fx.initiate).toHaveBeenCalledWith({platform: 'x', handle: 'second', nickname: 'Owner', replace: false, mirrorOptin: false, proofUrl: undefined});
    await fx.tool(ctx).execute('repeat', {posted: true}); expect(fx.initiate).toHaveBeenCalledOnce();
  });
  it('keeps separate chats and rejects stale explicit target A after preparing B', async () => {
    const fx = fixture(); const a = fx.tool(fx.context('one')), b = fx.tool(fx.context('two'));
    await prepare(a, 'first'); await prepare(a, 'second'); await prepare(b, 'third');
    expect((await a.execute('wrong', {posted:true, platform:'x', handle:'first'})).isError).toBe(true);
    expect(fx.initiate).not.toHaveBeenCalled();
    await a.execute('one', {posted:true}); await b.execute('two', {posted:true});
    expect(fx.initiate.mock.calls.map(c => c[0])).toEqual([expect.objectContaining({handle:'second'}), expect.objectContaining({handle:'third'})]);
  });
  it.each(['unsupported', 'invalid', 'disconnected'])('failed %s preparation preserves the earlier target', async reason => {
    const fx = fixture(); const t = fx.tool(fx.context('one')); await prepare(t, 'first');
    if (reason === 'disconnected') fx.setIdentity(null);
    const failed = await t.execute('bad', {platform: reason === 'unsupported' ? 'instagram' : 'x', handle: reason === 'invalid' ? 'not a handle' : 'second'});
    expect(failed.isError).toBe(true); fx.setIdentity(identity);
    await t.execute('posted', {posted:true}); expect(fx.initiate).toHaveBeenCalledWith(expect.objectContaining({handle:'first'}));
  });
  it.each(['sync', 'replace', 'nickname'])('posted with %s retains preview and explicit confirmation', async key => {
    const fx = fixture(); const t = fx.tool(fx.context('one')); await prepare(t);
    const preview = await t.execute('preview', {posted:true, platform:'x', handle:'first', [key]: key === 'nickname' ? 'Other' : true});
    expect(preview.text).toContain('confirm_token'); expect(fx.initiate).not.toHaveBeenCalled();
    expect(fx.runtime).not.toHaveBeenCalled(); expect(fx.notice).not.toHaveBeenCalled();
    await t.execute('confirm', {confirm_token: preview.text.match(/invite-\d+/)![0]}); expect(fx.initiate).toHaveBeenCalledOnce();
  });
  it.each(['missing', 'third-party', 'revoked'])('refuses %s native authority despite forged owner arguments', async kind => {
    const fx = fixture(); const ctx = fx.context('one'); const t = fx.tool(ctx); await prepare(t);
    if (kind === 'missing') ctx.assertInvocationCurrent = undefined as unknown as typeof ctx.assertInvocationCurrent;
    if (kind === 'third-party') ctx.senderIsOwner = false;
    if (kind === 'revoked') ctx.assertInvocationCurrent.mockImplementation(() => {throw new Error('REVOKED');});
    const failed = await t.execute('posted', {posted:true});
    expect(failed.isError).toBe(true); expect(fx.initiate).not.toHaveBeenCalled();
  });
  it('tool arguments cannot supply owner authority or request a wait flow', async () => {
    const fx = fixture(); const t = fx.tool(fx.context('one')); await prepare(t);
    for (const params of [{posted:true, owner_authorized:true}, {posted:true, senderIsOwner:true}, {wait_new_post:true, platform:'x', handle:'first'}]) {
      expect((await t.execute('forged', params)).isError).toBe(true);
    }
    expect(fx.initiate).not.toHaveBeenCalled();
  });
  it('cannot submit without preparation or under another identity', async () => {
    const fx = fixture(); const t = fx.tool(fx.context('one'));
    expect((await t.execute('unprepared', {posted:true, platform:'x', handle:'first'})).isError).toBe(true);
    await prepare(t); fx.setIdentity({...identity, popclawId:'another'});
    expect((await t.execute('changed', {posted:true})).isError).toBe(true); expect(fx.initiate).not.toHaveBeenCalled();
  });
  it('rechecks owner invocation at actual egress after async work', async () => {
    const fx = fixture(); const ctx = fx.context('one'); const t = fx.tool(ctx); await prepare(t);
    fx.delay(async () => {ctx.assertInvocationCurrent.mockImplementation(() => {throw new Error('REVOKED');});});
    const result = await t.execute('posted', {posted:true}); expect(result.isError).toBe(true); expect(fx.network).not.toHaveBeenCalled();
    await t.execute('retry', {posted:true}); expect(fx.initiate).toHaveBeenCalledOnce();
  });
  it('cannot reuse a prepared target after its captured conversation changes', async () => {
    const fx = fixture(); const ctx = fx.context('one'); const t = fx.tool(ctx); await prepare(t); ctx.sessionId = 'other';
    expect((await t.execute('posted', {posted:true})).isError).toBe(true); expect(fx.initiate).not.toHaveBeenCalled();
  });
  it('rechecks the latest prepared target through async work', async () => {
    const fx = fixture(); const ctx = fx.context('one'); const t = fx.tool(ctx); await prepare(t);
    fx.delay(async () => {await prepare(fx.tool(fx.context('one')), 'second');});
    expect((await t.execute('posted', {posted:true})).isError).toBe(true); expect(fx.network).not.toHaveBeenCalled();
    fx.delay(async () => {}); await t.execute('second', {posted:true});
    expect(fx.network).toHaveBeenCalledOnce(); expect(fx.initiate).toHaveBeenLastCalledWith(expect.objectContaining({handle:'second'}));
  });
  it('a sensitive confirmation token is confined to its prepared conversation', async () => {
    const fx = fixture(); const a = fx.tool(fx.context('one')), b = fx.tool(fx.context('two')); await prepare(a);
    const preview = await a.execute('preview', {posted:true, sync:true}); const token = preview.text.match(/invite-\d+/)![0];
    await b.execute('wrong', {confirm_token:token}); expect(fx.initiate).not.toHaveBeenCalled();
    await a.execute('correct', {confirm_token:token}); expect(fx.initiate).toHaveBeenCalledOnce();
  });
  it.each([false, true])('existing result watching retains House authority (closed=%s) without the expired submission turn', async closed => {
    vi.useFakeTimers();
    try {
      const fx = fixture(); fx.track(); const ctx = fx.context('one'); const t = fx.tool(ctx); await prepare(t);
      await t.execute('posted', {posted:true});
      ctx.assertInvocationCurrent.mockImplementation(() => {throw new Error('TURN ENDED');});
      if (closed) fx.closeHouse();
      await vi.advanceTimersByTimeAsync(15_000);
      expect(fx.watchNetwork).toHaveBeenCalledTimes(closed ? 0 : 1); expect(fx.notify).toHaveBeenCalledTimes(closed ? 0 : 1);
    } finally {vi.clearAllTimers(); vi.useRealTimers();}
  });
  it('preflights invalid proof without spending the prepared target', async () => {
    const fx = fixture(); const t = fx.tool(fx.context('one')); await prepare(t);
    expect((await t.execute('bad', {posted:true, proof_url:''})).isError).toBe(true); expect(fx.initiate).not.toHaveBeenCalled();
    await t.execute('good', {posted:true, proof_url:'https://x.com/first/status/123'});
    expect(fx.initiate).toHaveBeenCalledWith(expect.objectContaining({proofUrl:'https://x.com/first/status/123'}));
  });
});
