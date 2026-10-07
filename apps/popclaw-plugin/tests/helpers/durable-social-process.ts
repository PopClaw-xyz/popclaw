/** Synthetic identities, real SQLite and product command/signing code. No network. */
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import {LocalHostDb} from '../../src/host/local-host-db.js';
import {runMigrations} from '../../src/host/migrations.js';
import {MasterKeySigner} from '../../src/identity/master-key-signer.js';
import {actionSigner, assertActionActive} from '../../src/runtime/house-lifecycle/action-context.js';
import {registerWriteTools} from '../../src/tools/write-tools.js';
import {registerFeedbackCadenceTools} from '../../src/tools/feedback-cadence-tools.js';
import {setOwnerLang} from '../../src/lexicon/owner-language.js';
import type {ToolsCtx} from '../../src/tools/tools-context.js';
import {createDraftReviewFiles} from '../../src/host/draft-review-files.js';
import {ensureHouseLifecycleSchema} from '../../src/runtime/house-lifecycle/participation-store.js';

export const fixtureKey = (byte: number) => {
  const seed = new Uint8Array(32).fill(byte), pair = nacl.sign.keyPair.fromSeed(seed), id = bs58.encode(pair.publicKey);
  return {id, ...pair, signer: new MasterKeySigner({seed, ...pair, popclawId: id})};
};
export const fixtureContext = (overrides: Record<string, unknown> = {}) => ({
  agentId: 'main', sessionId: 'synthetic-session', sessionKey: 'agent:main:main', requesterSenderId: 'synthetic-human',
  messageChannel: 'weixin', agentAccountId: 'synthetic-account', nativeChannelId: 'synthetic-chat',
  deliveryContext: {channel: 'weixin', accountId: 'synthetic-account', to: 'synthetic-chat', threadId: 7},
  senderIsOwner: false, assertInvocationCurrent() {}, ...overrides,
});
export function durableFixture(root: string, options: {owner?: number; mode?: 'native' | 'local-stdio'; scope?: string; unknown?: boolean; generation?: number; origin?: string; revokeDuringSign?: () => void; durable?: boolean; migrationsDir?: string} = {}) {
  const owner = fixtureKey(options.owner ?? 3), recipient = fixtureKey(5), db = new LocalHostDb(join(root, 'host.db'));
  runMigrations(db, options.migrationsDir ?? fileURLToPath(new URL('../../migrations', import.meta.url)));
  ensureHouseLifecycleSchema(db);
  db.execute("INSERT OR IGNORE INTO house_participation (house_origin,installation_id,op_seq,desired,phase,session_id) VALUES (?,?,?,'enabled','connected',?)",
    [options.origin ?? 'https://house.fixture.invalid', 'synthetic-installation', options.generation ?? 1, 'synthetic-house-session']);
  if (options.generation) db.execute('UPDATE house_participation SET op_seq=? WHERE house_origin=?', [options.generation, options.origin ?? 'https://house.fixture.invalid']);
  db.execute('CREATE TABLE IF NOT EXISTS fixture_effects (id INTEGER PRIMARY KEY,house TEXT,bytes BLOB)');
  const signer = actionSigner({publicKey: owner.signer.publicKey.bind(owner.signer), popclawId: owner.signer.popclawId.bind(owner.signer),
    sign: async (bytes: Uint8Array) => {const result = await owner.signer.sign(bytes); options.revokeDuringSign?.(); return result;},
    sealDm: owner.signer.sealDm.bind(owner.signer), sealDmMedia: owner.signer.sealDmMedia.bind(owner.signer),
    openDm: owner.signer.openDm.bind(owner.signer), openDmMedia: owner.signer.openDmMedia.bind(owner.signer)});
  const house = 'house-fixture-invalid';
  const push = async (slug: string | undefined, bytes: Uint8Array) => {
    assertActionActive();
    db.execute('INSERT INTO fixture_effects (house,bytes) VALUES (?,?)', [slug ?? house, bytes]);
    if (options.unknown) throw new Error('SYNTHETIC_TRANSPORT_UNKNOWN_AFTER_EFFECT');
    return {status: 200};
  };
  const source = {handle: 'Alice', authorPopclawId: recipient.id, houseSlug: house, textPreview: 'Frozen parent', platformPostId: 'ab'.repeat(32)};
  const egress = {home: {slug: house}, push: (bytes: Uint8Array) => push(house, bytes), pushTo: push,
    capturePlan: () => ({targets: [{slug: house, origin: options.origin ?? 'https://house.fixture.invalid'}], egress})};
  const runtime = async () => ({host: {db},
    boot: {signer, nickname: 'Synthetic Owner', popclawId: owner.id, webBaseUrl: 'https://fixture.invalid', loreHouseUrl: 'https://house.fixture.invalid', loreHouseUrls: ['https://house.fixture.invalid']},
    egress, houseRuntime: {gateForSlug: () => ({generation: options.generation ?? 1})},
    bondsStore: {list: () => [{popclawId: recipient.id, nickname: 'Alice', remarkName: ''}]},
    knownFollowers: {allFollowerIds: () => [recipient.id]}, inboxStore: {houseOf: () => 'other-house', get: () => null},
    guideClient: {fetchGuideText: async () => `---\nfeedback:\n  popclaw_id: ${recipient.id}\n  contact: Alice\n---\nGuide`},
    worldFeedCache: {lookup: () => source, findByEventIdPrefix: () => ({item: source, ambiguous: []}), findFullEventId: () => ({full: source.platformPostId, ambiguous: []})},
  });
  const registrations = new Map<string, unknown>();
  const api = {registerTool: (value: unknown, opts?: unknown) => registrations.set((opts as {name: string})?.name ?? (value as {name: string}).name, value)};
  const deps = {api, runtime, socialSendHost: options.mode ?? 'native', durableSocialDrafts: options.durable ?? true,
    getLocalSocialScope: () => options.scope ?? 'synthetic-client',
    draftReviewFiles: options.mode === 'local-stdio' ? () => createDraftReviewFiles(join(root, 'review'), {staleAfterMs: Infinity}) : undefined};
  const ctx = {api, runtime, deps, total: 5} as unknown as ToolsCtx;
  registerWriteTools(ctx); registerFeedbackCadenceTools(ctx);
  const call = async (name: string, params: unknown, context: unknown = fixtureContext(), signal?: AbortSignal) => {
    const entry = registrations.get(name) as ((context: unknown) => unknown) | {create?: (context: unknown) => unknown};
    const tool = (typeof entry === 'function' ? entry(context) : entry.create!(context)) as {execute: (id: string, params: unknown, signal?: AbortSignal) => Promise<{text: string}>};
    return tool.execute('synthetic-call', params, signal);
  };
  const effects = () => db.queryAll<{house: string; bytes: Uint8Array}>('SELECT house,bytes FROM fixture_effects ORDER BY id');
  return {call, db, runtime, registrations, owner, recipient, effects};
}
if (process.argv[2] === '--durable-operation') {
  void (async () => {
  const input = JSON.parse(process.argv[3]!) as {root: string; name: string; params: unknown; options?: Parameters<typeof durableFixture>[1]; context?: Record<string, unknown>; advanceMs?: number; pressure?: number};
  if (input.advanceMs) {const now = Date.now(); Date.now = () => now + input.advanceMs!;}
  setOwnerLang('en', 'config');
  const fx = durableFixture(input.root, input.options);
  try {
    const result = await fx.call(input.name, input.params, fixtureContext(input.context));
    for (let n = 0; n < (input.pressure ?? 0); n++) await fx.call('popclaw_draft_message', {recipient: fx.recipient.id, body: `Pressure ${n}`});
    console.log(JSON.stringify({result, effects: fx.effects().map(row => ({house: row.house, bytes: Buffer.from(row.bytes).toString('base64')}))}));
  } catch (error) {console.log(JSON.stringify({error: String(error), effects: fx.effects().length}));}
  finally {fx.db.close();}
  })();
}
