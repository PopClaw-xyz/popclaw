import { it, expect } from 'vitest';
import { createServer, type ServerResponse } from 'node:http';
import EventSource from 'eventsource';
import { popclaw } from '@popclaw/contracts';
import { PublicWorldStreamClient } from '../../../src/ingress/public-world-stream-client.js';
import { WorldFeedStreamClient } from '../../../src/ingress/world-feed-stream-client.js';
import { InboxStreamClient } from '../../../src/messaging/inbox-stream-client.js';
import { SseIngress } from '../../../src/ingress/sse-ingress.js';
import { LocalHostDb } from '../../../src/host/local-host-db.js';
import { signedFixtureEnvelope } from '../../helpers/signed-envelope.js';

function deferred<T>() { let resolve!: (value:T)=>void; const promise=new Promise<T>(r=>{resolve=r;});return {promise,resolve}; }
const delay=(ms:number)=>new Promise<void>(r=>setTimeout(r,ms));
// Real eventsource@2 with shortened retry cadence only; parser, internal
// lastEventId and HTTP reconnect behavior are unchanged.
class FastEventSource extends EventSource {
  constructor(url:string,opts?:any) {
    super(url,opts);
    Object.defineProperty(this,'reconnectInterval',{get:()=>25,set:()=>{},configurable:true});
  }
}
async function listen(server: ReturnType<typeof createServer>) {
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  return `http://127.0.0.1:${(server.address() as {port:number}).port}`;
}
async function close(server: ReturnType<typeof createServer>) {
  server.closeAllConnections(); await new Promise<void>(resolve=>server.close(()=>resolve()));
}

it('native reconnect must resume from accepted durable cursor, not rejected SSE id',async()=>{
  const good=signedFixtureEnvelope('corrected seq 7');
  const bad={...good,signature:new Uint8Array(64)};
  const frame=(env:popclaw.event.IEventEnvelope)=>Buffer.from(popclaw.event.WorldStreamFrame.encode({seq:7,kind:'post',envelope:popclaw.event.EventEnvelope.encode(env).finish()}).finish()).toString('base64');
  const requests: Array<{url:string;lastEventId:string}>=[];
  const reconnected=deferred<void>();let delivered=0;let rejectedCursor:number|undefined;const errors:string[]=[];
  const server=createServer((req,res)=>{
    requests.push({url:req.url!,lastEventId:String(req.headers['last-event-id']??'')});
    res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache'});
    if(requests.length===1) res.end(`id: 7\ndata: ${frame(bad)}\n\nid: 8\ndata: ${frame(good)}\n\n`);
    else {
      // Real server precedence: Last-Event-ID overrides URL's durable after.
      const after=Number(req.headers['last-event-id']??new URL(req.url!,'http://local').searchParams.get('after')??0);
      if(after<7) res.write(`id: 7\ndata: ${frame(good)}\n\n`);else res.write(': heartbeat\n\n');
      reconnected.resolve();
    }
  });
  const db=new LocalHostDb(':memory:');
  const client=new PublicWorldStreamClient({baseUrl:await listen(server),db,eventSourceCtor:FastEventSource as any,reconnectDelayMs:25,onError:e=>{errors.push(String(e));if(String(e).includes('SIGNATURE_INVALID'))rejectedCursor=client.cursor();}});
  try {
    await client.start(()=>{delivered++;});
    await reconnected.promise;await delay(25);
    console.log('REJECTED_SSE_ID_RECONNECT',JSON.stringify({requests,cursor:client.cursor(),delivered,errors}));
    expect(errors.some(e=>e.includes('SIGNATURE_INVALID'))).toBe(true);
    expect(rejectedCursor).toBe(0);
    expect(client.cursor()).toBe(7);
    expect(requests[1]!.lastEventId,'rejected envelope must never become the reconnect cursor').toBe('');
    expect(delivered,'valid replay after rejection should be admitted').toBe(1);
  }finally{await client.stop();await close(server);db.close();}
});

for(const kind of ['public','world-feed','inbox','sse'] as const) it(`${kind} native retry must not reconnect after persistent gate revocation`,async()=>{
  let active=true;const gate={isActive:()=>active,signal:new AbortController().signal};
  const first=deferred<ServerResponse>();const next=deferred<void>();let connections=0;const states:boolean[]=[];
  const server=createServer((_req,res)=>{
    connections++;states.push(active);res.writeHead(200,{'content-type':'text/event-stream'});res.write(': ready\n\n');
    if(connections===1)first.resolve(res);else next.resolve();
  });
  const baseUrl=await listen(server);const db=new LocalHostDb(':memory:');
  const client=kind==='public'?new PublicWorldStreamClient({baseUrl,db,gate,eventSourceCtor:FastEventSource as any}):
    kind==='world-feed'?new WorldFeedStreamClient({baseUrl,gate,eventSourceCtor:FastEventSource as any,onItem:()=>{}}):
    kind==='sse'?new SseIngress({baseUrl,gate,eventSourceCtor:FastEventSource as any},{logger:{info(){},warn(){},error(){}},timer:{schedule:(ms:number,cb:()=>void)=>{const t=setTimeout(cb,ms);return {cancel:()=>clearTimeout(t)};}}} as any):
    new InboxStreamClient({baseUrl,gate,eventSourceCtor:FastEventSource as any,recipientPopclawId:'synthetic-recipient',readToken:async()=>'synthetic-token',onMessage:()=>{}});
  try {
    if(kind==='sse')await (client as SseIngress).start(()=>{});else await (client as Exclude<typeof client,SseIngress>).start();
    const response=await first.promise;
    active=false;response.end();
    await Promise.race([next.promise,delay(180)]);
    console.log('GATE_NATIVE_RECONNECT',JSON.stringify({kind,connections,activeAtEachRequest:states,abortNotNotified:!gate.signal.aborted}));
    expect(connections,'no new transport request after durable gate is false even before local abort notification').toBe(1);
  }finally{await client.stop();await close(server);db.close();}
});

for (const kind of ['public', 'world-feed', 'inbox', 'sse'] as const) it(`${kind} application retry checks revocation after scheduling`, async () => {
  let active = true;
  const gate = { isActive: () => active, signal: new AbortController().signal };
  const first = deferred<ServerResponse>();
  const disconnected = deferred<void>();
  let connections = 0;
  const server = createServer((_req, res) => {
    connections++;
    res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': ready\n\n');
    first.resolve(res);
  });
  const baseUrl = await listen(server);
  const db = new LocalHostDb(':memory:');
  const common = { baseUrl, gate, eventSourceCtor: FastEventSource as any, reconnectDelayMs: 80, onError: () => disconnected.resolve() };
  const client = kind === 'public' ? new PublicWorldStreamClient({ ...common, db }) :
    kind === 'world-feed' ? new WorldFeedStreamClient({ ...common, onItem: () => {} }) :
    kind === 'inbox' ? new InboxStreamClient({ ...common, recipientPopclawId: 'synthetic', readToken: async () => 'synthetic', onMessage: () => {} }) :
    new SseIngress({ ...common, baseBackoffMs: 80 }, {
      logger: { info() {}, warn() { disconnected.resolve(); }, error() {} },
      timer: { schedule: (ms: number, cb: () => void) => { const t = setTimeout(cb, ms); return { cancel: () => clearTimeout(t) }; } },
    } as any);
  try {
    if (kind === 'sse') await (client as SseIngress).start(() => {});
    else await (client as Exclude<typeof client, SseIngress>).start();
    (await first.promise).end();
    await disconnected.promise;
    active = false;
    await delay(200);
    expect(connections).toBe(1);
  } finally { await client.stop(); await close(server); db.close(); }
});
