/** MCP confirmation request ownership, independent of domain approval records.
 * One root shares this owner across adapters. Lanes stop independently; the
 * root stops all lanes before draining the runtime. Leases cover preparation,
 * asking and the caller's remaining work, not only the SDK request promise.
 */
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ErrorCode, McpError, type ElicitRequestFormParams } from '@modelcontextprotocol/sdk/types.js';

export interface McpConfirmationServerBox {
  current?: Pick<Server, 'elicitInput' | 'getClientCapabilities' | 'getClientVersion'>;
}
export interface McpConfirmationDialog {
  readonly message: string;
  readonly requestedSchema: ElicitRequestFormParams['requestedSchema'];
}
export type McpConfirmationResult =
  | { readonly kind: 'allow' | 'deny' | 'cancel' | 'invalid-action' | 'timeout' | 'inactive' | 'unavailable' | 'answer-invalid' }
  | { readonly kind: 'failed'; readonly error: unknown; readonly code: unknown };
export interface McpConfirmationRequest {
  readonly signal: AbortSignal;
  isActive(): boolean;
  ask(dialog: McpConfirmationDialog, timing: {
    readonly timeoutMs: number;
    /** Preserve the two adapters' existing timeout authorities. */
    readonly authority: 'owned-window' | 'sdk-window';
  }): Promise<McpConfirmationResult>;
  finish(): void;
}
export interface McpConfirmationLane {
  canAsk(): boolean;
  open(tool: string, callRef: string, signal?: AbortSignal): McpConfirmationRequest;
  stop(): void;
}
export interface McpConfirmationLifecycle {
  createLane(): McpConfirmationLane;
  noteProtocolError(error: unknown): void;
  stop(): void;
}

export const OWNER_APPROVAL_ANSWERED_AFTER_TIMEOUT = 'OWNER_APPROVAL_ANSWERED_AFTER_TIMEOUT';
const ORPHANED_RESPONSE = 'Received a response for an unknown message ID: ';
const WINDOW_BACKSTOP_MS = 60_000;
const ABANDONED_MAX = 16;
const ABANDONED_TTL_MS = 60 * 60 * 1000;

function orphanedElicitAnswer(error: unknown): boolean {
  if (!(error instanceof Error) || !error.message.startsWith(ORPHANED_RESPONSE)) return false;
  try {
    const response = JSON.parse(error.message.slice(ORPHANED_RESPONSE.length)) as { result?: { action?: unknown } };
    return typeof response?.result?.action === 'string';
  } catch { return false; }
}

export function createMcpConfirmationLifecycle(options: {
  readonly server: McpConfirmationServerBox;
  readonly logger?: { warn(context: unknown, message: string): void };
}): McpConfirmationLifecycle {
  let stopped = false;
  const requests = new Map<symbol, { lane: symbol; cancel(): void }>();
  // Preserve the existing reporting policy: only the general adapter's own
  // closed windows are attributed. SDK World timeouts remain unattributed.
  let abandoned: Array<{ tool: string; callRef: string; at: number }> = [];
  return {
    createLane(): McpConfirmationLane {
      const lane = Symbol('confirmation-lane');
      let laneStopped = false;
      const client = () => {
        if (stopped || laneStopped) return null;
        const server = options.server.current;
        return server?.getClientCapabilities()?.elicitation?.form ? server : null;
      };
      return {
        canAsk: () => client() !== null,
        open(tool, callRef, signal): McpConfirmationRequest {
          const id = Symbol('confirmation-request');
          const closer = new AbortController();
          const reason = signal ? AbortSignal.any([signal, closer.signal]) : closer.signal;
          let finished = false, asking = false;
          if (stopped || laneStopped) closer.abort();
          requests.set(id, { lane, cancel: () => closer.abort() });
          const active = () => !finished && !reason.aborted;
          return {
            signal: reason,
            isActive: active,
            async ask(dialog, timing): Promise<McpConfirmationResult> {
              const server = client();
              if (!server) return { kind: 'unavailable' };
              if (!active()) return { kind: 'inactive' };
              const windowCloser = new AbortController();
              let windowClosed = false;
              const owned = timing.authority === 'owned-window';
              const timer = owned ? setTimeout(() => {
                windowClosed = true;
                windowCloser.abort(McpError.fromError(ErrorCode.RequestTimeout, 'Request timed out', { timeout: timing.timeoutMs }));
              }, timing.timeoutMs) : undefined;
              // Detach forwarding after the SDK settles: it retains its own
              // signal listener and otherwise emits cancel for an answered form.
              const sdkCloser = new AbortController();
              const cancelSdk = () => sdkCloser.abort(reason.reason);
              reason.addEventListener('abort', cancelSdk, { once: true });
              if (reason.aborted) cancelSdk();
              let result;
              asking = true;
              try {
                result = await server.elicitInput({ mode: 'form', ...dialog }, {
                  timeout: timing.timeoutMs + (owned ? WINDOW_BACKSTOP_MS : 0),
                  signal: owned ? AbortSignal.any([sdkCloser.signal, windowCloser.signal]) : sdkCloser.signal,
                });
              } catch (error: unknown) {
                const code = (error as { code?: unknown } | null)?.code;
                if (windowClosed) {
                  const now = Date.now();
                  abandoned = [...abandoned.filter(a => now - a.at < ABANDONED_TTL_MS), { tool, callRef, at: now }].slice(-ABANDONED_MAX);
                  return { kind: 'timeout' };
                }
                if (!active()) return { kind: 'inactive' };
                if (!owned && code === ErrorCode.RequestTimeout) return { kind: 'timeout' };
                if (code === ErrorCode.InvalidParams) return { kind: 'answer-invalid' };
                return { kind: 'failed', error, code };
              } finally {
                asking = false;
                reason.removeEventListener('abort', cancelSdk);
                if (timer !== undefined) clearTimeout(timer);
              }
              // An answer cannot revive a lease that ended while it was pending.
              if (!active()) return { kind: 'inactive' };
              if (result.action === 'decline') return { kind: 'deny' };
              if (result.action === 'cancel') return { kind: 'cancel' };
              if (result.action !== 'accept') return { kind: 'invalid-action' };
              return { kind: result.content?.['confirm'] === true ? 'allow' : 'deny' };
            },
            finish(): void {
              if (finished) return;
              finished = true;
              requests.delete(id);
              // The SDK retains its abort listener after a successful answer.
              // Aborting that completed request would emit a spurious cancel.
              if (asking) closer.abort();
            },
          };
        },
        stop(): void {
          laneStopped = true;
          for (const request of requests.values()) if (request.lane === lane) request.cancel();
        },
      };
    },
    noteProtocolError(error): void {
      try {
        if (!orphanedElicitAnswer(error)) return;
        const now = Date.now();
        abandoned = abandoned.filter(a => now - a.at < ABANDONED_TTL_MS);
        const only = abandoned.length === 1 ? abandoned[0]! : null;
        if (only) abandoned = [];
        const tools = new Set(abandoned.map(a => a.tool));
        options.logger?.warn({ tool: only?.tool ?? (tools.size === 1 ? [...tools][0] : null),
          call_ref: only?.callRef ?? null, reason: OWNER_APPROVAL_ANSWERED_AFTER_TIMEOUT },
        'popclaw: an approval dialog was answered after its window closed — ignored, nothing was sent');
      } catch { /* A report is lost; nothing else is affected. */ }
    },
    stop(): void {
      stopped = true;
      for (const request of requests.values()) request.cancel();
    },
  };
}
