/** One normal per-House selection; every prepared result owns its evidence. */
import { popclaw } from '@popclaw/contracts';
import { cidFromCanonical } from '@popclaw/algorithms';
import bs58 from 'bs58';
import type { HostDb } from '../host/host-db.js';
import type { HouseRuntime } from '../runtime/house-lifecycle/house-runtime.js';
import { prepareConfirmHouseTrust, verifiedManifestBytes, commitHouseTrust } from '../world/house-trust.js';
import { pinnedBinding } from '../world/house-binding-pin.js';
import { verifyManifestProof } from '../world/house-binding.js';
import { parseWorldManifest } from '../world/json-profile.js';
import { readHouseCapabilityView, currentVerifiedManifestDigest } from '../world/world-capabilities.js';
import { isLoopbackOrigin } from '../social-graph/relation-host.js';
import { PublicFeedDisplay, type PublicDisplayItem, type PublicDisplaySource, type PublicDisplayQuery, type PublicDisplayResult } from './public-feed-display.js';
import { WorldFeedClient, type WorldFeedQuery, type SnapshotSource } from './world-feed-client.js';
import type { HouseStore } from './world-feed-store.js';
import { verifyInboundEnvelope } from './verify-envelope.js';
import { decodeEnvelopeBody, numberOrZero } from './feed-item-projection.js';

/** Existing endpoint provides a bounded snapshot, without history/window coverage. */
export const ORDINARY_SNAPSHOT_LIMIT = 1000;
export interface OrdinaryFeedEvidence {
  readonly manifest: string;
  readonly proof: string;
}
export interface OrdinaryFeedSource {
  readonly store: HouseStore;
  readonly authority: string;
  readonly evidence: OrdinaryFeedEvidence;
  readonly items: readonly PublicDisplayItem[];
  readonly status: PublicDisplaySource;
  assertCurrent(): void;
}
interface PreparedSource {
  status: PublicDisplaySource;
  items: readonly PublicDisplayItem[];
  check(): void;
  ordinary?: OrdinaryFeedSource;
  display?: PublicFeedDisplay;
}
const unavailable = (store: HouseStore, error: unknown): PublicDisplaySource => ({
  origin:store.baseUrl,slug:store.slug,capabilityRevision:'',logIncarnation:'',history:false,
  incomplete:true,unavailable:true,truncated:false,observedAt:null,
  code:error instanceof Error ? error.message : 'HOUSE_FEED_UNAVAILABLE',
});

/** Validate exactly the served ordinary declaration against the already trusted pin. */
export function verifyOrdinaryFeedManifest(db: HostDb, origin: string, evidence: OrdinaryFeedEvidence) {
  if(typeof evidence.manifest!=='string'||evidence.manifest.length>349528||typeof evidence.proof!=='string'||evidence.proof.length>8192)
    throw new Error('ORDINARY_FEED_MANIFEST_EVIDENCE_INVALID');
  const bytes = new Uint8Array(Buffer.from(evidence.manifest,'base64'));
  const document = parseWorldManifest(bytes,new Map()), pin = pinnedBinding(db,origin);
  if (!pin || pin.blockedReason) throw new Error('ORDINARY_FEED_NOT_TRUSTED');
  const binding = verifyManifestProof({origin,rawBytes:bytes,proofHeader:evidence.proof,pinnedHouseKey:pin.houseKey});
  if (binding.incarnation !== pin.incarnation) throw new Error('ORDINARY_FEED_INCARNATION_CHANGED');
  if (currentVerifiedManifestDigest(db,pin) !== binding.manifestDigest) throw new Error('ORDINARY_FEED_MANIFEST_CHANGED');
  // Presence, even malformed, cannot select this adapter after typed refusal.
  if (Object.hasOwn(document,'world_interaction')) throw new Error('ORDINARY_FEED_NOT_SELECTED');
  const read = document.read_auth as {schemes?:unknown} | undefined, core = document.core_primitives as Record<string,unknown> | undefined;
  if (!Array.isArray(read?.schemes) || !read.schemes.includes('popclaw-identity-read-v2')
    || core?.profile !== true || core.follow !== true || core.directed_delivery !== true)
    throw new Error('ORDINARY_FEED_UNSUPPORTED');
  const ids = document.official_ids ?? [];
  if (!Array.isArray(ids) || ids.some(id => {try{return typeof id!=='string'||id.length>44||bs58.decode(id).length!==32;}catch{return true;}})) throw new Error('ORDINARY_FEED_OFFICIAL_IDS_INVALID');
  return {binding,officialIds:ids as string[]};
}

/** Relay projection supplies no body, author, CID or external source authority. */
export function ordinarySignedMaterial(raw: Uint8Array, officialIds: readonly string[], source: PublicDisplayItem['source']): PublicDisplayItem | undefined {
  const env = verifyInboundEnvelope(raw,{publicStream:true,isOfficialActor:id=>officialIds.includes(id)});
  if (!env.post && !env.reply) return undefined;
  const external = env.post?.origin, reply = env.reply?.inReplyTo;
  const decoded = decodeEnvelopeBody(raw);
  if (!decoded) throw new Error('ORDINARY_FEED_BODY_UNAVAILABLE');
  const nativeParent = !external && env.post && /^[a-f0-9]{64}$/.test(env.prevEventId ?? '') ? env.prevEventId : '';
  const quoted = nativeParent && env.post?.blocks?.some(b=>b.blockType===5 && b.content===`https://popclaw.me/post/${nativeParent}`);
  const item: popclaw.event.IWorldFeedItem = {
    eventId:env.eventId,platform:external?.platform || 'popclaw',platformPostId:external?.postId || env.eventId,
    platformPostCreatedAt:external?.createdAt || env.timestamp,
    authorPopclawId:external ? '' : env.actor!.popclawId,actorNickname:external ? '' : env.actor?.nickname ?? '',
    textPreview:decoded.text,originalUrl:external?.url ?? '',envelope:new Uint8Array(raw),...(external ? {origin:external} : {}),
    ...(reply ? {replyToPlatform:reply.platform,replyToPostId:reply.platformPostId,replyToAuthorPopclawId:reply.authorPopclawId} : {}),
    ...(nativeParent ? quoted ? {quotedEventId:nativeParent} : {replyToPlatform:'popclaw',replyToPostId:nativeParent} : {}),
  };
  return {item,body:decoded.text,kind:env.post ? 'post' : 'reply',media:decoded.media,relaySnapshot:false,mirrorSigner:!!external,source};
}

class PreparedHouseFeed extends PublicFeedDisplay {
  constructor(private readonly captured: readonly PreparedSource[]) { super({sources:()=>[]}); }
  get ordinarySources(): readonly OrdinaryFeedSource[] { return this.captured.flatMap(s=>s.ordinary ? [s.ordinary] : []); }
  override read(query: PublicDisplayQuery = {}): PublicDisplayResult { return this.queryPrepared(query); }
  override search(term: string, limit=10): PublicDisplayResult { return this.queryPrepared({limit,includeThreads:true},term); }
  private queryPrepared(query: PublicDisplayQuery, search=''): PublicDisplayResult {
    const sources: PublicDisplaySource[] = [], merged = new Map<string,PublicDisplayItem>();
    const terms=search.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    for (const captured of this.captured) {
      try { captured.check(); } catch (error) { sources.push({...captured.status,unavailable:true,incomplete:true,code:error instanceof Error ? error.message : 'HOUSE_FEED_CHANGED'}); continue; }
      const publicResult=captured.display ? (search ? captured.display.search(search,100) : captured.display.read({...query,limit:100})) : undefined;
      sources.push({...publicResult?.sources[0] ?? captured.status});
      for (const hit of publicResult?.items ?? captured.items) {
        if (query.author && (hit.mirrorSigner || hit.item.authorPopclawId !== query.author)) continue;
        if (query.platform && hit.item.platform !== query.platform) continue;
        if (query.includeThreads === false && hit.item.replyToPostId && !hit.item.quotedEventId) continue;
        const text=[hit.body,hit.kind,hit.item.handle,hit.item.actorNickname,hit.item.originalUrl,hit.item.origin?.url].join(' ').toLocaleLowerCase();
        if (!publicResult && terms.some(t=>!text.includes(t))) continue;
        const id=hit.item.eventId!, first=merged.get(id);
        if (first) merged.set(id,{...first,alsoInHouses:[...(first.alsoInHouses??[]),hit.source.slug]});
        else merged.set(id,structuredClone(hit));
      }
    }
    const items=[...merged.values()].sort((a,b)=>numberOrZero(b.item.platformPostCreatedAt)-numberOrZero(a.item.platformPostCreatedAt)||a.item.eventId!.localeCompare(b.item.eventId!));
    const limit=Number.isSafeInteger(query.limit)&&query.limit!>0 ? Math.min(query.limit!,100) : 20;
    return {items:items.slice(0,limit),sources,truncated:items.length>limit||sources.some(s=>s.truncated)};
  }
}

export class HouseFeedReader extends PublicFeedDisplay implements SnapshotSource {
  constructor(private readonly deps: {db:HostDb;houses:HouseRuntime;stores:()=>readonly HouseStore[]}) {
    super({sources:()=>deps.stores().map(store=>({origin:store.baseUrl,slug:store.slug,capture:()=>deps.houses.capturePublicDisplay(store)}))});
  }
  store(origin:string,slug:string): HouseStore | undefined { return this.deps.stores().find(s=>s.baseUrl===origin&&s.slug===slug); }
  ordinaryEvidence(origin:string,evidence:OrdinaryFeedEvidence){
    if(readHouseCapabilityView(this.deps.db,origin))throw new Error('ORDINARY_FEED_SELECTION_CHANGED');
    return verifyOrdinaryFeedManifest(this.deps.db,origin,evidence);
  }
  override async prepare(query: PublicDisplayQuery = {}): Promise<PreparedHouseFeed> {
    const captured: PreparedSource[] = [];
    for (const store of this.deps.stores()) {
      let ordinarySelected = false;
      try {
        // Existing verified optional observation retains its selected journal, including history/refusal.
        if (readHouseCapabilityView(this.deps.db,store.baseUrl)) {
          captured.push(this.publicSource(store)); continue;
        }
        const before=this.deps.houses.captureOrdinaryFeed(store); before.assertCurrent();
        const trust=await prepareConfirmHouseTrust(this.deps.db,store.baseUrl,{fetch:this.deps.houses.houseReadFetch(store.baseUrl),allowInsecureOrigin:isLoopbackOrigin(store.baseUrl)});
        before.assertCurrent();
        if(!trust.ok)throw new Error(trust.refusal);
        const rawBytes=new Uint8Array(verifiedManifestBytes(trust.prepared)!);
        const document=parseWorldManifest(rawBytes,new Map());
        const committed=commitHouseTrust(this.deps.db,trust.prepared);
        if(!committed.ok)throw new Error(committed.refusal);
        const capture=this.deps.houses.captureOrdinaryFeed(store);capture.assertCurrent();
        if (Object.hasOwn(document,'world_interaction')) { captured.push(this.publicSource(store)); continue; }
        const evidence={manifest:Buffer.from(rawBytes).toString('base64'),proof:Buffer.from(committed.binding.proofBytes).toString('base64')};
        const verified=verifyOrdinaryFeedManifest(this.deps.db,store.baseUrl,evidence);
        ordinarySelected = true;
        const client=new WorldFeedClient({baseUrl:store.baseUrl,fetch:this.deps.houses.houseReadFetch(store.baseUrl),isOfficialActor:id=>verified.officialIds.includes(id)});
        const rows=await client.fetchSnapshot({limit:ORDINARY_SNAPSHOT_LIMIT,...(query.author ? {author:query.author} : {}),...(query.platform ? {platform:query.platform} : {})});
        capture.assertCurrent();
        if (rows.length>ORDINARY_SNAPSHOT_LIMIT) throw new Error('ORDINARY_FEED_SNAPSHOT_LIMIT_EXCEEDED');
        const observedAt=Math.floor(Date.now()/1000),source={origin:store.baseUrl,slug:store.slug,observedAt,sequence:'',logIncarnation:''};
        const items: PublicDisplayItem[]=[];
        for (const row of rows) {
          if (!row.envelope?.length) throw new Error('ORDINARY_FEED_ENVELOPE_REQUIRED');
          const hit=ordinarySignedMaterial(row.envelope,verified.officialIds,source);
          if (!hit) continue;
          if (query.author && !hit.mirrorSigner && hit.item.authorPopclawId!==query.author) throw new Error('ORDINARY_FEED_AUTHOR_MISMATCH');
          if (query.platform && hit.item.platform!==query.platform) throw new Error('ORDINARY_FEED_PLATFORM_MISMATCH');
          if (!query.author || !hit.mirrorSigner) items.push(hit);
        }
        const check=()=>{capture.assertCurrent();verifyOrdinaryFeedManifest(this.deps.db,store.baseUrl,evidence);
          if (readHouseCapabilityView(this.deps.db,store.baseUrl)) throw new Error('ORDINARY_FEED_SELECTION_CHANGED');};
        check();
        // Existing writable projection retains the exact signed envelope for later material checks.
        if (!store.cacheReadOnly) store.db.transaction(()=>{check();for(const hit of items) store.cache.record(hit.item);check();});
        const status:PublicDisplaySource={origin:store.baseUrl,slug:store.slug,protocol:'ordinary-snapshot',capabilityRevision:verified.binding.manifestDigest,
          logIncarnation:'',history:false,incomplete:true,unavailable:false,truncated:rows.length===ORDINARY_SNAPSHOT_LIMIT,observedAt};
        const ordinary:OrdinaryFeedSource={store,authority:capture.authority,evidence,items,status,assertCurrent:check};
        captured.push({status,items,check,ordinary});
      } catch (error) { captured.push({status:{...unavailable(store,error),...(ordinarySelected?{protocol:'ordinary-snapshot' as const}:{})},items:[],check(){}}); }
    }
    return new PreparedHouseFeed(captured);
  }
  private publicSource(store: HouseStore): PreparedSource {
    const source={origin:store.baseUrl,slug:store.slug}, capture=this.deps.houses.capturePublicDisplay(store);
    const display=new PublicFeedDisplay({sources:()=>[{...source,capture:()=>capture}]});
    const result=display.read({limit:100,includeThreads:true});
    return {status:result.sources[0]!,items:[],display,check:()=>capture.assertCurrent()};
  }
  async fetchSnapshot(query: WorldFeedQuery): Promise<popclaw.event.IWorldFeedItem[]> {
    const prepared=await this.prepare(query),result=prepared.read({...query,includeThreads:true});
    if (result.sources.every(s=>s.unavailable)) throw new Error('HOUSE_FEED_UNAVAILABLE');
    return result.items.map(hit=>({...hit.item,textPreview:hit.body,houseSlug:hit.source.slug}));
  }
}

export const ordinaryEnvelopeDigest = (raw: Uint8Array): string => cidFromCanonical(raw);
