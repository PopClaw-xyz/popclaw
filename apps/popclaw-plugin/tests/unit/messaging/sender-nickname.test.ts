import { describe, it, expect } from 'vitest';
import { makeNameChain, displayNamed } from '../../../src/identity/person-name.js';

/**
 * Issue #281 — the first real feedback DM announced itself to its recipient as
 * `#n3tzfhnt 给你发了私信`. The name was never missing: `envelope.actor.nickname`
 * rides along on every signed DM, and the SSE client decodes the envelope
 * anyway. It just threw the actor away after taking `directMessage`.
 */
const ID = 'HafABCDEFGHIJKLMNOPqrstuvwxyz12';

describe('a stranger who signs their name (#281)', () => {
  it('is addressed by that name once it reaches the chain', () => {
    const nameOf = makeNameChain({ bond: () => null });
    expect(nameOf(ID, '青山小待诏')).toBe('青山小待诏');
    expect(displayNamed(ID, nameOf, '青山小待诏')).toContain('青山小待诏#');
  });

  it('is still a bare sigil when nothing signed a name (legacy / envelope-less)', () => {
    const nameOf = makeNameChain({ bond: () => null });
    expect(nameOf(ID, '')).toBe('');
    // displayNamed falls back to the sigil alone — we do not invent a name.
    expect(displayNamed(ID, nameOf, '')).not.toContain('#undefined');
  });

  it('never outranks the bond book — the owner keeps the name they gave', () => {
    // The whole reason a self-reported name is safe to show: anyone can sign an
    // envelope claiming any nickname, so it sits at the BOTTOM of the chain.
    const nameOf = makeNameChain({
      bond: () => ({ remarkName: '老青', nickname: '青山小待诏' }),
    });
    expect(nameOf(ID, '我才是青山小待诏')).toBe('老青');
  });

  it('a bond nickname also outranks it', () => {
    const nameOf = makeNameChain({ bond: () => ({ remarkName: '', nickname: '青山小待诏' }) });
    expect(nameOf(ID, '冒名者')).toBe('青山小待诏');
  });
});
