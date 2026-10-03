/**
 * `/popclaw bond remark` —— 主人给人起备注名的入口（唯一名字链的第一级）。
 */
import { describe, expect, it, beforeAll } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InMemoryHostDb } from '../../../src/host/in-memory-host-db.js';
import { runMigrations } from '../../../src/host/migrations.js';
import { BondsStore } from '../../../src/bonds/bonds-store.js';
import { runBondCommand } from '../../../src/commands/popclaw-bond.js';
import { makeNameChain } from '../../../src/identity/person-name.js';
import { deriveSigil } from '../../../src/invite/sigil.js';
import { setOwnerLang } from '../../../src/lexicon/owner-language.js';

// Rollout slice 1: unresolvedText (via resolvePerson) now renders in
// `ownerLang()` (S1 process-wide singleton). Pin zh-CN so this file's
// pre-lexicon assertions stay byte-for-byte unchanged (same fix as
// status.test.ts / world-tools.test.ts).
beforeAll(() => setOwnerLang('zh-CN', 'config'));

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../migrations');
/** 一个真的 32-byte base58 popclaw_id（`parseFollowTarget` 认它，不走认人）。 */
const ID = 'BFhFRcpqjFT8cQKmyLprxrgTAG14ttEkxCqCYcbBZWzB';

function deps() {
  const db = new InMemoryHostDb();
  runMigrations(db, MIGRATIONS_DIR);
  const bondsStore = new BondsStore(db, () => 1000);
  const nameOf = makeNameChain({ bond: (id) => bondsStore.get(id) });
  return { bondsStore, nameOf };
}

describe('/popclaw bond remark', () => {
  it('写库：备注名落 bonds.remark_name', async () => {
    const d = deps();
    const r = await runBondCommand({ positional: ['remark', ID, '老王'] }, d);
    expect(d.bondsStore.get(ID)!.remarkName).toBe('老王');
    expect(r.text).toContain('老王');
  });

  it('回执显示新的称呼效果（备注名#印信）', async () => {
    const d = deps();
    const r = await runBondCommand({ positional: ['remark', ID, '老王'] }, d);
    expect(r.text).toContain(`老王#${deriveSigil(ID)}`);
  });

  it('备注名盖过自报名号（同一条链）', async () => {
    const d = deps();
    d.bondsStore.ensure(ID);
    d.bondsStore.fillNickname(ID, 'Blackfeather');
    expect(d.nameOf(ID)).toBe('Blackfeather');
    await runBondCommand({ positional: ['remark', ID, '老王'] }, d);
    expect(d.nameOf(ID)).toBe('老王');
  });

  it('不给备注名 = 清空，称呼回落到自报名号', async () => {
    const d = deps();
    d.bondsStore.ensure(ID);
    d.bondsStore.fillNickname(ID, 'Blackfeather');
    await runBondCommand({ positional: ['remark', ID, '老王'] }, d);
    const r = await runBondCommand({ positional: ['remark', ID] }, d);
    expect(d.bondsStore.get(ID)!.remarkName).toBe('');
    expect(d.nameOf(ID)).toBe('Blackfeather');
    expect(r.text).toContain('Blackfeather');
    expect(r.text).toContain('清空');
  });

  it('带空格的备注名整句收下', async () => {
    const d = deps();
    await runBondCommand({ positional: ['remark', ID, '老', '王'] }, d);
    expect(d.bondsStore.get(ID)!.remarkName).toBe('老 王');
  });

  it('人用形式过认人解析器（名号#印信 / 裸名号）', async () => {
    const d = deps();
    const r = await runBondCommand(
      { positional: ['remark', 'Blackfeather', '老王'] },
      {
        ...d,
        resolvePerson: async () => ({
          kind: 'resolved' as const,
          popclawId: ID,
          nickname: 'Blackfeather',
          sigil: deriveSigil(ID),
        }),
      },
    );
    expect(d.bondsStore.get(ID)!.remarkName).toBe('老王');
    expect(r.text).toContain('老王');
  });

  it('认不出是谁就不写库，诚实说', async () => {
    const d = deps();
    const r = await runBondCommand(
      { positional: ['remark', '查无此人', '老王'] },
      { ...d, resolvePerson: async () => ({ kind: 'notFound' as const, ref: '查无此人' }) },
    );
    expect(d.bondsStore.get(ID)).toBeNull();
    expect(r.text).toContain('认不出');
  });

  it('不给对象 → 用法', async () => {
    const r = await runBondCommand({ positional: ['remark'] }, deps());
    expect(r.text).toContain('/popclaw bond remark');
  });

  it('未知动作的用法行提到 remark', async () => {
    const r = await runBondCommand({ positional: ['nonsense'] }, deps());
    expect(r.text).toContain('remark');
  });

  // S3 rollout slice 4 — en lane.
  it('renders in en when set', async () => {
    setOwnerLang('en', 'config');
    const d = deps();
    const r = await runBondCommand({ positional: ['remark', ID, '老王'] }, d);
    expect(r.text).toContain('Noted');
    expect(r.text).toContain(`老王#${deriveSigil(ID)}`);
    const cleared = await runBondCommand({ positional: ['remark', ID] }, d);
    expect(cleared.text).toContain('Cleared the remark name');
    setOwnerLang('zh-CN', 'config'); // restore file default for tests after this one
  });
});
