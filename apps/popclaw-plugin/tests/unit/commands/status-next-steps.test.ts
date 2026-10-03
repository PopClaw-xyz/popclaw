/**
 * Direct policy tests for contributors changing next-step advice. Complete report
 * output, fact wiring and late-read boundaries remain covered by status.test.ts
 * and status-deps-parity.test.ts.
 */
import { describe, expect, it } from 'vitest';
import {
  isDreamStale,
  planStatusNextSteps,
  renderStatusNextSteps,
  withOutdatedNewspaperRules,
  type StatusNextStepFacts,
} from '../../../src/commands/status-next-steps.js';
import { DREAM_STALE_SECS } from '../../../src/dreamer/dream.js';
import type { DreamCronState } from '../../../src/dreamer/dream-cron.js';
import { lexiconFor, renderCopy } from '../../../src/lexicon/index.js';
import { listGaps, type Gap } from '../../../src/onboarding/settling-gaps.js';

const NOW = 1_800_000_000;
const facts: StatusNextStepFacts = Object.freeze({
  localNickname: 'Current Name', localNameReal: true, nowSec: NOW,
});

for (const lang of ['en', 'zh-CN'] as const) {
  describe(`status next-step policy (${lang})`, () => {
    it('prioritizes simultaneous gaps independently of input order, without optional advice taking an agent slot', () => {
      // No follows and a stale dream are mutually exclusive. This is the
      // zero-follows case; the followed-person combination is exercised below.
      const gaps: readonly Gap[] = Object.freeze(([
        { key: 'no_house_card' }, { key: 'auto_name' }, { key: 'no_verify' },
        { key: 'no_taste' }, { key: 'no_follows' },
        { key: 'resume_onboarding' }, { key: 'house:other:first_move' },
      ] satisfies Gap[]).map(g => Object.freeze(g)));
      const planned = planStatusNextSteps(gaps, facts, lang);
      expect(planned.map(t => t.title)).toEqual([
        'noFollows', 'noTaste', 'noVerify', 'autoName', 'noHouseCard',
      ].map(key => renderCopy(lang, `status.todo.${key}.title`)));
      expect(planned.filter(t => t.optional).map(t => t.title)).toEqual([
        renderCopy(lang, 'status.todo.noVerify.title'),
      ]);
      expect(planned[1]!.how).toBeUndefined(); // The taste title is already the action.
      expect(planned[3]!.benefit).toBe(renderCopy(lang, 'status.todo.autoName.benefit'));
      expect(planned[4]!.how).toBe(renderCopy(lang, 'status.todo.noHouseCard.how', { nickname: 'Current Name' }));

      const completed = withOutdatedNewspaperRules(Object.freeze(planned), ['daily-paper.md'], lang);
      const agent = renderStatusNextSteps(completed, true, lang);
      expect(agent[1]).toBe(renderCopy(lang, 'status.agent.stepsLeft', { n: '5' }));
      expect(agent.filter(l => /^\d+\./u.test(l))).toEqual([
        `1. ${planned[0]!.title} — ${planned[0]!.benefit}`,
        `2. ${planned[1]!.title} — ${planned[1]!.benefit}`,
        `3. ${planned[3]!.title} — ${planned[3]!.benefit}`,
      ]);
      expect(agent.filter(l => l.startsWith('· '))).toEqual([
        `· ${planned[2]!.title} — ${planned[2]!.benefit}`,
      ]);
      expect(agent.join('\n')).not.toContain(planned[4]!.title);
      expect(agent.join('\n')).not.toContain(completed[5]!.title);

      const human = renderStatusNextSteps(completed, false, lang);
      expect(human.filter(l => l.startsWith('👉'))).toEqual([`👉 **${planned[0]!.title}**`]);
      expect(human.at(-1)).toBe(renderCopy(lang, 'status.human.moreLeft', { n: '4' }));
      for (const todo of completed.slice(1)) expect(human.join('\n')).not.toContain(todo.title);
      // No rule update preserves the original plan; adding one never mutates it.
      expect(withOutdatedNewspaperRules(planned, [], lang)).toBe(planned);
      expect(planned).toHaveLength(5);
    });

    it('shows a late rule update before sole optional verification, then falls back to verification when required work is done', () => {
      const optional = Object.freeze(planStatusNextSteps([{ key: 'no_verify' }], facts, lang));
      const rules = Object.freeze(['daily-paper.md', 'editorial.md']);
      const completed = Object.freeze(withOutdatedNewspaperRules(optional, rules, lang));
      const update = completed[1]!;
      expect(update.how).toBe(renderCopy(lang, 'status.todo.staleNewspaper.how', {
        files: rules.join(` ${lexiconFor(lang).terms.status.andSep} `),
      }));
      const human = renderStatusNextSteps(completed, false, lang);
      expect(human).toEqual(['', `👉 **${update.title}**`, update.benefit, update.how]);
      const agent = renderStatusNextSteps(completed, true, lang);
      expect(agent[1]).toBe(renderCopy(lang, 'status.agent.stepsLeft', { n: '1' }));
      expect(agent.filter(l => /^\d+\./u.test(l))).toEqual([`1. ${update.title} — ${update.benefit}`]);
      expect(agent.filter(l => l.startsWith('· '))).toEqual([`· ${optional[0]!.title} — ${optional[0]!.benefit}`]);
      const howLines = update.how!.split('\n');
      const itemIndex = agent.findIndex(l => l.startsWith('1.'));
      expect(agent.slice(itemIndex + 1, itemIndex + 1 + howLines.length)).toEqual(
        howLines.map((l, i) => (i === 0 ? '　 → ' : '　   ') + l),
      );

      const optionalAgent = renderStatusNextSteps(optional, true, lang);
      expect(optionalAgent[1]).toBe(renderCopy(lang, 'status.allDone'));
      expect(optionalAgent.some(l => /^\d+\./u.test(l))).toBe(false);
      expect(optionalAgent).toContain(`· ${optional[0]!.title} — ${optional[0]!.benefit}`);
      const optionalHuman = renderStatusNextSteps(optional, false, lang);
      expect(optionalHuman[1]).toBe(`👉 **${optional[0]!.title}**`);
      expect(optionalHuman.join('\n')).not.toContain(renderCopy(lang, 'status.human.moreLeft', { n: '1' }));
      expect(renderStatusNextSteps([], true, lang)).toEqual(['', renderCopy(lang, 'status.allDone')]);
      expect(renderStatusNextSteps([], false, lang)).toEqual(['', renderCopy(lang, 'status.allDone')]);
      expect(optional).toHaveLength(1);
    });
  });
}

interface DreamCase {
  label: string;
  lastDreamAt: number | null | undefined;
  dreamCron: DreamCronState | undefined;
  titleKey?: string;
  days?: string;
  repair?: boolean;
}

const dreamCases: DreamCase[] = [
  { label: 'unwired cursor even with a scheduled job', lastDreamAt: undefined, dreamCron: { scheduled: true } },
  { label: 'still within grace period', lastDreamAt: NOW - DREAM_STALE_SECS + 1, dreamCron: { scheduled: true } },
  { label: 'no write-back and not scheduled', lastDreamAt: null, dreamCron: { scheduled: false }, titleKey: 'scheduledFalse' },
  { label: 'no write-back and cron read failed', lastDreamAt: null, dreamCron: null, titleKey: 'neverRan' },
  { label: 'stale cursor and cron unwired', lastDreamAt: NOW - 5 * 86_400, dreamCron: undefined, titleKey: 'someDays', days: '5' },
  { label: 'no write-back with a scheduled job', lastDreamAt: null, dreamCron: { scheduled: true, tz: 'Europe/Berlin' }, titleKey: 'scheduledTrue', days: '0', repair: true },
  { label: 'exact staleness boundary with a scheduled job', lastDreamAt: NOW - DREAM_STALE_SECS, dreamCron: { scheduled: true, tz: 'Europe/Berlin' }, titleKey: 'scheduledTrue', days: '3', repair: true },
];

describe('followed-person dream advice alongside taste and optional verification', () => {
  it('keeps dream write-back advice ahead of naming and late rules when all followed-person gaps compete', () => {
    const dreamFacts = { ...facts, lastDreamAt: NOW - 5 * 86_400, dreamCron: { scheduled: true, tz: 'Europe/Berlin' } };
    const gaps = listGaps({
      followingCount: 2, tasteSeeded: false, loreHouseReachable: true,
      externalVerifiedCount: 0, pendingInvitesCount: 0, nameSource: 'auto',
      dreamStale: true, cardOnHouse: false, localNameReal: true,
    });
    const planned = planStatusNextSteps(gaps.reverse(), dreamFacts, 'en');
    const titles = [
      renderCopy('en', 'status.todo.noTaste.title'),
      renderCopy('en', 'status.todo.noVerify.title'),
      renderCopy('en', 'status.dream.scheduledTrue.title', { writeback: renderCopy('en', 'status.dream.lastWriteback', { days: '5' }) }),
      renderCopy('en', 'status.todo.autoName.title'),
      renderCopy('en', 'status.todo.noHouseCard.title'),
    ];
    expect(planned.map(t => t.title)).toEqual(titles);
    const completed = withOutdatedNewspaperRules(planned, ['daily-paper.md'], 'en');
    const agent = renderStatusNextSteps(completed, true, 'en');
    expect(agent[1]).toBe(renderCopy('en', 'status.agent.stepsLeft', { n: '5' }));
    expect(agent.filter(l => /^\d+\./u.test(l)).map(l => l.split(' — ')[0])).toEqual([
      `1. ${titles[0]}`, `2. ${titles[2]}`, `3. ${titles[3]}`,
    ]);
    expect(agent.filter(l => l.startsWith('· '))).toHaveLength(1);
    expect(agent.join('\n')).not.toContain(titles[4]);
    const human = renderStatusNextSteps(completed, false, 'en');
    expect(human).toEqual([
      '', `👉 **${titles[0]}**`, planned[0]!.benefit,
      renderCopy('en', 'status.human.moreLeft', { n: '4' }),
    ]);
  });

  it.each(dreamCases)('$label', c => {
    const gaps = listGaps({
      followingCount: 2, tasteSeeded: false, loreHouseReachable: true,
      externalVerifiedCount: 0, pendingInvitesCount: 0, nameSource: 'owner',
      dreamStale: isDreamStale(c.lastDreamAt, NOW),
    });
    const planned = planStatusNextSteps(gaps, {
      ...facts, lastDreamAt: c.lastDreamAt, dreamCron: c.dreamCron,
    }, 'en');
    const tasteTitle = renderCopy('en', 'status.todo.noTaste.title');
    const verifyTitle = renderCopy('en', 'status.todo.noVerify.title');
    const writeback = c.lastDreamAt === null
      ? renderCopy('en', 'status.dream.noWriteback')
      : renderCopy('en', 'status.dream.lastWriteback', { days: String(Math.floor((NOW - (c.lastDreamAt ?? NOW)) / 86_400)) });
    const dreamTitle = c.titleKey
      ? c.dreamCron?.scheduled === true
        ? renderCopy('en', 'status.dream.scheduledTrue.title', { writeback })
        : c.dreamCron?.scheduled === false
          ? renderCopy('en', 'status.dream.scheduledFalse.title', { writeback })
          : writeback
      : undefined;
    expect(planned.map(t => t.title)).toEqual([tasteTitle, verifyTitle, ...(dreamTitle ? [dreamTitle] : [])]);
    const agent = renderStatusNextSteps(planned, true, 'en');
    expect(agent[1]).toBe(renderCopy('en', 'status.agent.stepsLeft', { n: dreamTitle ? '2' : '1' }));
    expect(agent.filter(l => /^\d+\./u.test(l)).map(l => l.split(' — ')[0])).toEqual([
      `1. ${tasteTitle}`, ...(dreamTitle ? [`2. ${dreamTitle}`] : []),
    ]);
    expect(agent.filter(l => l.startsWith('· '))).toHaveLength(1);
    const human = renderStatusNextSteps(planned, false, 'en');
    expect(human[1]).toBe(`👉 **${tasteTitle}**`);
    if (dreamTitle) {
      expect(human.at(-1)).toBe(renderCopy('en', 'status.human.moreLeft', { n: '1' }));
      expect(human.join('\n')).not.toContain(dreamTitle);
      const dream = planned[2]!;
      const attemptUnknown = renderCopy('en', 'status.dream.attemptUnknown');
      expect(dream.how).toBe(c.repair
        ? `${attemptUnknown}\n${renderCopy('en', 'status.dream.scheduledTrue.how')}\n${renderCopy('en', 'status.dream.tzLine', { tz: 'Europe/Berlin' })}`
        : `${attemptUnknown}\n${renderCopy('en', c.dreamCron?.scheduled === false ? 'status.dream.ask' : 'status.dream.scheduleUnknown')}`);
    } else {
      expect(human).toEqual(['', `👉 **${tasteTitle}**`, planned[0]!.benefit]);
    }
  });
});
