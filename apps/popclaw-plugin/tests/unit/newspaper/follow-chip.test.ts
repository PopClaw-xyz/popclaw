/**
 * The doorbell chip's pure halves (spec §5.4): the button itself, the three
 * faces a POST result flips it to, the reader-pass message contract, and the
 * inline script that wires both. All DOM-free on purpose — the plugin has no
 * DOM test rig, so the script is asserted as a string and every behaviour
 * that can be a pure function is one.
 *
 * Ruling H (controller, 2026-08-31) shapes the script tests:
 *   H1 the paper runs in a sandboxed iframe (no allow-same-origin), so
 *      `location.origin` is the string "null" there — the expected origin is
 *      derived from the URL (`new URL(location.href).origin`), never read off
 *      `location.origin`;
 *   H2 the iframe asks for the follow-states itself on init (the chrome push
 *      can fire before this listener exists);
 *   H3 the chrome side answers (canvas tests hold that contract).
 */
import { describe, it, expect } from 'vitest';
import {
  chipHtml,
  chipStateFor,
  doorbellScript,
  followStatesFromEvent,
  intentResultFromEvent,
  loginCodeFromEvent,
  readerContextFromEvent,
  type ChipStrings,
} from '../../../src/newspaper/follow-chip.js';

/** Real lexicon shape, dummy values — these tests assert structure, not copy. */
const T: ChipStrings = {
  cta: 'CTA',
  sent: 'SENT',
  exists: 'EXISTS',
  fail: 'FAIL',
  followed: 'FOLLOWED',
  pairFirst: 'PAIR-FIRST',
};

describe('chipHtml', () => {
  it('emits the one button the doorbell script targets, with the followee id and label', () => {
    expect(chipHtml({ authorPopclawId: 'pid-a', author: '云舟', sigil: '3m8v' }, T)).toBe(
      '<button class="follow-btn" data-followee="pid-a" data-label="云舟#3m8v">CTA</button>',
    );
  });

  it('label is the bare name when there is no sigil', () => {
    expect(chipHtml({ authorPopclawId: 'pid-a', author: 'levelsio' }, T)).toContain('data-label="levelsio"');
  });

  it('id and label are attribute-escaped — the label is reader-chosen material at heart', () => {
    const h = chipHtml({ authorPopclawId: 'pid"<x', author: 'a"b<c' }, T);
    expect(h).toContain('data-followee="pid&quot;&lt;x"');
    expect(h).toContain('data-label="a&quot;b&lt;c"');
  });
});

describe('chipStateFor — the faces a POST result flips to', () => {
  it('created → sent, disabled', () => {
    expect(chipStateFor('created', T)).toEqual({ text: 'SENT', disabled: true });
  });
  it('exists → already listed, disabled', () => {
    expect(chipStateFor('exists', T)).toEqual({ text: 'EXISTS', disabled: true });
  });
  // The reader-credit contract (2026-09-13) spells the two settled answers
  // recorded/duplicate; pages already in the wild speak created/exists.
  it('recorded / duplicate read as the same two settled answers', () => {
    expect(chipStateFor('recorded', T)).toEqual({ text: 'SENT', disabled: true });
    expect(chipStateFor('duplicate', T)).toEqual({ text: 'EXISTS', disabled: true });
  });
  it('fail → retry copy, stays clickable', () => {
    expect(chipStateFor('fail', T)).toEqual({ text: 'FAIL', disabled: false });
  });
  // Owner ruling 2026-09-13: an unpaired browser's click records NOTHING, so
  // this face is an instruction, not a receipt — and the button must stay
  // clickable for the click that follows the pairing.
  it('pair-first → the pair-first face, stays clickable (nothing was recorded)', () => {
    expect(chipStateFor('pair-first', T)).toEqual({ text: 'PAIR-FIRST', disabled: false });
  });
});

describe('followStatesFromEvent — reader-pass message contract', () => {
  const data = { type: 'follow-states', followed: ['pid-a', 'pid-b'] };

  it('same origin + right shape → the followed list', () => {
    expect(followStatesFromEvent('https://canvas', 'https://canvas', data)).toEqual(['pid-a', 'pid-b']);
  });
  it('cross-origin → null, whoever asks', () => {
    expect(followStatesFromEvent('https://evil', 'https://canvas', data)).toBeNull();
  });
  it('wrong type / not an object → null', () => {
    expect(followStatesFromEvent('https://canvas', 'https://canvas', { type: 'other', followed: [] })).toBeNull();
    expect(followStatesFromEvent('https://canvas', 'https://canvas', null)).toBeNull();
    expect(followStatesFromEvent('https://canvas', 'https://canvas', 'follow-states')).toBeNull();
  });
  it('followed must be an array of strings → else null', () => {
    expect(followStatesFromEvent('https://canvas', 'https://canvas', { type: 'follow-states' })).toBeNull();
    expect(followStatesFromEvent('https://canvas', 'https://canvas', { type: 'follow-states', followed: {} })).toBeNull();
    expect(
      followStatesFromEvent('https://canvas', 'https://canvas', { type: 'follow-states', followed: ['a', 7] }),
    ).toBeNull();
  });
});

describe('intentResultFromEvent — the relayed click\'s answer (canvas contract 2026-09-13)', () => {
  it('from the parent + the right shape → the nonce and the result', () => {
    expect(intentResultFromEvent(true, { type: 'follow-intent-result', req: 'r1', result: 'recorded' })).toEqual({
      req: 'r1',
      result: 'recorded',
    });
    expect(intentResultFromEvent(true, { type: 'follow-intent-result', req: 'r2', result: 'pair-first' })).toEqual({
      req: 'r2',
      result: 'pair-first',
    });
  });
  it('from anyone but the frame\'s own parent → null (the reply arrives targetOrigin "*", so the sender is the check)', () => {
    expect(intentResultFromEvent(false, { type: 'follow-intent-result', req: 'r1', result: 'recorded' })).toBeNull();
  });
  it('wrong type / non-object / missing nonce → null', () => {
    expect(intentResultFromEvent(true, { type: 'follow-states', req: 'r1' })).toBeNull();
    expect(intentResultFromEvent(true, null)).toBeNull();
    expect(intentResultFromEvent(true, { type: 'follow-intent-result', result: 'recorded' })).toBeNull();
    expect(intentResultFromEvent(true, { type: 'follow-intent-result', req: '', result: 'recorded' })).toBeNull();
  });
  it('an unknown result word is an error face, never a receipt', () => {
    expect(intentResultFromEvent(true, { type: 'follow-intent-result', req: 'r1', result: 'ok!' })).toEqual({
      req: 'r1',
      result: 'error',
    });
    expect(intentResultFromEvent(true, { type: 'follow-intent-result', req: 'r1' })).toEqual({
      req: 'r1',
      result: 'error',
    });
  });
});

describe('loginCodeFromEvent — click-time login contract (owner ruling 2026-09-01)', () => {
  it('same origin + token → the token string', () => {
    expect(loginCodeFromEvent('https://c', 'https://c', { type: 'login-code', code: '811121' })).toBe('811121');
  });
  it('same origin + code:null → logged in (no click-time prompt)', () => {
    expect(loginCodeFromEvent('https://c', 'https://c', { type: 'login-code', code: null })).toBe(null);
  });
  it('cross-origin → not this contract, whoever sends it', () => {
    expect(loginCodeFromEvent('https://evil', 'https://c', { type: 'login-code', code: '811121' })).toBeUndefined();
  });
  it('wrong type / non-object / malformed code → not this contract', () => {
    expect(loginCodeFromEvent('https://c', 'https://c', { type: 'follow-states' })).toBeUndefined();
    expect(loginCodeFromEvent('https://c', 'https://c', null)).toBeUndefined();
    expect(loginCodeFromEvent('https://c', 'https://c', { type: 'login-code', code: 42 })).toBeUndefined();
  });
});

describe('readerContextFromEvent — dual-links reader contract (owner ruling 2026-09-03)', () => {
  it('same origin + owner:true → true (the owner-code chrome said so)', () => {
    expect(readerContextFromEvent('https://c', 'https://c', { type: 'reader-context', owner: true })).toBe(true);
  });
  it('same origin + owner:false → false (guest chrome)', () => {
    expect(readerContextFromEvent('https://c', 'https://c', { type: 'reader-context', owner: false })).toBe(false);
  });
  it('cross-origin → not this contract, whoever sends it', () => {
    expect(readerContextFromEvent('https://evil', 'https://c', { type: 'reader-context', owner: true })).toBeUndefined();
  });
  it('wrong type / non-object / non-boolean owner → not this contract', () => {
    expect(readerContextFromEvent('https://c', 'https://c', { type: 'follow-states' })).toBeUndefined();
    expect(readerContextFromEvent('https://c', 'https://c', null)).toBeUndefined();
    expect(readerContextFromEvent('https://c', 'https://c', { type: 'reader-context' })).toBeUndefined();
    expect(readerContextFromEvent('https://c', 'https://c', { type: 'reader-context', owner: 'yes' })).toBeUndefined();
  });
});

describe('doorbellScript', () => {
  const script = doorbellScript({
    ...T,
    stripOwner: 'STRIP-OWNER',
    stripGuest: 'STRIP-GUEST',
    loginPrompt: 'LOGIN?TOKEN {code}',
    pairHint: 'PAIR-HINT',
  });

  it('is a complete inline script element', () => {
    expect(script.startsWith('<script>')).toBe(true);
    expect(script.endsWith('</script>')).toBe(true);
  });

  it('relays the click to the chrome instead of POSTing from the sandboxed frame (canvas contract 2026-09-13)', () => {
    // No allow-same-origin → no cookies on a fetch from here → the reader pass
    // would never be seen and every tap would come back pair-first. The chrome
    // rings as this reader and answers by nonce.
    expect(script).toContain("type: 'follow-intent-request'");
    expect(script).toContain("'follow-intent-result'");
    expect(script).toContain('inFlight[req] = btn;');
    expect(script).toContain('if (window.parent === window) { ringDirect(btn, followee, label); return; }');
    expect(script).toContain('source !== window.parent'); // the answer is checked by sender, not origin
  });

  it('an unanswered relay fails honestly instead of leaving the button latched', () => {
    expect(script).toContain("applyResult(btn, 'error')");
    expect(script).toContain('10000');
  });

  it('keeps the direct POST as the un-framed fallback: text/plain JSON, canvas_id read off its own URL', () => {
    // 2026-09-02 short links: the canvas ref is the segment before 'raw',
    // which resolves both /<short>/raw and the legacy /<slug>/<id>/raw —
    // the whole derivation pinned, fallback branch included.
    expect(script).toContain(
      "var canvasRef = parts[parts.length - 1] === 'raw' ? parts[parts.length - 2] : parts[1];",
    );
    expect(script).toContain("fetch(SELF + '/v1/follow-intent'");
    expect(script).toContain("'Content-Type': 'text/plain'");
    expect(script).toContain('canvas_id');
    expect(script).toContain('followee_popclaw_id');
    expect(script).toContain('followee_label');
  });

  it('derives the expected origin from the URL — never location.origin, which is "null" in the sandbox (ruling H1)', () => {
    expect(script).toContain('new URL(location.href).origin');
    expect(script).not.toContain('location.origin');
  });

  it('asks for the follow-states itself on init (ruling H2: the push can beat the listener)', () => {
    expect(script).toContain('follow-states-request');
    expect(script).toContain('window.parent.postMessage');
  });

  it('validates incoming follow-states by origin and type before flipping to followed', () => {
    expect(script).toContain("'follow-states'");
    expect(script).toContain('followed');
    expect(script).toContain('.follow-btn');
  });

  it('a click on the chip never navigates — preventDefault backstop inside the handler', () => {
    // The chip has lived inside a link once (the card head's .who anchor);
    // this is the behavioural half of the fix that keeps any such regression
    // from opening a tab alongside the ring.
    expect(script).toContain('e.preventDefault()');
  });

  it('carries every copy string so the flip and the strip need no lexicon at runtime', () => {
    for (const s of [
      'SENT', 'EXISTS', 'FAIL', 'FOLLOWED', 'PAIR-FIRST', 'PAIR-HINT', 'STRIP-OWNER', 'STRIP-GUEST',
      'LOGIN?TOKEN {code}',
    ]) {
      expect(script).toContain(s);
    }
  });

  it('asks for the login code on init and answers the click-time strip with it (ruling 2026-09-01)', () => {
    // The prompt meets the reader at the moment of need: the strip swaps its
    // second line for the login line (live token substituted) exactly when
    // chrome has said this browser is NOT logged in.
    expect(script).toContain("{ type: 'login-code-request' }");
    expect(script).toContain("'login-code'");
    expect(script).toContain("T.loginPrompt.replace('{code}', loginCode)");
    expect(script).toContain('typeof loginCode === \'string\'');
  });

  it('asks for the reader context on init and renders a ONE-LINE strip when the chrome says owner (dual links, 2026-09-03)', () => {
    // Owner mode: the second line ("not your paper? → popclaw.me") would ask
    // the paper's owner a lie. The keeper's notifier push carries the
    // confirmation either way, so the owner loses no information.
    expect(script).toContain("{ type: 'reader-context-request' }");
    expect(script).toContain("'reader-context'");
    expect(script).toContain('if (!ownerMode) strip.appendChild(b);'); // strip collapses to its first line
    expect(script).toContain('var ownerMode = false;'); // default: reader (guest) semantics
  });

  it('pair-first: wears the instruction face, releases the button, and asks the chrome for its pairing prompt (owner ruling 2026-09-13)', () => {
    // An unpaired browser gets NOTHING recorded — the canvas says so in the
    // same 200 the recorded/duplicate answers come in. The script must not
    // treat that as a receipt: the face is the instruction, the busy latch is
    // released so the click after pairing works, and the chrome is asked to
    // show the prompt that carries the code.
    expect(script).toContain("'pair-first'");
    expect(script).toContain("'recorded'"); // the reader-credit contract's spelling of `created`
    expect(script).toContain('T.pairFirst');
    expect(script).toContain("if (result === 'pair-first') window.parent.postMessage({ type: 'pair-request' }, SELF);");
    expect(script).toContain("if (!settled) btn.removeAttribute('data-busy');");
  });

  it('never records optimistically: the click handler itself paints no face', () => {
    // Every face change goes through applyResult, which only ever runs on an
    // answer (the chrome's, the fallback fetch's, or the unanswered-relay
    // timeout). The click path sets nothing but the busy latch.
    const click = script.slice(script.indexOf("document.addEventListener('click'"));
    expect(click).not.toContain('setBtn(');
    expect(click).not.toContain('applyResult(btn, T.');
  });

  it('bakes no id-shaped blob — the page never learns anyone’s popclaw id but the button targets', () => {
    expect(script).not.toMatch(/[1-9A-HJ-NP-Za-km-z]{40,}/);
  });

  it('escapes copy that would close the script element', () => {
    const raw = doorbellScript({
      ...T,
      stripOwner: 'S', stripGuest: 'G', loginPrompt: 'L {code}', pairHint: 'H',
      fail: '</script><b>x',
    });
    expect(raw).not.toContain('</script><b>x');
    expect(raw).toContain('\\u003c');
  });
});
