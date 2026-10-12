import { renderCopy, type Lang } from '../../lexicon/index.js';
import { ActionInactiveError } from './action-context.js';

export type HouseReadFailureCode = 'HOUSE_DISABLED' | 'HOUSE_CONNECTING' | 'HOUSE_LIFECYCLE_UNSUPPORTED'
  | 'HOUSE_OWNER_INACTIVE' | 'HOUSE_STORAGE_UNAVAILABLE' | 'HOUSE_TRUST_REVOKED' | 'HOUSE_ACTION_STALE'
  | 'HOUSE_REMOTE_NETWORK' | 'HOUSE_REMOTE_TIMEOUT' | 'HOUSE_REMOTE_HTTP' | 'HOUSE_REMOTE_PARSE' | 'HOUSE_REMOTE_UNKNOWN';
/** Safe remote-read diagnostics: no raw messages, headers, stacks or URLs. */
export interface HouseReadDiagnostic {
  readonly phase: 'before-fetch' | 'delegate' | 'fetch' | 'body';
  readonly cause: 'timeout' | 'dns' | 'tls' | 'connection' | 'aborted' | 'unknown';
  readonly elapsedMs?: number;
  readonly cancellation?: 'deadline' | 'action' | 'multiple' | 'unknown' | 'none';
  readonly timeoutMs?: number;
  readonly requestId?: string;
}
export interface HouseReadFailure {
  readonly code: HouseReadFailureCode;
  readonly origin?: string;
  readonly status?: number;
  readonly diagnostic?: HouseReadDiagnostic;
}
export class RemoteHouseReadError extends Error {
  constructor(readonly failure: HouseReadFailure) { super(failure.code); this.name = 'RemoteHouseReadError'; }
}
export function houseReadFailure(error: unknown, origin?: string): HouseReadFailure {
  if (error instanceof RemoteHouseReadError) return error.failure;
  if (error instanceof ActionInactiveError) return {code: error.code, origin: error.origin ?? origin};
  return {code:'HOUSE_REMOTE_NETWORK',origin};
}
const KEYS: Record<HouseReadFailureCode,string> = {
  HOUSE_DISABLED:'house.read.disabled',HOUSE_CONNECTING:'house.read.connecting',HOUSE_LIFECYCLE_UNSUPPORTED:'house.read.unsupported',
  HOUSE_OWNER_INACTIVE:'house.read.owner',HOUSE_STORAGE_UNAVAILABLE:'house.read.storage',HOUSE_TRUST_REVOKED:'house.read.trust',
  HOUSE_ACTION_STALE:'house.read.stale',HOUSE_REMOTE_NETWORK:'house.read.network',HOUSE_REMOTE_HTTP:'house.read.http',
  HOUSE_REMOTE_PARSE:'house.read.parse',HOUSE_REMOTE_UNKNOWN:'house.read.unknown',HOUSE_REMOTE_TIMEOUT:'house.read.timeout',
};
export function formatHouseReadFailure(lang: Lang, failure: HouseReadFailure): string {
  const text = renderCopy(lang,KEYS[failure.code],{origin:failure.origin ?? '',status:String(failure.status ?? '')});
  const d = failure.diagnostic;
  if (!d) return text;
  const detail = `${text} ${renderCopy(lang, 'house.read.diagnostic', {
    phase:d.phase,cause:d.cause,timeoutMs:d.timeoutMs === undefined ? '-' : String(d.timeoutMs),requestId:d.requestId ?? '-',
  })}`;
  return d.elapsedMs === undefined ? detail : `${detail} ${renderCopy(lang,'house.read.observation',{
    elapsedMs:String(d.elapsedMs),cancellation:d.cancellation ?? 'unknown',
  })}`;
}
