/**
 * Cards and short copy for the six acts (Plan C spec 2026-07-29).
 *
 * Card body and the agent briefing **share one source**: each act's content
 * is written exactly once (the `onboarding.brief.*` lexicon keys, assembled
 * by briefing.ts), and this file only lays it out as a card. The agent path
 * (personalized, in the owner's voice) goes through
 * `currentCardText → renderBriefingForAgent`.
 *
 * Three rules (constitution-level, don't route around them):
 *  - No buttons: the settling-in list is a conversation, not a form (spec §7
 *    "no dependence on buttons");
 *  - Never leak `/popclaw next <…>`-style navigation syntax — the owner just
 *    talks directly, that's enough;
 *  - When it's quiet, say so honestly — never dress up the emptiness with
 *    "curated/trending".
 *
 * S5 language discipline: this whole file is **emitted directly by the
 * plugin** (no agent present), so every line comes from the lexicon via
 * `ownerLang()` (see decision doc §10.3, the "L1 mobile push / interactive
 * card buttons" row). The Chinese source text lives verbatim in
 * `lexicon/zh-CN.ts`; English is the source language.
 */
import { renderBriefingForUser, type StageBriefing } from './briefing.js';
import { emojiFor } from '../identity/platform-emoji.js';
import { platformLabel } from '../world/summary-format.js';
import { t } from '../lexicon/owner-language.js';

// The card is **popclaw's own** structure, not the SDK's `MessagePresentation`
// (that one lives in `plugin-sdk/interactive-runtime`, uses a `type:`
// discriminant, and carries buttons). We never hand cards to the host to
// render — always `cardText()` down to plain prose (first discipline above:
// no buttons) — so this belongs as a local type rather than borrowing an SDK
// shape for a surface we never call.
export type MessageBlock = { kind: 'text'; text: string } | { kind: 'context'; text: string };

export type MessageAction = {
  kind: 'button';
  actionId: string;
  label: string;
  style?: 'primary' | 'secondary';
};

export interface MessagePresentation {
  blocks: ReadonlyArray<MessageBlock>;
  actions?: ReadonlyArray<MessageAction>;
}

/**
 * One card per act: briefing prose as the body + an optional one-line hint.
 * Zero buttons.
 *
 * The card goes **straight to the owner** with no agent in between, so the
 * briefing must have been built in the owner's lane (`ownerLang()`) — every
 * caller in the orchestrator passes it. Otherwise the body comes out in
 * English next to a `context` hint in the owner's language, which is the
 * mixed-language accident §9.5 forbids.
 */
export function briefingCard(b: StageBriefing, context?: string): MessagePresentation {
  return textCard(renderBriefingForUser(b), context);
}

/**
 * Same card, body already rendered. The arrival act builds its body twice
 * (`firstContact` — English on top, Chinese below) before there is any signal
 * to pick a lane with, so it has nothing to hand `briefingCard`.
 */
export function textCard(text: string, context?: string): MessagePresentation {
  return {
    blocks: [
      { kind: 'text', text },
      ...(context ? [{ kind: 'context' as const, text: context }] : []),
    ],
  };
}

/** Card → plain-text fallback (the reply body when the TUI doesn't render cards). */
export function cardText(card: MessagePresentation): string {
  return card.blocks
    .map((b) => ('text' in b ? b.text : ''))
    .filter((s) => s.length > 0)
    .join('\n\n');
}

// ---------------------------------------------------------------------------
// arrival
// ---------------------------------------------------------------------------

export type NamingRetryReason = 'empty' | 'placeholder' | 'digit' | 'sentence' | 'tooLong';

/** Naming retry copy — the reply when the stage doesn't transition. */
export function namingRetryText(reason: NamingRetryReason): string {
  return t(`onboarding.naming.retry.${reason}`);
}

/** A name read out of the owner's sentence, asked back before anything is signed (N1). */
export function namingConfirmText(name: string): string {
  return t('onboarding.naming.confirm', { name });
}

// ---------------------------------------------------------------------------
// passport
// ---------------------------------------------------------------------------

/** Namecard push failed (non-2xx HTTP or network unreachable) — the name is already
 *  recorded, so guide toward a retry. The self-healing loop (announce-namecard.ts)
 *  will auto-retry the push on the next boot/tick, so the retry isn't outsourced to
 *  the owner's memory — this line exists only to move the story forward right now. */
export function pushFailedText(nickname: string, cause: number | 'network'): string {
  const why = cause === 'network' ? t('onboarding.passport.pushFailed.network') : `HTTP ${cause}`;
  return t('onboarding.passport.pushFailed', { nickname, why });
}

/** Wanting a passport before a name is set: a placeholder name is never pushed out — say so honestly, and give a viable path forward. */
export function noNameYetText(): string {
  return t('onboarding.passport.noNameYet');
}

// ---------------------------------------------------------------------------
// lantern
// ---------------------------------------------------------------------------

/** Lore-house unreachable: doesn't block the spine — the owner can keep moving forward anytime. */
export function lanternUnreachableText(): string {
  return t('onboarding.lantern.unreachable');
}

export interface ExpandedCardArgs {
  readonly ordinal: number;
  readonly nickname: string;
  readonly platform: string;
  /** The full preview from the server (the list row only shows the first 120 characters). */
  readonly bodyPreview: string;
  readonly replyCount: number;
  readonly eventId: string;
  /** Web base URL (no trailing slash), from plugin-bootstrap's three-tier resolution. */
  readonly postUrlBase: string;
}

/** Expanded card: the full preview + source link (the fallback form of the cross-platform "view original" rule). */
export function buildExpandedCard(args: ExpandedCardArgs): MessagePresentation {
  const short = args.eventId.slice(0, 10);
  return {
    blocks: [
      {
        kind: 'text',
        text: t('onboarding.expand.head', {
          n: String(args.ordinal),
          nickname: args.nickname,
          emoji: emojiFor(args.platform),
          platform: platformLabel(args.platform),
          body: args.bodyPreview,
        }),
      },
      {
        kind: 'text',
        text: t('onboarding.expand.meta', {
          replies: String(args.replyCount),
          url: `${args.postUrlBase}/post/${short}`,
        }),
      },
      { kind: 'context', text: t('onboarding.expand.context') },
    ],
  };
}

/**
 * Mark succeeded: honestly conveys the value-annotation semantics (ADR-0019).
 * pushed=false → kept locally, with a hint that it can be retried.
 */
export function markSavedText(n: number, pushed = true): string {
  return t(pushed ? 'onboarding.mark.saved' : 'onboarding.mark.saved.local', { n: String(n) });
}

/** Mark failed: report the error honestly, never falsely claim it was saved. */
export function markFailedText(n: number): string {
  return t('onboarding.mark.failed', { n: String(n) });
}

/** "Meh" acknowledgement: a short confirmation, filed into the local private taste domain. */
export function mehAckText(n: number): string {
  return t('onboarding.meh.ack', { n: String(n) });
}

/** Out-of-range ordinal → retry copy, no transition. */
export function ordinalRetryText(max: number): string {
  return max > 0
    ? t('onboarding.ordinalRetry', { max: String(max) })
    : t('onboarding.ordinalRetry.empty');
}

// ---------------------------------------------------------------------------
// attune
// ---------------------------------------------------------------------------

/** Skipping the taste question: state the consequence clearly, **never ask a second time**. */
export function attuneSkippedText(): string {
  return t('onboarding.attune.skipped');
}

/** Confirmation that it landed in the sovereign layer (the write path's only claim: local-only). */
export function tasteSavedText(): string {
  return t('onboarding.taste.saved');
}

// ---------------------------------------------------------------------------
// errand
// ---------------------------------------------------------------------------

/**
 * The bond book's first line. The wording is constitution-level: **"no server,
 * no other user, can ever read this"** — never say "no one at all" (the owner
 * themself can of course read it, it's their book).
 */
export function bondBookLine(): string {
  return t('onboarding.bondBook.firstLine');
}

/**
 * The payoff for a successful follow: the one follow receipt, then the
 * bond-book line.
 *
 * `house` is the one `runFollowCommand`'s own
 * receipt named — never a guess. In production `relation-scope.ts` always
 * resolves a slug, so `house` undefined here is defensive, not a real path;
 * omitted (or undefined) renders the no-house variant rather than naming a
 * primary/home house that was never confirmed.
 */
export function followedText(display: string, house?: string): string {
  const key = house ? 'relation.followReceived' : 'relation.followReceivedNoHouse';
  const vars: Record<string, string> = { who: display, ...(house ? { house } : {}) };
  return `${t(key, vars)}\n${bondBookLine()}`;
}

/**
 * The verification nudge fires **conditionally**: only when the person just
 * followed is themself already verified does this line get appended.
 * If not verified, not a single word is mentioned (spec §2 errand).
 */
export function verifiedNudgeText(display: string, platform: string): string {
  return t('onboarding.errand.verifiedNudge', { display, platform });
}

/** Skipping the errand: honest consequence, no pressure applied. */
export function errandSkippedText(): string {
  return t('onboarding.errand.skipped');
}

/** Identity lookup found no such person / a name collision — stay in this act. */
export function errandNotFoundText(ref: string): string {
  return t('onboarding.errand.notFound', { ref });
}

export function errandAmbiguousText(lines: readonly string[]): string {
  return t('onboarding.errand.ambiguous', { lines: lines.join('\n') });
}

// ---------------------------------------------------------------------------
// cadence
// ---------------------------------------------------------------------------

/** Notification channel: **inform, don't request** — no three-tier threshold, never asks the owner for an address. */
export function channelNoticeText(): string {
  return t('onboarding.channelNotice');
}
