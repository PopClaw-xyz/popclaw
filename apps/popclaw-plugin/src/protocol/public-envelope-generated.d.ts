/** Generated runtime API from the immutable public-envelope .5 source bundle. */
export { popclaw } from '../../../../protocol/packages/contracts/ts/contracts/src/generated/index.js';
export declare const ENVELOPE_BASELINE: 'public-envelope-01';
export declare const L_ENVELOPE_MAX_BYTES: number;
export declare function checkEnvelopeWire(raw: Uint8Array): number;
export declare function checkPublicEnvelopeStructure(raw: Uint8Array): number;
export declare function canonicalizeEnvelope(envelope: unknown): Uint8Array;
export declare function cidFromCanonical(bytes: Uint8Array): string;
export declare function stripDefaultKeys(core: Record<string, unknown>): Record<string, unknown>;
export declare function requestSigningInput(core: Record<string, unknown>): Uint8Array;
export declare function ackSigningInput(core: Record<string, unknown>): Uint8Array;
