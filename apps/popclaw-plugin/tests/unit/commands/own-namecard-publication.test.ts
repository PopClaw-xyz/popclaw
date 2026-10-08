import {describe, expect, it, vi} from 'vitest';
import {runProfileCommand} from '../../../src/commands/profile.js';
import {deriveSigil} from '../../../src/invite/sigil.js';
import {ownerLang} from '../../../src/lexicon/owner-language.js';
import {renderCopy} from '../../../src/lexicon/index.js';
const ok = (body: unknown) => vi.fn(async()=>new Response(JSON.stringify(body)));

describe('own namecard publication provenance', () => {
  const ME = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
  const deps = (fetch: typeof globalThis.fetch) => ({loreHouseUrl:'https://house.example',fetch,
    self:{popclawId:ME,nickname:'Saved Locally'}});
  const body = {popclaw_id:ME,sigil:deriveSigil(ME),profiles:[{platform:'x',handle:'owner',
    profile_url:'https://x.com/owner',bio:'Verified external snapshot',verified_at:'2026-10-08T00:00:00Z'}],
    card:{nickname:'Published Before',one_line_intro:'Public intro'}};
  it('keeps the public card name above a newer local name on the existing by-id lane', async () => {
    const r = await runProfileCommand({target:ME},deps(ok(body) as typeof fetch));
    expect(r.text).toContain(`popclaw  @Published Before#${deriveSigil(ME)}`);
    expect(r.details).toMatchObject({namecard_source:'house',public_namecard:'observed',nickname:'Published Before'});
    expect(r.text).toContain('https://x.com/owner');
  });
  it('marks a local-only self card when the public read is 404', async () => {
    const r = await runProfileCommand({target:ME},deps((async()=>new Response('',{status:404})) as typeof fetch));
    expect(r.text).toContain(renderCopy(ownerLang(),'namecard.read.localOnly',{house:'https://house.example'}));
    expect(r.details).toMatchObject({namecard_source:'local',public_namecard:'unconfirmed',card:null,nickname:'Saved Locally'});
  });
  it('retains verified external snapshots when the public card is absent and labels the name fallback', async () => {
    const withoutCard = {...body, card: undefined};
    const r = await runProfileCommand({target:ME},deps(ok(withoutCard) as typeof fetch));
    expect(r.text).toContain('https://x.com/owner');
    expect(r.details?.profiles[0]?.bio).toBe('Verified external snapshot');
    expect(r.details).toMatchObject({namecard_source:'local',public_namecard:'unconfirmed',card:null});
  });
});
