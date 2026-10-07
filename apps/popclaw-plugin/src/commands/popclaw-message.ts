import { rethrowActionCancellation } from '../runtime/house-lifecycle/action-context.js';
/**
 * /popclaw message <to_popclaw_id> "<body>"
 *
 * Plan 12.1 — private 1:1 message to another popclaw user. Builds a signed
 * DirectMessage envelope and pushes via egress. Plan 12.0 / 12.1 MVP stores
 * plaintext (lore-house operator is trusted not to read or persist long-
 * term); Plan 12.x adds X25519 ECDH encryption to recipient's pubkey.
 *
 * The recipient can be a full popclaw_id, or a human-facing form
 * (name#sigil / bare sigil / name) — the latter is translated into a full
 * id via the injected PersonResolver (ADR-0028 amendment, 2026-07-25).
 */

import { signDirectMessage } from '../messaging/sign-message.js';
import { attachmentLine } from '../messaging/dm-presentation.js';
import { loadDmAttachment } from '../messaging/dm-media.js';
import { pushRejection, pushRouted } from '../egress/event-egress.js';
import type { Signer } from '../identity/signer.js';
import type { IdVerification } from '../identity/follow-resolution.js';
import {
  looksLikeBase58Id,
  unresolvedText,
  type PersonResolution,
} from '../identity/person-resolver.js';
import { displayNamed, type NameChain } from '../identity/person-name.js';
import { safeRecord, type SocialLogRecorder } from '../social-log/social-log.js';
import { renderCopy } from '../lexicon/index.js';
import { ownerLang } from '../lexicon/owner-language.js';

interface EgressLike {
  push(bytes: Uint8Array): Promise<unknown>;
  pushTo?(houseSlug: string | undefined, bytes: Uint8Array): Promise<unknown>;
}

export interface PopclawMessageArgs {
  positional: string[];
  /** `--image <local path>`: attach a file to the message (image / voice /
   *  text, ≤1MB). The flag keeps the name `--image` because it's the form
   *  the owner is already using; what it can actually send is no longer
   *  just images (see the allowlist in dm-media.ts). */
  flags?: Record<string, string>;
}

export interface PopclawMessageDeps {
  replyToEventId?: string;
  signer: Signer;
  egress: EgressLike;
  nickname: string;
  /**
   * Optional existence check (warn-but-send); injected at the call site.
   * `houseSlug` = the house this message is going to — that's the house
   * the roster should be queried against (slice 4).
   */
  verifyRecipient?: (id: string, houseSlug?: string) => Promise<IdVerification>;
  /** Identity resolution: human-facing form → full popclaw_id; not injected = only full ids are recognized. */
  resolveRecipient?: (ref: string) => Promise<PersonResolution>;
  /**
   * The person the owner approved in a draft. A full id skips resolution, so
   * without this the receipt could only say `#sigil` while the approval had
   * said `name#sigil`. Used only when the id matches.
   */
  approvedRecipient?: { readonly popclawId: string; readonly nickname: string; readonly sigil: string };
  /**
   * Explicit route supplied by the caller (an approved draft, exact reply,
   * or a live world session). Ordinary new messages use the home house.
   * This must never infer a route from the recipient's last incoming mail.
   */
  houseOfRecipient?: (id: string) => string | undefined;
  /** Social-log collection point `dm_sent` (spec 2026-07-26 §4). Not injected = not recorded. */
  socialLog?: SocialLogRecorder;
  /**
   * Unique name chain: the name returned by identity resolution / the
   * roster is what the other party **self-reports** — if the owner has
   * given them an alias, it should override that. Not injected = old
   * behavior (use the name from the resolver directly).
   */
  nameOf?: NameChain;
  /**
   * The attachment's BYTES, already read and validated, instead of a path to
   * read at send time.
   *
   * The confirmation gate needs this. A parked draft used to carry the path,
   * and `loadDmAttachment` re-read it here — so the file the owner approved
   * and the file that went out were only ever the same file by luck. Swapping
   * it between the approval and the send changed nothing the owner could see
   * and nothing the approval bound, because a path is not content. The draft
   * tools now hold the bytes they digested and hand them over here.
   *
   * The slash lane injects nothing and still reads its own `--image` path:
   * there, the person typing the command IS the owner and there is no gap
   * between approving and sending.
   */
  media?: { bytes: Uint8Array; mime: string; name: string };
}

/** Runs the self-reported name from resolution/roster through the name chain (alias takes priority), then renders it as `name#sigil`. */
function chainedPerson(
  p: { nickname: string; sigil: string; popclawId: string },
  nameOf?: NameChain,
): string {
  const name = nameOf?.(p.popclawId, p.nickname) || p.nickname;
  return name ? `${name}#${p.sigil}` : `#${p.sigil}`;
}

export async function runPopclawMessageCommand(
  args: PopclawMessageArgs,
  deps: PopclawMessageDeps,
): Promise<{ text: string; eventId?: string }> {
  const lang = ownerLang();
  const ref = args.positional[0];
  const body = args.positional.slice(1).join(' ');
  const imagePath = args.flags?.image;

  // Image with no text (real hardware, 2026-07-29): on WeChat you never
  // need a caption to send a sticker. An image alone is enough — "body is
  // required" is a leftover from the text-only era. Of course, both empty
  // is still rejected.
  // `deps.media` counts as an attachment: a draft that carries its bytes
  // passes no `--image` path, and an image-only DM would otherwise be told to
  // read the usage line (real hardware, 2026-07-29: the owner sent a sticker
  // and "body required" was a leftover from the text-only era).
  if (!ref || (!body && !imagePath && !deps.media)) {
    return { text: renderCopy(lang, 'message.usage') };
  }
  // Read and validate the image first: before doing anything network-bound
  // or irreversible, filter out "unrecognized format / can't read / over
  // 1MB". The tool side calls the same `loadDmImage` at draft stage, so
  // failing only after the owner has confirmed can't happen.
  let media: { bytes: Uint8Array; mime: string; name: string } | undefined = deps.media;
  // Only when the caller did not already hand over what it approved.
  if (!media && imagePath) {
    const loaded = loadDmAttachment(imagePath);
    if (!loaded.ok) return { text: loaded.text };
    media = { bytes: loaded.bytes, mime: loaded.mime, name: loaded.name };
  }
  // Human-facing forms first go through the resolver (local bond book /
  // world feed take priority, then ask the lore-house); if ambiguous, list
  // the candidates; if not found, say so honestly — never pretend to have
  // sent it. A full id passes straight through.
  let toId = ref;
  let display = '';
  if (!looksLikeBase58Id(ref)) {
    if (!deps.resolveRecipient) {
      return { text: renderCopy(lang, 'message.notAnId', { ref }) };
    }
    const r = await deps.resolveRecipient(ref);
    if (r.kind !== 'resolved') return { text: unresolvedText(ref, r, lang) };
    toId = r.popclawId;
    display = chainedPerson(r, deps.nameOf);
  } else if (deps.approvedRecipient?.popclawId === ref) {
    display = chainedPerson(deps.approvedRecipient, deps.nameOf);
  }
  // The guard that actually stops the write: nothing below this line has run,
  // so no envelope is signed and egress is never touched. The sentence was a
  // hardcoded English literal until the owner became resolvable by name and
  // this stopped being a corner case only a pasted id could reach.
  if (toId === (await deps.signer.popclawId())) {
    return { text: renderCopy(lang, 'person.thatIsYou') };
  }

  // Existence check (warn-but-send): a typo'd id is still valid base58. This
  // only checks a full id the owner typed by hand — an id that the resolver
  // returned was just identified from the bond book / world feed / the
  // lore-house, so asking again is a wasted round trip, and if the
  // lore-house is down it would even raise a false "couldn't verify"
  // banner.
  // The caller pins an explicit reply/world/draft route. An omitted route
  // uses home; recipient history is not a routing decision here.
  const houseSlug = deps.houseOfRecipient?.(toId);

  let warn = '';
  if (deps.verifyRecipient && !display) {
    const v = await deps.verifyRecipient(toId, houseSlug);
    if (v.status === 'unknown') warn = renderCopy(lang, 'message.recipientUnknown', { sigil: v.sigil });
    else if (v.status === 'offline') warn = renderCopy(lang, 'message.recipientUncheckable');
    // The lore-house recognizes them → the receipt also uses a human name (name#sigil), not just a truncated id string.
    else display = chainedPerson({ nickname: v.nickname, sigil: v.sigil, popclawId: toId }, deps.nameOf);
  }

  // #227: the body is encrypted to the recipient — and the recipient's
  // public key is their popclaw_id itself. So an id that "looks like base58
  // but isn't a real public key" (truncated / a typo) is guaranteed to fail
  // here. It used to "still send as written"; now it can only be honestly
  // blocked: nobody could decrypt this message. Never silently fall back to
  // plaintext.
  let signed;
  try {
    signed = await signDirectMessage(deps.signer, {
      toPopclawId: toId,
      body,
      nickname: deps.nickname,
      ...(deps.replyToEventId ? { replyToEventId: deps.replyToEventId } : {}),
      ...(media ? { media: { bytes: media.bytes, mime: media.mime } } : {}),
    });
  } catch (err) {
    rethrowActionCancellation(err);
    // The public envelope's fail-closed size cap is a protocol fact, not a
    // bad recipient: surface it as what it is instead of a key complaint.
    if (String(err).includes('WIRE_LIMIT')) {
      return { text: renderCopy(lang, 'message.wireLimit') };
    }
    return { text: renderCopy(lang, 'message.notAPublicKey', { toId }) };
  }
  const receipt = await pushRouted(deps.egress, houseSlug, signed.signedPayloadBytes);
  // A house REFUSES a push with a status code, not an exception
  // (egress/server-push-egress.ts returns `{status, detail}` on non-2xx), so
  // awaiting the push proves only that the transport spoke — not that the
  // letter was taken. Dropping the receipt here is why a DM the house rejected
  // still printed "✉️ sent DM … event_id" and still wrote `dm_sent`: a receipt
  // worth nothing as evidence, and a log of letters nobody received. The
  // relation producer reads the receipt it is handed (relation-assembly.ts);
  // this is the one caller that did not.
  //
  // Judged only when the seam actually reports a status: 2xx is the whole of
  // "accepted" here, deduplication included — lore-house answers a duplicate
  // with 200 and `deduplicated: true`, and reserves 409 for a real conflict.
  const rejection = pushRejection(receipt);
  if (rejection) {
    return {
      text: renderCopy(lang, 'message.notAccepted', {
        status: String(rejection.status),
        why: rejection.detail ? renderCopy(lang, 'message.notAccepted.reason', { detail: rejection.detail }) : '',
      }),
    };
  }

  // Social log: the push has already been awaited and succeeded. A DM is a
  // strong-tie signal, and the recipient's id is that edge.
  safeRecord(deps.socialLog, {
    kind: 'dm_sent',
    // Records whichever house it was sent to (the same value pushRouted used above).
    ...(houseSlug ? { house_slug: houseSlug } : {}),
    actor: { id: toId, ...(display ? { name: display } : {}) },
    text: body,
    event_id: signed.eventId,
  });

  const who = display || displayNamed(toId, deps.nameOf);
  const lines = [warn + renderCopy(lang, 'dm.presentation.sent', {who})];
  if (media) lines.push('', attachmentLine(media.name, lang, media.bytes.length));
  lines.push('', renderCopy(lang, 'dm.presentation.relay'));
  return {text: lines.join('\n'), eventId: signed.eventId};
}
