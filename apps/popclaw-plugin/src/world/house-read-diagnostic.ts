import { houseReadFailure, type HouseReadFailure, type HouseReadDiagnostic } from '../runtime/house-lifecycle/read-failure.js';

export interface HouseReadObservation {
  readonly phase: HouseReadDiagnostic['phase'];
  readonly deadline?: AbortSignal;
  readonly timeoutMs?: number;
  readonly requestId?: string;
  readonly startedAt?: number;
  /** The captured ambient action signal; not a claim about an unobserved host invocation. */
  readonly actionSignal?: AbortSignal;
}

/** Only enums, bounded timing and a previously validated request ID leave this function.
 * Raw error messages, stacks, URLs, headers and abort reasons never do. */
export function remoteReadFailure(error: unknown, origin: string, observation: HouseReadObservation): HouseReadFailure {
  const {phase, deadline, requestId, startedAt, actionSignal} = observation;
  const failure = houseReadFailure(error, origin);
  if (failure.diagnostic) return failure;
  let cause: HouseReadDiagnostic['cause'] = 'unknown';
  const pending: Array<{value:unknown;depth:number}> = [{value:error,depth:0}];
  let inspected = 0;
  while (pending.length && inspected++ < 16) {
    const {value,depth} = pending.shift()!;
    if (!(value instanceof Error) || depth >= 4) continue;
    const code = (value as Error & {code?:unknown}).code;
    if (value.name === 'TimeoutError' || code === 'UND_ERR_CONNECT_TIMEOUT' || code === 'UND_ERR_HEADERS_TIMEOUT'
      || code === 'UND_ERR_BODY_TIMEOUT' || code === 'ETIMEDOUT') { cause = 'timeout'; break; }
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') { cause = 'dns'; break; }
    if (code === 'CERT_HAS_EXPIRED' || code === 'DEPTH_ZERO_SELF_SIGNED_CERT' || code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'
      || code === 'ERR_TLS_CERT_ALTNAME_INVALID') { cause = 'tls'; break; }
    if (code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'EHOSTUNREACH' || code === 'ENETUNREACH'
      || code === 'UND_ERR_SOCKET') { cause = 'connection'; break; }
    if (value.name === 'AbortError') cause = 'aborted';
    pending.push({value:value.cause,depth:depth+1});
    // Native fetch may wrap multi-address connect errors in an AggregateError.
    // Inspect at most four members, without retaining any error object.
    if (value instanceof AggregateError) for (const member of value.errors.slice(0,4)) pending.push({value:member,depth:depth+1});
  }
  const ownTimeout = !!deadline?.aborted && deadline.reason instanceof Error && deadline.reason.name === 'TimeoutError';
  if (ownTimeout) cause = 'timeout';
  const extra = startedAt === undefined ? {} : {
    elapsedMs:Math.max(0,Math.round(performance.now()-startedAt)),
    cancellation:(deadline?.aborted && actionSignal?.aborted ? 'multiple' : ownTimeout ? 'deadline'
      : actionSignal?.aborted ? 'action' : cause === 'aborted' ? 'unknown' : 'none') as HouseReadDiagnostic['cancellation'],
  };
  if (failure.code !== 'HOUSE_REMOTE_NETWORK') {
    // Never relabel a lifecycle/HTTP refusal or overwrite a richer delegated diagnostic.
    return startedAt === undefined || failure.diagnostic ? failure
      : {...failure,diagnostic:{phase,cause:'unknown',...extra}};
  }
  return {code:cause === 'timeout' ? 'HOUSE_REMOTE_TIMEOUT' : 'HOUSE_REMOTE_NETWORK',origin,
    diagnostic:{phase,cause,...extra,...(ownTimeout && observation.timeoutMs !== undefined ? {timeoutMs:observation.timeoutMs} : {}),
      ...(requestId ? {requestId} : {})}};
}
