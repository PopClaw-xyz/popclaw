import type { HostDb } from '../../host/host-db.js';

export interface TrustedManifestInput {
  readonly origin: string;
  readonly rawBytes: Uint8Array;
  readonly proofHeader: string | null;
  /** Already established pin; session-free proof verification never discovers it. */
  readonly ackKeyHex: string;
  readonly provenance: 'configured_pin' | 'persisted_pin' | 'https_tofu' | 'loopback_fixture';
  readonly signal: AbortSignal;
}
export interface PreparedTrustedManifest {
  /** Called synchronously under the same owner/operation write lock, after
   * preparation. It must not start asynchronous work or make network calls. */
  commit(tx: HostDb): void;
  /** Human-readable, owner-language explanation for a disabled outcome — the
   * machine code committed to storage (e.g. `WORLD_UNSUPPORTED`) is never
   * shown to a person on its own. Absent for an outcome that is not a
   * refusal. */
  readonly reason?: string;
}

