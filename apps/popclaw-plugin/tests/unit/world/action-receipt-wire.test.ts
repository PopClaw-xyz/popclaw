import { describe, expect, it } from 'vitest';
import { popclaw } from '@popclaw/contracts';
import { cidFromCanonical } from '@popclaw/algorithms';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { canonicalWorldCore, extractActionStatusResponse, inspectActionWire, verifyActionReceipt, worldSigningInput, type StoredActionIdentity } from '../../../src/world/action-wire.js';
import { ACTION_SELECTION_PROFILE, copyActionSelectionEvidence, decodeActionSelectionEvidence, encodeActionSelectionEvidence, type ActionSelectionEvidenceV1, type ActionAttachment } from '../../../src/world/action-client.js';
const key = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(27)), actor = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(28));
const keyId = bs58.encode(key.publicKey), actorId = bs58.encode(actor.publicKey), utf8 = new TextEncoder();
const house = {origin:'https://wire.invalid',houseKey:keyId,incarnation:'inc1'};
function context(allowed: ActionAttachment[] = [], required: ActionAttachment[] = [], consistency: ActionSelectionEvidenceV1['consistency'] = 'none') {
  const schema = {type:'object',properties:{done:{type:'boolean'}},required:['done'],additionalProperties:false};
  const guideBytes = utf8.encode('A fixed guide.');
  const row = {kind:'test.act',schema_version:1,transport:'house',signer:'user',description:'Test',params_schema:{type:'object'},result_schema:schema,result_attachments:{allowed,required_on_success:required},consistency};
  const manifest = {house_session:{version:1,endpoint:'/v1/house-session',ack_pubkey:Buffer.from(key.publicKey).toString('hex'),operations:['enter']},
    world_interaction:{version:1,actions:{status_endpoint:'/v1/world-actions/status',result_authority_pubkey:keyId,kinds:['test.act'],attachments:allowed},guide:{path:'/v1/guide.md',sha256:cidFromCanonical(guideBytes),revision:'g1'},
      ...(consistency !== 'none' ? {public_stream:{endpoint:'/v1/world-stream',mode:'public-v1',log_incarnation:'log1',envelope_baseline: 'public-envelope-02' as const, initial_public_scopes:[]}} : {})},
    intent_kinds:[row,{kind:'unrelated.legacy',uninterpreted:true}],event_kinds:[{kind:'test.state',schema_version:1,body_schema:{type:'object'}}]};
  const manifestBytes = utf8.encode(JSON.stringify(manifest)), capabilityRevision = cidFromCanonical(manifestBytes);
  const core = {house,manifestDigest:capabilityRevision,signedAt:900};
  const proofBytes = canonicalWorldCore(popclaw.world.ManifestProof,{...core,authoritySignature:nacl.sign.detached(worldSigningInput('POPCLAW_WORLD_MANIFEST_PROOF_V1',canonicalWorldCore(popclaw.world.ManifestProof,core)),key.secretKey)});
  const selection: ActionSelectionEvidenceV1 = {profile:ACTION_SELECTION_PROFILE,house,actorId,capabilityRevision,manifestBytes,proofBytes,guideBytes,guideDigest:cidFromCanonical(guideBytes),kind:'test.act',schemaVersion:1,resultAuthorityKey:keyId,paramsSchema:row.params_schema,resultSchema:schema,allowed,requiredOnSuccess:required,consistency};
  const identity: StoredActionIdentity = {actorId,requestId:'a'.repeat(64),requestDigest:'b'.repeat(64),kind:'test.act',schemaVersion:1,selection,
    capabilities:{house,capabilityRevision,manifest,guide:'A fixed guide.'}};
  return {selection,identity};
}
const attachmentValues = {
  snapshot:{stateRef:'state1',stateRevision:'4',asOf:1000,schemaKind:'test.state',schemaVersion:1,body:utf8.encode('{}')},
  subscription:{house,actorId,participationId:'part1',descriptorRevision:'1',logIncarnation:'log1',scopes:['scope1'],barrierId:'barrier1'},
  participation:{version:1,house,actorId,participationId:'part1',revision:'1',windowId:'window1',windowOpensAt:900,windowClosesAt:2000,actionGroups:[{id:'group1',intentKinds:['test.act'],controlReset:'window'}],opportunities:[],budgets:[]},
};
function signed(identity: StoredActionIdentity, extras: Record<string,unknown> = {}, signingKey = key): Uint8Array {
  const body = utf8.encode('{"done":true}');
  const result = popclaw.world.ActionResult.fromObject({house,actorId,audienceId:actorId,requestId:identity.requestId,requestDigest:identity.requestDigest,kind:identity.kind,schemaVersion:identity.schemaVersion,capabilityRevision:identity.capabilities.capabilityRevision,
    status:3,statusRevision:'3',executionId:'exec1',code:'OK',committedAt:1000,resultBody:body,resultDigest:cidFromCanonical(body),...extras});
  return canonicalWorldCore(popclaw.world.SignedActionResult,{result,signature:nacl.sign.detached(worldSigningInput('POPCLAW_WORLD_ACTION_RESULT_V1',canonicalWorldCore(popclaw.world.ActionResult,result)),signingKey.secretKey)});
}
function wrap(field: number, value: Uint8Array): Uint8Array {
  const length: number[] = []; let n = value.length; do {length.push((n & 127) | (n >= 128 ? 128 : 0)); n = Math.floor(n/128);} while(n);
  return Uint8Array.from([field * 8 + 2,...length,...value]);
}
describe('first-release receipt verification and faithful raw evidence', () => {
  it.each(Array.from({length:8},(_,mask)=>mask))('validates attachment shape %i with installers disabled', async mask => {
    const kinds = (['snapshot','subscription','participation'] as const).filter((_,i)=>mask & (1<<i));
    const {identity} = context(kinds,kinds,kinds.includes('subscription') ? (kinds.includes('snapshot') ? 'snapshot_barrier':'stream') : 'none');
    const verified = await verifyActionReceipt(signed(identity,Object.fromEntries(kinds.map(kind=>[kind,kind === 'subscription' && !kinds.includes('snapshot') ? {...attachmentValues.subscription,barrierId:''} : attachmentValues[kind]]))),identity);
    expect(verified.result.status).toBe(3); expect(verified.attachmentContract.outcome).toBe('valid'); expect(verified.attachments).toHaveLength(kinds.length);
    for(const item of verified.attachments) expect(item).toMatchObject({validation:'valid',install:'not_selected',selection:null,retry:{attempts:0,nextAt:null}});
  });
  it('blocks a stream subscription barrier while preserving the authentic successful base and raw result',async()=>{
    const {identity}=context(['subscription'],['subscription'],'stream');
    const raw=signed(identity,{subscription:attachmentValues.subscription}), original=new Uint8Array(raw);
    const verified=await verifyActionReceipt(raw,identity);
    expect(verified.result.status).toBe(3);expect(verified.result.code).toBe('OK');
    expect(verified.attachmentContract).toEqual({outcome:'violated',reason:'ATTACHMENT_STREAM_BARRIER_FORBIDDEN'});
    expect(verified.attachments[0]).toMatchObject({validation:'valid',install:'blocked',reason:'ATTACHMENT_STREAM_BARRIER_FORBIDDEN'});
    expect(new Uint8Array(raw)).toEqual(original);
    const extracted=extractActionStatusResponse(wrap(1,raw));expect(new Uint8Array(extracted.signedResultBytes)).toEqual(original);
    expect((await verifyActionReceipt(signed(identity,{subscription:{...attachmentValues.subscription,barrierId:''}}),identity)).attachmentContract.outcome).toBe('valid');
  });
  it('retains a successful base when an attachment is invalid or unavailable', async () => {
    const {identity} = context(['snapshot'],['snapshot']);
    const invalid = await verifyActionReceipt(signed(identity,{snapshot:{...attachmentValues.snapshot,schemaVersion:2}}),identity);
    expect(invalid.result.status).toBe(3); expect(invalid.attachments[0]!.validation).toBe('invalid'); expect(invalid.attachmentContract.outcome).toBe('violated');
    delete identity.capabilities.manifest.event_kinds;
    const unavailable = await verifyActionReceipt(signed(identity,{snapshot:attachmentValues.snapshot}),identity);
    expect(unavailable.attachments[0]!.validation).toBe('unsupported'); expect(unavailable.attachmentContract.outcome).toBe('unsupported');
    const future=context(['participation']);
    expect((await verifyActionReceipt(signed(future.identity,{participation:{...attachmentValues.participation,version:2}}),future.identity)).attachments[0]!.validation).toBe('unsupported');
  });
  it('distinguishes missing success requirements from authentic rejection and partial rejection groups', async () => {
    const {identity} = context(['snapshot','subscription'],['snapshot','subscription'],'snapshot_barrier');
    expect((await verifyActionReceipt(signed(identity),identity)).attachmentContract).toMatchObject({outcome:'violated',reason:'REQUIRED_ATTACHMENT_MISSING'});
    const rejection = {status:4,statusRevision:'0',executionId:'',resultBody:new Uint8Array(),resultDigest:'',committedAt:0,code:'REJECTED'};
    expect((await verifyActionReceipt(signed(identity,rejection),identity)).attachmentContract.outcome).toBe('valid');
    const partial = await verifyActionReceipt(signed(identity,{...rejection,statusRevision:'2',committedAt:1000,snapshot:attachmentValues.snapshot}),identity);
    expect(partial.attachments[0]!.install).toBe('blocked'); expect(partial.attachmentContract.outcome).toBe('violated');
  });
  it('detects out-of-allowlist, cross-actor and U/P mismatch without losing the base', async () => {
    const base = context(); expect((await verifyActionReceipt(signed(base.identity,{snapshot:attachmentValues.snapshot}),base.identity)).attachments[0]!.reason).toBe('ATTACHMENT_NOT_ALLOWED');
    const {identity} = context(['subscription','participation'],['subscription'],'stream');
    const cross = await verifyActionReceipt(signed(identity,{subscription:{...attachmentValues.subscription,actorId:keyId}}),identity);
    expect(cross.attachments[0]!.validation).toBe('invalid');
    const mismatch = await verifyActionReceipt(signed(identity,{subscription:{...attachmentValues.subscription,barrierId:''},participation:{...attachmentValues.participation,participationId:'different'}}),identity);
    expect(mismatch.attachmentContract.reason).toBe('ATTACHMENT_PARTICIPATION_MISMATCH'); expect(mismatch.attachments.every(a=>a.install==='blocked')).toBe(true);
  });
  it('rejects signatures and base schema failures, and nonterminal or cancelled attachments', async () => {
    const {identity} = context();
    await expect(verifyActionReceipt(signed(identity,{},actor),identity)).rejects.toThrow('RESULT_SIGNATURE_INVALID');
    const body=utf8.encode('{"done":42}'); await expect(verifyActionReceipt(signed(identity,{resultBody:body,resultDigest:cidFromCanonical(body)}),identity)).rejects.toThrow();
    for(const status of [1,2,5]) await expect(verifyActionReceipt(signed(identity,{status,snapshot:attachmentValues.snapshot}),identity)).rejects.toThrow();
  });
  it('retains distinct compatible field order and extracts the exact original nested bytes', async () => {
    const {identity}=context(), raw=signed(identity), fields=inspectActionWire(raw,'SignedActionResult');
    const reordered=Uint8Array.from([...wrap(2,fields.get(2)![0]!),...wrap(1,fields.get(1)![0]!)]);
    expect([...reordered]).not.toEqual([...raw]); expect((await verifyActionReceipt(reordered,identity)).result.status).toBe(3);
    const outer=wrap(1,reordered), extracted=extractActionStatusResponse(outer);
    expect(extracted.sourceBytes).toEqual(outer); expect(extracted.signedResultBytes).toEqual(reordered); expect(extracted.observationBytes).toBeUndefined();
  });
  it('rejects unknown signed fields, duplicate singulars, malformed lengths, UTF-8 and explicit defaults', async () => {
    const {identity}=context(), raw=signed(identity), fields=inspectActionWire(raw,'SignedActionResult');
    await expect(verifyActionReceipt(Uint8Array.from([...raw,24,1]),identity)).rejects.toThrow('RESULT_WIRE_UNSUPPORTED');
    await expect(verifyActionReceipt(Uint8Array.from([...raw,...wrap(2,fields.get(2)![0]!)]),identity)).rejects.toThrow('RESULT_WIRE_DUPLICATE');
    expect(()=>inspectActionWire(Uint8Array.from([10,127,1]),'SignedActionResult')).toThrow('RESULT_WIRE_INVALID');
    expect(()=>inspectActionWire(Uint8Array.from([10,2,0xc0,0xaf]),'HouseBinding')).toThrow();
    expect(()=>inspectActionWire(Uint8Array.from([56,0]),'ActionResult')).toThrow('RESULT_WIRE_UNSUPPORTED');
  });
});
describe('bounded immutable original selection codec', () => {
  it('round-trips exact bytes without treating an unrelated malformed row as selected', () => {
    const {selection}=context(); const encoded=encodeActionSelectionEvidence(selection), restored=decodeActionSelectionEvidence(encoded);
    expect(restored).toEqual({...selection,proofBytes:new Uint8Array(selection.proofBytes)}); expect(restored.manifestBytes).not.toBe(selection.manifestBytes);
    const owned=copyActionSelectionEvidence(selection); selection.guideBytes[0]=0; expect(owned.guideBytes[0]).not.toBe(0);
  });
  it('rejects substituted original evidence, redundant schema authority, unknown profile and accessors', () => {
    const {selection}=context();
    for(const altered of [{...selection,resultAuthorityKey:actorId},{...selection,paramsSchema:{type:'string'}},{...selection,guideDigest:'a'.repeat(64)},{...selection,profile:'future'}, {...selection,allowed:['snapshot','snapshot']}]) expect(()=>copyActionSelectionEvidence(altered as ActionSelectionEvidenceV1)).toThrow();
    const accessor={...selection}; Object.defineProperty(accessor,'guideDigest',{get(){throw new Error('getter ran');},enumerable:true});
    expect(()=>copyActionSelectionEvidence(accessor)).toThrow('ACTION_CONTEXT_UNSUPPORTED');
    expect(()=>decodeActionSelectionEvidence(new Uint8Array(2097153))).toThrow('ACTION_CONTEXT_SIZE_LIMIT');
    const encoded=JSON.parse(new TextDecoder().decode(encodeActionSelectionEvidence(selection))); encoded.guideBytes='Zg';
    expect(()=>decodeActionSelectionEvidence(utf8.encode(JSON.stringify(encoded)))).toThrow();
  });
});
