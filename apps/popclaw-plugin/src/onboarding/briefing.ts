import type { OnboardingStage } from './stages.js';
import { languageDirective } from '../lexicon/directive.js';
import { renderCopy, type Lang } from '../lexicon/index.js';

/**
 * StageBriefing = what one act hands to the OpenClaw agent, not hard-coded
 * lines of dialogue (spec 2026-06-16, still in force). popclaw owns **what
 * to say** (intent + material); the agent owns **how to say it** — it
 * already carries the owner's persona and speaks in the owner's voice.
 *
 * Two renderings, and they have **two different readers**:
 *  - `renderBriefingForAgent` → the instruction handed to the agent (it does
 *    the narrating);
 *  - `renderBriefingForUser`  → the same prose pushed **straight to the
 *    owner**, with no agent in between: `briefingCard` → `presentCard` →
 *    `presenter.present`, plus the raw-slash path (`/popclaw start`).
 *
 * S5 language discipline (decision doc §4 / §9.5 "one language all the way
 * through, never mixed"): because the second reader is the owner, the prose
 * cannot be frozen English. It lives in the lexicon (`onboarding.brief.*`)
 * and every builder takes the lane to build in:
 *
 *  - `lang` defaults to `'en'` — the English source the agent is handed;
 *    `languageDirective()` at the top of `renderBriefingForAgent` is what
 *    makes a zh-CN owner hear Chinese out of the agent's mouth.
 *  - the card path passes `ownerLang()`, so what the plugin pushes to the
 *    owner itself is in the owner's language — same as every other
 *    plugin-emitted surface (`act-cards.ts`).
 *
 * `voice` is the one thing that stays an English literal here: it is tone
 * direction for the agent and is dropped before the owner ever sees the
 * briefing (`renderBriefingForUser`).
 *
 * How the owner is addressed (`{who}`) follows the same rule, and for the
 * same reason it is derived from `lang` right here rather than injected:
 * it used to be an `ownerAddressing` string handed to the orchestrator by the
 * composition root, which resolved it **once, at boot** — before the first
 * turn's language sniff had run. On a fresh identity that froze the English
 * "the owner" into every act, and the Chinese cards then read "the owner"
 * mid-sentence (2026-08-23 MCP smoke). A value that must follow the lane
 * cannot be captured before the lane is known.
 */
export interface StageBriefing {
  readonly stage: OnboardingStage;
  /** What this step must convey — the instruction popclaw hands to the agent. */
  readonly intent: string;
  /** Raw material for the agent to work with (passport stamps / numbered highlights / guide list…). */
  readonly material?: string;
  /** Voice/tone hints for the narration (agent-only, never shown verbatim). */
  readonly voice: string;
}

/** The six acts' prose, in the lane being built for. */
function copy(lang: Lang, key: string, vars: Record<string, string> = {}): string {
  return renderCopy(lang, `onboarding.brief.${key}`, vars);
}

/**
 * The hard-coded sentence every act must carry (spec §6). Numbers are the
 * handle the owner's next reply grabs onto, and canvas links are what they
 * actually click — if the agent "paraphrases" either one, the number the
 * owner reports back won't match, and the link won't open.
 */
const VERBATIM = 'Read canvas links and item numbers out exactly as given — not one character changed.';

/**
 * The second hard-coded sentence every act must carry (the 2026-07-29
 * host-c incident): with one input box and two conversations in flight, the
 * agent judges the owner's short reply as an answer to whichever pending
 * question feels closer to it — the agent asked "want a paper run?", the
 * naming card came up, the owner replied "1", and the agent went and
 * rendered the paper, hijacking the naming step. The plugin side already
 * has a hard gate at before_dispatch (onboarding/inbound-claim.ts); this
 * sentence is the fallback on the old gateway, and also discipline for the
 * agent.
 */
const NO_PENDING_QUESTIONS =
  'Until the settling-in list is finished, hold your own pending questions and start no new ones; ' +
  "every short answer the owner gives is an answer to this list. ";

// VERBATIM is still pinned to the last sentence (the briefing tests guard this invariant).
function voice(v: string): string {
  return `${v}${NO_PENDING_QUESTIONS}${VERBATIM}`;
}

function joinLines(lines: ReadonlyArray<string | null | undefined>): string {
  return lines.filter((l): l is string => typeof l === 'string' && l.length > 0).join('\n');
}

// ---------------------------------------------------------------------------
// ① arrival — naming kickoff
// ---------------------------------------------------------------------------

export interface ArrivalBriefingArgs {
  /** Up to 3 name candidates (produced by suggestNames; a single neutral fallback name when there is no material). */
  readonly candidates: readonly string[];
  /** true = there is no naming material at all, and it must be said plainly: "I do not know you yet". */
  readonly blind: boolean;
}

/**
 * Kickoff: one sentence of positioning, then straight into name candidates.
 * **Do not explain the lore-house concept** — experience before concept
 * (spec §2 arrival).
 */
export function buildArrivalBriefing(
  args: ArrivalBriefingArgs,
  lang: Lang = 'en',
): StageBriefing {
  const who = renderCopy(lang, 'owner.addressing');
  const list = args.candidates.map((name, i) => `${i + 1}. ${name}`).join('\n');
  return {
    stage: 'arrival',
    intent:
      copy(lang, 'arrival.intent', { who }) +
      (args.blind ? copy(lang, 'arrival.blind', { who }) : ''),
    material: copy(lang, 'arrival.material', { list }),
    voice: voice(
      `Sound like ${who}'s own agent, with a little of the world's flavour to it; the one-line pitch is ` +
        `a sentence, not a manifesto, and do not reach for words like "lore-house" that they have not met yet. ` +
        `Read the candidates as given — do not invent extra ones. `,
    ),
  };
}

// ---------------------------------------------------------------------------
// ② passport — claiming the passport
// ---------------------------------------------------------------------------

export interface PassportBriefingArgs {
  readonly nickname: string;
  readonly sigil: string;
  readonly profileUrl: string;
  /** Per-house stamping results (from the broadcast receipt; report failures plainly). */
  readonly stamps: readonly { readonly houseName: string; readonly ok: boolean }[];
  /** Short link to the passport page; null = the canvas service is unreachable, read the text only. */
  readonly canvasUrl?: string | null;
  /**
   * The first thing to try, self-reported by each house, one line per house
   * (`<house name> · <headline> · say "<first_move>" to start`).
   * Even if the canvas is down, this information is not lost — these lines
   * are the door themselves. A house with no declaration takes no line.
   */
  readonly doorLines?: readonly string[];
}

/** The vermilion moment: the namecard is signed by the owner themself, the houses only stamp it. The full explainer on what a sigil is lives on the passport page — do not read it out in chat. */
export function buildPassportBriefing(
  args: PassportBriefingArgs,
  lang: Lang = 'en',
): StageBriefing {
  const who = renderCopy(lang, 'owner.addressing');
  const name = `${args.nickname}#${args.sigil}`;
  const stampLines = args.stamps.map(
    (s) => `${s.houseName} ${copy(lang, s.ok ? 'passport.stamp.ok' : 'passport.stamp.failed')}`,
  );
  return {
    stage: 'passport',
    intent:
      copy(lang, 'passport.intent', { who, name }) +
      (args.canvasUrl ? copy(lang, 'passport.canvas', { who }) : '') +
      copy(lang, 'passport.sigil') +
      // "two doors" is only said when there really are more than two doors — someone on a single house who hears "two doors" will go looking for a second one that does not exist.
      ((args.doorLines ?? []).length > 1 ? copy(lang, 'passport.doors') : ''),
    material: joinLines([
      copy(lang, 'passport.mat.card', { name }),
      copy(lang, 'passport.mat.home', { url: args.profileUrl }),
      stampLines.length > 0
        ? copy(lang, 'passport.mat.stamps', { lines: stampLines.join('\n') })
        : null,
      (args.doorLines ?? []).length > 0
        ? copy(lang, 'passport.mat.doors', { lines: (args.doorLines ?? []).join('\n') })
        : null,
      args.canvasUrl ? copy(lang, 'passport.mat.page', { url: args.canvasUrl }) : null,
    ]),
    voice: voice(
      `Weighty but not ceremonious — a sentence or two. If a house did not stamp it, say so plainly, ` +
        `no dressing it up. Do not bring up verification. `,
    ),
  };
}

// ---------------------------------------------------------------------------
// ③ lantern — meeting the houses (old guide + summary merged)
// ---------------------------------------------------------------------------

export interface LanternBriefingArgs {
  /** Houses already joined, one line per house (house names come from data, none hard-coded in the plugin). */
  readonly houseLines: readonly string[];
  /** A real stat line (e.g. "the world: 56 identities …"); omit if it cannot be obtained. */
  readonly statLine?: string;
  /** Numbered highlight lines (≤8, numbers must match the canvas exactly). */
  readonly entryLines: readonly string[];
  /** Well-known (verified) people, ≤5 lines. */
  readonly notablePeopleLines?: readonly string[];
  /** Active mirror accounts, ≤3 lines. */
  readonly mirrorAuthorLines?: readonly string[];
  /** Short link to the world-at-a-glance page; null = read the text only. */
  readonly canvasUrl?: string | null;
  /** true = it really is quiet here right now — say so plainly, never dress it up. */
  readonly quiet: boolean;
}

export function buildLanternBriefing(
  args: LanternBriefingArgs,
  lang: Lang = 'en',
): StageBriefing {
  const who = renderCopy(lang, 'owner.addressing');
  return {
    stage: 'lantern',
    intent:
      copy(lang, 'lantern.intent', { who }) +
      (args.quiet ? copy(lang, 'lantern.quiet') : '') +
      copy(lang, 'lantern.pick', { who }),
    material: joinLines([
      args.houseLines.length > 0
        ? copy(lang, 'lantern.mat.houses', { lines: args.houseLines.join('\n') })
        : null,
      args.statLine,
      (args.notablePeopleLines ?? []).length > 0
        ? copy(lang, 'lantern.mat.notable', { lines: (args.notablePeopleLines ?? []).join('\n') })
        : null,
      args.entryLines.length > 0
        ? copy(lang, 'lantern.mat.entries', { lines: args.entryLines.join('\n') })
        : null,
      (args.mirrorAuthorLines ?? []).length > 0
        ? copy(lang, 'lantern.mat.mirrors', { lines: (args.mirrorAuthorLines ?? []).join('\n') })
        : null,
      args.canvasUrl ? copy(lang, 'lantern.mat.canvas', { url: args.canvasUrl }) : null,
    ]),
    voice: voice(
      `Put the material into your own words in ${who}'s register — do not read a cold table back to them. ` +
        `Drop any empty heading whole. `,
    ),
  };
}

// ---------------------------------------------------------------------------
// ④ attune — finding the taste
// ---------------------------------------------------------------------------

export interface AttuneBriefingArgs {
  /** The taste statement the owner just gave in their own words; absent = still asking. */
  readonly tasteText?: string;
  /** The reordered lines, already annotated with "(was #N)". */
  readonly rerankedLines?: readonly string[];
}

/**
 * Ask once, that is enough — **never ask a second time** (spec §2 attune).
 * Once answered → immediately reorder that same batch of entries and show
 * them: this is the centerpiece of the whole settling-in list.
 */
export function buildAttuneBriefing(args: AttuneBriefingArgs, lang: Lang = 'en'): StageBriefing {
  const who = renderCopy(lang, 'owner.addressing');
  if (!args.tasteText) {
    return {
      stage: 'attune',
      intent: copy(lang, 'attune.ask', { who }),
      voice: voice(`One sentence, asked in passing — do not turn it into a questionnaire. `),
    };
  }
  return {
    stage: 'attune',
    intent: copy(lang, 'attune.recap', { who }),
    material: joinLines([
      copy(lang, 'attune.mat.words', { who, text: args.tasteText }),
      (args.rerankedLines ?? []).length > 0
        ? copy(lang, 'attune.mat.order', { lines: (args.rerankedLines ?? []).join('\n') })
        : null,
    ]),
    voice: voice(
      `Do not take credit — just put the change where ${who} can see it for themselves. ` +
        `Keep the numbers exactly as given. `,
    ),
  };
}

// ---------------------------------------------------------------------------
// ⑤ errand — the first task
// ---------------------------------------------------------------------------

export interface ErrandBriefingArgs {
  /** The people who can be referred to from the batch just shown (number + name), for reference resolution. */
  readonly peopleLines?: readonly string[];
  /**
   * A light **one-line** nudge toward another house (R1 spec §3.3): present
   * only when there is an entry and things have not started there yet.
   * No number, no follow-up question — this is naming a door, not a
   * seventh act.
   */
  readonly houseNudge?: string;
}

export function buildErrandBriefing(args: ErrandBriefingArgs, lang: Lang = 'en'): StageBriefing {
  const who = renderCopy(lang, 'owner.addressing');
  return {
    stage: 'errand',
    intent:
      copy(lang, 'errand.intent', { who }) +
      (args.houseNudge ? copy(lang, 'errand.nudge', { who }) : ''),
    material: joinLines([
      (args.peopleLines ?? []).length > 0
        ? copy(lang, 'errand.mat.people', { lines: (args.peopleLines ?? []).join('\n') })
        : null,
      args.houseNudge ? copy(lang, 'errand.mat.house', { line: args.houseNudge }) : null,
    ]),
    voice: voice(
      `Like a hand waiting for a job, not a form waiting to be filled in. Following is light and reversible: ` +
        `when ${who} names someone, just do it — do not ask them to confirm twice. `,
    ),
  };
}

// ---------------------------------------------------------------------------
// ⑥ cadence — setting the rhythm + graduation + the guide
// ---------------------------------------------------------------------------

/** `21` → `21:00`. The clock face is the same in both lanes; only the sentence around it differs. */
export function hourLabel(hour: number): string {
  const h = Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : 8;
  return `${String(h).padStart(2, '0')}:00`;
}

/**
 * The first closing question: whether to deliver the daily paper, and when.
 * Ask once, two options — plus an open door to any other hour.
 *
 * `proposedHour` is named out loud rather than left as a vague "tomorrow
 * morning": a concrete time is something the owner can nod at or correct, and
 * correcting it is the whole point of asking.
 */
export function buildCadenceBriefing(lang: Lang = 'en', proposedHour = 8): StageBriefing {
  const who = renderCopy(lang, 'owner.addressing');
  return {
    stage: 'cadence',
    intent: copy(lang, 'cadence.intent', { who, at: hourLabel(proposedHour) }),
    voice: voice(`One sentence, then stop. Whichever ${who} picks, do not talk them out of it. `),
  };
}

export interface GraduationBriefingArgs {
  readonly nickname: string;
  readonly sigil: string;
  readonly profileUrl: string;
  /** The cadence choice: daily = schedule the morning paper; declined = explicitly said no; undefined = did not say either way. */
  readonly newspaper?: 'daily' | 'declined';
  /** The hour the owner settled on, 0-23. Only meaningful with `newspaper: 'daily'`. */
  readonly newspaperHour?: number;
  /** The owner's own taste statement verbatim (the sentence attune wrote into the sovereignty layer). */
  readonly tasteText?: string;
  readonly verifiedHandles?: readonly string[];
  /** What they actually did this run (every item must be evidenced — never list something that did not happen). */
  readonly done: readonly string[];
  /** Gaps still open (same source as the status to-do list). */
  readonly gaps: readonly string[];
  /** Plain words ⇄ capability mapping: `say this → I go do that`. */
  readonly phrasebook: readonly string[];
  /** Key how-it-works points for houses already joined (body text from each house's own guide, house names come from data). */
  readonly houseGuides: readonly { readonly houseName: string; readonly excerpt: string }[];
}

/**
 * The graduation act: closing words + a guide page **written by the agent
 * itself** (spec §3-3). material is the complete set of material for the
 * guide; the instruction is to render it to HTML and call `popclaw_canvas`
 * (ttl_hours: 72). Degradation rule of iron: this list shares the same
 * source as the status to-do list and must never live only inside a
 * 72-hour link — so material itself is a plain text list that can be read
 * out directly.
 */
export function buildGraduationBriefing(
  args: GraduationBriefingArgs,
  lang: Lang = 'en',
): StageBriefing {
  const who = renderCopy(lang, 'owner.addressing');
  const paper =
    args.newspaper === 'daily'
      ? 'graduation.paper.daily'
      : args.newspaper === 'declined'
        ? 'graduation.paper.declined'
        : 'graduation.paper.unsaid';
  return {
    stage: 'cadence',
    intent:
      copy(lang, 'graduation.intent', { who }) +
      copy(lang, paper, { who, at: hourLabel(args.newspaperHour ?? 8) }),
    material: joinLines([
      copy(lang, 'graduation.mat.card', {
        name: `${args.nickname}#${args.sigil}`,
        url: args.profileUrl,
      }),
      copy(lang, 'graduation.mat.vault', { who }),
      args.verifiedHandles && args.verifiedHandles.length > 0
        ? copy(lang, 'graduation.mat.verified', { list: args.verifiedHandles.join(' / ') })
        : null,
      args.tasteText
        ? copy(lang, 'graduation.mat.taste', { who, text: args.tasteText })
        : null,
      args.done.length > 0
        ? copy(lang, 'graduation.mat.done', { lines: args.done.map((d) => `· ${d}`).join('\n') })
        : null,
      args.gaps.length > 0
        ? copy(lang, 'graduation.mat.gaps', { lines: args.gaps.map((g) => `· ${g}`).join('\n') })
        : null,
      args.phrasebook.length > 0
        ? copy(lang, 'graduation.mat.phrasebook', {
            lines: args.phrasebook.map((p) => `· ${p}`).join('\n'),
          })
        : null,
      ...args.houseGuides.map((h) =>
        copy(lang, 'graduation.mat.house', { house: h.houseName, excerpt: h.excerpt }),
      ),
    ]),
    voice: voice(
      `Keep the closing words short, two or three sentences; write the guide page in your own words rather ` +
        `than pasting the material above onto it. If the canvas service cannot send it, read this list to ` +
        `${who} directly — not one item may go missing. `,
    ),
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** Agent-facing: instructs the agent to narrate this briefing in the owner's voice. */
export function renderBriefingForAgent(b: StageBriefing): string {
  return [
    // S1/S5: which language to narrate in. The briefing below is built in the
    // `en` lane (the builders' default); the directive is what makes a zh-CN
    // owner hear Chinese.
    languageDirective(),
    `[settling-in · ${b.stage}] Tell the owner the "intent" below in your own voice — do not read it out verbatim.`,
    `Intent: ${b.intent}`,
    b.material ? `Material:\n${b.material}` : null,
    `Voice: ${b.voice}`,
  ]
    .filter((l): l is string => l !== null)
    .join('\n');
}

/** Straight to the owner (card body / raw slash): intent itself is already readable prose; voice is dropped. */
export function renderBriefingForUser(b: StageBriefing): string {
  return b.material ? `${b.intent}\n\n${b.material}` : b.intent;
}
