import type { HouseCapabilityView } from '../../../src/world/world-capabilities.js';
/** Synthetic typed observation; supported=true is only a command-port test seam. */
export function firstReleaseView(origin: string, houseKey: string, supported = false): HouseCapabilityView {
  const state = { validation: 'valid' as const, detail: '', support: supported ? 'supported' as const : 'unsupported' as const, ready: supported };
  const absent = { ...state, validation: 'absent' as const, support: 'unsupported' as const, ready: false };
  const house = { origin, houseKey, incarnation: 'inc_1' }, capabilityRevision = 'a'.repeat(64);
  return { verified: { house, capabilityRevision, manifestBytes: new Uint8Array(), proofBytes: new Uint8Array(), pinProvenance: 'configured_pin' },
    publicStream: state, actions: { ...state, kinds: { 'example.reply': state } }, privateMessages: { ...absent, kinds: {} },
    guide: state, executionClosure: absent,
    publicStreamCapability: { house, capabilityRevision, publicStream: { endpoint: '/v1/world-stream', mode: 'public-v1', log_incarnation: 'log_1', envelope_baseline: 'public-envelope-02' as const, initial_public_scopes: ['sc_public'] } } };
}
