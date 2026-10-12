/**
 * "Not scheduled" and "scheduled but never runs" are different failures. Identifying the dream cron
 * job is necessary to distinguish them.
 */
import { describe, expect, it } from 'vitest';
import { findDreamJob, readDreamCronState, DREAM_JOB_NAME, type CronJobLike } from '../../../src/dreamer/dream-cron.js';

const job = (o: Partial<CronJobLike> = {}): CronJobLike => ({ id: 'j1', ...o });

describe('findDreamJob', () => {
  it('认约定的名字（确定性路径）', () => {
    expect(findDreamJob([job({ id: 'a', name: 'backup' }), job({ id: 'b', name: DREAM_JOB_NAME })])?.id).toBe('b');
  });

  it('agent 没照约定命名时，从措辞里认（兜底）', () => {
    const jobs = [job({ id: 'a', name: '晨报', payload: { message: '出一份报纸' } }),
                  job({ id: 'b', name: '夜里那个', payload: { message: '用 popclaw_dream 取素材消化一下' } })];
    expect(findDreamJob(jobs)?.id).toBe('b');
  });

  it('中文措辞也认', () => {
    expect(findDreamJob([job({ payload: { message: '做一次夜间消化' } })])).not.toBeNull();
  });

  it('禁用的任务当作没排 —— 主人关了它就是不想跑，这时候该提醒他', () => {
    expect(findDreamJob([job({ name: DREAM_JOB_NAME, enabled: false })])).toBeNull();
  });

  it('无关任务不误认', () => {
    expect(findDreamJob([job({ name: 'daily-standup', payload: { message: '汇报进度' } })])).toBeNull();
  });
});

describe('readDreamCronState', () => {
  it('排了 → scheduled:true', async () => {
    expect(await readDreamCronState(async () => ({ jobs: [job({ name: DREAM_JOB_NAME })] }))).toEqual({ scheduled: true });
  });

  // B8: the plugin cannot control cron's timezone, but must expose it; report it when present, otherwise host-local time.
  it('任务带 tz 就带出来；没带就省略（status 那边替它说 host-local）', async () => {
    const withTz = { jobs: [job({ name: DREAM_JOB_NAME, schedule: { kind: 'cron', tz: 'Asia/Shanghai' } })] };
    expect(await readDreamCronState(async () => withTz)).toEqual({ scheduled: true, tz: 'Asia/Shanghai' });
    const blank = { jobs: [job({ name: DREAM_JOB_NAME, schedule: { kind: 'cron', tz: '  ' } })] };
    expect(await readDreamCronState(async () => blank)).toEqual({ scheduled: true });
  });

  it('没排 → scheduled:false', async () => {
    expect(await readDreamCronState(async () => ({ jobs: [] }))).toEqual({ scheduled: false });
  });

  // Unable to query does not mean unscheduled: omit the optional signal instead of misleading the owner.
  it('读不着 / 形状不对 → null，绝不抛', async () => {
    expect(await readDreamCronState(async () => { throw new Error('ENOENT'); })).toBeNull();
    expect(await readDreamCronState(async () => null)).toBeNull();
    expect(await readDreamCronState(async () => ({}) as never)).toBeNull();
  });
});

// Found during real-host acceptance: a one-off dream triggered with `--at +1m` was mistaken
// for "already scheduled", skipping a required question. Scheduled means it will recur.
describe('findDreamJob — 一次性任务不算排期', () => {
  it('--at 的一次性任务被忽略（它跑完就删）', () => {
    expect(findDreamJob([job({ name: DREAM_JOB_NAME, schedule: { kind: 'at' } })])).toBeNull();
  });

  it('--cron / --every 的周期任务才算数', () => {
    expect(findDreamJob([job({ name: DREAM_JOB_NAME, schedule: { kind: 'cron' } })])).not.toBeNull();
    expect(findDreamJob([job({ name: DREAM_JOB_NAME, schedule: { kind: 'every' } })])).not.toBeNull();
  });

  it('没有 schedule 字段时不误杀（老存档 / 形状变了）', () => {
    expect(findDreamJob([job({ name: DREAM_JOB_NAME })])).not.toBeNull();
  });
});
