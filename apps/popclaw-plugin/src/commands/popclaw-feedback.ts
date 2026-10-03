/**
 * /popclaw feedback bug|need <body>
 *
 * The owner's agent wants to do something on their behalf that popclaw can't
 * do, or has hit a clear bug — this path sends the message straight to the
 * lore-house's official contact.
 *
 * No new endpoint, no new event, no notice-board change: **feedback is just
 * an ordinary DM**, addressed to the `feedback.popclaw_id` that the house
 * itself declares in guide.md frontmatter. Encryption, signing, and routing
 * all reuse the already-working path of `/popclaw message` (ADR-0042).
 *
 * The contact is only ever the id declared in the guide — it never falls
 * back to the notice board's `official_ids` (that's the id the house uses to
 * sign its own posts; nobody reads that inbox). When the target house hasn't
 * declared a contact, it **falls back to the primary house** (ADR-0042
 * Amendment 2): the root/canonical house is the general collection point for
 * popclaw product issues and federation communication issues, and the
 * message header carries the original target house.
 *
 * **Feedback follows the wall it hit** (ADR-0042 amendment, 2026-07-30): if
 * it's a wall in popclaw itself (commands / notifications / the daily paper
 * / protocol) → leave house unset, send to the primary house; if it's a wall
 * in some specific house's own gameplay → `--house <slug>`, send to that
 * house — the contact comes from that house's guide, persisted on disk from
 * the lore-house handshake (ADR-0041). Deciding who should receive it is up
 * to the agent (it has the context); the plugin does no automatic
 * classification.
 */

import { houseRefToSlug } from '../ingress/host-slug.js';
import { parseGuideFrontmatter } from '../world/guide.js';
import { renderCopy, type Lang } from '../lexicon/index.js';
import { ownerLang } from '../lexicon/owner-language.js';
import { routingLine } from './status.js';
import { routingStats, type RoutingStats } from '../routing/stats.js';
import {
  runPopclawMessageCommand,
  type PopclawMessageArgs,
  type PopclawMessageDeps,
} from './popclaw-message.js';
import { runPopclawReactCommand, type PopclawReactDeps } from './popclaw-react.js';

export interface PopclawFeedbackArgs {
  positional: string[];
  /** `--house <slug>`: which house's gameplay this feedback is about; omit = the primary house (popclaw itself). */
  flags?: Record<string, string>;
}

/**
 * Everything the owner has to see before a feedback letter goes out, frozen
 * at the moment the destination was resolved.
 *
 * The letter is an ordinary outbound DM, so the agent path has to clear the
 * same confirmation gate every other outbound DM clears — see `draftDm`
 * below. This is what the preview is built from: the recipient, the house
 * whose contact that is, and the complete text. Nothing is appended after
 * the owner has read it.
 */
export interface FeedbackDraftPlan {
  readonly kind: 'bug' | 'need';
  /** The resolved contact's popclaw_id — the exact id the parked send is bound to. */
  readonly contactPopclawId: string;
  /** The name that house's guide.md declares for its contact; it may declare none. */
  readonly contactName?: string;
  /** The house whose contact this letter is addressed to, after any fallback. */
  readonly house: string;
  /** The house the caller named, when the fallback moved the letter off it. */
  readonly requestedHouse?: string;
  /** The complete text that will be sent, `[feedback/v1]` header included. */
  readonly body: string;
  /** The health report riding along, when one was built. */
  readonly attachmentPath?: string;
}

export interface PopclawFeedbackDeps extends PopclawMessageDeps {
  /** Full text of the primary house's guide.md; unavailable → null (network failure / non-2xx, see GuideClient). */
  fetchGuide: () => Promise<string | null>;
  /** Primary house slug: the default recipient house, also used for the honest "this house hasn't declared a contact" error message. */
  houseSlug: string;
  /**
   * The guide for a non-primary house: the one persisted on disk from the
   * lore-house handshake (ADR-0041, `readHouseGuide`). No handshake yet /
   * the house hasn't declared a guide_url → null (never guess the path).
   * Not injected = can only send to the primary house.
   */
  readHouseGuide?: (slug: string) => string | null;
  /**
   * The slugs of houses already registered (each `lore_houses` entry's
   * `hostDbSlug`). On real hardware the house is `house.popclaw.world` →
   * slug `house-popclaw-world`, but what people actually say is
   * "popclaw.world" — naive character-folding alone would produce a slug
   * nobody owns, so this must be matched against the list of registered
   * houses. Not injected → falls back to plain character-folding (old
   * behavior).
   */
  knownHouseSlugs?: readonly string[];
  /** Build stamp (`POPCLAW_BUILD`), goes into the `[feedback/v1]` header — so the recipient sees the version at a glance. */
  buildStamp: string;
  /**
   * `/popclaw doctor send` and `popclaw_feedback`'s `attach_doctor_report`
   * share this slot: set = this feedback carries the health-check report as
   * an attachment and the body gains one line of build + routing verdict
   * (the same verdict `/popclaw status` prints); unset = plain feedback
   * (final doc §3 item 4).
   */
  attachmentPath?: string;
  /** Test seam — defaults to the live process-wide routing counters (same
   *  yardstick as status.ts). Read only when `attachmentPath` is given. */
  routingStats?: () => RoutingStats;
  /**
   * The dependency set used to forward the deprecated `feedback up|down`
   * alias to react. Optional: the typed tool's (popclaw_feedback) `kind` is
   * a bug|need enum, so it can never reach this alias and doesn't need to
   * wire it up.
   */
  react?: PopclawReactDeps;
  /** Test seam: defaults to `/popclaw message` itself. */
  sendDm?: (
    args: PopclawMessageArgs,
    deps: PopclawMessageDeps,
  ) => Promise<{ text: string }>;
  /**
   * Set by the AGENT path (`popclaw_feedback`): do not send — park the
   * finished letter behind a draft_id and return the preview instead.
   *
   * Real hardware, 2026-09-21: a world action failed, and the model sent a
   * feedback letter to the home lore-house's contact on its own initiative,
   * carrying the error and the test parameters. Nobody had asked for it, and
   * nobody saw the recipient or the text before it left. A letter is an
   * outbound private message to a person, so the agent path goes through the
   * same gate `popclaw_draft_message` → `popclaw_send_draft` puts in front of
   * every other outbound private message.
   *
   * Unset = the owner typed `/popclaw feedback` themselves, which is the
   * owner acting: it sends straight away, exactly like `/popclaw message`.
   *
   * `send` is the whole tail — the DM plus this command's own receipt — so
   * confirming a feedback draft yields the same receipt the slash command
   * would have printed, not a bare DM one.
   */
  draftDm?: (
    plan: FeedbackDraftPlan,
    send: () => Promise<{ text: string }>,
  ) => Promise<{ text: string }>;
  /** S3 rollout — defaults to `ownerLang()` (S1 process-wide singleton). */
  lang?: Lang;
}

/**
 * Hand-typed house name → the registered house's official slug. A person
 * says "popclaw.world"; on real hardware that house is named
 * `house-popclaw-world` — naive character-folding alone would produce a
 * slug nobody owns, so every `--house` would fall into "no such house".
 * So: fold first, then match against the registered list — an exact hit
 * wins first, otherwise the one house whose slug uniquely contains it; if
 * several match, surface the candidates and let the agent pick — never
 * guess on its behalf.
 */
function resolveHouse(
  ref: string,
  known: readonly string[] | undefined,
): { slug: string } | { candidates: readonly string[]; ambiguous: boolean } {
  const folded = houseRefToSlug(ref);
  if (!known?.length || known.includes(folded)) return { slug: folded };
  const hits = known.filter((s) => s.includes(folded));
  if (hits.length === 1) return { slug: hits[0]! };
  return { candidates: hits.length > 0 ? hits : known, ambiguous: hits.length > 1 };
}

export async function runPopclawFeedbackCommand(
  args: PopclawFeedbackArgs,
  deps: PopclawFeedbackDeps,
): Promise<{ text: string }> {
  const lang = deps.lang ?? ownerLang();
  const kind = args.positional[0];

  // Deprecated alias: `feedback up|down <postId>` was the old usage before
  // 2026-07-29 (upvote/downvote a recommendation). Still works as before,
  // just appends a mention of the new name to the receipt.
  if (kind === 'up' || kind === 'down') {
    if (!deps.react) {
      return { text: renderCopy(lang, 'feedback.alias.noReact') };
    }
    const r = await runPopclawReactCommand(args, deps.react);
    return { text: `${r.text}\n${renderCopy(lang, 'feedback.alias.renamedSuffix')}` };
  }

  const body = args.positional.slice(1).join(' ').trim();
  if ((kind !== 'bug' && kind !== 'need') || !body) {
    return { text: renderCopy(lang, 'feedback.usage') };
  }

  // Feedback follows the wall it hit: house unset = primary house (goes
  // through GuideClient — the primary house's guide isn't necessarily
  // persisted on disk); if set, read that house's guide from the handshake
  // cache. If the value given is exactly the primary house → same as unset.
  const houseRef = args.flags?.house?.trim();
  let target = deps.houseSlug;
  if (houseRef) {
    const hit = resolveHouse(houseRef, deps.knownHouseSlugs);
    if (!('slug' in hit)) {
      const list = hit.candidates.join(renderCopy(lang, 'feedback.listSep'));
      return {
        text: hit.ambiguous
          ? renderCopy(lang, 'feedback.house.ambiguous', { ref: houseRef, list })
          : // Deliberately no way out on offer. This refusal used to add "drop
            // the house flag and it goes to the home lore-house's contact",
            // and on real hardware (2026-09-21) the model read it as an
            // instruction: refused once for 127.0.0.1:8113, it retried
            // without the flag and mailed the home contact instead. A house
            // the owner named and popclaw cannot find is a full stop.
            renderCopy(lang, 'feedback.house.notFound', { ref: houseRef, list }),
      };
    }
    target = hit.slug;
  }
  const readContact = async (slug: string) => {
    const md = slug === deps.houseSlug ? await deps.fetchGuide() : (deps.readHouseGuide?.(slug) ?? null);
    return md ? parseGuideFrontmatter(md).frontmatter?.feedback : undefined;
  };

  let toPrimary = target === deps.houseSlug;
  let contact = await readContact(target);
  // Falls back to the root house (ADR-0042 Amendment 2): if the target
  // house has no guide on file / hasn't declared a contact → no longer
  // reject, send to the primary house instead — the root/canonical house
  // is the general collection point for popclaw product issues and
  // federation communication issues. The header carries the original
  // target house, so the "redirect" is written into the message itself,
  // not a silently swapped recipient.
  const fellBack = !contact?.popclawId && !toPrimary;
  if (fellBack) {
    contact = await readContact(deps.houseSlug);
    toPrimary = true;
    if (!contact?.popclawId) {
      return {
        text:
          renderCopy(lang, 'feedback.contact.fallbackFailedMain', { target, houseSlug: deps.houseSlug }) +
          '\n' +
          (deps.knownHouseSlugs?.length
            ? renderCopy(lang, 'feedback.contact.knownHousesLine', {
                list: deps.knownHouseSlugs.join(renderCopy(lang, 'feedback.listSep')),
              }) + '\n'
            : '') +
          renderCopy(lang, 'feedback.contact.declareHint'),
      };
    }
  }
  if (!contact?.popclawId) {
    return {
      text:
        renderCopy(lang, 'feedback.contact.noneAtAll', { houseSlug: deps.houseSlug }) +
        '\n' +
        renderCopy(lang, 'feedback.contact.declareHint'),
    };
  }

  // The first line gives the recipient version context (if house was set,
  // include the target house too — that's the only clue on a fallback);
  // the body is copied verbatim — the agent has already composed it
  // following the guide's template, and we have no business rewriting it.
  const houseToken = houseRef ? ` house=${target}` : '';
  // With an attachment (the health report), the body gains one line of
  // build + routing verdict — the recipient can do first-pass triage without
  // opening the attachment (final doc §3 item 4).
  const diagnosticsPrefix = deps.attachmentPath
    ? `popclaw build ${deps.buildStamp} · ${routingLine((deps.routingStats ?? routingStats)(), lang)}\n`
    : '';
  const composed = `[feedback/v1] kind=${kind}${houseToken} plugin=${deps.buildStamp}\n${diagnosticsPrefix}${body}`;
  const send = deps.sendDm ?? runPopclawMessageCommand;
  // The message needs to land in **that house's** contact's inbox: DMs
  // route via `houseOfRecipient` (default is "whichever house their last
  // message came from"), but when sending to another house's official
  // contact it's pinned to the target house. The primary house (including
  // the fallback case) still follows the default path.
  //
  // Both are built now, before anything is confirmed, and the closure below
  // captures them: a draft parked for this contact stays bound to that
  // contact and to that body, however the mounted houses or the cached
  // guides change in the meantime. A different recipient means drafting again.
  //
  // Exactly one thing is NOT frozen, and only on the primary path: `deps`
  // carries the host's own `houseOfRecipient`, which is a live
  // `inboxStore.houseOf(id)` read evaluated inside the send
  // (popclaw-message.ts). So if that contact's last incoming letter moves to
  // another house between drafting and confirming, the letter is RELAYED via
  // that other house. The recipient does not change and the body is sealed to
  // their key, so only relay metadata moves — and the preview line says which
  // house DECLARES this contact, not which house carries the letter, so it
  // stays true. `popclaw_draft_message` does freeze this; feedback inherits
  // the live default from base, where it is pinned by
  // tests/unit/commands/popclaw-feedback.test.ts ("the primary house slug
  // behaves exactly like omitting --house"). Changing it is a behaviour
  // decision, not part of the confirmation gate.
  const sendArgs: PopclawMessageArgs = {
    positional: [contact.popclawId, composed],
    ...(deps.attachmentPath ? { flags: { image: deps.attachmentPath } } : {}),
  };
  const sendDeps: PopclawMessageDeps = toPrimary ? deps : { ...deps, houseOfRecipient: () => target };
  const houseOfContact = toPrimary ? deps.houseSlug : target;

  // A DM's success receipt (✉) reads like an ordinary DM was sent — feedback
  // needs its own receipt line. Layered honestly: "sent" = the lore-house
  // has accepted it (the protocol has no read receipt); a reply means the
  // person replied, and lands in the inbox.
  const deliver = async (): Promise<{ text: string }> => {
    const r = await send(sendArgs, sendDeps);
    if (!r.text.includes('✉')) return r;
    const whose = toPrimary
      ? renderCopy(lang, 'feedback.receipt.wholePrimary')
      : renderCopy(lang, 'feedback.receipt.wholeHouse', { target });
    const contactName = contact.contact ? renderCopy(lang, 'feedback.receipt.contactSep') + contact.contact : '';
    const who = renderCopy(lang, 'feedback.receipt.who', { whose, contactName });
    const kindLabel = renderCopy(lang, kind === 'bug' ? 'feedback.kindLabel.bug' : 'feedback.kindLabel.need');
    return {
      text:
        (fellBack ? renderCopy(lang, 'feedback.receipt.fellBackNotice', { target }) + '\n' : '') +
        `${r.text}\n` +
        renderCopy(lang, 'feedback.receipt.sent', { kindLabel, who }) +
        renderCopy(lang, 'feedback.receipt.inboxNote'),
    };
  };

  if (deps.draftDm) {
    return deps.draftDm(
      {
        kind,
        contactPopclawId: contact.popclawId,
        ...(contact.contact ? { contactName: contact.contact } : {}),
        house: houseOfContact,
        ...(fellBack ? { requestedHouse: target } : {}),
        body: composed,
        ...(deps.attachmentPath ? { attachmentPath: deps.attachmentPath } : {}),
      },
      deliver,
    );
  }
  return deliver();
}
