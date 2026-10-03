import { describe, it, expect, vi } from 'vitest';
import {
  classifyOnboardingClaim,
  claimOnboardingInbound,
} from '../../../src/onboarding/inbound-claim.js';

describe('classifyOnboardingClaim', () => {
  it('裸编号被认领——这正是被劫走的那一类', () => {
    for (const n of ['1', '2', '10']) {
      expect(classifyOnboardingClaim('arrival', n)).toBe('claim');
    }
  });

  it('三位数不是编号（不是这几幕的把手）', () => {
    expect(classifyOnboardingClaim('lantern', '123')).toBe('pass');
  });

  it('封闭关键词被认领', () => {
    for (const w of ['跳过', 'skip', '你定', '先这样', '换个名字', '继续', '下一步']) {
      expect(classifyOnboardingClaim('arrival', w)).toBe('claim');
    }
  });

  it('标一下 N / 无感 N 被认领', () => {
    for (const w of ['标一下 2', '标记3', '收藏 1', '无感 3']) {
      expect(classifyOnboardingClaim('lantern', w)).toBe('claim');
    }
  });

  it('自由文本一律放行——自取名号也好、对 agent 说别的也好,路由权归 agent', () => {
    for (const t of ['我叫素问小待诏', '帮我出一版报纸', '好剑', '我最近在看开源治理']) {
      expect(classifyOnboardingClaim('arrival', t)).toBe('pass');
    }
  });

  it('N1: yes / no is claimed only at arrival while a name is pending on the card', () => {
    for (const w of ['对', '是的', '没错', '嗯', 'yeah', 'right', '不对', '不是', '取消', 'no', 'nope', 'wrong']) {
      expect(classifyOnboardingClaim('arrival', w, true), w).toBe('claim');
      // Nothing pending: plain chat, the agent's to answer.
      expect(classifyOnboardingClaim('arrival', w, false), `no pending: ${w}`).toBe('pass');
      expect(classifyOnboardingClaim('arrival', w), `default: ${w}`).toBe('pass');
    }
    for (const stage of ['passport', 'lantern', 'attune', 'errand', 'cadence'] as const) {
      for (const w of ['对', '不对', 'nope', 'wrong']) {
        expect(classifyOnboardingClaim(stage, w, true), `${stage}:${w}`).toBe('pass');
      }
    }
  });

  it('bare 1 / ok / proceed are claimed at arrival as before, pending or not', () => {
    for (const w of ['1', 'ok', '好', '继续']) {
      expect(classifyOnboardingClaim('arrival', w, false), w).toBe('claim');
      expect(classifyOnboardingClaim('arrival', w, true), w).toBe('claim');
    }
  });

  it('斜杠命令放行', () => {
    expect(classifyOnboardingClaim('arrival', '/popclaw start')).toBe('pass');
    expect(classifyOnboardingClaim('arrival', '/new')).toBe('pass');
  });

  it('idle / completed / 无状态一律放行——一毕业永不再碰', () => {
    for (const stage of ['idle', 'completed', null] as const) {
      expect(classifyOnboardingClaim(stage, '1')).toBe('pass');
      expect(classifyOnboardingClaim(stage, '跳过')).toBe('pass');
    }
  });

  it('空串放行', () => {
    expect(classifyOnboardingClaim('arrival', '   ')).toBe('pass');
  });
});

describe('claimOnboardingInbound', () => {
  const okAdvance = vi.fn(async () => ({ text: '卡片文本' }));

  it('认领 → 调 handleAdvance(next) 并返回卡片文本', async () => {
    const advance = vi.fn(async () => ({ text: '取名卡：1. 素问小待诏' }));
    const result = await claimOnboardingInbound(
      { content: '1' },
      { stage: () => 'arrival', advance },
    );
    expect(result).toEqual({ handled: true, text: '取名卡：1. 素问小待诏' });
    expect(advance).toHaveBeenCalledWith('next', '1');
  });

  it('N1: 「嗯」 reaches the card only while a name is pending (namePending dep)', async () => {
    const advance = vi.fn(async () => ({ text: 'card' }));
    expect(
      await claimOnboardingInbound({ content: '嗯' }, { stage: () => 'arrival', namePending: () => false, advance }),
    ).toBeUndefined();
    expect(await claimOnboardingInbound({ content: '嗯' }, { stage: () => 'arrival', advance })).toBeUndefined();
    expect(advance).not.toHaveBeenCalled();
    expect(
      await claimOnboardingInbound({ content: '嗯' }, { stage: () => 'arrival', namePending: () => true, advance }),
    ).toEqual({ handled: true, text: 'card' });
    expect(advance).toHaveBeenCalledWith('next', '嗯');
  });

  it('a namePending that throws never stops the gate: bare 1 is still claimed, 「对」 passes', async () => {
    const advance = vi.fn(async () => ({ text: 'card' }));
    const namePending = vi.fn((): boolean => {
      throw new Error('state db gone');
    });
    expect(await claimOnboardingInbound({ content: '1' }, { stage: () => 'arrival', namePending, advance })).toEqual({
      handled: true,
      text: 'card',
    });
    expect(namePending).not.toHaveBeenCalled(); // read lazily: a bare 1 never asks
    expect(await claimOnboardingInbound({ content: '对' }, { stage: () => 'arrival', namePending, advance })).toBeUndefined();
    expect(namePending).toHaveBeenCalledTimes(1);
    expect(advance).toHaveBeenCalledTimes(1);
  });

  it('跳过类词映射成 skip', async () => {
    const advance = vi.fn(async () => ({ text: '下一幕' }));
    await claimOnboardingInbound({ content: '跳过' }, { stage: () => 'attune', advance });
    expect(advance).toHaveBeenCalledWith('skip', '跳过');
  });

  it('认领时打一行日志（排障用）', async () => {
    const log = vi.fn();
    await claimOnboardingInbound(
      { content: '1' },
      { stage: () => 'arrival', advance: okAdvance, log },
    );
    expect(log).toHaveBeenCalledWith('popclaw: onboarding claimed inbound "1" at stage arrival');
  });

  it('orchestrator 抛错 → 返回 undefined,绝不打断正常聊天', async () => {
    const result = await claimOnboardingInbound(
      { content: '1' },
      {
        stage: () => 'arrival',
        advance: async () => {
          throw new Error('boom');
        },
      },
    );
    expect(result).toBeUndefined();
  });

  it('stage 取不到（runtime 未起来）→ 放行,且不碰 orchestrator', async () => {
    const advance = vi.fn(async () => ({ text: 'x' }));
    const result = await claimOnboardingInbound(
      { content: '1' },
      {
        stage: () => {
          throw new Error('runtime not started');
        },
        advance,
      },
    );
    expect(result).toBeUndefined();
    expect(advance).not.toHaveBeenCalled();
  });

  it('completed 之后永远放行', async () => {
    const advance = vi.fn(async () => ({ text: 'x' }));
    expect(
      await claimOnboardingInbound({ content: '1' }, { stage: () => 'completed', advance }),
    ).toBeUndefined();
    expect(advance).not.toHaveBeenCalled();
  });

  it('群消息放行——onboarding 是主人私下的事', async () => {
    const advance = vi.fn(async () => ({ text: 'x' }));
    expect(
      await claimOnboardingInbound(
        { content: '1', isGroup: true },
        { stage: () => 'arrival', advance },
      ),
    ).toBeUndefined();
    expect(advance).not.toHaveBeenCalled();
  });

  it('content 缺席时退回 body', async () => {
    const advance = vi.fn(async () => ({ text: 'ok' }));
    await claimOnboardingInbound({ body: '2' }, { stage: () => 'lantern', advance });
    expect(advance).toHaveBeenCalledWith('next', '2');
  });
});
