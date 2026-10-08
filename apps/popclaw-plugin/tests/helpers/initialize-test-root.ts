/** Initialize only an owned, fresh fixture through the production admission,
 * migrations and profile completion. Call before seeding config or business data.
 * An existing fixture identity is preserved; incomplete histories are refused.
 */
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import {PopclawPaths} from '../../src/host/popclaw-paths.js';
import {LocalHostAdapter} from '../../src/host/local-host-adapter.js';
import {completeStorageInitialization, inspectStorageCompatibility} from '../../src/host/storage-compatibility.js';

export function initializeTestRoot(root: string): string {
  const paths = new PopclawPaths(root);
  const admission = inspectStorageCompatibility({paths, migrationsDir: fileURLToPath(new URL('../../migrations', import.meta.url))});
  if (!['new', 'identity-only'].includes(admission.status)) throw new Error(`Fixture must start before data seeding: ${admission.reason}`);
  const file = join(paths.identityDir(), 'master.key');
  if (!existsSync(file)) {
    const seed = nacl.randomBytes(32), pair = nacl.sign.keyPair.fromSeed(seed);
    mkdirSync(paths.identityDir(), {recursive: true});
    writeFileSync(file, JSON.stringify({version: 1, type: 'master-raw-seed', created_at: new Date().toISOString(),
      public_key: bs58.encode(pair.publicKey), seed: Buffer.from(seed).toString('hex')}), {mode: 0o600, flag: 'wx'});
  }
  const actorId = (JSON.parse(readFileSync(file, 'utf8')) as {public_key: string}).public_key;
  const host = new LocalHostAdapter({dataRoot: root, logger: {info() {}, warn() {}, error() {}}});
  try { completeStorageInitialization(host, actorId); } finally { host.db.close(); }
  return actorId;
}
