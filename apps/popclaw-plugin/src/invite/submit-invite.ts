import type { InviteInitiateOpts, InviteInitiateResult } from './invite-initiator.js';
import type { PendingInvitesStore } from './pending-invites.js';
import { formatInviteResult } from './format-invite-result.js';

/** Capabilities used only after an entry has authorized and validated submission. */
export interface InviteSubmissionDeps {
  readonly initiate: (opts: InviteInitiateOpts) => Promise<InviteInitiateResult>;
  readonly recordPending: PendingInvitesStore['add'];
  readonly watch: (taskId: string) => Promise<void>;
  /** The entry selects its host's log level; the submission owns the diagnostic. */
  readonly onWatchError: (message: string) => void;
  readonly webBaseUrl: string;
}

/**
 * Submit once, record the receipt before launching its background watcher, and
 * return the owner-facing receipt without waiting for verification (ADR-0040).
 * Validation, default-name resolution and tool confirmation stay in the entry.
 */
export async function submitInvite(
  deps: InviteSubmissionDeps,
  opts: InviteInitiateOpts,
): Promise<{ text: string }> {
  const result = await deps.initiate(opts);
  // A task id is the tracking capability. Older houses omit it, so the receipt
  // still renders but there is nothing to record or poll. Keep this independent
  // of HTTP status, as on the existing entry paths.
  const taskId = result.push.taskId;
  if (taskId) {
    deps.recordPending({
      taskId,
      platform: opts.platform,
      handle: opts.handle,
      sigil: result.expectedSigil,
      proofUrl: opts.proofUrl,
    });
    void deps.watch(taskId).catch((err) =>
      deps.onWatchError(`popclaw: invite poll failed — ${String(err)}`),
    );
  }
  return {
    text: formatInviteResult(
      result, opts.platform, opts.handle, deps.webBaseUrl, opts.proofUrl, opts.mirrorOptin,
    ),
  };
}
