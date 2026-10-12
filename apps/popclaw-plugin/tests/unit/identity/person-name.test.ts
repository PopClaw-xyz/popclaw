import { describe, it, expect } from 'vitest';
import { makeNameChain, displayNamed } from '../../../src/identity/person-name.js';
import { deriveSigil } from '../../../src/invite/sigil.js';

const ID = 'BFhFRcpqjFT8cQKmyLprxrgTAG14ttEkxCqCYcbBZWzB';

describe('name chain: remark > nickname > server > handle', () => {
  it('备注名盖过自报名号', () => {
    const nameOf = makeNameChain({ bond: () => ({ nickname: 'Blackfeather', remarkName: '老王' }) });
    expect(nameOf(ID)).toBe('老王');
  });

  it('备注名盖过服务器给的自报名号', () => {
    const nameOf = makeNameChain({ bond: () => ({ nickname: '', remarkName: '老王' }) });
    expect(nameOf(ID, 'Blackfeather')).toBe('老王');
  });

  it('备注名盖过世界流 handle', () => {
    const nameOf = makeNameChain({
      bond: () => ({ remarkName: '老王' }),
      handleFromFeed: () => 'elonmusk',
    });
    expect(nameOf(ID)).toBe('老王');
  });

  it('备注名为空 → 回落自报名号', () => {
    const nameOf = makeNameChain({ bond: () => ({ nickname: 'Blackfeather', remarkName: '' }) });
    expect(nameOf(ID)).toBe('Blackfeather');
  });

  it('备注名清空后 → 回落自报名号（清空 = 写空串）', () => {
    let remarkName = '老王';
    const nameOf = makeNameChain({ bond: () => ({ nickname: 'Blackfeather', remarkName }) });
    expect(nameOf(ID)).toBe('老王');
    remarkName = '';
    expect(nameOf(ID)).toBe('Blackfeather');
  });

  it('交情本两格都空 → 服务器名，再空 → handle', () => {
    const nameOf = makeNameChain({
      bond: () => ({ nickname: '', remarkName: '' }),
      handleFromFeed: () => 'elonmusk',
    });
    expect(nameOf(ID, '马斯克')).toBe('马斯克');
    expect(nameOf(ID)).toBe('elonmusk');
  });

  it('全空 → 空串（交给 displayPerson 落 #印信）', () => {
    const nameOf = makeNameChain({});
    expect(nameOf(ID)).toBe('');
    expect(displayNamed(ID, nameOf)).toBe(`#${deriveSigil(ID)}`);
  });

  it('只留空白的备注名不算数', () => {
    const nameOf = makeNameChain({ bond: () => ({ nickname: '白鹭', remarkName: '   ' }) });
    expect(nameOf(ID)).toBe('白鹭');
  });

  it('交情本查库抛异常 → 降级到后面的级，不炸', () => {
    const nameOf = makeNameChain({
      bond: () => {
        throw new Error('db locked');
      },
      handleFromFeed: () => 'elonmusk',
    });
    expect(nameOf(ID)).toBe('elonmusk');
  });

  // Real host-c run, 2026-07-31: the postcard said `#6q0w4z7r sent you a DM`. The official house account publishes no
  // profile, so the first three name-resolution levels are always empty and the owner cannot recognize the world sender.
  it('坊官方名号：三级全空 → 报坊名（链末一级）', () => {
    const nameOf = makeNameChain({ houseOfficialName: () => 'popclaw.world' });
    expect(nameOf(ID)).toBe('popclaw.world');
    expect(displayNamed(ID, nameOf)).toBe(`popclaw.world#${deriveSigil(ID)}`);
  });

  it('坊名绝不盖过人自报的名字（它是兜底，不是权威）', () => {
    const nameOf = makeNameChain({
      handleFromFeed: () => 'elonmusk',
      houseOfficialName: () => 'popclaw.world',
    });
    expect(nameOf(ID)).toBe('elonmusk');
    expect(nameOf(ID, '马斯克')).toBe('马斯克');
  });

  it('坊名兜底读文件抛异常 → 落空串，不炸', () => {
    const nameOf = makeNameChain({
      houseOfficialName: () => {
        throw new Error('fs exploded');
      },
    });
    expect(nameOf(ID)).toBe('');
  });

  it('displayNamed 用链的名字渲染 名号#印信', () => {
    const nameOf = makeNameChain({ bond: () => ({ nickname: '白鹭', remarkName: '老王' }) });
    expect(displayNamed(ID, nameOf, '白鹭')).toBe(`老王#${deriveSigil(ID)}`);
  });

  it('displayNamed 未注入链 → 退回服务器名（老行为）', () => {
    expect(displayNamed(ID, undefined, '白鹭')).toBe(`白鹭#${deriveSigil(ID)}`);
    expect(displayNamed(ID, undefined)).toBe(`#${deriveSigil(ID)}`);
  });

  it('没有 popclaw_id → 不推印信', () => {
    const nameOf = makeNameChain({ bond: () => ({ remarkName: '老王' }) });
    expect(nameOf('', '白鹭')).toBe('白鹭');
    expect(displayNamed('', nameOf, '白鹭')).toBe('白鹭');
  });
});
