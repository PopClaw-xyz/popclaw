/**
 * DOES THIS CALL'S APPROVAL PROMPT GO BACK WHERE THE CALL CAME FROM?
 *
 * The seam's other origins (`webchat`, `tui`) are admitted because the host has
 * no chat to fall back into for them. Every other channel HAS one, so for those
 * the safety cannot come from the origin — and it cannot come from proving the
 * turn was a direct chat either, which the survey established is not derivable
 * from this context at all.
 *
 * SO THE QUESTION IS ASKED RELATIONALLY, AND THAT IS THE WHOLE DESIGN. Not
 * "who is the owner" — this module never learns anyone's address, and nothing
 * here has to be told one in advance. It asks whether the route the host would
 * actually deliver this call's prompt down is THE SAME ROUTE THE CALL ARRIVED
 * ON. Both halves are present at hook time: `senderIsOwner` is the host's own
 * runtime verdict about this turn's sender, and the turn's channel / account /
 * destination are this turn's own coordinates. If the effective targets route
 * equals those coordinates, then the prompt returns to exactly the person the
 * host has just vouched for — without either side naming them.
 *
 * WHY THAT MAKES A MISCONFIGURATION FAIL CLOSED INSTEAD OF LEAK. A target typed
 * wrongly does not equal this turn's coordinates, so it is refused and no
 * prompt is ever built. And a turn that genuinely arrived from that wrongly
 * typed address would not be carrying `senderIsOwner`, because the host decides
 * that from its own owner allowlist and not from anything here. The two
 * failures cannot line up: one of them always refuses. That is the argument
 * that makes deriving the destination from configuration acceptable at all.
 *
 * WHAT IT READS, AND WHY IT IS NOT THE CONFIG FILE. `approvals.plugin` on disk
 * is not this turn's route: the gateway runs on a pinned in-memory snapshot and
 * the forwarder reads that snapshot
 * (`openclaw/dist/server-aux-handlers-BKv4BKQ5.mjs:469`
 * `const getConfig = deps.getConfig ?? getRuntimeConfig`, with `getRuntimeConfig`
 * returning the pinned snapshot — `openclaw/dist/io.runtime-Bm3fPzNt.mjs:77` →
 * `:70` → `loadPinnedRuntimeConfig` at
 * `openclaw/dist/runtime-snapshot-TR10u-8L.mjs:204`). This module reads that
 * same object through the supported typed entry point
 * `openclaw/plugin-sdk/runtime-config-snapshot`, and treats "no runtime
 * snapshot in this process" as a refusal rather than quietly loading the file:
 * a plugin reading the file would be answering a question about the disk.
 *
 * TARGETS MODE IS NOT A GLOBAL NO-FALLBACK SWITCH, so a mode string is not the
 * check. Six things can independently send the host back to a route this seam
 * does not control:
 *
 *   1. `enabled` — `shouldForwardRoute` returns false outright when forwarding
 *      is off (`server-aux-handlers-BKv4BKQ5.mjs:179-188`), and with no
 *      forwarder delivery the ladder falls through to the turn-source decision
 *      (`approval-shared-ouR8XZ--.mjs:348-353`).
 *   2. `mode === "targets"` — `session` and `both` BOTH resolve a target from
 *      the turn through the host's own session resolver (`:290-306`), which is
 *      a second destination this module has not checked. Only `targets` skips
 *      that branch.
 *   3. every configured target is this turn's route — `deliverToTargets` sends
 *      to ALL resolved targets (`:267-287`), so one entry pointing elsewhere is
 *      one stranger receiving the full `Description` line
 *      (`plugin-approvals-tK1mxYhQ.mjs:53`).
 *   4. the agent/session filters match THIS call — a filter that excludes it
 *      makes `shouldForwardRoute` false for this request only (`:181-187`),
 *      which is exactly the per-call mismatch a mode string cannot see.
 *   5. the channel can actually receive a delivery — `deliverToTargets`
 *      silently SKIPS a target whose channel is not deliverable (`:270-272`),
 *      producing no error and no prompt.
 *   6. the turn's channel does not run an approval client that DELETES the
 *      validated target before it is ever used — `resolveTargets` filters
 *      every target through the channel adapter's own
 *      `shouldSkipForwardingFallback` (`:340` → `:215-224`), and an emptied
 *      list makes `handleRequested` return false (`:387-390`). See
 *      `channelClaimsApprovals` for which adapter families can do this, which
 *      half of it a plugin can read, and why the unreadable half can only
 *      subtract a delivery rather than add a destination.
 *
 * WHAT IT DELIBERATELY DOES NOT CLAIM. A refusal here is "not proven pinned",
 * never "a prompt was posted into a group": no send call is observed from a
 * plugin, and the host's `deliveryRoute === "turn-source"` label has no sender
 * attached in this build — its only consumer builds a timeout message
 * (`agent-tools.before-tool-call-WtmCO7BO.mjs:1043`). The surfaces that really
 * can post into an originating chat are the approval clients and internal
 * subscribers published BEFORE the forwarder runs
 * (`approval-shared-ouR8XZ--.mjs:342-345`), which `targets` does not constrain.
 * Pinning delivery is necessary and not sufficient.
 */

/**
 * THE HOST PACKAGE IS LOADED ON USE, AND NEVER AT MODULE LOAD.
 *
 * `openclaw` is an OPTIONAL peer dependency of this plugin, and the word
 * optional is load-bearing: three of this repository's five composition roots
 * run where nobody has installed it. `src/mcp.ts` is the MCP server Claude Code
 * and Codex spawn, and it reaches this module through
 * `mcp-owner-approval.ts` → `owner-approval.ts`. A STATIC import of a host
 * subpath therefore does not degrade a feature there — it kills the process
 * during module linking, before any of this code runs:
 *
 *     ERR_MODULE_NOT_FOUND: Cannot find package 'openclaw'
 *       imported from dist/bundled/mcp.js
 *
 * That shipped. Three static imports at the top of this file stopped both MCP
 * hosts from starting at all, and `tools/list` was never reached. The suite was
 * green through it for one reason: it runs with `node_modules/openclaw` present
 * as a devDependency, so resolution always succeeded — the environment under
 * test differed from the environment that ships in exactly the way that
 * mattered. `tests/unit/mcp-bundle-host-free.test.ts` now closes that
 * difference, generally rather than per-specifier.
 *
 * SO THE IMPORT IS DYNAMIC, in the same posture `dream-taste-tools.ts`'s
 * `loadDreamCronStore` already uses for `openclaw/plugin-sdk/cron-store-runtime`
 * (`src/tools/dream-taste-tools.ts`) — import-on-use, with a failure folded
 * into a defined answer rather than thrown. The one difference is what the
 * defined answer is: the cron read degrades to `null` because "can't tell" and
 * "not scheduled" are both safe there. HERE A FAILURE MUST REFUSE. This module
 * decides whether an approval prompt may be shown at all, so an unloadable host
 * is answered `OWNER_ROUTE_CONFIG_UNAVAILABLE` — the same answer as a process
 * holding no runtime snapshot, and for the same reason: a question that cannot
 * be answered is refused, never answered optimistically. A missing module can
 * never admit anything.
 *
 * WHERE THIS IS AND IS NOT REACHED. The MCP root imports this module but does
 * not call it: its lane is `askOwnerApprovalBeforeDispatch`, which goes straight
 * to `prepare` and never consults the route. The one production caller is
 * `ownerApprovalBeforeToolCall`, the OpenClaw native `before_tool_call` hook,
 * which only runs on a gateway — where the host package is installed by
 * definition. So on the MCP roots the load is not merely tolerated on failure,
 * it is never attempted.
 *
 * THE RESULT IS MEMOISED, failure included. On a gateway the first call pays
 * one resolution and every later call reads the same object; on an MCP host a
 * caller that somehow did reach this would not retry a resolution that cannot
 * start succeeding.
 */
interface OwnerApprovalRouteSdk {
  readonly matchesApprovalRequestFilters:
    typeof import('openclaw/plugin-sdk/approval-runtime')['matchesApprovalRequestFilters'];
  readonly normalizeOptionalAccountId:
    typeof import('openclaw/plugin-sdk/routing')['normalizeOptionalAccountId'];
  readonly normalizeAccountId:
    typeof import('openclaw/plugin-sdk/routing')['normalizeAccountId'];
  readonly defaultAccountId:
    typeof import('openclaw/plugin-sdk/routing')['DEFAULT_ACCOUNT_ID'];
  readonly listBoundAccountIds:
    typeof import('openclaw/plugin-sdk/routing')['listBoundAccountIds'];
  readonly resolveListedDefaultAccountId:
    typeof import('openclaw/plugin-sdk/account-core')['resolveListedDefaultAccountId'];
  readonly resolveGatewayMessageChannel:
    typeof import('openclaw/plugin-sdk/routing')['resolveGatewayMessageChannel'];
  readonly getRuntimeConfigSnapshot:
    typeof import('openclaw/plugin-sdk/runtime-config-snapshot')['getRuntimeConfigSnapshot'];
}

let sdkOnce: Promise<OwnerApprovalRouteSdk | null> | undefined;
/** The host entry points this module reads, or `null` where `openclaw` is not
 *  installed. Never throws: every caller owes a named answer, not a stack. */
async function loadRouteSdk(): Promise<OwnerApprovalRouteSdk | null> {
  sdkOnce ??= (async (): Promise<OwnerApprovalRouteSdk | null> => {
    try {
      const [approvals, routing, snapshot, accounts] = await Promise.all([
        import('openclaw/plugin-sdk/approval-runtime'),
        import('openclaw/plugin-sdk/routing'),
        import('openclaw/plugin-sdk/runtime-config-snapshot'),
        import('openclaw/plugin-sdk/account-core'),
      ]);
      return Object.freeze({
        matchesApprovalRequestFilters: approvals.matchesApprovalRequestFilters,
        normalizeOptionalAccountId: routing.normalizeOptionalAccountId,
        normalizeAccountId: routing.normalizeAccountId,
        defaultAccountId: routing.DEFAULT_ACCOUNT_ID,
        listBoundAccountIds: routing.listBoundAccountIds,
        resolveListedDefaultAccountId: accounts.resolveListedDefaultAccountId,
        resolveGatewayMessageChannel: routing.resolveGatewayMessageChannel,
        getRuntimeConfigSnapshot: snapshot.getRuntimeConfigSnapshot,
      });
    } catch {
      return null;
    }
  })();
  return sdkOnce;
}

/** One entry of `approvals.plugin.targets`, as the host declares it
 *  (`openclaw/dist/types.openclaw-D-pPz-sB.d.ts:2092-2101`). */
export interface OwnerApprovalRouteTarget {
  readonly channel: string;
  readonly to: string;
  readonly accountId?: string;
}
/**
 * This turn's own coordinates. Shaped for a caller that is NOT the approval
 * hook — the draft side has to send its full preview down this same approved
 * route and holds the same facts — the ones this interface names, and it is
 * the list.
 *
 * NO ADDRESS IS SUPPLIED FROM OUTSIDE AND NONE IS CONFIGURED HERE. Every value
 * is read off the call being authorized.
 */
export interface OwnerApprovalRouteQuery {
  readonly channel?: string | null;
  readonly accountId?: string | null;
  /** This turn's own destination — where a reply to it would go. */
  readonly to?: string | null;
  /**
   * THE HOST'S OTHER PROJECTION OF THE SAME DESTINATION, AND WHY IT IS
   * OPTIONAL RATHER THAN REQUIRED.
   *
   * `to` above is the hook context's `channelId` = `hookChannelId ??
   * currentChannelId` (`dist/agent-tools-DXxcrXNI.mjs:759`). The host ALSO
   * computes `turnSourceTo = currentMessagingTarget ?? currentChannelId`
   * (`:734`) and puts it on the same context (`:762`) — and `turnSourceTo` is
   * the variable its own forwarder routes on. They coincide on this bundle
   * (`hookChannelId` is assigned nowhere in it), so requiring them to AGREE
   * costs nothing today and closes the one divergence that could point the
   * prompt somewhere this module did not check: a channel whose threading
   * adapter supplies a `currentMessagingTarget` of its own.
   *
   * ABSENT MEANS FALL BACK, NEVER REFUSE, and that asymmetry is the point.
   * `turnSourceTo` is NOT in the declared `PluginHookToolContext`
   * (`agent-harness-runtime-BvaKEkqR.d.ts:1700-1722`), so a host update can
   * drop it with no type error anywhere. Refusing on absence would turn this
   * whole feature off silently on the next upgrade — which is precisely the
   * failure shape this lane keeps being bitten by. So an absent, blank or
   * unreadable value leaves the check exactly as it was before this field
   * existed: strictly extra narrowing when it is there, and never a gate of
   * its own.
   */
  readonly turnSourceTo?: string | null;
  readonly agentId?: string | null;
  readonly sessionKey?: string | null;
}
/**
 * Every way the route can fail to be this turn's own, told apart. A caller
 * that refuses owes the person a reason, and "unavailable" is not one.
 *
 * THIS ARRAY IS THE TYPE, not a copy of it. A name that exists only in a union
 * is a name no runtime caller can enumerate, and a name nobody can enumerate is
 * what four defects in this lane turned out to be: a hook on the wrong table, a
 * registry filled in one composition root, a guard reporting into a sink, and
 * a set of refusal names computed and then discarded. Deriving the union from the
 * array makes "added to the type but not to the list" inexpressible, and
 * `tests/unit/host/owner-approval-reasons.test.ts` drives every entry of this
 * array all the way to `consumeOwnerApproval`, so a name that reaches no caller
 * fails the suite instead of shipping as a comment.
 */
export const OWNER_APPROVAL_ROUTE_REFUSALS = [
  'OWNER_ROUTE_CONFIG_UNAVAILABLE',
  'OWNER_ROUTE_TURN_ADDRESS_ABSENT',
  /** The TURN's own channel cannot receive a delivery. Nothing to do with a
   *  configured target, which is what this answer used to be named. */
  'OWNER_ROUTE_TURN_CHANNEL_NOT_DELIVERABLE',
  /** The host's two projections of this turn's destination disagree, so which
   *  of them the forwarder will route on cannot be established from here. Only
   *  raised when the second one is actually present — see `turnSourceTo`. */
  'OWNER_ROUTE_TURN_TARGET_DIVERGED',
  /** The turn's channel declares a native approval client of its own, which can
   *  delete the forwarding target this module just validated —
   *  see `channelClaimsApprovals`. */
  'OWNER_ROUTE_CHANNEL_CLAIMS_APPROVALS',
  'OWNER_ROUTE_FORWARDING_DISABLED',
  'OWNER_ROUTE_MODE_NOT_TARGETS',
  /** A filter is present but is not a list of strings, so what the host would
   *  do with it cannot be reproduced. "Cannot tell" is not "no constraint". */
  'OWNER_ROUTE_FILTER_UNREADABLE',
  'OWNER_ROUTE_FILTERS_EXCLUDE_CALL',
  'OWNER_ROUTE_NO_TARGET',
  /** A target pinned to a thread: refused rather than compared, and named apart
   *  from a target that is merely a different address. */
  'OWNER_ROUTE_TARGET_THREAD_PINNED',
  /** A target is not this turn's route, and the three answers below say ON
   *  WHICH AXIS. They replace a single earlier reason that covered all three:
   *  on a real instance that name could not tell a wrong address from a wrong
   *  account, and separating them took a round of source reading and a config
   *  change. Checked in this order, so the first differing axis names it. */
  'OWNER_ROUTE_TARGET_CHANNEL_NOT_THIS_TURN',
  'OWNER_ROUTE_TARGET_ADDRESS_NOT_THIS_TURN',
  /** Same channel, same address, and an account that is not the one this turn
   *  arrived on — including a target that names NO account on a channel where
   *  that does not unambiguously mean this turn's account. See `sameAccount`. */
  'OWNER_ROUTE_TARGET_ACCOUNT_NOT_THIS_TURN',
  'OWNER_ROUTE_TARGET_NOT_DELIVERABLE',
] as const;
export type OwnerApprovalRouteRefusal = typeof OWNER_APPROVAL_ROUTE_REFUSALS[number];
export type OwnerApprovalRoute =
  | { readonly pinned: true; readonly targets: readonly OwnerApprovalRouteTarget[] }
  | { readonly pinned: false; readonly reason: OwnerApprovalRouteRefusal };
/** Injection points, so a test states a route instead of standing up a
 *  Gateway. The defaults are the host's own supported entry points. */
export interface OwnerApprovalRouteReaders {
  /** The pinned runtime snapshot, or null when this process has none. */
  readActiveConfig(): unknown;
  /** The host's normalizer; `undefined` for anything it will not route to. */
  resolveChannel(raw: string): string | undefined;
}

/** The host's own entry points, bound to an SDK that has already loaded. Built
 *  per call rather than frozen at module load, because at module load there is
 *  nothing to bind to — see `loadRouteSdk`. */
function hostReaders(sdk: OwnerApprovalRouteSdk): OwnerApprovalRouteReaders {
  return {
    readActiveConfig: () => sdk.getRuntimeConfigSnapshot() as unknown,
    resolveChannel: (raw: string) => sdk.resolveGatewayMessageChannel(raw),
  };
}
function refuse(reason: OwnerApprovalRouteRefusal): OwnerApprovalRoute { return { pinned: false, reason }; }
/** Own data properties only: a configuration value that runs code when it is
 *  read is not a configuration value. */
function field(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}
function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}
/**
 * A filter, or the fact that it cannot be read.
 *
 * `undefined` really is "no filter": the host treats an absent `agentFilter` /
 * `sessionFilter` as matching every call
 * (`openclaw/dist/approval-request-filters-CyEsHpxf.mjs:17-28`). ANY OTHER
 * unreadable shape is not that. This used to fold a filter array containing a
 * non-string into "no filter", which admits a call the host's own
 * `matchesApprovalRequestFilters` would have excluded — admit-where-the-host-
 * refuses, which is the one direction that must never happen. It is the same
 * rule this module already applies to a missing runtime snapshot: a question
 * that cannot be answered is refused, not answered optimistically.
 */
function filterList(value: unknown): { readonly list?: string[] } | 'unreadable' {
  if (value === undefined) return {};
  if (Array.isArray(value) && value.every(entry => typeof entry === 'string')) return { list: value };
  return 'unreadable';
}
/**
 * DOES THE TURN'S OWN CHANNEL RUN AN APPROVAL CLIENT THAT CAN DELETE OUR
 * TARGET? — the sixth host mechanism, and the one the other five miss.
 *
 * `resolveTargets` filters every resolved target through
 * `shouldSkipForwardingFallback` (`server-aux-handlers-BKv4BKQ5.mjs:340` →
 * `:215-224`), implemented by the target channel's own approval adapter. If it
 * claims our explicit target, `filteredTargets.length === 0`, `handleRequested`
 * returns false (`:387-390`) and the forwarder delivers nothing.
 *
 * TWO ADAPTER FAMILIES, AND THEY BEHAVE DIFFERENTLY.
 *
 *  - The STANDARD routing family
 *    (`approval-delivery-helpers-y-bw7F82.mjs:7-59`) CANNOT claim our target
 *    while `mode === "targets"`, which check 2 already requires — but NOT at
 *    the gate this comment used to cite, and the difference matters because
 *    the cited branch is not the one our own targets take. An explicit
 *    configured target reaches the suppressor with `target.source ===
 *    "target"`, so the eligibility gate it meets
 *    (`approval-native-helpers-D9UH_amF.mjs:314-325`) is
 *    `isExplicitTargetEligible` (`:268-275` →
 *    `isExplicitTargetApprovalEligibleViaForwarding` `:169-183`) and NOT the
 *    session gate — and that one REQUIRES `approvalModeIncludesTargets`
 *    (`:172`, `:124`), so under `targets` it PASSES.
 *    The refusal lands one step later. Both of the suppressor's `return true`
 *    paths (`:340` and `:341-346`) go through resolvers gated on
 *    `routeGates.shouldHandleApprovalRequest`
 *    (wired at `approval-delivery-helpers:23` and `:37`), which IS
 *    `isSessionApprovalEligible` (`approval-native-helpers:276-279`) →
 *    `isSessionApprovalEligibleViaForwarding` (`:260-266`) →
 *    `approvalModeIncludesSession` (`:158`, `:121-123`) — false for `targets`.
 *    So `createOriginTargetResolver` returns null at `:351`,
 *    `createChannelApproverDmTargetResolver` returns `[]` at `:386`, the
 *    suppressor answers false, and the target survives. The conclusion is the
 *    one this check already relied on; only the reason was cited from the
 *    half that does not apply to us.
 *  - The APPROVER-RESTRICTED family
 *    (`approval-delivery-helpers-y-bw7F82.mjs:171-182`) never looks at `mode`.
 *    It returns whatever `isNativeDeliveryEnabled({cfg, accountId})` says, and
 *    for Telegram that is `isTelegramExecApprovalClientEnabled`
 *    (`channel-CHfjx_3S.mjs:209`) = `enabled !== false` AND at least one
 *    approver (`approval-client-helpers-o0nF7MjT.mjs:13-16`), with `enabled`
 *    DEFAULTING TO `"auto"` (`exec-approvals-D22xLsQ6.mjs:28`) and approvers
 *    falling back to `commands.ownerAllowFrom` (`:21-24`, `:34-39`). So it can
 *    fire on exactly the configuration this guard needs.
 *
 * WHAT THIS CHECK COVERS, AND WHAT IT DOES NOT. The predicate itself is a
 * channel-plugin closure reached through `getLoadedChannelPlugin`, which is in
 * no `exports` entry of the installed `openclaw` package (searched
 * `dist/plugin-sdk/*.js` and `*.d.ts`), so a plugin cannot evaluate it. What a
 * plugin CAN read from the same snapshot is the configuration those closures
 * read: the `execApprovals` block on the channel's own account entries
 * (`types.openclaw-D-pPz-sB.d.ts:2617`, `:3204`, `:3294` — Discord, Slack,
 * Telegram). Declared and not explicitly disabled ⇒ refuse. NOT COVERED, and
 * stated rather than approximated: a channel whose plugin declares that
 * capability while the operator writes no `execApprovals` block at all still
 * resolves to `"auto"`. Reproducing that would mean reproducing each channel's
 * approver grammar, which is the mistake `routeDifference` refuses for the same
 * reason.
 *
 * WHY THE UNCOVERED HALF IS BOUNDED. The suppressor runs at
 * `server-aux-handlers:340`, inside `resolveTargets`, which the ladder reaches
 * only at `approval-shared-ouR8XZ--.mjs:347` — STRICTLY AFTER `:342` and `:343`
 * have broadcast to approval clients and `:345` has published to every internal
 * subscriber. It can therefore only SUBTRACT the delivery this module
 * validated; it can add no destination that those earlier lines did not already
 * reach, and those are exactly the surfaces §18.3 records as not constrained by
 * `targets`. What it costs is that the owner may never see the prompt and the
 * call blocks to timeout — fail closed, silently.
 */
function channelClaimsApprovals(cfg: unknown, channel: string): boolean {
  const channelConfig = field(field(cfg, 'channels'), channel);
  if (!channelConfig) return false;
  const accounts = field(channelConfig, 'accounts');
  const entries: unknown[] = [channelConfig];
  if (accounts && typeof accounts === 'object' && !Array.isArray(accounts)) {
    for (const key of Object.getOwnPropertyNames(accounts)) entries.push(field(accounts, key));
  }
  return entries.some(entry => {
    const approvals = field(entry, 'execApprovals');
    // Absent is the only shape that says nothing; `false` is the operator
    // saying it off. Anything else — `true`, `"auto"`, unreadable — is refused.
    return approvals !== undefined && field(approvals, 'enabled') !== false;
  });
}
/** `webchat` normalizes fine but is not deliverable. The host's own delivery
 *  test `isDeliverableMessageChannel` is not exported to plugins, and
 *  `isGatewayMessageChannel` is exactly it plus `webchat`
 *  (`openclaw/dist/message-channel-normalize-BB_YA0eD.mjs:10-16`), so
 *  subtracting the one known difference reproduces the host's test rather than
 *  a lookalike. */
function deliverableChannel(raw: string, readers: OwnerApprovalRouteReaders): string | undefined {
  const normalized = readers.resolveChannel(raw);
  return !normalized || normalized === 'webchat' ? undefined : normalized;
}
/**
 * SAME ROUTE — or the NAME of the first axis on which it is not.
 *
 * Channel and address follow `channelRoutesMatchExact`
 * (`openclaw/dist/channel-route-BQEi692o.mjs:73-76`) over
 * `normalizeChannelRouteRef` (`:15-35`): channel normalized, `to` TRIMMED ONLY,
 * compared exactly. The account used to follow it too, and that is where it
 * went wrong: that helper is the forwarder's DEDUPE comparison (`buildTargetKey`
 * at `server-aux-handlers-BKv4BKQ5.mjs:189-198` → `channelRouteDedupeKey`), and
 * it keeps a missing account apart from a present one. The account axis now has
 * its own rule — see `sameAccount`.
 *
 * Each axis refuses under its own name, so the line an operator greps says
 * which value to look at.
 *
 * THE COMPARISON IS EXACT ON PURPOSE, AND `normalizeE164` IS NOT USED. It is
 * tempting, because a phone number and a JID spell the same person
 * differently. It is also wrong here: measured on this bundle,
 * `normalizeE164` is a digit extractor rather than a validator —
 * `"120363012345678901@g.us"` (a GROUP jid) becomes `"+120363012345678901"`
 * and `"C0123ABCD"` becomes `"+0123"`. Two genuinely different conversations
 * can collapse onto one string, so putting it on an authorization path would
 * widen equality in the one direction that must never widen. Inventing a
 * channel's own address grammar here would be the same mistake with more
 * steps. The cost is real and is written down: if a channel spells its reply
 * address differently from the form an operator configures, this simply never
 * matches, and the feature is safe and inert rather than unsafe.
 */
function routeDifference(sdk: OwnerApprovalRouteSdk, cfg: unknown,
  target: { channel: string; to: string; accountId?: string },
  turn: { channel: string; to: string; accountId?: string }): OwnerApprovalRouteRefusal | undefined {
  if (target.channel !== turn.channel) return 'OWNER_ROUTE_TARGET_CHANNEL_NOT_THIS_TURN';
  if (target.to !== turn.to) return 'OWNER_ROUTE_TARGET_ADDRESS_NOT_THIS_TURN';
  if (!sameAccount(sdk, cfg, turn.channel, target.accountId, turn.accountId)) return 'OWNER_ROUTE_TARGET_ACCOUNT_NOT_THIS_TURN';
  return undefined;
}

/**
 * THE ACCOUNT AXIS — exact, except for one case, and that case is not a
 * widening.
 *
 * The comparison above was borrowed from the host's DEDUPE key, which keeps a
 * missing account apart from a present one. In dedupe that is the conservative
 * choice: the worst case is delivering twice. Borrowed into an authorization
 * check the same choice is a false refusal, and it was one on a real instance:
 * `channels.whatsapp.accounts` unset, the turn on `default`, the target written
 * `{channel, to}` with no account — refused, although the host could deliver
 * that target through exactly one account, the one the turn arrived on.
 *
 * What the host does with a target that names no account is hand `accountId:
 * undefined` to the channel (`server-aux-handlers-BKv4BKQ5.mjs:273-281`), which
 * delivers through ITS default account. So "absent" means "the channel's
 * default account", and whether that is this turn's account is answerable here
 * only when the channel has ONE account:
 *
 *  - every case that is not (target absent, turn present) is compared exactly,
 *    through the host's `normalizeOptionalAccountId`, as before — a target that
 *    NAMES an account still has to name this one;
 *  - target absent, turn present: admitted only when `soleAccountId` can name
 *    the channel's one account from the runtime snapshot, and it is this
 *    turn's.
 *
 * WHY THAT IS NOT A WIDENING. Channel and address are compared exactly, above,
 * and this case never reaches them. On a channel with exactly one account the
 * host has exactly one account to deliver through, so "absent" and that
 * account are the same destination — nothing is merged, a second spelling of
 * one route is recognised. Where there could be two accounts, `soleAccountId`
 * answers `undefined` and the target stays refused; the operator writes the
 * account out.
 */
function sameAccount(sdk: OwnerApprovalRouteSdk, cfg: unknown, channel: string,
  targetAccount: string | undefined, turnAccount: string | undefined): boolean {
  const target = sdk.normalizeOptionalAccountId(targetAccount);
  const turn = sdk.normalizeOptionalAccountId(turnAccount);
  if (target !== undefined || turn === undefined) return (target ?? '') === (turn ?? '');
  const sole = soleAccountId(sdk, cfg, channel);
  return sole !== undefined && sole === turn;
}

/**
 * THE CHANNEL'S ONE ACCOUNT, OR `undefined` WHEN IT MAY HAVE MORE THAN ONE —
 * read from the same runtime snapshot the rest of this module reads.
 *
 * The id is RESOLVED, never typed: the account list goes through the host's
 * `resolveListedDefaultAccountId` (`account-helpers-D6JJwsKg.mjs:88-95`, where a
 * listed `defaultAccount` beats a literal `default`), and the implicit single
 * account is the host's own `DEFAULT_ACCOUNT_ID`. What exactly delivers is the
 * channel plugin's own `resolveDefaultAccountId`, a closure reached through
 * `getLoadedChannelPlugin`, which no `exports` entry offers (see
 * `channelClaimsApprovals`). So this reproduces the generic rule and REFUSES
 * every configuration where a channel-specific input could make the answer
 * differ:
 *
 *  - accounts the snapshot names: the keys of `channels.<ch>.accounts`, through
 *    the host's `normalizeAccountId`, plus every account a route binding names
 *    for this channel (`listBoundAccountIds`), which the Telegram selection
 *    already counts as an account (`account-selection-BBzrj2eW.mjs:37`). More
 *    than one ⇒ multi-account ⇒ `undefined`. An `accounts` value that is not a
 *    plain object cannot be counted ⇒ `undefined`.
 *  - none named: the implicit single account, `DEFAULT_ACCOUNT_ID`.
 *  - exactly one named, and it is not `DEFAULT_ACCOUNT_ID`: admitted only when
 *    `defaultAccount` names it. A channel can hold an implicit top-level
 *    account beside `accounts` (Telegram's `botToken`,
 *    `account-selection-BBzrj2eW.mjs:30-34`), which the generic rule cannot
 *    see; an explicit, listed `defaultAccount` is the one input that makes the
 *    host resolve to the named account regardless.
 *  - a `defaultAccount` that names no listed account: the channel's own
 *    `allowUnlistedDefaultAccount` option decides that, and it is unreadable
 *    here ⇒ `undefined`.
 */
function soleAccountId(sdk: OwnerApprovalRouteSdk, cfg: unknown, channel: string): string | undefined {
  const channelConfig = field(field(cfg, 'channels'), channel);
  const accounts = field(channelConfig, 'accounts');
  const named = new Set<string>();
  if (accounts !== undefined) {
    if (!accounts || typeof accounts !== 'object' || Array.isArray(accounts)) return undefined;
    for (const key of Object.getOwnPropertyNames(accounts)) if (key) named.add(sdk.normalizeAccountId(key));
  }
  try {
    for (const id of sdk.listBoundAccountIds(cfg as never, channel)) named.add(sdk.normalizeAccountId(id));
  } catch { return undefined; }
  if (named.size > 1) return undefined;
  const rawDefault = field(channelConfig, 'defaultAccount');
  if (rawDefault !== undefined && typeof rawDefault !== 'string') return undefined;
  const preferred = sdk.normalizeOptionalAccountId(rawDefault);
  const listed = named.size === 1 ? [...named] : [sdk.defaultAccountId];
  if (preferred !== undefined && !listed.includes(preferred)) return undefined;
  if (listed[0] !== sdk.defaultAccountId && preferred !== listed[0]) return undefined;
  return sdk.resolveListedDefaultAccountId({ accountIds: listed, configuredDefaultAccountId: preferred });
}

/**
 * WAS THE OWNER ALLOWLIST EVER SET UP? — the one part of "the host says this
 * sender is not the owner" that can be told apart from the guard simply
 * working correctly.
 *
 * `senderIsOwner` has exactly two producers
 * (`openclaw/dist/command-auth-D4uAtGGe.mjs:330-331`):
 * `senderIsOwnerByIdentity`, which requires `explicitOwners.length > 0`
 * (`:214`, `:324`) and therefore a usable `commands.ownerAllowFrom`; and
 * `senderIsOwnerByScope` (`:329`), which requires `isInternalMessageChannel`
 * — and that constant is literally `"webchat"`
 * (`openclaw/dist/message-channel-constants-Cd7Eq8Zi.mjs:3`). So on ANY OTHER
 * CHANNEL, an absent owner allowlist makes `senderIsOwner` false for everyone,
 * always, with no error anywhere. That is a setup mistake and it should say so
 * rather than look like "you are not the owner".
 *
 * WHAT THIS CANNOT TELL APART, and the distinction is not invented to cover
 * it: once a list EXISTS, a wrongly spelled entry and a genuinely different
 * sender are the same observation from here. The comparison that decides it is
 * `explicitOwners.includes(candidate)` (`:324`) — plain string equality after
 * BOTH sides have gone through the channel plugin's own
 * `config.formatAllowFrom` (`:86-95`, reached from `:169-172` for the owner
 * list and `:255-260` for the sender), and that function is not reachable from
 * a plugin. So `configured` here means only "a list exists", never "the list
 * is right".
 */
export type OwnerAllowlistState = 'configured' | 'unconfigured' | 'unknown';
export async function readOwnerAllowlistState(
  readers: Partial<OwnerApprovalRouteReaders> = {},
): Promise<OwnerAllowlistState> {
  let cfg: unknown;
  // A caller that states the config needs no host at all; only the DEFAULT
  // reader has to reach for one, and an absent host is the same fact as an
  // unreadable snapshot — `unknown`, which the one caller treats as a refusal.
  try {
    if (readers.readActiveConfig) cfg = readers.readActiveConfig();
    else {
      const sdk = await loadRouteSdk();
      if (!sdk) return 'unknown';
      cfg = sdk.getRuntimeConfigSnapshot() as unknown;
    }
  } catch { return 'unknown'; }
  if (!cfg) return 'unknown';
  const raw = field(field(cfg, 'commands'), 'ownerAllowFrom');
  if (!Array.isArray(raw)) return 'unconfigured';
  // A wildcard is stripped before the owner comparison
  // (`stripWildcardAllowFrom` at `:214`), so a list of nothing but wildcards
  // resolves to an empty owner list exactly like an absent one.
  const usable = raw.filter(entry => (typeof entry === 'string' || typeof entry === 'number')
    && String(entry).trim().length > 0 && String(entry).trim() !== '*');
  // NOT REPRODUCED ON PURPOSE: an entry prefixed for another channel is
  // dropped by `:158-167`, so a non-empty list can still resolve to nothing.
  // Deciding that needs the host's channel-id resolution per turn; rather than
  // approximate it, such a list is reported `configured` and lands in the
  // indistinguishable bucket above.
  return usable.length > 0 ? 'configured' : 'unconfigured';
}

/**
 * The whole check, in the order that refuses earliest and reads least.
 *
 * Returns the targets on success so a caller can DELIVER down the route it
 * just validated, instead of validating one thing and sending to another.
 */
export async function resolveOwnerApprovalRoute(
  query: OwnerApprovalRouteQuery, readers: Partial<OwnerApprovalRouteReaders> = {},
): Promise<OwnerApprovalRoute> {
  // FIRST, and unconditionally — even when a caller states both readers. Most
  // of the host entry points are not readers at all: the filter predicate and
  // the account normalizers and default-account resolution ARE the host's
  // decision, reproduced by calling it. Without them this cannot answer whether the filters exclude this call,
  // and "cannot tell" is refused here exactly as it is for an unreadable
  // filter shape.
  const sdk = await loadRouteSdk();
  if (!sdk) return refuse('OWNER_ROUTE_CONFIG_UNAVAILABLE');
  const read: OwnerApprovalRouteReaders = { ...hostReaders(sdk), ...readers };
  const turnChannelRaw = text(query.channel);
  const turnTo = text(query.to);
  if (!turnChannelRaw || !turnTo) return refuse('OWNER_ROUTE_TURN_ADDRESS_ABSENT');
  const turnChannel = deliverableChannel(turnChannelRaw, read);
  // THE TURN's channel, not a target's. Saying `TARGET` here answered a
  // reader with a fact about the wrong half of the comparison.
  if (!turnChannel) return refuse('OWNER_ROUTE_TURN_CHANNEL_NOT_DELIVERABLE');
  // The host's own routing variable, when this host projects it. Equal is the
  // only admitting answer; ABSENT is not a refusal, because the field is
  // undeclared and losing it must cost accuracy, never the whole feature.
  const turnSource = text(query.turnSourceTo);
  if (turnSource !== undefined && turnSource !== turnTo) return refuse('OWNER_ROUTE_TURN_TARGET_DIVERGED');
  const turn = { channel: turnChannel, to: turnTo, ...text(query.accountId) !== undefined ? { accountId: text(query.accountId)! } : {} };
  let cfg: unknown;
  // A snapshot reader that throws is a host that cannot answer, which is the
  // same fact as having no snapshot — and never a reason to try the disk.
  try { cfg = read.readActiveConfig(); } catch { return refuse('OWNER_ROUTE_CONFIG_UNAVAILABLE'); }
  if (!cfg) return refuse('OWNER_ROUTE_CONFIG_UNAVAILABLE');

  const forwarding = field(field(cfg, 'approvals'), 'plugin');
  if (field(forwarding, 'enabled') !== true) return refuse('OWNER_ROUTE_FORWARDING_DISABLED');
  if (field(forwarding, 'mode') !== 'targets') return refuse('OWNER_ROUTE_MODE_NOT_TARGETS');
  // Check 6: a channel that runs its own approval client can delete the target
  // the other five checks are about to validate.
  if (channelClaimsApprovals(cfg, turnChannel)) return refuse('OWNER_ROUTE_CHANNEL_CLAIMS_APPROVALS');
  const agentFilter = filterList(field(forwarding, 'agentFilter'));
  const sessionFilter = filterList(field(forwarding, 'sessionFilter'));
  if (agentFilter === 'unreadable' || sessionFilter === 'unreadable') return refuse('OWNER_ROUTE_FILTER_UNREADABLE');
  // The host's own predicate, on the host's own request shape, with the same
  // `fallbackAgentIdFromSessionKey` the forwarder passes (`:181-186`).
  if (!sdk.matchesApprovalRequestFilters({
    request: { agentId: query.agentId ?? null, sessionKey: query.sessionKey ?? null },
    ...agentFilter.list ? { agentFilter: agentFilter.list } : {},
    ...sessionFilter.list ? { sessionFilter: sessionFilter.list } : {},
    fallbackAgentIdFromSessionKey: true,
  })) return refuse('OWNER_ROUTE_FILTERS_EXCLUDE_CALL');

  const rawTargets = field(forwarding, 'targets');
  if (!Array.isArray(rawTargets) || rawTargets.length === 0) return refuse('OWNER_ROUTE_NO_TARGET');
  const targets: OwnerApprovalRouteTarget[] = [];
  for (const raw of rawTargets) {
    const channel = text(field(raw, 'channel'));
    const to = text(field(raw, 'to'));
    if (!channel || !to) return refuse('OWNER_ROUTE_NO_TARGET');
    const normalized = deliverableChannel(channel, read);
    if (!normalized) return refuse('OWNER_ROUTE_TARGET_NOT_DELIVERABLE');
    // A THREAD ON THE TARGET IS REFUSED, not compared — and the reason this
    // comment used to give was false. It said the hook context carries no
    // thread id for this turn. It can carry one: the host projects
    // `turnSourceThreadId` from `options.currentThreadTs`
    // (`dist/agent-tools-DXxcrXNI.mjs:764`) onto the very context literal that
    // supplies `channelId` (`:759`) and `turnSourceTo` (`:762`), and carries it
    // on to the approval request it routes
    // (`dist/agent-tools.before-tool-call-WtmCO7BO.mjs:936`, `:991`). As with
    // `turnSourceTo` it is absent from the DECLARED `PluginHookToolContext`
    // (`dist/agent-harness-runtime-BvaKEkqR.d.ts:1700-1722`, which ends at
    // `requester`), and present only on turns that have a thread at all.
    //
    // THE BEHAVIOUR IS DELIBERATELY UNCHANGED. Nothing on this path reads that
    // field — `OwnerApprovalToolContext` does not declare it and the query this
    // function is given carries no thread — so comparing one would be new
    // ADMITTING behaviour: a target pinned to a thread, refused today, would
    // start being accepted. That is a reviewed change, not a comment fix, and
    // it is named as a follow-up rather than made here.
    //
    // WHAT SURVIVES WITHOUT THE FALSE PREMISE, so it cannot come back as the
    // justification: refusing is fail-closed and can only narrow what this
    // module pins, and the host's own target comparison counts the thread as
    // part of the route (`dist/approval-native-target-key-B0rOiEHN.mjs:4-8`),
    // so a thread-pinned target really is a different destination from a bare
    // one. The refusal is therefore inert where it used to be described as
    // protective — it is not evidence that a check exists here.
    if (field(raw, 'threadId') !== undefined) return refuse('OWNER_ROUTE_TARGET_THREAD_PINNED');
    const accountId = text(field(raw, 'accountId'));
    const target = { channel: normalized, to, ...accountId !== undefined ? { accountId } : {} };
    // EVERY target, not "at least one": the host delivers to all of them.
    const differs = routeDifference(sdk, cfg, target, turn);
    if (differs) return refuse(differs);
    targets.push(Object.freeze(target));
  }
  return { pinned: true, targets: Object.freeze(targets) };
}
