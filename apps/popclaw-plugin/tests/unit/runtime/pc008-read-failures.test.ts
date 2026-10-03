/** Synthetic read transport/caller classification; no real network. */
import {expect,it,vi} from 'vitest';
import {WorldSummaryClient} from '../../../src/world/world-summary-client.js';
import {WorldFeedClient} from '../../../src/ingress/world-feed-client.js';
import {ActionInactiveError} from '../../../src/runtime/house-lifecycle/action-context.js';
import {RemoteHouseReadError,type HouseReadFailureCode} from '../../../src/runtime/house-lifecycle/read-failure.js';
import {runPopclawFeedCommand} from '../../../src/commands/popclaw-feed.js';
import {setOwnerLang} from '../../../src/lexicon/owner-language.js';
const origin='https://house.read-errors.invalid';
it.each(['network','http','parse','body-network','local'] as const)('PC008 read client classification: %s',async kind=>{
  const code:HouseReadFailureCode={network:'HOUSE_REMOTE_NETWORK',http:'HOUSE_REMOTE_HTTP',parse:'HOUSE_REMOTE_PARSE','body-network':'HOUSE_REMOTE_NETWORK',local:'HOUSE_TRUST_REVOKED'}[kind] as HouseReadFailureCode;
  const transport=vi.fn(async()=>{
    if(kind==='network') throw new TypeError('synthetic connection failure');
    if(kind==='local') throw new ActionInactiveError('HOUSE_TRUST_REVOKED',origin);
    if(kind==='http') return new Response('synthetic body not for display',{status:503});
    if(kind==='body-network') return new Response(new ReadableStream({start(c){c.error(new TypeError('synthetic truncated body'));}}));
    return new Response('<html>synthetic non-protocol</html>');
  }) as typeof fetch;
  const summary=new WorldSummaryClient({baseUrl:origin,fetch:transport});
  await expect(summary.fetchSummaryResult()).resolves.toMatchObject({ok:false,failure:{code,origin}});
  await expect(summary.fetchSummary()).resolves.toBeNull(); // legacy consumer facade still never throws
  const feed=new WorldFeedClient({baseUrl:origin,fetch:transport});
  if(kind==='local') await expect(feed.fetchSnapshot({})).rejects.toMatchObject({code,origin});
  else await expect(feed.fetchSnapshot({})).rejects.toMatchObject({failure:{code,origin}});
});
it.each(['HOUSE_DISABLED','HOUSE_CONNECTING','HOUSE_LIFECYCLE_UNSUPPORTED','HOUSE_OWNER_INACTIVE','HOUSE_STORAGE_UNAVAILABLE','HOUSE_TRUST_REVOKED','HOUSE_REMOTE_NETWORK','HOUSE_REMOTE_HTTP','HOUSE_REMOTE_PARSE'] as const)('PC008 feed caller renders %s in both languages',async code=>{
  try {
    for(const lang of ['en','zh-CN'] as const) {
      setOwnerLang(lang,'config');
      const client={fetchSnapshot:async()=>{throw code.startsWith('HOUSE_REMOTE_') ? new RemoteHouseReadError({code,origin,status:503}) : new ActionInactiveError(code,origin);}};
      const rendered=await runPopclawFeedCommand({positional:[],flags:{}},client);
      expect(rendered.text).toContain(code);
      expect(rendered.text).not.toContain('ActionInactiveError');
    }
  } finally {setOwnerLang('zh-CN','config');}
});
