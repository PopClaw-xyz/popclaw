/**
 * Status next-step policy and presentation. Gap detection remains in listGaps;
 * this module consumes its results without knowing about the host or runtime.
 * The entry builds gap advice first, reads outdated rules at its original
 * boundary, then completes the plan and renders it for the selected audience.
 */
import type { Gap, GapKey } from '../onboarding/settling-gaps.js';
import { DREAM_STALE_SECS } from '../dreamer/dream.js';
import type { DreamCronState } from '../dreamer/dream-cron.js';
import { systemTz } from '../time/time-context.js';
import { lexiconFor, renderCopy, type Lang } from '../lexicon/index.js';
import { ownerLang } from '../lexicon/owner-language.js';

interface Todo {
  readonly title: string;
  readonly benefit: string;
  /** Optional: for some todos (e.g. the taste seed one) the title itself is already the action, so an extra `how` line would just repeat it. */
  readonly how?: string;
  /**
   * True only for `no_verify` (house guide: take a name → say something →
   * get verified if you want to, no hurry). An optional todo is never a
   * missing step: it's excluded from the "N steps left" count and from the
   * agent path's numbered list, and is instead appended after, unnumbered.
   */
  readonly optional?: boolean;
}

/** The agent path gets all 3 at once; a human gets only 1 (one thing at a time — the rest surface next time status is checked). */
const AGENT_MAX_TODOS = 3;

export interface StatusDreamFacts {
  readonly lastDreamAt?: number | null;
  readonly dreamCron?: DreamCronState;
}

export interface StatusNextStepFacts extends StatusDreamFacts {
  readonly localNickname: string;
  readonly localNameReal: boolean;
  readonly nowSec: number;
}

/** Split command alternatives at the language's conjunction, preserving its text. */
export function splitAtOr(how: string, lang: Lang): string[] {
  // Both halves come from the lexicon rather than a `lang ===` ladder here:
  // the marker is the whole "<punctuation><conjunction>" run to break on, and
  // the conjunction is the part the continuation line keeps.
  const marker = renderCopy(lang, 'status.how.orMarker');
  const conjunction = renderCopy(lang, 'status.how.orConjunction');
  const cut = how.indexOf(marker);
  if (cut <= 0) return [how];
  return [how.slice(0, cut), how.slice(cut + marker.length - conjunction.length)];
}

/**
 * Staleness of the last effective write-back, independent of cron attempts.
 * Undefined means the caller cannot provide the cursor; null means no recorded
 * write-back. Neither establishes whether an attempt ran or failed.
 */
export function isDreamStale(lastDreamAt: number | null | undefined, now: number): boolean {
  if (lastDreamAt === undefined) return false;
  return lastDreamAt === null || now - lastDreamAt >= DREAM_STALE_SECS;
}

/**
 * Report write-back age and schedule evidence separately. Empty material can
 * end a successful attempt without advancing the cursor. This surface has no
 * attempt history, so it cannot infer a last attempt or a failure cause.
 * Only a successful schedule query finding no active recurring job warrants
 * an invitation to schedule one; an unreadable archive remains unknown.
 */
export function dreamTodo(
  deps: StatusDreamFacts,
  now: number,
  lang: Lang = ownerLang(),
): Todo {
  const writeback = deps.lastDreamAt === undefined
    ? renderCopy(lang, 'status.dream.writebackUnknown')
    : deps.lastDreamAt === null
      ? renderCopy(lang, 'status.dream.noWriteback')
      : renderCopy(lang, 'status.dream.lastWriteback', {
        days: String(Math.floor((now - deps.lastDreamAt) / 86_400)),
      });
  const benefit = renderCopy(lang, 'status.dream.benefit');
  const attemptUnknown = renderCopy(lang, 'status.dream.attemptUnknown');

  if (deps.dreamCron?.scheduled === true) {
    const tzLine = deps.dreamCron.tz
      ? renderCopy(lang, 'status.dream.tzLine', { tz: deps.dreamCron.tz })
      : renderCopy(lang, 'status.dream.tzLineHostLocal', { tz: systemTz() });
    return {
      title: renderCopy(lang, 'status.dream.scheduledTrue.title', { writeback }),
      benefit,
      how: `${attemptUnknown}\n${renderCopy(lang, 'status.dream.scheduledTrue.how')}\n${tzLine}`,
    };
  }
  if (deps.dreamCron?.scheduled === false) {
    return {
      title: renderCopy(lang, 'status.dream.scheduledFalse.title', { writeback }),
      benefit,
      how: `${attemptUnknown}\n${renderCopy(lang, 'status.dream.ask')}`,
    };
  }
  return {
    title: writeback,
    benefit,
    how: `${attemptUnknown}\n${renderCopy(lang, 'status.dream.scheduleUnknown')}`,
  };
}

/** Map only status's supported gaps, in their established priority order. */
export function planStatusNextSteps(
  gaps: readonly Gap[],
  facts: StatusNextStepFacts,
  lang: Lang,
): Todo[] {
  const hasGap = (key: GapKey): boolean => gaps.some((g) => g.key === key);

  const todos: Todo[] = [];
  if (hasGap('no_follows')) {
    todos.push({
      title: renderCopy(lang, 'status.todo.noFollows.title'),
      benefit: renderCopy(lang, 'status.todo.noFollows.benefit'),
      how: renderCopy(lang, 'status.todo.noFollows.how'),
    });
  }
  // The landing spot for attune-skip. The title is itself the action, so no separate `how` is given.
  if (hasGap('no_taste')) {
    todos.push({
      title: renderCopy(lang, 'status.todo.noTaste.title'),
      benefit: renderCopy(lang, 'status.todo.noTaste.benefit'),
    });
  }
  // Don't nag if a request is already pending — the ⏳ line above already made the status clear (ADR-0040's interruption budget).
  // Verification is optional (house guide order: name → post → verify if you
  // want to), so this one is marked `optional` — see the Todo field doc.
  if (hasGap('no_verify')) {
    todos.push({
      title: renderCopy(lang, 'status.todo.noVerify.title'),
      benefit: renderCopy(lang, 'status.todo.noVerify.benefit'),
      how: renderCopy(lang, 'status.todo.noVerify.how'),
      optional: true,
    });
  }
  // If the night digest doesn't run, the product's core (learning your taste,
  // getting to know the people you follow) is entirely dead. Precondition:
  // there has to be someone to digest first — this is mutually exclusive with
  // zero-follows, so they never compete for the same slot.
  if (hasGap('dream_stale')) {
    todos.push(dreamTodo(facts, facts.nowSec, lang));
  }
  if (hasGap('auto_name')) {
    // `auto_name` fires on name_source==='auto' alone, which is broader than
    // "invisible": onboarding's own skip/blind-fallback path already adopts a
    // real (non-placeholder) name with source 'auto' and publishes its
    // namecard (orchestrator.ts adoptName / my-namecard.ts) — the exact case
    // settling-gaps.ts's no_house_card comment warns about. So the
    // "nobody can find you" line is only true while the local name is still
    // the literal machine placeholder; reuse that same check here rather
    // than the gap's own (coarser) trigger.
    const stillInvisible = !facts.localNameReal;
    todos.push({
      title: renderCopy(lang, 'status.todo.autoName.title'),
      benefit: renderCopy(lang, stillInvisible ? 'status.todo.autoName.benefitInvisible' : 'status.todo.autoName.benefit'),
      how: renderCopy(lang, 'status.todo.autoName.how'),
    });
  }
  // The namecard self-heal ran but the card still didn't attach (issue #280
  // §3.3): the criterion lives in listGaps (`no_house_card`), this just
  // renders it. The suggested command carries the **local** nickname — the
  // boot-time snapshot would teach the owner to rename himself back.
  if (hasGap('no_house_card')) {
    todos.push({
      title: renderCopy(lang, 'status.todo.noHouseCard.title'),
      benefit: renderCopy(lang, 'status.todo.noHouseCard.benefit'),
      how: renderCopy(lang, 'status.todo.noHouseCard.how', { nickname: facts.localNickname }),
    });
  }
  return todos;
}

/** Complete the plan after the entry has read the owner's outdated rule files. */
export function withOutdatedNewspaperRules(
  todos: readonly Todo[],
  staleRules: readonly string[],
  lang: Lang,
): readonly Todo[] {
  // The daily-paper rulebook has moved on to a new version but the owner
  // edited that file — we never overwrite his changes, all we can do is
  // mention it here. Placed last: this isn't an identity gap, it's a
  // notification that's fine to ignore indefinitely.
  if (staleRules.length > 0) {
    return [...todos, {
      title: renderCopy(lang, 'status.todo.staleNewspaper.title'),
      benefit: renderCopy(lang, 'status.todo.staleNewspaper.benefit'),
      how: renderCopy(lang, 'status.todo.staleNewspaper.how', { files: staleRules.join(` ${lexiconFor(lang).terms.status.andSep} `) }),
    }];
  }

  return todos;
}

/** Humans see one required suggestion; agents get three plus optional advice. */
export function renderStatusNextSteps(
  todos: readonly Todo[],
  forAgent: boolean,
  lang: Lang,
): string[] {
  // `requiredTodos` feeds every count and the numbered agent-path list;
  // `optionalTodos` (today: just no_verify) is appended after, unnumbered —
  // an optional todo must never inflate "N steps left" or steal one of the
  // agent path's 3 numbered slots from an actual requirement.
  const requiredTodos = todos.filter((t) => !t.optional);
  const optionalTodos = todos.filter((t) => t.optional);

  const lines: string[] = [''];
  if (requiredTodos.length === 0 && optionalTodos.length === 0) {
    lines.push(renderCopy(lang, 'status.allDone'));
  } else if (forAgent) {
    lines.push(
      requiredTodos.length > 0
        ? renderCopy(lang, 'status.agent.stepsLeft', { n: String(requiredTodos.length) })
        : renderCopy(lang, 'status.allDone'),
    );
    requiredTodos.slice(0, AGENT_MAX_TODOS).forEach((t, i) => {
      lines.push(`${i + 1}. ${t.title} — ${t.benefit}`);
      // Leading U+3000 (full-width space) hangs the continuation line under the item on
      // phones. Concatenated, not interpolated: no-irregular-whitespace skips
      // string literals but not template literals. A multi-line `how` gets the
      // arrow once and hangs the rest under it — two arrows would read as two steps.
      if (t.how) lines.push(...t.how.split('\n').map((l, k) => (k === 0 ? '　 → ' : '　   ') + l));
    });
    // No number: an optional suggestion, not a counted step.
    optionalTodos.forEach((t) => {
      lines.push(`· ${t.title} — ${t.benefit}`);
      if (t.how) lines.push(...t.how.split('\n').map((l, k) => (k === 0 ? '　 → ' : '　   ') + l));
    });
  } else {
    // One thing at a time: giving three options is decision paralysis; the
    // remaining count is hinted at instead. Falls back to the first optional
    // todo only when nothing required is left — the sole-remaining-item case.
    const first = requiredTodos[0] ?? optionalTodos[0]!;
    lines.push(`👉 **${first.title}**`);
    lines.push(`${first.benefit}`);
    // The command and its alternative wording do not fit on
    // one phone line, so it's split into two at the conjunction — an
    // intentional line break always beats a passive wrap: we choose the break
    // point, not the screen width. If it can't be split (the copy changed the
    // conjunction), the whole sentence stays on one line, no content lost.
    // The split anchor comes from the selected language lexicon.
    if (first.how) lines.push(...splitAtOr(first.how, lang));
    const moreRequired = requiredTodos.length > 0 ? requiredTodos.length - 1 : 0;
    if (moreRequired > 0) lines.push(renderCopy(lang, 'status.human.moreLeft', { n: String(moreRequired) }));
  }
  return lines;
}
