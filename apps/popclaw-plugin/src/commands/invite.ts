/**
 * CLI command `popclaw invite <platform> <handle> [--nickname=X]`.
 *
 * The async command body is shared by CLI and host command wiring.
 */

import type { InviteInitiator } from '../invite/invite-initiator.js';
import type { Signer } from '../identity/signer.js';
import { LORE_HOUSE_TIMEOUT_MS } from '../world/http-timeout.js';

export interface InviteCommandDeps {
  readonly initiator: InviteInitiator;
  readonly signer: Signer;
  readonly loreHouseUrl: string;
  readonly fetch: typeof globalThis.fetch;
  readonly logger: { info(msg: string): void; warn(msg: string): void };
  /** Pollable clock for testing. Defaults to `Date.now`. */
  readonly now?: () => number;
  /** Async sleep for testing. Defaults to setTimeout. */
  readonly sleepMs?: (ms: number) => Promise<void>;
}

export interface InviteCommandArgs {
  readonly platform: string;
  readonly handle: string;
  readonly nickname?: string;
  /** ADR-0034: URL of the post carrying the bound token (enables by-id verification). */
  readonly proofUrl?: string;
  /** Consent to keep mirroring later posts. Default off. */
  readonly mirrorOptin?: boolean;
  /** Poll timeout in seconds (default 300). */
  readonly pollTimeoutSec?: number;
  /** Poll interval in ms (default 5000). */
  readonly pollIntervalMs?: number;
}

export async function runInviteCommand(
  deps: InviteCommandDeps,
  args: InviteCommandArgs,
): Promise<{ verified: boolean }> {
  const result = await deps.initiator.initiate({
    platform: args.platform,
    handle: args.handle,
    nickname: args.nickname,
    proofUrl: args.proofUrl,
    mirrorOptin: args.mirrorOptin,
  });

  if (result.push.status < 200 || result.push.status >= 300) {
    deps.logger.warn(
      `invite push rejected (HTTP ${result.push.status}); cannot proceed`,
    );
    return { verified: false };
  }

  deps.logger.info(
    `invite submitted. event_id=${result.pushedEventId ?? '(unknown)'}`,
  );
  // ADR-0040 act one, CLI version: one step is yours, the rest is waiting for
  // the echo; valid 48h, the sigil doesn't change, expiring costs nothing.
  deps.logger.info(
    args.proofUrl
      ? `verifying against ${args.proofUrl} — it must be your own post and contain "${args.handle}#${result.expectedSigil}"`
      : `step 1 (yours): post "${args.handle}#${result.expectedSigil}" on ${args.platform} — a new post or a self-reply, never the bio. ` +
        'step 2: rangers verify within ~a minute. step 3: you get told either way. ' +
        'Valid 48h; the sigil never changes; expiring costs you nothing. ' +
        'If REJECTED (new/small accounts are often invisible to search), retry immediately with --proof=<post url> — only a still-pending task is throttled (24h)',
  );
  deps.logger.info(
    'polling /v1/profile for verification (Ctrl-C to stop; check again later with `popclaw status`)',
  );

  const timeoutMs = (args.pollTimeoutSec ?? 300) * 1000;
  const intervalMs = args.pollIntervalMs ?? 5000;
  const clock = deps.now ?? Date.now;
  const sleep =
    deps.sleepMs ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  const deadline = clock() + timeoutMs;
  const popclawId = await deps.signer.popclawId();
  const profileUrl = `${deps.loreHouseUrl.replace(/\/$/, '')}/v1/profile/${encodeURIComponent(popclawId)}`;

  while (clock() < deadline) {
    await sleep(intervalMs);
    const resp = await deps.fetch(profileUrl, { signal: AbortSignal.timeout(LORE_HOUSE_TIMEOUT_MS) });
    if (resp.ok) {
      const body = (await resp.json()) as {
        profiles?: Array<{ platform?: string; handle?: string }>;
      };
      const match = (body.profiles ?? []).some(
        (p) => p.platform === args.platform && p.handle === args.handle,
      );
      if (match) {
        deps.logger.info(
          `✓ invite APPROVED — you are now verified as ${args.platform}:${args.handle}`,
        );
        return { verified: true };
      }
    }
    // 404 is expected while no profile exists yet; any other status we keep polling.
  }
  deps.logger.info(
    '(polling timeout reached; check status later via `popclaw status`)',
  );
  return { verified: false };
}
