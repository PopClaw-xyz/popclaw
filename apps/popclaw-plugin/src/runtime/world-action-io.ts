/** Root-only I/O bindings for the durable WorldActionClient. */
import type { WorldActionClientOptions, WorldActionGate } from '../world/action-client.js';
import { hostDbSlug } from '../ingress/host-slug.js';
import { normalizeHouseOrigin } from './house-lifecycle/control-client.js';
import { withAction } from './house-lifecycle/action-context.js';
import type { HouseRuntime } from './house-lifecycle/house-runtime.js';

export interface WorldActionIoOptions {
  runtime: HouseRuntime;
  origin: string;
  /** The root checks its actor/house-bound client's actual local request view.
   * Never supplied by tool JSON or replaced with an unconditional permission. */
  knownRequest(requestId: string): boolean;
  statusTimeoutMs?: number;
}
export type WorldActionIo = Pick<WorldActionClientOptions, 'captureSession' | 'push' | 'controlRead' | 'readStatus'>;

export function createWorldActionIo(options: WorldActionIoOptions): WorldActionIo {
  const {runtime, knownRequest} = options;
  const origin = normalizeHouseOrigin(options.origin), slug = hostDbSlug(origin);
  if (runtime.originForSlug(slug) !== origin) throw new Error('HOUSE_AUDIENCE_MISMATCH');
  const statusTimeoutMs = options.statusTimeoutMs ?? 10_000;
  if (!Number.isSafeInteger(statusTimeoutMs) || statusTimeoutMs < 1 || statusTimeoutMs > 60_000) throw new Error('ACTION_STATUS_TIMEOUT_INVALID');
  const businessGates = new WeakSet<WorldActionGate>();
  const checkSend = (gate: WorldActionGate, requestId: string) => {
    if (!/^[a-f0-9]{64}$/.test(requestId)) throw new Error('REQUEST_ID_INVALID');
    if (!businessGates.has(gate) || gate.origin !== origin || gate.signal.aborted || !gate.isActive()) throw new Error('ACTION_GATE_CLOSED');
  };
  return {
    captureSession: () => {
      const session = runtime.captureSessionCommandContext(origin);
      businessGates.add(session.gate);
      return session;
    },
    push: async (bytes, {gate, requestId, executionReference}) => {
      const body = new Uint8Array(bytes);
      checkSend(gate, requestId);
      try {
        const receipt = await withAction(gate, () => runtime.withPushEffect(origin, {version: 1, kind: 'world_intent', requestId, executionReference}, () => runtime.egress.pushTo(slug, body)));
        checkSend(gate, requestId);
        return receipt;
      } catch (error) { checkSend(gate, requestId); throw error; }
    },
    controlRead: requestId => runtime.captureKnownActionReadGate(origin, requestId, knownRequest),
    readStatus: (bytes, {gate, requestId}) => runtime.readKnownActionStatus(origin, requestId, bytes, gate, statusTimeoutMs),
  };
}
