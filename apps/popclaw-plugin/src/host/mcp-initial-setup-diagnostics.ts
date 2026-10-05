import type { HostLogger } from './host-adapter.js';
import type { LoginResult } from '../runtime/house-lifecycle/manager.js';
import type { HouseGuideResult } from '../world/house-guide-context.js';

// LoginResult.errorCode may contain an exception message. Only source-owned
// codes are operational diagnostics; never print an entire result or error.
const INITIAL_ME_CODES = new Set([
  'HOUSE_PARTICIPATION_AUTHORITY_REQUIRED', 'HOUSE_BINDING_PREPARER_REQUIRED',
  'HOUSE_CONTROL_HISTORY_NOT_SESSIONLESS', 'HOUSE_CONTROL_HISTORY_UNPROVEN',
  'HOUSE_ADMISSION_UNRESOLVED', 'HOUSE_ADMISSION_ALREADY_RESOLVED', 'HOUSE_ADMISSION_FAILED',
  'HOUSE_SOURCE_EXPIRED', 'HOUSE_PERMIT_EXPIRED', 'HOUSE_SETUP_ALREADY_RESOLVED',
  'HOUSE_BINDING_UNAVAILABLE', 'HOUSE_MANIFEST_UNAVAILABLE',
  'STORAGE_RECOVERY_HELD', 'HOUSE_RUNTIME_STOPPED',
  'HOUSE_NOT_TRUSTED', 'HOUSE_KEY_CHANGED', 'HOUSE_INCARNATION_CHANGED', 'HOUSE_BINDING_BLOCKED',
  'HOUSE_ADD_NOT_AUTHORIZED', 'HOUSE_ATTEMPT_MISMATCH', 'HOUSE_OWNER_MOVED_ON',
  'HOUSE_PREPARED_NOT_OURS', 'HOUSE_PREPARED_MISMATCH', 'HOUSE_ADD_CANCELLED',
  'HOUSE_PIN_MOVED_WHILE_FETCHING', 'HOUSE_FIRST_PIN_NOT_AUTHORIZED',
  'MANIFEST_PROOF_MISSING', 'MANIFEST_PROOF_MALFORMED', 'MANIFEST_PROOF_BINDING_MISMATCH',
  'MANIFEST_PROOF_SIGNATURE_INVALID', 'HOUSE_PIN_INVALID',
  'INVALID_HOUSE', 'HOUSE_LIFECYCLE_UNSUPPORTED', 'HOUSE_DISABLED', 'EXECUTOR_BUSY',
  'STALE_OPERATION', 'SESSION_FENCED', 'LEASE_EXPIRED', 'AUTH_INVALID',
  'AUDIENCE_MISMATCH', 'IDEMPOTENCY_CONFLICT', 'PERSISTENCE_FAILED', 'ACTION_RESULT_UNKNOWN',
]);
const GUIDE_CODES = new Set([
  'HOUSE_GUIDE_CONTEXT_STALE', 'HOUSE_GUIDE_NOT_DECLARED', 'HOUSE_GUIDE_FETCH_FAILED', 'HOUSE_GUIDE_TOO_LARGE',
]);
function safeCode(value: unknown, allowed: ReadonlySet<string>): string {
  return typeof value === 'string' && allowed.has(value) ? value : 'UNCLASSIFIED_ERROR_CODE';
}
export type McpInitialSetupStage = 'runtime' | 'initial_me' | 'house_guide';

export function logMcpInitialMe(logger: HostLogger, result: LoginResult | undefined): void {
  if (!result) {
    logger.info({stage:'initial_me',status:'no_result'}, 'popclaw: MCP initial setup result');
    return;
  }
  const status = ['connected','connecting','unsupported'].includes(result.status) ? result.status : 'unknown';
  const fields = {stage:'initial_me',status,hasOperationId:typeof result.operationId === 'string' && result.operationId.length > 0,
    ...(result.admission === 'configured' ? {admission:'configured'} : {}),
    ...(typeof result.legacyAvailable === 'boolean' ? {legacyAvailable:result.legacyAvailable} : {}),
    ...(result.errorCode === undefined ? {} : {errorCode:safeCode(result.errorCode,INITIAL_ME_CODES)}),
    ...(result.legacyRefusal === undefined ? {} : {legacyRefusal:safeCode(result.legacyRefusal,INITIAL_ME_CODES)})};
  logger[status === 'connecting' || fields.errorCode || fields.legacyRefusal ? 'warn' : 'info'](fields, 'popclaw: MCP initial setup result');
}

export function logMcpInitialGuide(logger: HostLogger, result: HouseGuideResult): void {
  if (result.status === 'unavailable') {
    logger.warn({stage:'house_guide',status:'unavailable',code:safeCode(result.code,GUIDE_CODES)}, 'popclaw: MCP initial setup result');
  } else {
    logger.info({stage:'house_guide',status:result.status === 'available' ? 'available' : 'unknown'}, 'popclaw: MCP initial setup result');
  }
}

export function logMcpInitialSetupFailure(logger: HostLogger, stage: McpInitialSetupStage, error: unknown): void {
  logger.warn({stage,status:'threw',errorCode:safeCode(error instanceof Error ? error.message : undefined,
    stage === 'house_guide' ? GUIDE_CODES : INITIAL_ME_CODES)}, 'popclaw: MCP initial setup result');
}
