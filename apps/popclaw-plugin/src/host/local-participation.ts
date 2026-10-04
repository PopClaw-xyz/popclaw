/** Native/MCP composition-root adapter. Installation evidence is not tool JSON. */
import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { LocalHostDb, assertNoLiveDatabaseDescriptor } from './local-host-db.js';
import { entryDigest } from '../runtime/house-lifecycle/participation-journal.js';
import type { HouseParticipationAdmissionPort } from '../runtime/house-lifecycle/participation-admission.js';
export const INITIAL_ME_ORIGIN = 'https://house.popclaw.me';
export interface LocalSetupEvidence { readonly reference: string; readonly actorId?: string }
export function localParticipationPort(initialEvidence: () => LocalSetupEvidence | undefined): HouseParticipationAdmissionPort {
  return {
    capture(input) {
      if (!input.actorId || !input.installationId) return undefined;
      if (input.reason === 'initial_me_setup') {
        const evidence = initialEvidence();
        if (!evidence || input.origin !== INITIAL_ME_ORIGIN || (evidence.actorId && evidence.actorId !== input.actorId)) return undefined;
        const logical = entryDigest({actorId:input.actorId,installationId:input.installationId,purpose:'initial_me_setup'});
        return Object.freeze({...input,eligibilityRef:logical,originalIntentRef:logical,originalOperationRef:logical,authorityRef:evidence.reference});
      }
      const original = randomUUID();
      return Object.freeze({...input,originalIntentRef:original,originalOperationRef:original,authorityRef:original});
    },
    async admit(plan, {signal,deadlineAtMs}) {
      if (signal.aborted || Date.now() >= deadlineAtMs) return {status:'denied',code:'HOUSE_SOURCE_EXPIRED'};
      let consumed = false;
      return {status:'permitted',permit:{beforeCommit(_tx,exact) {
        if (consumed || signal.aborted || Date.now() >= deadlineAtMs || exact.planDigest !== plan.planDigest) throw new Error('HOUSE_PERMIT_EXPIRED');
        consumed = true;
      }}};
    },
    async settle() { /* The atomic SQLite receipt is the native outcome ledger. */ },
  };
}
export function readMcpSetupEvidence(path: string | undefined, dataRoot: string, packageRoot: string): LocalSetupEvidence | undefined {
  if (!path) return undefined;
  try {
    assertNoLiveDatabaseDescriptor(path,'read setup receipt');
    const record = JSON.parse(readFileSync(path,'utf8'));
    const source = record.initialMe;
    if (record.format !== 1 || source?.version !== 1 || source.purpose !== 'initial_me_setup' || source.origin !== INITIAL_ME_ORIGIN
      || typeof source.setupId !== 'string' || typeof record.digest !== 'string' || typeof record.popclawId !== 'string'
      || source.actorId !== record.popclawId || realpathSync(record.root) !== realpathSync(dataRoot)
      || realpathSync(source.dataRoot) !== realpathSync(dataRoot) || realpathSync(record.package) !== realpathSync(packageRoot)) return undefined;
    return {reference:entryDigest({setupId:source.setupId,digest:record.digest,root:record.root}),actorId:record.popclawId};
  } catch { return undefined; }
}
/** OpenClaw 2026.9.4 persisted installation evidence, read only at full service activation. */
export function readNativeSetupEvidence(input: {stateDir:string;serviceStateDir:string;rootDir:string;source:string;enabled:boolean}): LocalSetupEvidence | undefined {
  if (!input.enabled || input.stateDir !== input.serviceStateDir) return undefined;
  let db: LocalHostDb | undefined;
  try {
    db = new LocalHostDb(join(input.stateDir,'state/openclaw.sqlite'),{readOnly:true});
    const row = db.queryOne<{value_json:string}>("SELECT value_json FROM config_machine_state WHERE state_key='plugins.installedIndex'");
    const index = row ? JSON.parse(row.value_json).index : undefined;
    const record = index?.installRecords?.popclaw;
    const plugins = index?.plugins?.filter((p: {pluginId:string}) => p.pluginId === 'popclaw');
    const plugin = plugins?.[0];
    if (index?.version !== 1 || index.migrationVersion !== 1 || index.hostContractVersion !== '2026.9.4' || plugins.length !== 1
      || plugin.installOwner !== 'popclaw' || plugin.installOwnerAmbiguous || plugin.enabled !== true
      || typeof record?.installedAt !== 'string' || !Number.isFinite(Date.parse(record.installedAt))
      || typeof record.acceptedSurfaceHash !== 'string' || !record.acceptedSurfaceHash || !record.acceptedSurfaceAt || !record.acceptedSurface
      || realpathSync(record.installPath) !== realpathSync(input.rootDir) || realpathSync(plugin.rootDir) !== realpathSync(input.rootDir)
      || realpathSync(plugin.source) !== realpathSync(input.source)) return undefined;
    return {reference:entryDigest({record,rootDir:input.rootDir,stateDir:input.stateDir})};
  } catch { return undefined; }
  finally { db?.close(); }
}
