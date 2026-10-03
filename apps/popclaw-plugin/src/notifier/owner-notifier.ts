/**
 * OwnerNotifier — delivers L1 straight to the owner's active OpenClaw channel.
 *
 * One transport only: `sendDurableMessageBatch` (channel-outbound). The
 * system-event + heartbeat "wake the agent" leg was deleted on 2026-07-26 after
 * a real-device test proved it never reaches the owner — see `notifyOwnerNow`.
 */
import { NotificationDeliveryInactiveError, type Notifier, type NotificationDeliveryBatch } from './notifier.js';
import type { DeliveryFailureStore } from './delivery-failure.js';
import type { NotificationItem } from './types.js';
import type { OwnerDeliveryContext } from './owner-session.js';
import { renderL1, renderL1Batch } from './l1-content.js';

// Keep the existing content entrypoints available to callers during migration.
export { renderL1, mediaUrlsOf } from './l1-content.js';

export interface OwnerNotifier {
  /**
   * Push one message to the owner's active channel right now.
   * `false` = it did NOT go out (no target / channel rejected it) — the caller
   * owns the fallback. Reliability may never rest on a call that can't report
   * failure (the `requestHeartbeat` lesson, 2026-07-26). When supplied,
   * authorizeSend must run synchronously after all awaits, immediately before send.
   */
  deliverNow(text: string, mediaUrls?: string[], authorizeSend?: () => void): Promise<boolean>;
}

/**
 * The `sendDurableMessageBatch` subset we call — a **port**, deliberately not the
 * SDK type: this module must stay host-agnostic (the composition root in
 * index.ts supplies the real `openclaw/plugin-sdk/channel-outbound` function and
 * the real `OpenClawConfig`). It is the exact durable-send primitive the cron
 * daily-briefing uses — a direct write to the channel substrate, no heartbeat,
 * no agent turn (ADR research 2026-06-16).
 *
 * ⚠️ `skipQueue` is `@internal` in the SDK's own JSDoc (it lives on
 * `DeliverOutboundPayloadsParams`, which `DurableMessageBatchSendParams` keeps
 * through its `Omit`). It survived the 2026.6.6 → 2026.7.1-2 bump (re-verified
 * 2026-08-11), but it carries no compatibility promise: pin the SDK minor, and
 * `tests/unit/types/sdk-surface-smoke.test.ts` fails the build the day it goes.
 * Why we need it at all: see `deliverNow` below.
 */
export type SendDurableMessageBatch = (params: {
  cfg: unknown;
  channel: string;
  to: string;
  accountId?: string;
  threadId?: string | number | null;
  /** `mediaUrls` can be local file paths — each channel adapter is responsible
   *  for uploading them itself (#231). */
  payloads: { text: string; mediaUrls?: string[] }[];
  bestEffort?: boolean;
  skipQueue?: boolean;
}) => Promise<{ status: string; error?: unknown }>;

/**
 * The host's `error` is not guaranteed to be an Error — a plain object run
 * through `String()` becomes `[object Object]`, and this log line is the only
 * trap for catching "why did the host report partial_failed"; printing that
 * would render it a dud.
 */
function describeError(e: unknown): string {
  if (e === undefined || e === null) return '';
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  try {
    return JSON.stringify(e) ?? String(e);
  } catch {
    return String(e);
  }
}

/** Resolves the current delivery target by precedence; null = defer (no target). */
export type ResolveTarget = () => Promise<{ sessionKey?: string; deliveryContext?: OwnerDeliveryContext } | null>;

export interface MiniLogger {
  info(m: string): void;
  warn(m: string): void;
}

/**
 * Delivers an L1 line straight to the owner's pinned channel via OpenClaw 6.6's
 * `sendDurableMessageBatch` (`openclaw/plugin-sdk/channel-outbound`).
 *
 * Why not enqueueSystemEvent + heartbeat (the previous attempt): a system event
 * is agent *context*, surfaced only when a heartbeat *turn* runs and the model
 * chooses to relay it — and the heartbeat is hard-skipped while a cron session
 * is active (popclaw-recommend). sendDurableMessageBatch writes to the channel
 * directly (durable, hook-driven), bypassing all of that. Needs only
 * {cfg, channel, to, payloads}; the channel adapter self-bootstraps from cfg.
 *
 * Target comes from `resolveTarget()` (precedence: pinned channel → routable
 * last-active → null). A non-routable/absent target defers to inbox.
 */
export class RuntimeOwnerNotifier implements OwnerNotifier {
  constructor(
    private readonly send: SendDurableMessageBatch,
    private readonly cfg: unknown,
    private readonly resolveTarget: ResolveTarget,
    private readonly logger: MiniLogger,
  ) {}

  async deliverNow(text: string, mediaUrls?: string[], authorizeSend?: () => void): Promise<boolean> {
    const dc = (await this.resolveTarget())?.deliveryContext;
    if (!dc?.channel || !dc?.to) {
      this.logger.warn('popclaw: no routable notify target — L1 deferred to next interaction (pin one with /popclaw notify-here)');
      return false;
    }
    // A slash-command context prefixes `to` as "slash:<channelId>"; the durable
    // send wants the bare channel id (the Discord adapter uses `to` as channelId
    // — a "slash:…" value is rejected with "Invalid Form Body"). Strip the known
    // surface marker. ponytail: only `slash:` seen so far; extend if another
    // surface shows up.
    const to = dc.to.replace(/^slash:/, '');
    // skipQueue: true is the real exactly-once lever. sendDurableMessageBatch
    // sends once, but it first journals the send in the write-ahead delivery
    // queue; if the ack is lost in a channel reconnect/restart window, the
    // recovery/drain sweep blindly RE-SENDS the row — a second platform post
    // (the WeChat "with-context then contextToken-missing without-context" log is
    // that replay). skipQueue=null'd queueId → no row → nothing to replay → one
    // post. This is the maintainers' own fix for the analogous duplicate
    // proactive-cron messages (OpenClaw PR #40646 / issue #40545).
    // bestEffort: true additionally trims same-process retries; a proactive
    // notification is at-most-once by nature (a missed ping beats duplicate pings).
    authorizeSend?.();
    const res = await this.send({
      cfg: this.cfg,
      channel: dc.channel,
      to,
      accountId: dc.accountId,
      threadId: dc.threadId ?? null,
      // The image actually gets pushed to the owner's IM, not just a line
      // saying "there's an image, at this path".
      payloads: [{ text, ...(mediaUrls?.length ? { mediaUrls } : {}) }],
      bestEffort: true,
      skipQueue: true,
    });
    // Report, don't swallow. The caller drained the queue and is the only one
    // that can put the item back; hiding a failure here is how a ping dies.
    //
    // But `partial_failed` is not a failure: the host's `sentBeforeError: true`
    // explicitly says part of this batch already went out — the owner already
    // has this notification in hand. Returning it to the queue would make the
    // next new notification read it back out along with the whole stale batch
    // — that's exactly how the real-machine incident of 2026-07-28→29 happened
    // ("host-b sent an emoji, host-a pulled out the entire DM history"): every
    // notification carrying an image got judged partial_failed (all three
    // images were outbound send ok on the telegram side), the whole batch got
    // requeued, and only after attempts went 1→2→3 did it quietly get dropped.
    // Proactive notifications are inherently at-most-once (same reasoning as
    // `bestEffort: true`): missing one beats bombarding with duplicates.
    if (res.status === 'failed') {
      this.logger.warn(`popclaw: L1 send to ${dc.channel} failed: ${describeError(res.error)}`);
      return false;
    }
    if (res.status === 'partial_failed') {
      this.logger.warn(
        `popclaw: L1 partial_failed to ${dc.channel} — already went out, not requeuing: ${describeError(res.error)}`,
      );
      return true;
    }
    this.logger.info(`popclaw: L1 delivered to ${dc.channel} (${res.status})`);
    return true;
  }
}

/** Where this L1 delivery ended up going. */
export type NotifyOutcome =
  /** Direct channel write succeeded — the queue was consumed */
  | 'channel'
  /** Could not be delivered — the item was returned to the queue as-is, waiting
   *  for the owner to next speak (channel B) */
  | 'queued'
  /** No routable target — nothing was drained */
  | 'no-target'
  /** All claimed batches were cancelled before host invocation. */
  | 'inactive'
  /** The L1 queue was already empty */
  | 'nothing';

/**
 * Push pending L1 items, grouped by captured house when using a delivery view.
 *
 * Only one delivery path: `sendDurableMessageBatch`'s direct channel write —
 * this is the **only** channel in the entire project verified on a real
 * machine to actually reach the owner's phone (DMs have always used it).
 *
 * There used to be another branch here: `enqueueSystemEvent` +
 * `requestHeartbeat`, meant to "wake the agent so it can say it in its own
 * words." A real-machine test on 2026-07-26 disproved it: every step on the
 * plugin side printed success, and the owner received nothing; reproduced
 * with OpenClaw's own `openclaw system event --mode now`, which also failed
 * to deliver. Worse still, `requestHeartbeat` returns `void` — it neither
 * throws on failure nor reports on success, so "degrade only after the first
 * tier fails" could never trigger — the fallback chain was fake. **Never
 * build reliability on a call whose outcome can't be confirmed** — that
 * branch has been deleted entirely, no dead branch left behind.
 *
 * Order is resolve → drain: no target means nothing moves at all. A delivery
 * failure re-enqueues the drained item back onto L1 as-is — "leave it in the
 * queue if it can't be delivered" is only true when delivery can actually
 * report failure.
 *
 * Two cursors have different meanings and must never be merged: draining the
 * queue means "this interruption happened"; `reply_pings.read_at` means "the
 * owner actually saw the content," and only advances via `popclaw_show_pings`
 * — this path never touches it.
 *
 * Scoped to L1 only — there is no L2/L3 reporter in this codebase; an
 * unscoped drain would mark items at those tiers delivered here and
 * silently swallow them.
 */
/**
 * The maximum number of times a single L1 item can be requeued. After the
 * 3rd delivery failure it is **no longer requeued** — instead a warn is logged.
 *
 * Why a cap is needed: on a real machine, the host rejects sending an image
 * outside the workspace → the whole batch is judged failed → requeued as-is →
 * the next new notification drags this batch of old corpses out and sends
 * them again → forever. "A silent failure is bad, but infinite resending is
 * worse" — it would poison every single new notification. See issue #236 for
 * the adjacent-but-not-overlapping issue of failure visibility.
 */
const MAX_DELIVERY_ATTEMPTS = 3;

export async function notifyOwnerNow(deps: {
  notifier: Notifier;
  owner: OwnerNotifier;
  resolveTarget: ResolveTarget;
  logger: MiniLogger;
  /**
   * Before going out, copy the image into a directory the host is allowed to
   * send from (media-staging.ts). Returning null = this image can't go out
   * this time, **only the image is dropped, the text still goes out**. If
   * omitted, send from the original path directly (test/CLI path).
   */
  stageMedia?: (path: string) => string | null;
  /**
   * Records why the owner heard nothing (issue #236). Optional so the CLI and
   * test paths stay one-argument; when absent the behaviour is exactly today's.
   */
  failureStore?: DeliveryFailureStore;
  /** Unix seconds; injected so tests are not at the mercy of the wall clock. */
  now?: () => number;
}): Promise<NotifyOutcome> {
  // Resolve BEFORE draining: no target = nothing drained = nothing lost.
  const dc = (await deps.resolveTarget())?.deliveryContext;
  if (!dc?.channel || !dc?.to) {
    deps.logger.warn(
      'popclaw: notify level=queued reason=no-target — L1 stays queued (pin a channel with /popclaw notify-here)',
    );
    return 'no-target';
  }
  const batches = deps.notifier.claimDelivery?.('L1') ?? [{ items: deps.notifier.drain('L1') }];
  // A slow house batch must not hold another house's notification. The
  // returned promise still drains every actual send and receipt continuation.
  const completed = await Promise.allSettled(batches.map(batch => deliverOwnerBatch(deps, batch)));
  const rejected = completed.find(result => result.status === 'rejected');
  if (rejected?.status === 'rejected') throw rejected.reason;
  let outcome: NotifyOutcome = 'nothing';
  for (const result of completed) {
    if (result.status !== 'fulfilled') continue;
    const next = result.value;
    if (next === 'queued' || outcome === 'queued') outcome = 'queued';
    else if (next === 'channel' || outcome === 'channel') outcome = 'channel';
    else if (next === 'inactive') outcome = 'inactive';
  }
  if (outcome === 'channel') deps.failureStore?.clear();
  return outcome;
}

async function deliverOwnerBatch(
  deps: Parameters<typeof notifyOwnerNow>[0], batch: NotificationDeliveryBatch,
): Promise<NotifyOutcome> {
  const items = batch.items;
  if (items.length === 0) return 'nothing';
  try {
    batch.authorizeSend?.();
  } catch (error) {
    batch.cancel?.();
    if (!(error instanceof NotificationDeliveryInactiveError)) throw error;
    return 'inactive';
  }

  let text: string;
  let media: string[];
  try {
    const content = renderL1Batch(items);
    // When multiple items are merged into one message, images are unioned —
    // one interruption, not a single image dropped. An image whose staging
    // failed simply doesn't make the cut (flatMap drops the empty result),
    // without affecting the text.
    // An image link inside the body is a **remote url**, not a local file:
    // staging (copying into a host-sendable directory) can't do anything with
    // it, so it's handed to the channel adapter as-is to fetch itself.
    media = content.mediaUrls.flatMap((path) => {
      const staged = /^https?:\/\//i.test(path) ? path : deps.stageMedia ? deps.stageMedia(path) : path;
      return staged ? [staged] : [];
    });
    text = content.text;
  } catch (error) {
    // No host invocation occurred; keep the original row and retry budget.
    batch.cancel?.();
    throw error;
  }

  let ok = false;
  let err: unknown;
  try {
    ok = batch.authorizeSend
      ? await deps.owner.deliverNow(text, media, batch.authorizeSend)
      : await deps.owner.deliverNow(text, media);
  } catch (e) {
    if (e instanceof NotificationDeliveryInactiveError) {
      batch.cancel?.();
      return 'inactive';
    }
    err = e;
  }
  if (ok) {
    deps.notifier.confirmDelivery?.(items);
    deps.logger.info(`popclaw: notify level=channel — delivered (n=${items.length})`);
    return 'channel';
  }
  const reason = err === undefined ? 'channel rejected' : describeError(err);
  // Written BEFORE the requeue loop: if that loop throws, the owner still gets
  // told that something failed, which is the entire point of #236.
  deps.failureStore?.set({
    at: (deps.now ?? (() => Math.floor(Date.now() / 1000)))(),
    reason,
  });
  let requeued = 0;
  for (const item of items) {
    const attempts = attemptsOf(item) + 1;
    // Durable DM references have an independent gateway retry observer. Keep
    // the same queue ID and back off so an ordinary outage cannot exhaust a
    // three-attempt budget in seconds. Legacy notification policy is unchanged.
    const durableDm = item.kind === 'dm' && typeof item.payload.messageId === 'number';
    if (attempts >= MAX_DELIVERY_ATTEMPTS && !durableDm) {
      // Give up loudly: include the kind and a summary, so the owner/developer
      // can tell at a glance what got dropped.
      deps.logger.warn(
        `popclaw: notify DROPPED after ${attempts} attempts kind=${item.kind} — ${renderL1(item).slice(0, 120)}`,
      );
      if (item.deliveryLeaseToken) deps.notifier.discardDelivery?.([item]);
      continue;
    }
    const retryAfter = durableDm
      ? (deps.now ?? (() => Math.floor(Date.now() / 1000)))() + Math.min(3600, 30 * 2 ** Math.min(attempts - 1, 7))
      : undefined;
    const payload = { ...item.payload, attempts, ...(retryAfter ? { retryAfter } : {}) };
    if (item.deliveryLeaseToken && deps.notifier.retryDelivery) {
      if (deps.notifier.retryDelivery(item, payload)) requeued += 1;
    } else {
      deps.notifier.enqueue({ level: 'L1', kind: item.kind, payload });
      requeued += 1;
    }
  }
  deps.logger.warn(
    `popclaw: notify level=queued reason=delivery-failed (${reason}) — ${requeued} item(s) requeued`,
  );
  return 'queued';
}

/** How many times this notification has already failed delivery (carried
 *  along in the payload, still present after a requeue). */
function attemptsOf(item: NotificationItem): number {
  const n = Number((item.payload as { attempts?: unknown }).attempts ?? 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}
