import { existsSync, lstatSync, readdirSync, readFileSync, mkdirSync, openSync, closeSync, writeFileSync, constants } from 'node:fs';
import { dirname, join, resolve, isAbsolute, parse } from 'node:path';
import { Keystore } from '../identity/keystore.js';
import { PopclawPaths } from '../host/popclaw-paths.js';
import type { HostAdapter, HostStorage } from '../host/host-adapter.js';

export function safeAbsolute(path: string): string {
  if (!isAbsolute(path) || resolve(path) !== path) throw new Error('Use a normalized absolute path');
  let cursor = parse(path).root;
  for (const part of path.slice(cursor.length).split('/').filter(Boolean)) {
    cursor = join(cursor, part);
    try { const stat = lstatSync(cursor); if (stat.isSymbolicLink()) throw new Error(`Symlink path refused: ${cursor}`); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  return path;
}
export interface RootCredential {
  format: 1; root: string; popclawId: string; initialRuntimeDigest: string;
  identityOrigin: 'created_by_setup' | 'existing_key';
  scope: 'setup-management-only';
}
const CREDENTIAL = '.popclaw-setup-root.json';
export function inspectRoot(root: string): { root: string; key: boolean; empty: boolean; credential?: RootCredential } {
  safeAbsolute(root);
  const keyPath = join(new PopclawPaths(root).identityDir(), 'master.key');
  const files: string[] = [];
  function walk(path: string) {
    if (!existsSync(path)) return;
    for (const entry of readdirSync(path)) {
      const child = join(path, entry); const stat = lstatSync(child);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw new Error('Unsupported link or special file in identity root');
      if (stat.isDirectory()) walk(child); else files.push(child);
    }
  }
  walk(root);
  const key = files.includes(keyPath);
  const credentialPath = join(root, CREDENTIAL);
  let credential: RootCredential | undefined;
  if (files.includes(credentialPath)) {
    try {
      credential = JSON.parse(readFileSync(credentialPath, 'utf8')) as RootCredential;
      if (credential.format !== 1 || credential.root !== root || credential.scope !== 'setup-management-only'
        || !['created_by_setup', 'existing_key'].includes(credential.identityOrigin)
        || typeof credential.popclawId !== 'string' || !credential.popclawId
        || !/^[0-9a-f]{64}$/.test(credential.initialRuntimeDigest)) throw new Error('invalid');
    } catch { throw new Error('Invalid setup root credential; restore the original management record before reconnecting'); }
  }
  if (!key && files.length) throw new Error('Root contains history without master.key. Restore the original identity from backup; no identity was created.');
  if (!credential && files.some(file => file !== keyPath)) throw new Error(
    'Existing root contains unverified history/schema; in-place setup is refused. Preserve this root and use a reviewed migration separately.');
  // A credential proves only an existing local management relationship and actor.
  // Additional regular data files remain opaque: setup never opens or migrates them.
  return { root, key, empty: !files.length, credential };
}

export function claimRoot(root: string, popclawId: string, initialRuntimeDigest: string, identityOrigin: RootCredential['identityOrigin']): RootCredential {
  const state = inspectRoot(root);
  if (!state.key) throw new Error('Cannot manage a root without its existing identity');
  if (state.credential) {
    if (state.credential.popclawId !== popclawId) throw new Error('Root credential identity mismatch; no binding was changed');
    return state.credential;
  }
  // inspectRoot accepted only master.key, so adopting this local root does not
  // imply that its identity is new or has no remote history.
  const credential: RootCredential = { format: 1, root, popclawId, initialRuntimeDigest, identityOrigin, scope: 'setup-management-only' };
  const path = safeAbsolute(join(root, CREDENTIAL));
  try {
    const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(fd, JSON.stringify(credential, null, 2) + '\n'); } finally { closeSync(fd); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const winner = inspectRoot(root).credential;
    if (!winner || winner.popclawId !== popclawId) throw new Error('Root credential changed concurrently');
    return winner;
  }
  return credential;
}

export async function identity(root: string, create = false): Promise<{ popclawId: string; created: boolean }> {
  const state = inspectRoot(root);
  if (!state.key && !create) throw new Error('No identity exists. Explicit --create-identity is required.');
  const keyPath = join(new PopclawPaths(root).identityDir(), 'master.key');
  const check = (ns: string, key: string) => { if (ns !== 'identity' || key !== 'master.key') throw new Error('Setup storage is identity-only'); safeAbsolute(keyPath); };
  const storage: HostStorage = {
    async read(ns, key) { check(ns, key); try { const fd = openSync(keyPath, constants.O_RDONLY | constants.O_NOFOLLOW); try { const bytes = readFileSync(fd); const envelope = JSON.parse(bytes.toString('utf8')); if (typeof envelope.seed !== 'string' || !/^[0-9a-f]{64}$/i.test(envelope.seed)) throw new Error('Invalid master.key seed encoding'); return bytes; } finally { closeSync(fd); } } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; } },
    async write(ns, key, bytes, options) {
      check(ns, key); if (!create || state.key || !options?.exclusive) throw new Error('Identity overwrite refused');
      inspectRoot(root); mkdirSync(dirname(keyPath), { recursive: true, mode: 0o700 });
      const fd = openSync(keyPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { writeFileSync(fd, bytes); } finally { closeSync(fd); }
    },
    async delete() { throw new Error('Identity deletion refused'); }, async list() { return []; }, pathFor() { return keyPath; },
  };
  // Keystore has no reason to mutate existing key permissions in a read-only plan.
  const denied = () => { throw new Error('Setup has no runtime or network capability'); };
  const host = { storage, clock: { now: () => new Date() }, logger: { info() {}, warn() {}, error() {} }, db: { queryOne: denied } } as unknown as HostAdapter;
  const keys = new Keystore(host);
  const result = state.key ? await keys.load() : await keys.loadOrGenerate();
  if (!result) throw new Error('Existing identity disappeared; recovery required');
  if (state.credential && state.credential.popclawId !== result.popclawId) throw new Error('Root credential identity mismatch; no binding was changed');
  const reopened = await keys.load();
  if (reopened?.popclawId !== result.popclawId) throw new Error('Identity changed during verification');
  return { popclawId: result.popclawId, created: !state.key };
}
