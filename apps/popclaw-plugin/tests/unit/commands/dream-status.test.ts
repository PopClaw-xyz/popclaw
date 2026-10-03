import { describe, expect, it } from 'vitest';
import { dreamTodo } from '../../../src/commands/status.js';
import { readDreamCronState } from '../../../src/dreamer/dream-cron.js';

const NOW = 1_800_000_000;

// A write-back cursor records a committed material window, never an attempt.
// Exercise both supported languages and the three independent schedule states.
describe.each(['zh-CN', 'en'] as const)('dream status evidence (%s)', (lang) => {
  it.each([true, false, null, undefined])('old write-back preserves limited facts with schedule %s', (scheduled) => {
    const todo = dreamTodo({ lastDreamAt: NOW - 16 * 86_400,
      dreamCron: scheduled == null ? scheduled : { scheduled } }, NOW, lang);
    const text = Object.values(todo).join('\n');
    expect(text).toMatch(lang === 'en' ? /write-back.*16/ : /有效写回.*16/);
    expect(text).not.toMatch(/没跑|没做过|没跑成|hasn't run|haven't had|probably|多半|投递失败|Delivery.*failed/);
    expect(text).toMatch(lang === 'en' ? /latest attempt.*unknown/ : /最近一次运行.*未知/);
    if (scheduled !== false) expect(text).not.toMatch(/每天凌晨|3am|have a dream|做个梦/);
  });

  it.each([true, false, null])('no stamp does not fabricate elapsed days or lack of attempts (schedule %s)', (scheduled) => {
    const todo = dreamTodo({ lastDreamAt: null, dreamCron: scheduled === null ? null : { scheduled } }, NOW, lang);
    const text = Object.values(todo).join('\n');
    expect(text).toMatch(lang === 'en' ? /No effective write-back.*recorded/ : /尚无有效写回记录/);
    expect(text).not.toMatch(/0 天|0 day|没做过|never run|haven't had|hasn't run/);
  });

  it('failed schedule query stays unknown and does not invite a duplicate job', async () => {
    const dreamCron = await readDreamCronState(async () => { throw new Error('unreadable archive'); });
    expect(dreamCron).toBeNull();
    const todo = dreamTodo({ lastDreamAt: NOW - 16 * 86_400, dreamCron }, NOW, lang);
    const text = Object.values(todo).join('\n');
    expect(text).toMatch(lang === 'en' ? /Schedule status.*unknown/ : /调度状态暂时查不到/);
    expect(text).not.toMatch(/还没排上|isn't scheduled|3am|每天凌晨/);
  });

  it('a successful empty archive permits an explicit scheduling invitation', async () => {
    const dreamCron = await readDreamCronState(async () => ({ jobs: [] }));
    const todo = dreamTodo({ lastDreamAt: null, dreamCron }, NOW, lang);
    expect(Object.values(todo).join('\n')).toMatch(lang === 'en' ? /3am/ : /每天凌晨 3 点/);
  });
});
