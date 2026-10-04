import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { identity, inspectRoot, safeAbsolute, claimRoot } from './identity.js';
import { runtimePlan, copyRuntime, probeNative, stableNode } from './runtime.js';
import { setup as connect, commitFiles, probeMcp } from './connector.mjs';

export interface SetupOptions {
  package: string; host: 'claude' | 'codex' | 'both'; root?: string; project?: string;
  home?: string; appRoot?: string; createIdentity?: boolean; plan?: boolean;
  claudeProfile?: string; env?: NodeJS.ProcessEnv; beforeWrite?: (path: string, index: number) => void;
}
export async function setup(options: SetupOptions) {
  if (process.platform !== 'darwin' && process.platform !== 'linux') throw new Error('Setup supports tested POSIX environments only');
  const home = safeAbsolute(realpathSync(options.home ?? homedir()));
  const project = safeAbsolute(realpathSync(options.project ?? process.cwd()));
  const env = options.env ?? process.env;
  const node = stableNode(process.execPath);
  const appRoot = safeAbsolute(options.appRoot ?? join(home, '.local/share/popclaw'));
  const statePath = join(project, '.popclaw/setup.json'); safeAbsolute(statePath);
  const before = existsSync(statePath) ? readFileSync(statePath, 'utf8') : undefined;
  const previous = before !== undefined ? JSON.parse(before) : undefined;
  if (before !== undefined && (!previous || typeof previous !== 'object' || Array.isArray(previous) || previous.format !== 1 || typeof previous.root !== 'string' || typeof previous.package !== 'string' || typeof previous.popclawId !== 'string' || !['created_by_setup', 'existing_key'].includes(previous.identityOrigin))) throw new Error('Unknown setup record');
  let root = options.root ?? previous?.root ?? env.POPCLAW_DATA_ROOT;
  if (!root) {
    const state = env.OPENCLAW_STATE_DIR ?? join(home, '.openclaw');
    const candidates = [join(home, '.popclaw'), join(state, 'popclaw'), join(state, 'popclaw-data')].filter(p => existsSync(p));
    if (candidates.length > 1) throw new Error(`Multiple existing roots; select an explicit --root: ${candidates.join(', ')}`);
    root = candidates[0] ?? join(home, '.popclaw');
  }
  root = safeAbsolute(root);
  const state = inspectRoot(root);
  if (previous && previous.root !== root) throw new Error('Project identity differs; restore or remove its reviewed binding before selecting another root');
  const id = state.key ? await identity(root) : undefined;
  if (previous && (!id || previous.popclawId !== id.popclawId)) throw new Error('Project identity binding mismatch; restore the original key before reconnecting');
  if (previous && (!state.credential || previous.identityOrigin !== state.credential.identityOrigin)) throw new Error('Project root credential is missing or inconsistent; restore the original management record');
  if (!state.key && !options.createIdentity && !options.plan) throw new Error('Explicit --create-identity is required to create a local identity');
  const runtime = runtimePlan(safeAbsolute(options.package), appRoot);
  // Plan configuration before mutating any identity/runtime. Connector accepts this already inspected root.
  const planned = await connect({ ...options, package: options.package, root, home, project, env, node, planOnly: true, validateRoot: (p: string) => p === root, previousPackage: previous?.package, requireNewBinding: !previous });
  if (options.plan) return { root, identity: id, runtime: { target: runtime.target, digest: runtime.digest }, hosts: planned.hosts, createConfirmationRequired: !state.key, trust: 'pending-host-review', validation: 'not-run' };
  // Only explicit bundled ABI. No native fallback compiler or default House boot.
  probeNative(options.package, project);
  const installed = copyRuntime(runtime);
  const selected = id ?? await identity(root, true);
  await probeMcp(installed, root, node, env);
  const reopened = await identity(root);
  if (reopened.popclawId !== selected.popclawId) throw new Error('Identity changed during setup; configuration was not written');
  const credential = claimRoot(root, selected.popclawId, runtime.digest, id ? 'existing_key' : 'created_by_setup');
  const finalPlan = await connect({ ...options, package: installed, root, home, project, env, node, planOnly: true, validateRoot: (p: string) => p === root, previousPackage: previous?.package, requireNewBinding: !previous });
  const record = { initialMe: previous?.initialMe ?? {version:1,purpose:'initial_me_setup',origin:'https://house.popclaw.me',actorId:selected.popclawId,dataRoot:root,setupId:randomUUID()}, format: 1, root, identityOrigin: credential.identityOrigin, package: installed, digest: runtime.digest, popclawId: selected.popclawId, ...(previous?.package !== installed && previous ? { previousPackage: previous.package } : previous?.previousPackage ? { previousPackage: previous.previousPackage } : {}) };
  const after = JSON.stringify(record, null, 2) + '\n';
  // A missing plans array means the connector returned an abnormal shape: the
  // setup receipt must never be committed while the host config write is
  // undefined — fail loudly instead of silently skipping configuration.
  if (!Array.isArray(finalPlan.plans)) throw new Error('setup connector returned no write plan');
  const plans = [...finalPlan.plans, { path: statePath, before, after }];
  const backupBase = join(home, '.local/state/popclaw-setup', createHash('sha256').update(project).digest('hex').slice(0, 16));
  const result = commitFiles(plans, project, backupBase, home, options.beforeWrite);
  return { ...result, root, identity: selected, package: installed, validation: 'native-write-reopen-and-mcp-list', trust: 'pending-host-review', network: 'not-tested', previousPackage: record.previousPackage };
}
