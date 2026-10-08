import { afterEach, describe, expect, it, vi } from 'vitest';
import { InMemoryHostAdapter } from '../../../src/host/host-adapter.in-memory.js';
import { runPopclawNameCommand, runPopclawBioCommand } from '../../../src/commands/popclaw-name.js';
import { loadMyNamecard, signMyNamecard } from '../../../src/messaging/my-namecard.js';
import { ensureNamecardOnHouse } from '../../../src/messaging/announce-namecard.js';
import { popclaw } from '../../../src/protocol/public-envelope-generated.js';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import {MasterKeySigner} from '../../../src/identity/master-key-signer.js';
import {HousePushError} from '../../../src/runtime/house-lifecycle/house-runtime.js';
import type {CommandPushResult} from '../../../src/runtime/house-lifecycle/command-bus.js';
import {MultiHouseEgress} from '../../../src/egress/multi-house-egress.js';
import { registerNameTasteTools } from '../../../src/tools/name-taste-tools.js';
import { makeToolCollector, toMcpToolListing, toMcpToolResult } from '../../../src/tools/mcp-adapter.js';
import manifest from '../../../openclaw.plugin.json';
import {onNicknamePersisted} from '../../../src/onboarding/identity-writer.js';

afterEach(() => vi.unstubAllGlobals());

const BIO = 'Lantern keeper.\nI help feedback find its way home.  ';
const HOUSE = 'https://house.example';
const SECOND = 'https://second.example';
function card(nickname = 'Old', intro = '', declaredAt = 1000) {
  return { nickname, one_line_intro: intro, declared_at_ms: declaredAt * 1000,
    taste_tags: [], role_persona: '', location_hint: '', avatar_uri: '', payout_addresses: [] };
}
async function setup(origins = [HOUSE]) {
  const host = new InMemoryHostAdapter({config: {plugin: {ranger_profile: {nickname: 'Old', namecard_declared_at: 1000}}}});
  const seed = nacl.randomBytes(32);
  const key = nacl.sign.keyPair.fromSeed(seed);
  const signer = new MasterKeySigner({seed,...key,popclawId:bs58.encode(key.publicKey)});
  const id = await signer.popclawId();
  const rows = new Map<string, unknown>(origins.map(origin => [origin, card()]));
  const fetch = vi.fn(async (url: string | URL | Request) => {
    const origin = new URL(String(url)).origin;
    const row = rows.get(origin);
    return new Response(JSON.stringify({popclaw_id:id, sigil:'abc', profiles:[], house_follower_count:0,
      house_post_count:0, house_reply_received_count:0, ...(row === undefined ? {} : {card:row})}));
  }) as unknown as typeof globalThis.fetch;
  const sent: Uint8Array[] = [];
  const push = vi.fn(async (bytes: Uint8Array) => {
    sent.push(bytes);
    const signed = popclaw.identity.SignedPayload.decode(bytes);
    expect(nacl.sign.detached.verify(signed.payload!,signed.signature!,signed.signerPubkey!)).toBe(true);
    const env = popclaw.event.EventEnvelope.decode(signed.payload!);
    for (const origin of origins) rows.set(origin, card(env.profile!.nickname!, env.profile!.oneLineIntro ?? '', Number(env.profile!.declaredAt)));
    return {status:200};
  });
  return {host, rows, sent, push, deps:{host, signer, popclawId:id, houseOrigins:origins,
    clock:{now:()=>new Date(2000_000)}, fetch, egress:{push}}};
}

describe('shared public namecard update', () => {
  it('notifies live nickname readers after successful local saving even when publication is blocked', async () => {
    const s = await setup();
    const listener = vi.fn();
    onNicknamePersisted(s.host, listener);
    s.rows.set(HOUSE, {...card(), avatar_uri:'https://other.example/avatar.png'});
    const r = await runPopclawNameCommand({nickname:'New Local Name'}, s.deps);
    expect(r.details.local.status).toBe('saved');
    expect(r.details.public.status).toBe('blocked');
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith('New Local Name');
    expect(s.push).not.toHaveBeenCalled();
  });
  it('does not notify live nickname readers when the local save fails', async () => {
    const s = await setup();
    const listener = vi.fn();
    onNicknamePersisted(s.host, listener);
    vi.spyOn(s.host.config, 'saveJson').mockRejectedValue(new Error('disk write denied'));
    const r = await runPopclawNameCommand({nickname:'Unsaved Name'}, s.deps);
    expect(r.details.local.status).toBe('failed');
    expect(listener).not.toHaveBeenCalled();
    expect(s.push).not.toHaveBeenCalled();
  });
  it('publishes exact two-line bio, then preserves it on rename, reload and self-heal', async () => {
    const s = await setup();
    const bio = await runPopclawBioCommand({bio:BIO}, s.deps);
    expect(bio.isError).not.toBe(true);
    expect(bio.details.local.status).toBe('saved');
    expect(bio.details.public.status).toBe('confirmed');
    expect(s.rows.get(HOUSE)).toMatchObject({one_line_intro:BIO});
    const renamed = await runPopclawNameCommand({nickname:'Lanny Lantern'}, s.deps);
    expect(renamed.details.public.status).toBe('confirmed');
    expect(s.rows.get(HOUSE)).toMatchObject({nickname:'Lanny Lantern', one_line_intro:BIO});
    const loaded = await loadMyNamecard({host:s.host, now:()=>9000});
    expect(loaded!.oneLineIntro).toBe(BIO);
    const signed = await signMyNamecard(s.deps.signer, loaded!);
    expect(signed.signedPayloadBytes).toEqual(s.sent.at(-1));
    s.rows.set(HOUSE, card('Old', BIO, 1000));
    await ensureNamecardOnHouse(HOUSE, {card:loaded!, signedBytes:signed.signedPayloadBytes,
      popclawId:s.deps.popclawId, fetch:s.deps.fetch, pushTo:async (_slug, bytes)=>s.push(bytes)});
    expect(s.rows.get(HOUSE)).toMatchObject({nickname:'Lanny Lantern', one_line_intro:BIO});
    expect((await s.host.config.loadJson('plugin'))).toMatchObject({ranger_profile:{one_line_intro:BIO}});
  });
  it('explicitly clears owned bio with the empty string and confirms it', async () => {
    const s = await setup();
    await runPopclawBioCommand({bio:BIO}, s.deps);
    const r = await runPopclawBioCommand({bio:''}, s.deps);
    expect(r.details.public.status).toBe('confirmed');
    expect(s.rows.get(HOUSE)).toMatchObject({one_line_intro:''});
    const renamed = await runPopclawNameCommand({nickname:'After Clear'}, s.deps);
    expect(renamed.details.public.status).toBe('confirmed');
    expect(s.rows.get(HOUSE)).toMatchObject({nickname:'After Clear',one_line_intro:''});
    expect((await loadMyNamecard({host:s.host,now:()=>9000}))!.oneLineIntro).toBe('');
  });
  it('blocks rename over a foreign bio and never overwrites unowned content', async () => {
    const s = await setup();
    s.rows.set(HOUSE, {...card('Old', 'foreign bio'), role_persona:'curated elsewhere'});
    const r = await runPopclawNameCommand({nickname:'Lanny Lantern'}, s.deps);
    expect(r.isError).toBe(true);
    expect(r.details.public.status).toBe('blocked');
    expect(s.push).not.toHaveBeenCalled();
    expect(s.rows.get(HOUSE)).toMatchObject({one_line_intro:'foreign bio', role_persona:'curated elsewhere'});
  });
  it('blocks a foreign intro by itself on rename, including after a local bio was saved', async () => {
    const s = await setup();
    await runPopclawBioCommand({bio:BIO}, s.deps);
    s.rows.set(HOUSE, card('Old', 'foreign bio', 1000));
    const sent = s.push.mock.calls.length;
    const r = await runPopclawNameCommand({nickname:'Lanny Lantern'}, s.deps);
    expect(r.details.public.status).toBe('blocked');
    expect(s.push.mock.calls).toHaveLength(sent);
    expect(s.rows.get(HOUSE)).toMatchObject({one_line_intro:'foreign bio'});
  });
  it('retries an explicit bio edit after failed publication without losing the old remote bio', async () => {
    const s = await setup();
    s.rows.set(HOUSE, card('Old', 'previous public bio'));
    const original = s.deps.egress.push;
    s.deps.egress.push = vi.fn(async () => ({status:503}));
    const failed = await runPopclawBioCommand({bio:BIO}, s.deps);
    expect(failed.isError).toBe(true);
    expect(failed.details.public.status).toBe('failed');
    expect((await loadMyNamecard({host:s.host, now:()=>3000}))!.oneLineIntro).toBe(BIO);
    expect(s.rows.get(HOUSE)).toMatchObject({one_line_intro:'previous public bio'});
    s.deps.egress.push = original;
    const retried = await runPopclawBioCommand({bio:BIO}, s.deps);
    expect(retried.details.public.status).toBe('confirmed');
    expect(s.rows.get(HOUSE)).toMatchObject({one_line_intro:BIO});
  });
  it('self-heal checks intro even at the same timestamp and blocks a different foreign intro', async () => {
    const s = await setup();
    await runPopclawBioCommand({bio:BIO}, s.deps);
    const loaded = (await loadMyNamecard({host:s.host, now:()=>9000}))!;
    const signed = await signMyNamecard(s.deps.signer, loaded);
    const deps = {card:loaded, signedBytes:signed.signedPayloadBytes, popclawId:s.deps.popclawId,
      fetch:s.deps.fetch, pushTo:async (_slug:string, bytes:Uint8Array)=>s.push(bytes)};
    s.rows.set(HOUSE, card(loaded.nickname, '', loaded.declaredAt));
    expect(await ensureNamecardOnHouse(HOUSE, deps)).toBe(true);
    expect(s.rows.get(HOUSE)).toMatchObject({one_line_intro:BIO});
    s.rows.set(HOUSE, card(loaded.nickname, 'foreign', loaded.declaredAt-1));
    const sent = s.push.mock.calls.length;
    expect(await ensureNamecardOnHouse(HOUSE, deps)).toBe(false);
    expect(s.push.mock.calls).toHaveLength(sent);
  });
  it('reports local config failure without attempting signing or publication', async () => {
    const s = await setup();
    vi.spyOn(s.host.config, 'saveJson').mockRejectedValue(new Error('disk write denied'));
    const r = await runPopclawBioCommand({bio:BIO}, s.deps);
    expect(r.isError).toBe(true);
    expect(r.details.local).toMatchObject({status:'failed', detail:expect.stringContaining('disk write denied')});
    expect(r.details.public.status).toBe('not-attempted');
    expect(s.push).not.toHaveBeenCalled();
  });
  it('does not report success from accepted transport without matching public readback', async () => {
    const s = await setup();
    s.deps.egress.push = vi.fn(async () => ({status:200}));
    const r = await runPopclawNameCommand({nickname:'Lanny Lantern'}, s.deps);
    expect(r.isError).toBe(true);
    expect(r.details.local.status).toBe('saved');
    expect(r.details.public.status).toBe('unknown');
    expect(r.details.public.houses[0]).toMatchObject({publication:'accepted', confirmation:'mismatched'});
  });
  it('keeps per-House partial publication evidence', async () => {
    const s = await setup([HOUSE, SECOND]);
    s.deps.egress = {push:s.push, broadcastEach:async (bytes:Uint8Array)=> {
      const env = popclaw.event.EventEnvelope.decode(popclaw.identity.SignedPayload.decode(bytes).payload!);
      s.rows.set(HOUSE, card(env.profile!.nickname!, env.profile!.oneLineIntro ?? '', Number(env.profile!.declaredAt)));
      return [{slug:'house-example', result:{status:200}}, {slug:'second-example', result:{status:403, detail:'authorization denied'}}];
    }} as typeof s.deps.egress;
    const r = await runPopclawBioCommand({bio:BIO}, s.deps);
    expect(r.isError).toBe(true);
    expect(r.details.public.status).toBe('partial');
    expect(r.details.public.houses).toHaveLength(2);
    expect(r.details.public.houses[1]).toMatchObject({publication:'rejected', status:403, detail:'authorization denied'});
  });
  it.each([403, 503, 0])('preserves a real HousePushError receipt with status %i through MultiHouseEgress', async status => {
    const s = await setup([HOUSE, SECOND]);
    // Preserve optional transport evidence from the shared Hosted receipt too;
    // the native command bus has the narrower CommandPushResult contract.
    const failed: CommandPushResult & {outboundRetry: 'never'; outboundOutcome: unknown} = {status, operationId:'original-core-operation',
      state:status === 0 ? 'unknown' : 'failed', detail:status === 0 ? 'result unknown' : 'House rejected publication',
      outboundRetry:'never', outboundOutcome:status === 0
        ? {kind:'unknown',transportInvoked:'unknown',code:'ADMISSION_RESULT_UNKNOWN'}
        : {kind:'received',transportInvoked:true,httpStatus:status,receiptRef:'existing-outbound-receipt'}};
    const homePush = async (bytes:Uint8Array) => {
      const env = popclaw.event.EventEnvelope.decode(popclaw.identity.SignedPayload.decode(bytes).payload!);
      s.rows.set(HOUSE, card(env.profile!.nickname!,env.profile!.oneLineIntro ?? '',Number(env.profile!.declaredAt)));
      return {status:200};
    };
    const egress = new MultiHouseEgress([
      {slug:'house-example',origin:HOUSE,egress:{push:homePush}},
      {slug:'second-example',origin:SECOND,egress:{push:async()=>{throw new HousePushError(failed);}}},
    ]);
    const r = await runPopclawBioCommand({bio:BIO}, {...s.deps, egress});
    expect(r.isError).toBe(true);
    expect(r.details.public.status).toBe('partial');
    expect(r.details.public.houses[0]).toMatchObject({publication:'accepted',confirmation:'matched'});
    expect(r.details.public.houses[1]).toMatchObject({
      publication:status === 0 ? 'unknown' : 'rejected',status,receipt:failed,
    });
    if (status === 0) expect(r.text).not.toContain('HTTP 0');
  });
  it('reports thrown policy errors as unknown evidence without calling them network failure', async () => {
    const s = await setup();
    s.deps.egress.push = vi.fn(async () => { throw new Error('HOSTED_REQUEST_MATERIAL_MISMATCH'); });
    const r = await runPopclawBioCommand({bio:BIO}, s.deps);
    expect(r.isError).toBe(true);
    expect(r.details.public.status).toBe('unknown');
    expect(r.details.public.houses[0]!.detail).toContain('HOSTED_REQUEST_MATERIAL_MISMATCH');
    expect(r.text).not.toMatch(/no network|网络不通|next start|下次开机/);
  });
  it.each([null, {nickname:'Old'}, {...card(), unexpected:'private'}, {...card(), taste_tags:['owned elsewhere']}])('fails closed for incomplete or unowned remote card %j', async remote => {
      const s = await setup();s.rows.set(HOUSE, remote);
      const r = await runPopclawBioCommand({bio:BIO}, s.deps);
      expect(r.isError).toBe(true);expect(s.push).not.toHaveBeenCalled();
    });
});

describe('public bio tool contract', () => {
  it('publishes exact biography through the registered tool and exposes MCP structured confirmation', async () => {
    const s = await setup();
    vi.stubGlobal('fetch', s.deps.fetch);
    const collector = makeToolCollector();
    registerNameTasteTools({api:collector.api, runtime:async()=>({host:s.host,boot:{signer:s.deps.signer,
      popclawId:s.deps.popclawId,loreHouseUrls:[HOUSE]},egress:s.deps.egress}),deps:{},total:0} as never);
    const tool = collector.tools.find(tool=>tool.name==='popclaw_set_bio')!;
    const r = toMcpToolResult(await tool.execute('bio', {bio:BIO}));
    expect(r.isError).not.toBe(true);
    expect(r.structuredContent).toMatchObject({local:{status:'saved',card:{oneLineIntro:BIO}}, public:{status:'confirmed'}});
    expect(s.rows.get(HOUSE)).toMatchObject({one_line_intro:BIO});
  });
  it('aligns registration, static surface, MCP schema and annotations and keeps structured failures', async () => {
    const s = await setup();
    const collector = makeToolCollector();
    registerNameTasteTools({api:collector.api, runtime:async()=>({host:s.host,boot:{signer:s.deps.signer,
      popclawId:s.deps.popclawId,loreHouseUrls:[HOUSE]},egress:s.deps.egress}),deps:{},total:0} as never);
    const tool = collector.tools.find(tool=>tool.name==='popclaw_set_bio');expect(tool).toBeDefined();
    const listing = toMcpToolListing(tool!);
    expect(listing.inputSchema.required).toEqual(['bio']);
    expect(listing.annotations).toMatchObject({readOnlyHint:false, openWorldHint:true});
    expect(manifest.contracts.tools).toContain('popclaw_set_bio');
    const r = toMcpToolResult(await tool!.execute('x', {bio:42}));
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toMatchObject({local:{status:'unchanged'},public:{status:'not-attempted'}});
  });
});
