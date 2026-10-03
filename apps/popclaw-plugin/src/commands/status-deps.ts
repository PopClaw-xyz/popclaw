/**
 * The status report's dependencies, as the two entrances that hold a runtime —
 * the `/popclaw status` slash command and the `popclaw_check_status` tool —
 * both build them. Each entrance adds only what is its own: the slash command
 * the channel this command came in on and the install-upgrade line; the tool
 * its agent audience and the dream-schedule reading.
 *
 * Built at call time, inside the handler, never at registration (ADR-0035):
 * every value is read from the live runtime when the owner asks.
 *
 * The dev CLI builds a narrower set from a bootstrap, not a runtime, and stays
 * on its own.
 */

import type { PluginRuntime } from '../runtime/plugin-runtime.js';
import type { StatusCommandDeps } from './status.js';
import { checkPendingInvites } from '../invite/pending-invites.js';
import { newspaperRulesOutdated } from '../newspaper/newspaper-files.js';
import { fileLastRun } from '../runtime/last-run.js';
import { readSocialLog } from '../social-log/social-log.js';

/** The runtime slots the shared status dependencies read. */
export type StatusRuntime = Pick<
  PluginRuntime,
  | 'boot'
  | 'host'
  | 'houseRuntime'
  | 'socialGraph'
  | 'ownerNotifyTargetStore'
  | 'nameOf'
  | 'bondsStore'
  | 'inboxStore'
  | 'onboardingState'
  | 'tasteLoader'
  | 'paths'
  | 'pendingInvites'
  | 'inviteWatch'
  | 'drainNotifications'
  | 'notifyBacklog'
>;

export async function statusDepsFrom(
  rt: StatusRuntime,
  logger: StatusCommandDeps['logger'],
): Promise<StatusCommandDeps> {
  return {
    signer: rt.boot.signer,
    host: rt.host,
    loreHouseUrl: rt.boot.loreHouseUrl,
    // The identity block's only house call is the unauthenticated /v1/profile
    // GET, so it takes the public read lane like the namecard: on a host that
    // does not own the lifecycle (MCP beside a running gateway) the owner lane
    // refuses it before it leaves the process, and status used to call a live
    // house "down" (R17-D1). The optional chain is defensive: the contract
    // declares houseRuntime, but both entrances always tolerated its absence.
    fetch: rt.houseRuntime?.houseReadFetch(rt.boot.loreHouseUrl) ?? globalThis.fetch,
    logger,
    // Which houses are configured and which of them are trusted. The trust is
    // established without the owner asking, so status is the only place it is
    // ever mentioned.
    configuredHouses: rt.boot.loreHouseUrls,
    socialGraph: rt.socialGraph,
    nickname: rt.boot.nickname,
    notifyTarget: await rt.ownerNotifyTargetStore.get(),
    nameOf: rt.nameOf,
    webBaseUrl: rt.boot.webBaseUrl,
    bondsStore: rt.bondsStore,
    dmSenderCount: () => rt.inboxStore.distinctSenderCount(),
    onboardingStage: (id: string) => rt.onboardingState.get(id)?.stage ?? null,
    // The criterion for the "taste profile is still empty" todo item (where an attune skip lands).
    tasteLoader: rt.tasteLoader,
    // Raw material for "this week". If the read fails (first run, no log
    // directory yet), treat it as a quiet week and omit the whole section —
    // status shouldn't error out just because it can't read the log.
    socialLog: (from: number, to: number) => {
      try {
        return readSocialLog(rt.paths.socialLogDir(), from, to);
      } catch {
        return [];
      }
    },
    // Where the config lives + what language/timezone it produced. The 07-31
    // incident was a cadence file written to the wrong directory, silently, on
    // three machines; an MCP host has no slash commands, so this is the
    // owner's only way to see it there.
    cadenceDir: rt.paths.cadenceDir(),
    // ADR-0040: "invitation in progress" + lazy-lookup compensation — the
    // moment the owner speaks up, ask on their behalf about pending requests.
    pendingInvites: () => rt.pendingInvites.listPending(),
    checkPendingInvites: () => checkPendingInvites(rt.inviteWatch),
    // #236: retry the notification queue the moment the owner speaks, then
    // say what is still stuck. Functions, so the count is read AFTER the retry.
    drainNotifications: rt.drainNotifications,
    notifyBacklog: rt.notifyBacklog,
    // Silent decay is the worst case: hasn't dreamed in a long time → say so
    // in the todo list (spec 2026-07-26, step 3 ③).
    lastDreamAt: fileLastRun(rt.paths.dreamerStateFile()).get(),
    // The newspaper rulebook changed a generation but the owner edited theirs →
    // only mention it, never overwrite the owner's edits (P-006).
    outdatedNewspaperRules: () => newspaperRulesOutdated(rt.paths.newspaperDir()),
  };
}
