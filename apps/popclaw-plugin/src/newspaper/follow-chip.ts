/**
 * The doorbell chip (spec §5.4 / §6.1): a stateless follow button beside every
 * author the owner could follow, plus the small inline script that gives it a
 * click life inside the canvas chrome.
 *
 * Pure functions only, no node:*, no CJK — every visible string arrives in the
 * `ChipStrings` bag, filled from the lexicon by the renderer. The plugin has no
 * DOM test rig, so the script is built as a string here and tested by
 * assertion; every behaviour that could be a pure function is one
 * (`chipStateFor`, `followStatesFromEvent`, `loginCodeFromEvent`,
 * `readerContextFromEvent`) so the script itself stays a thin shell around
 * them.
 *
 * Ruling H (controller, 2026-08-31) is baked into the script's shape:
 *   H1 the paper is served in a sandboxed iframe WITHOUT allow-same-origin, so
 *      `location.origin` there is the string "null" — the real origin is
 *      derived from the URL (`new URL(location.href).origin`) and used for the
 *      message check, the fetch base and the postMessage target alike;
 *   H2 the chrome push can fire before this script's listener exists, so on
 *      init the iframe asks for the states itself
 *      (`{type:'follow-states-request'}`); the chrome side (canvas render.ts)
 *      answers from its cached /v1/my-follows result.
 *
 * Reader credit (owner ruling 2026-09-13): a ➕ belongs to the READER who
 * taps it, named by the reader pass their browser holds. The pass is a cookie
 * on the canvas origin and this document is framed WITHOUT allow-same-origin,
 * so the tap cannot be POSTed from here — it is relayed to the chrome
 * (`follow-intent-request` → `follow-intent-result`), which rings as this
 * reader. An unpaired browser gets `pair-first`: nothing recorded, an
 * instruction on the button, and the chrome raises its pairing line.
 *
 * Dual links (owner ruling 2026-09-03): the chrome also vouches WHO is
 * reading (`{type:'reader-context', owner:boolean}`, pulled on init the same
 * H2 way). In owner mode the click strip drops its second line — the
 * "not your paper?" door is a guest question; the owner's confirmation
 * arrives through the keeper's notifier push either way.
 */

/** The faces a chip can wear. All of it is lexicon copy, nothing is baked. */
export interface ChipStrings {
  /** The initial face: nobody has rung yet. */
  cta: string;
  /** The intake answered `created`/`recorded` — on the reader's list, awaiting their confirmation. */
  sent: string;
  /** The intake answered `exists`/`duplicate` — already on the to-follow list. */
  exists: string;
  /** The ring failed (or the chrome answered `error`) — stays clickable, this face invites the retry. */
  fail: string;
  /** The reader pass says this browser's account already follows them. */
  followed: string;
  /**
   * The canvas answered `pair-first`: this browser holds no reader pass, so
   * NOTHING was recorded (owner ruling 2026-09-13). The face is an
   * instruction, not a receipt — pair, then click again.
   */
  pairFirst: string;
}

/** Escape for HTML text and attributes — same rules as the page's own `esc`. */
const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** `name#sigil` — the label the pending-follow rows will print, sigil only when there is one. */
const labelOf = (author: string, sigil?: string): string => (sigil ? `${author}#${sigil}` : author);

/**
 * The one button the doorbell script targets:
 *   <button class="follow-btn" data-followee="<id>" data-label="<author>[#sigil]">cta</button>
 *
 * Stateless by contract (spec §5.4): which face it wears at any moment is
 * decided at view time — by the fetch result or the reader pass — never baked
 * into the page. The id and label are escaped because both are remote
 * material at heart (a feed author name, a lore-house field).
 */
export function chipHtml(
  p: { authorPopclawId: string; author: string; sigil?: string },
  T: ChipStrings,
): string {
  return (
    `<button class="follow-btn" data-followee="${esc(p.authorPopclawId)}"` +
    ` data-label="${esc(labelOf(p.author, p.sigil))}">${esc(T.cta)}</button>`
  );
}

/**
 * Which face a POST result flips the button to. `created` and `exists` both
 * settle the button (the intent is credited to this reader either way — spec
 * §5.4 forbids optimistic updates, so this only ever runs after a response);
 * `fail` and `pair-first` keep it clickable — the first for the retry, the
 * second for the click that follows the pairing.
 */
export function chipStateFor(
  result: 'created' | 'recorded' | 'exists' | 'duplicate' | 'fail' | 'pair-first',
  T: ChipStrings,
): { text: string; disabled: boolean } {
  // Two spellings per settled answer: the intake's original `created`/`exists`
  // and the reader-credit contract's `recorded`/`duplicate` (owner ruling
  // 2026-09-13). Papers already in the wild carry the old script, and a page
  // outlives a deploy either way — both lanes stay understood.
  if (result === 'created' || result === 'recorded') return { text: T.sent, disabled: true };
  if (result === 'exists' || result === 'duplicate') return { text: T.exists, disabled: true };
  // Nothing was recorded for an unpaired browser, so the button must stay
  // clickable: the pairing is the missing step, not the click.
  if (result === 'pair-first') return { text: T.pairFirst, disabled: false };
  return { text: T.fail, disabled: false };
}

/**
 * The reader-pass message contract as a pure function: the chrome parent's
 * `{type:'follow-states', followed:[...]}` is trusted only when it arrived
 * from the canvas origin (the one derived from this document's own URL — see
 * H1) and is shaped exactly as the contract says. Everything else is null.
 *
 * The inline script below carries a byte-mirrored copy of this logic (it
 * cannot import this module); the tests hold both to the same contract.
 */
export function followStatesFromEvent(origin: string, selfOrigin: string, data: unknown): string[] | null {
  if (origin !== selfOrigin) return null;
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return null;
  const d = data as { type?: unknown; followed?: unknown };
  if (d.type !== 'follow-states') return null;
  if (!Array.isArray(d.followed) || !d.followed.every((x) => typeof x === 'string')) return null;
  return d.followed;
}

/** What the chrome can answer a relayed click with. */
export type IntentResult = 'created' | 'recorded' | 'exists' | 'duplicate' | 'pair-first' | 'error';

/**
 * The relayed-click answer as a pure function (canvas contract 2026-09-13).
 *
 * The raw paper is framed WITHOUT `allow-same-origin`, so a fetch from this
 * document carries no cookies — the reader pass would never be seen and every
 * tap would come back `pair-first`. The click is therefore relayed to the
 * chrome (`follow-intent-request`), which does the credited POST and answers
 * `{type:'follow-intent-result', req, followee_popclaw_id, result, status}`.
 *
 * That answer comes back with targetOrigin '*', so the check that matters is
 * WHO sent it: only the frame's own parent. (The other contracts keep their
 * origin check — they are pushes, not replies.) A forged answer could at most
 * paint a wrong face on a button; nothing here writes anything.
 *
 * Returns the request nonce and result, or null when this is not that message.
 */
export function intentResultFromEvent(
  fromParent: boolean,
  data: unknown,
): { req: string; result: IntentResult } | null {
  if (!fromParent) return null;
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return null;
  const d = data as { type?: unknown; req?: unknown; result?: unknown };
  if (d.type !== 'follow-intent-result') return null;
  if (typeof d.req !== 'string' || !d.req) return null;
  // An unknown result string is an error face, never a receipt.
  const known: readonly string[] = ['created', 'recorded', 'exists', 'duplicate', 'pair-first', 'error'];
  const result = typeof d.result === 'string' && known.includes(d.result) ? (d.result as IntentResult) : 'error';
  return { req: d.req, result };
}

/**
 * The login-code contract as a pure function (owner ruling 2026-09-01:
 * pairing speaks the user's word for it — login + token — and the prompt
 * surfaces at the moment of need, i.e. on the click). The chrome parent's
 * `{type:'login-code', code}` is trusted only from the canvas origin.
 * Returns:
 *   undefined — not this contract (some other message)
 *   null      — this browser is logged in (paired); no click-time prompt
 *   string    — the current one-time token; the unpaired strip shows it
 */
export function loginCodeFromEvent(
  origin: string,
  selfOrigin: string,
  data: unknown,
): string | null | undefined {
  if (origin !== selfOrigin) return undefined;
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return undefined;
  const d = data as { type?: unknown; code?: unknown };
  if (d.type !== 'login-code') return undefined;
  if (d.code === null) return null;
  return typeof d.code === 'string' ? d.code : undefined;
}

/**
 * The reader-context contract as a pure function (dual links, owner ruling
 * 2026-09-03): the chrome parent's `{type:'reader-context', owner:boolean}`
 * says whether this page was reached through the OWNER link (chat-delivered,
 * carries the owner's state) or a guest one. Trusted only from the canvas
 * origin, same shape discipline as loginCodeFromEvent.
 * Returns:
 *   undefined — not this contract (some other message)
 *   true      — owner mode: the reader IS the paper's owner
 *   false     — guest mode (also the script's default before any answer)
 */
export function readerContextFromEvent(
  origin: string,
  selfOrigin: string,
  data: unknown,
): boolean | undefined {
  if (origin !== selfOrigin) return undefined;
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return undefined;
  const d = data as { type?: unknown; owner?: unknown };
  if (d.type !== 'reader-context') return undefined;
  return typeof d.owner === 'boolean' ? d.owner : undefined;
}

/**
 * The inline script, as one `<script>` element. Everything it needs — copy,
 * endpoint path, canvas id — is either embedded or read off its own URL at
 * view time; it bakes no identity of anyone (spec §5.1, page-side half).
 *
 * The copy is serialized with `<` escaped so no lexicon string can close the
 * script element early.
 */
export function doorbellScript(
  T: ChipStrings & { stripOwner: string; stripGuest: string; loginPrompt: string; pairHint: string },
): string {
  const copy = JSON.stringify({
    sent: T.sent,
    exists: T.exists,
    fail: T.fail,
    followed: T.followed,
    pairFirst: T.pairFirst,
    stripOwner: T.stripOwner,
    stripGuest: T.stripGuest,
    loginPrompt: T.loginPrompt,
    pairHint: T.pairHint,
  }).replace(/</g, '\\u003c');
  return `<script>
(function () {
  var T = ${copy};
  // H1: sandboxed iframe — this document's origin property is the string
  // "null", so the origin is derived from the URL instead. One derivation,
  // three uses: the message check, the fetch base and the postMessage target.
  var SELF = new URL(location.href).origin;
  // LOCAL_FILE: the same page saved to disk. A file:// document has no origin —
  // the URL's origin is the string "null" — and postMessage would throw on that
  // target before anything else ran, taking the whole script with it. There is no
  // chrome to talk to and no canvas to ring, so the chips are hidden and the
  // script stops here: nothing thrown, nothing fetched, nothing offered that
  // cannot work (owner ruling 2026-09-12, the zero-dependency page).
  var LOCAL_FILE = SELF === 'null' || (location.protocol !== 'http:' && location.protocol !== 'https:');
  if (LOCAL_FILE) {
    var dead = document.querySelectorAll('.follow-btn');
    for (var d = 0; d < dead.length; d++) dead[d].hidden = true;
    return;
  }
  // The iframe's own url is /<short>/raw (2026-09-02 short links) or, for
  // papers published before them, /<slug>/<id>/raw — either way the canvas
  // reference is the path segment right before 'raw'. Intake resolves both
  // shapes (spec §5.1: the page never carries its owner's identity).
  var parts = location.pathname.split('/').filter(Boolean);
  var canvasRef = parts[parts.length - 1] === 'raw' ? parts[parts.length - 2] : parts[1];
  function stateFor(result) {
    // Both spellings of each settled answer (see chipStateFor): created/recorded
    // and exists/duplicate.
    if (result === 'created' || result === 'recorded') return { text: T.sent, disabled: true };
    if (result === 'exists' || result === 'duplicate') return { text: T.exists, disabled: true };
    // pair-first: the canvas recorded nothing because this browser holds no
    // reader pass. Instruction face, still clickable (owner ruling 2026-09-13).
    if (result === 'pair-first') return { text: T.pairFirst, disabled: false };
    return { text: T.fail, disabled: false };
  }
  function setBtn(btn, s) { btn.textContent = s.text; btn.disabled = s.disabled; }
  // Byte-mirror of followStatesFromEvent (an inline script cannot import it):
  // origin must be ours, type must be 'follow-states', followed must be string[].
  function statesFrom(origin, data) {
    if (origin !== SELF) return null;
    if (!data || typeof data !== 'object') return null;
    if (data.type !== 'follow-states') return null;
    var f = data.followed;
    if (!Array.isArray(f)) return null;
    for (var i = 0; i < f.length; i++) if (typeof f[i] !== 'string') return null;
    return f;
  }
  // Byte-mirror of loginCodeFromEvent: undefined = other message, null =
  // logged in, string = one-time token. JSON postMessage never carries an
  // undefined value, so a string|null payload under the right type is the
  // whole contract.
  function codeFrom(origin, data) {
    if (origin !== SELF) return undefined;
    if (!data || typeof data !== 'object') return undefined;
    if (data.type !== 'login-code') return undefined;
    if (data.code === null) return null;
    return typeof data.code === 'string' ? data.code : undefined;
  }
  // Byte-mirror of intentResultFromEvent: the chrome's answer to a relayed
  // click. Checked by SENDER (it replies with targetOrigin '*'), not origin.
  function resultFrom(source, data) {
    if (source !== window.parent) return null;
    if (!data || typeof data !== 'object') return null;
    if (data.type !== 'follow-intent-result') return null;
    if (typeof data.req !== 'string' || !data.req) return null;
    var known = ['created', 'recorded', 'exists', 'duplicate', 'pair-first', 'error'];
    var r = (typeof data.result === 'string' && known.indexOf(data.result) !== -1) ? data.result : 'error';
    return { req: data.req, result: r };
  }
  // Byte-mirror of readerContextFromEvent: undefined = other message, else the
  // boolean the chrome vouched for.
  function ctxFrom(origin, data) {
    if (origin !== SELF) return undefined;
    if (!data || typeof data !== 'object') return undefined;
    if (data.type !== 'reader-context') return undefined;
    return typeof data.owner === 'boolean' ? data.owner : undefined;
  }
  // Click-time login state: unknown (undefined) until chrome answers.
  var loginCode = undefined;
  // Dual links (2026-09-03): false until the chrome's reader-context says
  // otherwise — the default must be the reader (guest) semantics.
  var ownerMode = false;
  var strip = null;
  function showStrip(pairFirst) {
    if (strip) return;
    strip = document.createElement('div');
    strip.className = 'follow-strip';
    var a = document.createElement('div');
    // Line one is a receipt — except after a pair-first answer, where nothing
    // was recorded and "delivered to the keeper" would be a lie. There the
    // hint explaining the pairing takes its place (owner ruling 2026-09-13).
    a.textContent = pairFirst ? T.pairHint : T.stripOwner;
    var b = document.createElement('div');
    // Owner ruling 2026-09-01: the prompt meets the reader at the moment of
    // need. Logged-out browser → the login line with the live token;
    // logged-in (or unknown) → the share door, as before.
    b.textContent = (typeof loginCode === 'string')
      ? T.loginPrompt.replace('{code}', loginCode)
      : T.stripGuest;
    strip.appendChild(a);
    // Owner mode (dual links, 2026-09-03): line two asks "not your paper?" of
    // the paper's owner — a lie. The keeper's notifier push carries the
    // confirmation either way, so the owner loses no information.
    if (!ownerMode) strip.appendChild(b);
    document.body.appendChild(strip);
    setTimeout(function () {
      if (strip && strip.parentNode) strip.parentNode.removeChild(strip);
      strip = null;
    }, 6000);
  }
  // The reader pass: chrome relays who THIS browser already follows. Buttons it
  // hits wear the followed face and go quiet; everyone else keeps their cta.
  // The same listener also carries the login-code answer (click-time prompt)
  // and the reader-context answer (owner vs guest link).
  window.addEventListener('message', function (e) {
    var f = statesFrom(e.origin, e.data);
    if (f) {
      var btns = document.querySelectorAll('.follow-btn');
      for (var i = 0; i < btns.length; i++) {
        if (f.indexOf(btns[i].getAttribute('data-followee')) !== -1) {
          setBtn(btns[i], { text: T.followed, disabled: true });
        }
      }
    }
    var c = codeFrom(e.origin, e.data);
    if (c !== undefined) loginCode = c;
    var oc = ctxFrom(e.origin, e.data);
    if (oc !== undefined) ownerMode = oc;
    var res = resultFrom(e.source, e.data);
    if (res && inFlight[res.req]) {
      var waiting = inFlight[res.req];
      delete inFlight[res.req];
      applyResult(waiting, res.result);
    }
  });
  // H2: the chrome push may have fired before the listener above existed.
  // Ask for the states; chrome answers from its cached result. Ask for the
  // login code at the same time so a first click already knows the answer,
  // and for the reader context so the strip knows its audience.
  window.parent.postMessage({ type: 'follow-states-request' }, SELF);
  window.parent.postMessage({ type: 'login-code-request' }, SELF);
  window.parent.postMessage({ type: 'reader-context-request' }, SELF);
  // One place decides what an answer does to a button. Settled answers
  // (created/recorded, exists/duplicate) keep the latch: the intent is on the
  // reader's list either way. pair-first and error release it — nothing was
  // recorded, and the next tap is the whole point.
  function applyResult(btn, result) {
    var settled = result === 'created' || result === 'recorded'
      || result === 'exists' || result === 'duplicate';
    setBtn(btn, stateFor(result));
    if (!settled) btn.removeAttribute('data-busy');
    // The chrome owns the pairing line (it holds the code); this only asks.
    if (result === 'pair-first') window.parent.postMessage({ type: 'pair-request' }, SELF);
    if (settled || result === 'pair-first') showStrip(result === 'pair-first');
  }
  // Relay bookkeeping: nonce -> the button waiting on that answer.
  var inFlight = {};
  var reqSeq = 0;
  // Fallback only (see the click handler): a direct POST, which can only carry
  // the reader pass when this document is NOT the sandboxed frame.
  function ringDirect(btn, followee, label) {
    fetch(SELF + '/v1/follow-intent', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({
        canvas_id: canvasRef,
        followee_popclaw_id: followee,
        followee_label: label
      })
    }).then(function (r) {
      if (!r.ok) throw 0;
      return r.json();
    }).then(function (d) {
      applyResult(btn, (d && d.result) || 'error');
    }).catch(function () {
      applyResult(btn, 'error');
    });
  }
  // The ring itself. Never optimistic (spec §5.4): the face changes only on an
  // answer. data-busy only blocks re-entrant clicks on a button already in
  // flight — it is not a state anyone can see.
  document.addEventListener('click', function (e) {
    var btn = e.target && e.target.closest ? e.target.closest('.follow-btn') : null;
    if (!btn) return;
    // Backstop: a click on the chip must never do anything but ring — not even
    // navigate, should a chip ever end up nested in a link again (the card
    // head's anchor once carried it; the layout keeps it out, this keeps the
    // click honest regardless).
    e.preventDefault();
    if (btn.disabled || btn.getAttribute('data-busy')) return;
    btn.setAttribute('data-busy', '1');
    var followee = btn.getAttribute('data-followee');
    var label = btn.getAttribute('data-label');
    // Canvas contract 2026-09-13: the paper is framed WITHOUT
    // allow-same-origin, so a fetch from here carries no cookies — the reader
    // pass would never be seen and every tap would answer pair-first. The
    // click is relayed to the chrome, which POSTs it as this reader. The
    // direct POST survives only for the un-framed case (the page opened on its
    // own); file:// never gets this far (LOCAL_FILE above).
    if (window.parent === window) { ringDirect(btn, followee, label); return; }
    var req = 'r' + (++reqSeq) + '-' + Date.now();
    inFlight[req] = btn;
    window.parent.postMessage({
      type: 'follow-intent-request',
      canvas_id: canvasRef,
      followee_popclaw_id: followee,
      followee_label: label,
      req: req
    }, SELF);
    // A chrome too old to know this message would otherwise leave the button
    // latched and silent — an unanswered relay is a failure, and says so.
    setTimeout(function () {
      if (!inFlight[req]) return;
      delete inFlight[req];
      applyResult(btn, 'error');
    }, 10000);
  });
})();
</script>`;
}
