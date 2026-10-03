/**
 * Nudge — the backdoor hook (R1 spec §4).
 *
 * After graduation, the agent mentions in passing one still-unsettled little
 * thing — no notification queue entry, no unread badge, zero new timers,
 * never speaks up on its own initiative, only rides on the tail of a tool's
 * return. 8 trigger gates split across two places:
 *  - `pickNudge`: ① stage=completed ② ≥24h since graduation ③ ≥72h since the
 *    last nudge ④ lifetime <6 lines ⑧ that gap's strike count <2 and not
 *    muted — these five only look at gaps/ledger/ctx, unrelated to "which
 *    tool was called this turn", so they live in this pure function, easy to
 *    test on its own.
 *  - `composeTail`: ⑤ this turn's tool returned non-error/non-refusal ⑥ this
 *    tool is not on the exclusion list ⑦ the tail slot isn't already taken
 *    by an unread notice (unread takes priority) — these three only concern
 *    "this turn", unrelated to gaps/ledger, so they live at the call-site
 *    layer.
 *
 * The ledger (config `onboarding.nudge`) is only written after a line is
 * actually output — `recordNudgeSent` is kept separate from `pickNudge`; the
 * caller persists it only after confirming `pick.line` was actually spliced
 * into the returned text.
 */
import type { HostAdapter } from '../host/host-adapter.js';
import type { Gap, GapKey } from './settling-gaps.js';
import { asRecord, patchOnboardingSection, readOnboardingSection } from './settling-gaps.js';
import { renderCopy } from '../lexicon/index.js';
import { ownerLang } from '../lexicon/owner-language.js';

/** Max times any single gap may be mentioned in its lifetime (counting starts 24h after graduation, see pickNudge gate ②). */
const STRIKE_CAP = 2;
/** Minimum interval since the last nudge. */
const NUDGE_COOLDOWN_SECS = 72 * 3600;
/** Quiet period after graduation — don't nag right after settling in. */
const GRADUATION_COOLDOWN_SECS = 24 * 3600;
/** Lifetime cap on line count — a nudge is a reminder, not nagging. */
const LIFETIME_CAP = 6;

export interface NudgeLedger {
  readonly last_at?: number;
  readonly lifetime: number;
  readonly strikes: Readonly<Record<string, number>>;
  readonly muted: readonly string[];
}

const EMPTY_LEDGER: NudgeLedger = { lifetime: 0, strikes: {}, muted: [] };

function parseLedger(raw: unknown): NudgeLedger {
  const r = asRecord(raw);
  const strikesRaw = asRecord(r.strikes);
  const strikes: Record<string, number> = {};
  for (const [k, v] of Object.entries(strikesRaw)) if (typeof v === 'number') strikes[k] = v;
  return {
    ...(typeof r.last_at === 'number' ? { last_at: r.last_at } : {}),
    lifetime: typeof r.lifetime === 'number' ? r.lifetime : 0,
    strikes,
    muted: Array.isArray(r.muted) ? r.muted.filter((x): x is string => typeof x === 'string') : [],
  };
}

export async function readNudgeLedger(host: HostAdapter): Promise<NudgeLedger> {
  try {
    const onboarding = await readOnboardingSection(host);
    return parseLedger(onboarding.nudge);
  } catch {
    return EMPTY_LEDGER;
  }
}

/** Record after actually outputting a line: strikes[key]+=1, last_at=now, lifetime+=1. */
export async function recordNudgeSent(host: HostAdapter, key: string, nowSec: number): Promise<void> {
  await patchOnboardingSection(host, (prev) => {
    const ledger = parseLedger(prev.nudge);
    const nextLedger: NudgeLedger = {
      last_at: nowSec,
      lifetime: ledger.lifetime + 1,
      strikes: { ...ledger.strikes, [key]: (ledger.strikes[key] ?? 0) + 1 },
      muted: ledger.muted,
    };
    return { ...prev, nudge: nextLedger };
  });
}

/**
 * Mute: `scope==='all'` → `muted:["*"]` (a generalization of "don't mention
 * it again / stop reminding me", the same semantics as newspaper:declined);
 * otherwise mutes only that one gap key. Idempotent, failures swallowed.
 */
export async function muteNudge(host: HostAdapter, scope: string): Promise<void> {
  const key = scope === 'all' ? '*' : scope;
  await patchOnboardingSection(host, (prev) => {
    const ledger = parseLedger(prev.nudge);
    if (ledger.muted.includes(key)) return prev;
    return { ...prev, nudge: { ...ledger, muted: [...ledger.muted, key] } };
  });
}

export interface NudgeCtx {
  /** Current onboarding stage; only 'completed' can possibly get a nudge (gate ①). */
  readonly stage: string | null;
  /** Graduation moment (epoch seconds); null = unknown (gate ② fails). */
  readonly graduatedAt: number | null;
}

/**
 * Max length of a plain-text line (spec §4 "≤60 characters"); truncate by
 * code point and append an ellipsis when over (house copy length varies
 * with what the house self-reports, so a fallback is needed). One Chinese
 * character is worth roughly two Latin letters, so the English tier gets
 * double the budget — the same sentence should occupy comparable visual
 * width in both languages.
 */
function clamp(s: string, max = ownerLang() === 'zh-CN' ? 60 : 120): string {
  const chars = [...s];
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : s;
}

/** The non-house members of `GapKey` — `house:*` is handled separately by `houseLine` (its copy is assembled from per-house data, not a fixed lexicon key). */
type FixedGapKey = Exclude<GapKey, `house:${string}:first_move`>;

/**
 * Gap copy all lives in the lexicon (`onboarding.nudge.<gap key>`). Three-part
 * structure (fact → honest consequence → one line of what to do), no
 * emoji/exclamation marks. Banned words: "other people"/"the
 * community"/"N people"/"X steps left"/"completion rate"/"are you sure you
 * don't want to"/"ASAP".
 *
 * A `Record<FixedGapKey, ...>` rather than a parallel array of key names: TS
 * then forces every `GapKey` member to be listed here — add one to the union
 * in settling-gaps.ts and forget to register it, and the build fails instead
 * of `lineFor` silently returning null forever.
 *
 * `no_house_card: null` — not a regression, checked against history
 * (`git diff 0bc3169b 591eee7c -- settling-gaps.ts nudge.ts`): the gap has
 * never had a nudge line, since the day it was introduced. And it structurally
 * can't fire here: `pickNudgeFor` (register-tools.ts) hardcodes
 * `loreHouseReachable: false` for the nudge path (the zero-network rule, same
 * one that keeps `no_verify` off), and listGaps only ever pushes
 * `no_house_card` when `loreHouseReachable` is true. Registered explicitly
 * rather than omitted so a future change that wires network access into the
 * nudge path doesn't silently inherit "no line" — it has to touch this table.
 */
export const GAP_LINE_KEYS: Readonly<Record<FixedGapKey, string | null>> = {
  resume_onboarding: 'onboarding.nudge.resume_onboarding',
  no_follows: 'onboarding.nudge.no_follows',
  no_taste: 'onboarding.nudge.no_taste',
  no_verify: 'onboarding.nudge.no_verify',
  dream_stale: 'onboarding.nudge.dream_stale',
  auto_name: 'onboarding.nudge.auto_name',
  no_house_card: null,
};

/** house:<slug>:first_move copy — house name/headline/first_move all come from data, zero hardcoded house names. */
function houseLine(gap: Gap): string | null {
  if (!gap.houseFirstMove) return null;
  const lang = ownerLang();
  const headline = gap.houseHeadline
    ? renderCopy(lang, 'onboarding.nudge.house.headline', { headline: gap.houseHeadline })
    : '';
  return clamp(
    renderCopy(lang, 'onboarding.nudge.house', {
      house: gap.houseName ?? renderCopy(lang, 'onboarding.nudge.house.fallbackName'),
      headline,
      move: gap.houseFirstMove,
    }),
  );
}

function lineFor(gap: Gap): string | null {
  if (gap.key.startsWith('house:')) return houseLine(gap);
  const lexiconKey = GAP_LINE_KEYS[gap.key as FixedGapKey];
  return lexiconKey ? renderCopy(ownerLang(), lexiconKey) : null;
}

/**
 * Pick one nudge from the gap list (gates ①②③④⑧, pure function). Picks the
 * **first** one, in the order given by `gaps`, that hasn't hit the strike
 * cap and isn't muted — not the "most urgent" one, but "the earliest one
 * that hasn't been mentioned many times yet", the same priority order as
 * the status todo list.
 */
export function pickNudge(
  gaps: readonly Gap[],
  ledger: NudgeLedger,
  nowSec: number,
  ctx: NudgeCtx,
): { key: string; line: string } | null {
  if (ctx.stage !== 'completed') return null; // gate ①
  if (ctx.graduatedAt === null || nowSec - ctx.graduatedAt < GRADUATION_COOLDOWN_SECS) return null; // gate ②
  if (ledger.last_at !== undefined && nowSec - ledger.last_at < NUDGE_COOLDOWN_SECS) return null; // gate ③
  if (ledger.lifetime >= LIFETIME_CAP) return null; // gate ④

  for (const gap of gaps) {
    if (ledger.muted.includes('*') || ledger.muted.includes(gap.key)) continue; // gate ⑧ (muted)
    if ((ledger.strikes[gap.key] ?? 0) >= STRIKE_CAP) continue; // gate ⑧ (cap)
    const body = lineFor(gap);
    if (body) return { key: gap.key, line: `${renderCopy(ownerLang(), 'onboarding.nudge.prefix')}${body}` };
  }
  return null;
}

/** Tools that would occupy the tail slot but shouldn't be interrupted by a nudge — checking status/fetching notifications/fetching pings already means "already looking". */
const EXCLUDED_TOOLS = new Set(['popclaw_check_status', 'popclaw_notifications', 'popclaw_show_pings']);

export function isExcludedFromNudge(toolName: string): boolean {
  return EXCLUDED_TOOLS.has(toolName) || toolName.startsWith('popclaw_onboarding_');
}

export interface ComposeTailFacts {
  /** Already-computed unread notice line (each host has its own unread signal, formats vary); null = no unread. */
  readonly unreadLine: string | null;
  readonly toolName: string;
  /** This turn's tool returned non-error/non-refusal (gate ⑤). */
  readonly toolOk: boolean;
  /** The nudge already picked by `pickNudge` (gates ①②③④⑧); null = nothing to mention. */
  readonly nudgeLine: string | null;
}

/**
 * Unified tail exit point: unread takes priority, the nudge applies only
 * when there's no unread and gates ⑤⑥ both pass. At most one tail per turn.
 * Pure function — any exception fallback is left to the caller (a failure in
 * the tail itself must never be allowed to break the real work).
 */
export function composeTail(facts: ComposeTailFacts): string | null {
  if (facts.unreadLine) return facts.unreadLine; // gate ⑦ + unread priority
  if (!facts.toolOk) return null; // gate ⑤
  if (isExcludedFromNudge(facts.toolName)) return null; // gate ⑥
  return facts.nudgeLine;
}
