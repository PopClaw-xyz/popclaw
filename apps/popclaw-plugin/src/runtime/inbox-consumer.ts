/**
 * The incoming-DM consumer — ONE copy, shared by all three composition roots
 * (`index.ts` for the OpenClaw gateway, `main.ts` for the dev CLI daemon,
 * `mcp.ts` for the stdio MCP bridge).
 *
 * It used to be hand-copied into each root, and both drifts that caused were
 * real (see the file header of tests/unit/messaging/dm-handler-parity.test.ts):
 * mcp.ts dropped `envelopeBytes`, main.ts never wrote the `dm_received` social
 * log. The fixed order of steps is the whole point of this module:
 *
 *   readDmBody → receiveDmMedia → InboxStore.record → `wasNew` gate →
 *   social log → plain-DM notice
 *
 * Two of those placements are load-bearing:
 *  - #227 single-point decryption: an undecryptable DM drops that ONE message,
 *    never the inbox loop. An attachment that won't decrypt or won't write
 *    drops only the attachment — the text is still delivered (#231).
 *  - The social log sits AFTER the `wasNew` gate. SSE reconnect backfill
 *    re-delivers the same DM N times and the UNIQUE index has already judged
 *    it; recording before the gate would turn one letter into N dreams.
 *
 * Discipline: this module must stay free of `node:*` imports (eslint exempts
 * only the composition roots + the host adapter). Anything needing the
 * filesystem or the host clock is injected.
 */
import type { popclaw } from '@popclaw/contracts';
import type { Signer } from '../identity/signer.js';
import { readDmBody } from '../messaging/dm-plaintext.js';
import { receiveDmMedia } from '../messaging/dm-media.js';
import type { InboxStore, StoredInboxItem } from '../messaging/inbox-store.js';
import { describeSseError } from '../ingress/sse-error.js';
import { safeRecord, type SocialLogRecorder } from '../social-log/social-log.js';

/** A DM that decrypted and was newly recorded. */
export interface PlainDmArrival {
  readonly item: StoredInboxItem;
  readonly dm: popclaw.event.IDirectMessage;
  readonly houseSlug: string;
  /** Sender's popclaw_id, already defaulted to '' the way the store recorded it. */
  readonly from: string;
  readonly body: string;
  readonly ts: number;
  /** Where the attachment landed on disk, if there was one and it survived. */
  readonly mediaPath: string | null;
  /**
   * `envelope.actor.nickname` — what the sender calls themselves. Empty on
   * legacy/synthetic frames that carry no envelope.
   *
   * Untrusted by construction: anyone can sign an envelope claiming any
   * nickname. That is survivable only because every owner-facing surface
   * renders it as `nickname#sigil`, and the sigil is derived from the key
   * (ADR-0015) — a name can be borrowed, a sigil cannot. It also ranks BELOW
   * the bond book in the name chain, so a person the owner has actually met
   * keeps the name the owner gave them.
   */
  readonly senderNickname: string;
}

export interface InboxConsumerDeps {
  /** The owner's signer — decrypts both the body (#227) and any attachment (#231). */
  readonly signer: Signer;
  readonly inboxStore: InboxStore;
  readonly socialLog: SocialLogRecorder | undefined;
  /** Read per message (the roots all resolve it lazily through PopclawPaths). */
  readonly dmMediaDir: () => string;
  /**
   * Naming for the saved attachment (see dmMediaFileName). Omit = sigil only.
   * NOT defaulted here: main.ts has never passed one, and quietly changing the
   * on-disk file names of an existing daemon is a behaviour change, not a
   * refactor. Tracked as a follow-up, see the knife's report.
   */
  readonly mediaNaming?: { sigilOf: (id: string) => string; nameOf?: (id: string) => string };
  /** Owner-visible log sink. Receives the FULL line, prefix included. */
  readonly info: (line: string) => void;
  /** Warning sink. Receives the FULL line, prefix included. */
  readonly warn: (line: string) => void;
  /**
   * Runs for a DM that decrypted and was new — AFTER the arrival line is
   * logged. The gateway hangs its relative-value gate and L1 push here; the
   * daemon and the MCP bridge have nothing to add.
   */
  readonly onPlainDm?: (arrival: PlainDmArrival) => void | Promise<void>;
}

/** The `onMessage` callback for `openHouseInboxStreams`. */
export function makeInboxOnMessage(
  deps: InboxConsumerDeps,
): (
  dm: popclaw.event.IDirectMessage,
  houseSlug: string,
  envelopeBytes: Uint8Array,
  senderNickname: string,
  /** Only the authenticated private receiver may provide its already-opened
   * plain result. Never populate this value from transport metadata. */
  authenticatedPlain?: { readonly originalText: string },
) => void | Promise<void> {
  return (dm, houseSlug, envelopeBytes, senderNickname, authenticatedPlain) => {
    // #227: single-point decryption. Downstream consumers (inbox storage /
    // social log / red-packet tickets / notifications / display) still get
    // plaintext, unchanged. If it can't be decrypted, only that one message is
    // dropped — the whole inbox loop is never taken down.
    const body = authenticatedPlain !== undefined ? authenticatedPlain.originalText : readDmBody(dm, deps.signer, (reason) =>
      deps.warn(
        `popclaw: inbox — undecryptable DM from ${(dm.fromPopclawId ?? '').slice(0, 8)}…` +
          ` [${houseSlug}] (${reason}) — skipped`,
      ),
    );
    if (body === null) return;
    const ts = typeof dm.ts === 'number' ? dm.ts : Number(dm.ts ?? 0);
    // #231 image: **two independent judgments** from the text — if the image
    // fails to decrypt or fails to write, only the image is dropped; the text
    // is still delivered.
    const mediaPath = receiveDmMedia(
      dm,
      deps.signer,
      deps.dmMediaDir(),
      ts,
      (m) => deps.warn(`${m} [${houseSlug}]`),
      deps.mediaNaming,
    );
    const { wasNew, item } = deps.inboxStore.recordReceived({
      ...(dm.mediaCiphertext?.length ? { mediaCiphertext: dm.mediaCiphertext } : {}),
      ts,
      fromPopclawId: dm.fromPopclawId ?? '',
      toPopclawId: dm.toPopclawId ?? '',
      body,
      inReplyToPlatform: dm.inReplyToPost?.platform ?? undefined,
      inReplyToPostId: dm.inReplyToPost?.platformPostId ?? undefined,
      receivedAtMs: Date.now(),
      houseSlug,
      ...(mediaPath ? { mediaPath } : {}),
      // P0-A: persist the full signed envelope (empty on synthetic/legacy frames).
      // Without it an inbox holds nothing but envelope-less letters, and v0.2
      // client-side verification can never be run over that stretch of history.
      ...(envelopeBytes.length > 0 ? { envelopeBytes } : {}),
      ...(senderNickname ? { senderNickname } : {}),   // #281
    });
    if (!wasNew && item.notificationState !== 'pending') return;

    // Social log `dm_received`. Placed **after** the `wasNew` gate — the UNIQUE
    // index has already deduplicated for us (SSE reconnect backfill resends the
    // same DM N times), and recording before the gate would log one message as
    // Carries house: which house relayed this message (ADR-0037, "facts carry
    // their house"; after cross-house dedup this records the house it **first**
    // arrived at — consistent with how inboxStore persists it).
    if (wasNew) safeRecord(deps.socialLog, {
      kind: 'dm_received',
      ...(houseSlug ? { house_slug: houseSlug } : {}),
      actor: { id: dm.fromPopclawId ?? '' },
      text: body,
    });

    const from = dm.fromPopclawId ?? '';
    deps.info(`popclaw: inbox — DM from ${from.slice(0, 8)}… [${houseSlug}]`);
    return deps.onPlainDm?.({ item, dm, houseSlug, from, body, ts, mediaPath, senderNickname });
  };
}

/** The `onError` callback for `openHouseInboxStreams` — one house failing only drops that house. */
export function makeInboxOnError(
  warn: (line: string) => void,
): (houseSlug: string, err: unknown) => void {
  return (houseSlug, err) => warn(`popclaw: inbox-stream error [${houseSlug}] — ${describeSseError(err)}`);
}
