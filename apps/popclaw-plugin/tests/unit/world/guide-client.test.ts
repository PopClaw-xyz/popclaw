/**
 * S4-T4: GuideClient unit tests fetch the complete GET /v1/guide.md body and tolerate failure by
 * returning null.
 */
import { describe, it, expect, vi } from 'vitest';
import { GuideClient } from '../../../src/world/guide-client.js';
import { formatHouseReadFailure, RemoteHouseReadError } from '../../../src/runtime/house-lifecycle/read-failure.js';
import { withAction, ActionInactiveError } from '../../../src/runtime/house-lifecycle/action-context.js';

const BASE = 'http://localhost:8080';
const GUIDE_TEXT = '---\nworld: popclaw.me\n---\n\n# 欢迎\n';

function textFetch(status: number, body: string): typeof globalThis.fetch {
  return (async () =>
    new Response(body, {
      status,
      headers: { 'content-type': 'text/markdown' },
    })) as unknown as typeof globalThis.fetch;
}

describe('GuideClient', () => {
  it.each(['http', 'network', 'local', 'body-network'] as const)('typed guide result preserves %s classification while nullable reads stay null', async kind => {
    const client = new GuideClient({ baseUrl: BASE, fetch: async () => {
      if (kind === 'local') throw new ActionInactiveError('HOUSE_TRUST_REVOKED', BASE);
      if (kind === 'network') throw new TypeError('synthetic network');
      if (kind === 'body-network') return new Response(new ReadableStream({ start(c) { c.error(new TypeError('synthetic body error')); } }));
      return new Response('hidden response body', { status: 404 });
    } });
    const code = kind === 'local' ? 'HOUSE_TRUST_REVOKED' : kind === 'http' ? 'HOUSE_REMOTE_HTTP' : 'HOUSE_REMOTE_NETWORK';
    expect(await client.fetchGuideResult()).toMatchObject({ ok: false, failure: { code, origin: BASE } });
    expect(await client.fetchGuideText()).toBeNull();
  });

  it('200 → 返回全文', async () => {
    let requested = '';
    const fetchFn = (async (url: RequestInfo | URL) => {
      requested = String(url);
      return new Response(GUIDE_TEXT, { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    const client = new GuideClient({ baseUrl: BASE, fetch: fetchFn });
    const text = await client.fetchGuideText();
    expect(text).toBe(GUIDE_TEXT);
    expect(requested).toBe(`${BASE}/v1/guide.md`);
  });

  it('baseUrl 末尾斜杠被归一化', async () => {
    let requested = '';
    const fetchFn = (async (url: RequestInfo | URL) => {
      requested = String(url);
      return new Response(GUIDE_TEXT, { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    const client = new GuideClient({ baseUrl: `${BASE}/`, fetch: fetchFn });
    await client.fetchGuideText();
    expect(requested).toBe(`${BASE}/v1/guide.md`);
  });

  it('500 → null（不抛）', async () => {
    const client = new GuideClient({ baseUrl: BASE, fetch: textFetch(500, 'boom') });
    expect(await client.fetchGuideText()).toBeNull();
  });

  it('404 → null（不抛）', async () => {
    const client = new GuideClient({ baseUrl: BASE, fetch: textFetch(404, '') });
    expect(await client.fetchGuideText()).toBeNull();
  });

  it('fetch 抛（网络不通）→ null', async () => {
    const fetchFn = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof globalThis.fetch;
    const client = new GuideClient({ baseUrl: BASE, fetch: fetchFn });
    expect(await client.fetchGuideText()).toBeNull();
  });
});

it('standalone guide validates through its fetch gate and reuses the full body on 304',async()=>{
  let calls=0;const headers:Headers[]=[];const generation={token:{},isCurrent:()=>true};
  const client=new GuideClient({baseUrl:BASE,readGeneration:()=>generation,fetch:async(_url,init)=>{
    headers.push(new Headers(init?.headers));calls++;
    if(calls===3)throw new ActionInactiveError('HOUSE_TRUST_REVOKED',BASE);
    return calls===1?new Response(GUIDE_TEXT):new Response(null,{status:304});
  }});
  expect(await client.fetchGuideText()).toBe(GUIDE_TEXT);
  expect(await client.fetchGuideText()).toBe(GUIDE_TEXT);
  expect(headers[1]?.get('if-none-match')).toMatch(/^"[a-f0-9]{64}"$/);
  expect(await client.fetchGuideResult()).toMatchObject({ok:false,failure:{code:'HOUSE_TRUST_REVOKED'}});
});

it('does not reuse standalone representations across unknown or changed subject generations',async()=>{
  const {entryDigest}=await import('../../../src/runtime/house-lifecycle/participation-journal.js');
  let token:object|undefined={},body='first';const headers:Headers[]=[];
  const client=new GuideClient({baseUrl:BASE,readGeneration:()=>token?{token,isCurrent:()=>true}:undefined,fetch:async(_url,init)=>{
    headers.push(new Headers(init?.headers));return new Response(body);
  }});
  await client.fetchGuideResult();await client.fetchGuideResult();
  expect(headers[1]?.get('if-none-match')).toBe(`"${entryDigest('first')}"`);
  token={};body='second';await client.fetchGuideResult();expect(headers[2]?.has('if-none-match')).toBe(false);
  token=undefined;await client.fetchGuideResult();expect(headers[3]?.has('if-none-match')).toBe(false);
  await client.fetchGuideResult();expect(headers[4]?.has('if-none-match')).toBe(false);
});


describe('safe guide failure observations', () => {
  it.each([
    ['ENOTFOUND', 'dns'], ['EAI_AGAIN', 'dns'], ['ERR_TLS_CERT_ALTNAME_INVALID', 'tls'],
    ['ECONNRESET', 'connection'], ['UND_ERR_CONNECT_TIMEOUT', 'timeout'], ['NOT_ALLOWED_SECRET', 'unknown'],
  ])('classifies %s without returning transport details', async (code, cause) => {
    let now = 100;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
    try {
      const client = new GuideClient({baseUrl:BASE,fetch:async () => {
        now = 147;
        throw new TypeError('SECRET auth/body/message', {cause:Object.assign(new Error('SECRET stack/env'), {code})});
      }});
      const result = await client.fetchGuideResult();
      expect(result).toMatchObject({ok:false,failure:{code:cause === 'timeout' ? 'HOUSE_REMOTE_TIMEOUT' : 'HOUSE_REMOTE_NETWORK',
        diagnostic:{phase:'fetch',cause,elapsedMs:47,cancellation:'none'}}});
      expect(JSON.stringify(result)).not.toMatch(/SECRET|ENOTFOUND|stack|auth|NOT_ALLOWED/);
      if (!result.ok) {
        const rendered = formatHouseReadFailure('en', result.failure);
        expect(rendered).toContain('elapsed_ms=47');
        expect(rendered).toContain('cancellation=none');
        expect(rendered).not.toContain('SECRET');
      }
    } finally {clock.mockRestore();}
  });

  it('observes body failure and retains the nullable facade', async () => {
    const client = new GuideClient({baseUrl:BASE,fetch:async () => new Response(new ReadableStream({start(c) {
      c.error(new TypeError('SECRET body', {cause:Object.assign(new Error('SECRET endpoint'),{code:'ECONNRESET'})}));
    }}))});
    expect(await client.fetchGuideResult()).toMatchObject({ok:false,failure:{diagnostic:{phase:'body',cause:'connection',cancellation:'none'}}});
    expect(await client.fetchGuideText()).toBeNull();
  });

  it('separates its deadline from an action cancellation', async () => {
    const deadline = vi.spyOn(AbortSignal,'timeout').mockReturnValue(AbortSignal.abort(new DOMException('SECRET deadline','TimeoutError')));
    try {
      const client = new GuideClient({baseUrl:BASE,fetch:async () => {throw new TypeError('SECRET transport');}});
      expect(await client.fetchGuideResult()).toMatchObject({ok:false,failure:{code:'HOUSE_REMOTE_TIMEOUT',
        diagnostic:{phase:'fetch',cause:'timeout',timeoutMs:10000,cancellation:'deadline'}}});
      expect(deadline).toHaveBeenCalledWith(10000);
    } finally {deadline.mockRestore();}
    const controller = new AbortController();
    const client = new GuideClient({baseUrl:BASE,fetch:async () => {
      controller.abort(new Error('SECRET owner cancellation'));
      throw new DOMException('SECRET aborted','AbortError');
    }});
    const result = await withAction({signal:controller.signal,isActive:()=>true},()=>client.fetchGuideResult());
    expect(result).toMatchObject({ok:false,failure:{code:'HOUSE_REMOTE_NETWORK',diagnostic:{cause:'aborted',cancellation:'action'}}});
    expect(JSON.stringify(result)).not.toContain('SECRET');
  });

  it('keeps lifecycle refusals and marks an unobserved delegated phase honestly', async () => {
    const client = new GuideClient({baseUrl:BASE,readGuide:async () => {
      throw new ActionInactiveError('HOUSE_TRUST_REVOKED',BASE);
    }});
    expect(await client.fetchGuideResult()).toMatchObject({ok:false,failure:{code:'HOUSE_TRUST_REVOKED',
      diagnostic:{phase:'delegate',cause:'unknown',cancellation:'none'}}});
  });
});


it('does not overwrite a delegated transport diagnostic with an unknown outer phase',async()=>{
  const failure={code:'HOUSE_REMOTE_NETWORK' as const,origin:BASE,
    diagnostic:{phase:'body' as const,cause:'dns' as const,elapsedMs:29,cancellation:'none' as const}};
  const client=new GuideClient({baseUrl:BASE,readGuide:async()=>{throw new RemoteHouseReadError(failure);}});
  expect(await client.fetchGuideResult()).toEqual({ok:false,failure});
});
