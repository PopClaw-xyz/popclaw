/**
 * OwnerNotifyTargetStore — the owner's pinned proactive-notification channel.
 *
 * `/popclaw notify-here` captures the command's routable address (channel/to/…)
 * and pins it here so background L1 pushes always reach the owner's preferred
 * channel (Discord, WeChat, …), not wherever they last ran a command.
 *
 * Zero-config default: the owner should never have to know `notify-here` exists.
 * `captureIfUnset` pins the FIRST routable conversation we ever see (source
 * `auto`); `notify-here` is then only the explicit override (source `owner`).
 * Auto never replaces anything already stored — see captureIfUnset.
 *
 * Persisted as JSON in the `config` namespace so it survives a gateway restart
 * (the in-memory OwnerSession does not). Owner-private config, never on
 * lore-house (ADR-0024 / P-005).
 */
import type { HostStorage } from '../host/host-adapter.js';
import type { OwnerDeliveryContext } from './owner-session.js';

/** The owner's pinned delivery target. */
export interface OwnerNotifyTarget {
  readonly deliveryContext: OwnerDeliveryContext;
  readonly sessionKey?: string;
  /**
   * How this target got here. `owner` = explicit `/popclaw notify-here`,
   * `auto` = captured from the first conversation channel we saw.
   * ABSENT = written before this field existed → treat as `owner` (an explicit
   * pin must never be silently replaced by auto-capture).
   */
  readonly source?: 'owner' | 'auto';
}

const NS = 'config' as const;
const KEY = 'notify-target.json';

export class OwnerNotifyTargetStore {
  constructor(private readonly storage: HostStorage) {}

  async get(): Promise<OwnerNotifyTarget | null> {
    const raw = await this.storage.read(NS, KEY);
    if (!raw || raw.length === 0) return null;
    try {
      return JSON.parse(new TextDecoder().decode(raw)) as OwnerNotifyTarget;
    } catch {
      return null; // corrupt → treat as unset rather than crash the notifier
    }
  }

  async set(target: OwnerNotifyTarget): Promise<void> {
    await this.storage.write(NS, KEY, new TextEncoder().encode(JSON.stringify(target)));
  }

  /**
   * Zero-config capture: pin `target` (marked `auto`) only if nothing is stored
   * yet. Never replaces — neither an owner pin, nor an earlier auto one, nor a
   * legacy record with no `source` field. First conversation wins.
   *
   * Skips contexts with no routable `to` (browser/TUI): they can't receive a
   * push, same rule `notify-here` enforces.
   *
   * ponytail: no private-vs-group filter — the 6.6 `PluginCommandContext`
   * carries no `chatType` (the SDK's `ChatType` "direct|group|channel" lives on
   * agent-run params, not on the plugin command context), so there is nothing
   * to branch on. `/popclaw status` shows which channel got pinned, which is
   * the visible escape hatch. Add the filter if the SDK ever exposes chatType.
   */
  async captureIfUnset(target: OwnerNotifyTarget, beforeWrite?: () => void): Promise<boolean> {
    if (!target.deliveryContext.channel || !target.deliveryContext.to) return false;
    if (await this.get()) return false;
    beforeWrite?.();
    try {
      await this.storage.write(NS, KEY, new TextEncoder().encode(JSON.stringify({ ...target, source: 'auto' })), { exclusive: true, assertCommitAllowed: beforeWrite });
      return true;
    } catch (error) {
      // A concurrent owner pin or first conversation wins at publication too.
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw error;
    }
  }

  async clear(): Promise<void> {
    await this.storage.delete(NS, KEY);
  }
}
