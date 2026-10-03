import { describe, expect, it, vi } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InMemoryHostDb } from '../../../src/host/in-memory-host-db.js';
import { runMigrations } from '../../../src/host/migrations.js';
import { BondsStore } from '../../../src/bonds/bonds-store.js';
import { backfillBondNicknames } from '../../../src/bonds/backfill-nicknames.js';

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../migrations');

function freshStore(): BondsStore {
  const db = new InMemoryHostDb();
  runMigrations(db, MIGRATIONS_DIR);
  return new BondsStore(db, () => 1000);
}

describe('backfillBondNicknames — 开机补课', () => {
  it('名字空着的行被补上', async () => {
    const s = freshStore();
    s.ensure('CANGWU');
    const filled = await backfillBondNicknames({ store: s, lookup: async () => ({ nickname: '苍梧小居士', handles: [] }) });
    expect(filled).toBe(1);
    expect(s.get('CANGWU')?.nickname).toBe('苍梧小居士');
  });

  // 改口径（2026-07-30）：名字非空的行**也要问**——名号会变，本地这份是缓存。
  // 以前"非空就不问"正是 handle 卡在名号位两天没人纠正的原因。
  it('名字非空的行照样对，灯坊改了就跟着改', async () => {
    const s = freshStore();
    s.setNickname('CANGWU', '旧名号');
    const lookup = vi.fn(async () => ({ nickname: '灯坊上的新名号', handles: [] }));
    expect(await backfillBondNicknames({ store: s, lookup })).toBe(1);
    expect(lookup).toHaveBeenCalled();
    expect(s.get('CANGWU')?.nickname).toBe('灯坊上的新名号');
  });

  it('查无此人（404 → null）跳过，不炸也不建行', async () => {
    const s = freshStore();
    s.ensure('GHOST');
    expect(await backfillBondNicknames({ store: s, lookup: async () => null })).toBe(0);
    expect(s.get('GHOST')?.nickname).toBe('');
  });

  it('单个人查询抛异常 → 跳过他，后面的照补', async () => {
    const s = freshStore();
    s.ensure('BOOM');
    s.ensure('OK');
    const filled = await backfillBondNicknames({
      store: s,
      lookup: async (id) => {
        if (id === 'BOOM') throw new Error('灯坊打嗝');
        return { nickname: '好人', handles: [] };
      },
    });
    expect(filled).toBe(1);
    expect(s.get('OK')?.nickname).toBe('好人');
    expect(s.get('BOOM')?.nickname).toBe('');
  });

  it('上限生效：一次最多问 limit 个人', async () => {
    const s = freshStore();
    for (let i = 0; i < 10; i++) s.ensure(`P${i}`);
    const lookup = vi.fn(async () => ({ nickname: '某人', handles: [] }));
    expect(await backfillBondNicknames({ store: s, lookup, limit: 3 })).toBe(3);
    expect(lookup).toHaveBeenCalledTimes(3);
  });

  it('没人要补 → 一次网络都不发', async () => {
    const lookup = vi.fn(async () => ({ nickname: '某人', handles: [] }));
    expect(await backfillBondNicknames({ store: freshStore(), lookup })).toBe(0);
    expect(lookup).not.toHaveBeenCalled();
  });
});

// 真机 2026-07-30：主人把灯坊上的名号改成「Blackfeather」，苍梧阁那边收到的私信
// 仍显示 `owl_scribe_7#7t4k2n9q`。查证：苍梧阁交情本里 `nickname = owl_scribe_7`
// —— X handle 被写进了名号字段（灯坊在没名片时会拿 handle 顶 nickname），而
// `fillNickname` 只填空，于是真名号永远进不来。名号是缓存，得跟着灯坊走。
describe('名号是缓存，要跟着灯坊更新（真机 2026-07-30）', () => {
  function bed(rows: Record<string, string>) {
    const store = {
      idsForNicknameSync: () => Object.keys(rows),
      syncNickname: (id: string, name: string) => {
        if (rows[id] === name) return false;
        rows[id] = name;
        return true;
      },
    };
    return { rows, store };
  }

  it('灯坊上改了名号 → 本地跟着改', async () => {
    const { rows, store } = bed({ ownerId: 'owl_scribe_7' });
    const n = await backfillBondNicknames({
      store,
      lookup: async () => ({ nickname: 'Blackfeather', handles: ['owl_scribe_7'] }),
    });
    expect(rows.ownerId).toBe('Blackfeather');
    expect(n).toBe(1);
  });

  it('灯坊只有 handle 顶着（没名片）→ 绝不写进名号字段', async () => {
    const { rows, store } = bed({ ownerId: '' });
    await backfillBondNicknames({
      store,
      lookup: async () => ({ nickname: 'owl_scribe_7', handles: ['owl_scribe_7'] }),
    });
    expect(rows.ownerId).toBe(''); // 名号位留空，显示自己会退到 handle 那一档
  });

  it('已经存着 handle、灯坊也还只有 handle → 不动（不制造无谓写）', async () => {
    const { rows, store } = bed({ ownerId: 'owl_scribe_7' });
    const n = await backfillBondNicknames({
      store,
      lookup: async () => ({ nickname: 'owl_scribe_7', handles: ['owl_scribe_7'] }),
    });
    expect(rows.ownerId).toBe('owl_scribe_7');
    expect(n).toBe(0);
  });

  it('灯坊失联 / 查无此人 → 不动本地（绝不把已知的名字擦掉）', async () => {
    const { rows, store } = bed({ ownerId: 'Blackfeather' });
    await backfillBondNicknames({ store, lookup: async () => null });
    expect(rows.ownerId).toBe('Blackfeather');
  });
});
