import { afterEach, describe, expect, it, vi } from 'vitest';
import bs58 from 'bs58';
import { ErrorCode, McpError, type ElicitResult } from '@modelcontextprotocol/sdk/types.js';
import {
  createMcpOwnerAuthorization, displayWidth, ownerConfirmationSchema,
  type DuplicateActionQuery, type McpServerBox, type OwnerConfirmation, type OwnerGrant,
} from '../../../src/host/mcp-owner-authorization.js';
import { ownerConfirmedWorldInvoke, worldDuplicateLookup } from '../../../src/runtime/world-runtime.js';
import { WORLD_PROTOCOL_LIMITS, type WorldCommandContext } from '../../../src/commands/popclaw-world.js';
import type { WorldInvokeInput } from '../../../src/world/action-client.js';
import { setOwnerLang } from '../../../src/lexicon/owner-language.js';
import { renderCopy } from '../../../src/lexicon/index.js';
import { OWNER_APPROVAL_WINDOW_MS } from '../../../src/host/owner-approval.js';

const actorId = bs58.encode(new Uint8Array(32).fill(91));
const house = 'http://127.0.0.1:48180';
const input = { house, kind: 'rangermap.check_in', params: { spot: 'north gate' }, expected_capability_revision: 'b'.repeat(64) };
const start = Date.parse('2026-09-19T10:00:00Z') / 1000;
/** The message's first line for `input`, spelled out rather than rebuilt. */
const summary = `rangermap.check_in at 127.0.0.1:48180 as ${actorId.slice(0, 6)}… cap bbbbbb…`;
/** An earlier request with the same canonical input, still unresolved. */
const twin = '7f3a91c0'.repeat(8);
/** The lines the owner reads before the facts when an identical earlier request
 *  is unresolved, and when nobody could find out. Spelled out, not rebuilt. */
const TWIN_LINES = [
  'DUPLICATE: an earlier request with the same input is unresolved.',
  `Original request: ${twin}`,
  'Confirming creates a SECOND action that may duplicate it.',
];
const UNKNOWN_LINES = [
  'DUPLICATE CHECK FAILED: PopClaw could not check whether an earlier',
  'request with the same input is still unresolved.',
  'Whether this duplicates an earlier action is UNKNOWN.',
];
/** The whole message for `input` with these parameter lines, spelled out. */
function expectedMessage(parameterLines: readonly string[], reference: string, lead: readonly string[] = []): string[] {
  return [
    ...lead,
    summary,
    'PopClaw: confirm world action',
    `House: ${house}`,
    `Identity: ${actorId}`,
    'Action: rangermap.check_in',
    `Capability revision: ${'b'.repeat(64)}`,
    parameterLines.length > 0 ? 'Parameters:' : 'Parameters: (none)',
    ...parameterLines,
    `Reference: ${reference}`,
    `Answer within ${OWNER_APPROVAL_WINDOW_MS / 1000} s.`,
  ];
}
/** The one real input, exactly. `default: false`: the box starts unticked, never pre-ticked. */
const theOneField = (reference: string) => ({
  type: 'object',
  properties: { confirm: { type: 'boolean', default: false, title: 'Approve this action',
    description: `Runs the world action described above, once (ref ${reference}). Decline or cancel and nothing happens.` } },
  required: ['confirm'],
});
/** The reference the dialog shows, read back off the job id it is cut from. */
const referenceOf = (grant: OwnerGrant) => /^mcp-owner:([0-9a-f]{16})$/.exec(grant.jobId)![1]!.slice(0, 6);
/** What a `refuseToAsk` fake throws if a dialog is built that should not be. */
const ASKED_ANYWAY = 'ASKED_ANYWAY: a dialog was built that should have been refused';

interface Ask { message: string; requestedSchema: unknown; timeout: unknown; signal: AbortSignal | undefined }

afterEach(() => { setOwnerLang(undefined); });

/** A fake client: `form` capability on by default, one queued answer per ask.
 *  `client` is the name the connected host reports; the dialog no longer
 *  depends on it, which is what the cases below check. It honours
 *  `options.signal` the way the SDK's own `request` does — an abort rejects the
 *  pending elicitation rather than leaving the dialog hanging. `duplicates` is
 *  the injected lookup; the default answers "no twin". */
function setup(options: {
  form?: boolean; client?: string;
  duplicates?: () => readonly string[] | Promise<readonly string[]>;
  duplicateTimeoutMs?: number;
  /** For a case that asserts the dialog is NEVER built: the fake refuses to ask
   *  with a sentinel, so a guard that stops guarding fails with that sentinel
   *  instead of leaving the test waiting on an answer nobody will give. */
  refuseToAsk?: boolean;
} = {}) {
  let now = start;
  let form = options.form ?? true;
  const asks: Ask[] = [];
  const queries: DuplicateActionQuery[] = [];
  let answer: (result: ElicitResult) => void = () => {};
  let reject: (error: unknown) => void = () => {};
  const elicitInput = vi.fn(async (params: { message: string; requestedSchema: unknown }, opts?: { timeout?: number; signal?: AbortSignal }) => {
    asks.push({ message: params.message, requestedSchema: params.requestedSchema, timeout: opts?.timeout, signal: opts?.signal });
    if (options.refuseToAsk) throw new Error(ASKED_ANYWAY);
    return new Promise<ElicitResult>((resolve, rejecter) => {
      answer = resolve; reject = rejecter;
      opts?.signal?.addEventListener('abort', () => rejecter(new Error('request aborted')), { once: true });
    });
  });
  const server = {
    elicitInput,
    getClientCapabilities: () => (form ? { elicitation: { form: {} } } : {}),
    getClientVersion: () => ({ name: options.client ?? 'some-unrecognised-ide', version: '3.1' }),
  };
  const box = { current: server } as unknown as McpServerBox;
  const adapter = createMcpOwnerAuthorization({ actorId, server: box, now: () => now,
    ...(options.duplicateTimeoutMs !== undefined ? { duplicateTimeoutMs: options.duplicateTimeoutMs } : {}),
    duplicates: { unresolved: query => { queries.push(query); return options.duplicates?.() ?? []; } } });
  return {
    adapter, asks, elicitInput, queries,
    accept: (confirm = true) => answer({ action: 'accept', content: { confirm } }),
    acceptWith: (content: ElicitResult['content']) => answer({ action: 'accept', content }),
    respond: (action: 'decline' | 'cancel') => answer({ action }),
    breakElicit: (error: unknown) => reject(error),
    setForm: (value: boolean) => { form = value; },
    setNow: (value: number) => { now = value; },
    unbind: () => { (box as { current?: unknown }).current = undefined; },
  };
}
/** Waits until the fake has been asked, so the test never races the await. */
const asked = async (s: ReturnType<typeof setup>) => vi.waitFor(() => expect(s.asks).toHaveLength(1));
/** The dialog one accepted confirmation put in front of the owner, for these
 *  parameters, with the reference it showed. */
async function dialogFor(params: Record<string, unknown>, options: Parameters<typeof setup>[0] = {}):
  Promise<{ lines: string[]; schema: unknown; reference: string }> {
  const s = setup(options);
  const call = { ...input, params };
  let reference = '';
  const running = s.adapter.withInvocation('mcp_wrap', call, undefined, async ask => { reference = ask.reference; return ask.authorize(call); });
  await asked(s);
  s.accept();
  await running;
  return { lines: s.asks[0]!.message.split('\n'), schema: s.asks[0]!.requestedSchema, reference };
}
/** The refusal for these parameters. The fake refuses to ask at all, so a guard
 *  that stops guarding fails with ASKED_ANYWAY rather than leaving the test
 *  waiting on an answer nobody will give. */
function refusalFor(params: Record<string, unknown>, options: Parameters<typeof setup>[0] = {}): Promise<unknown> {
  const s = setup({ ...options, refuseToAsk: true });
  const call = { ...input, params };
  return s.adapter.withInvocation('mcp_wrap', call, undefined, async ask => ask.authorize(call));
}

/** The parameters as the owner reads them back: a `> ` line starts one, and
 *  each `>   ` continuation line after it carries on the same one. */
function parametersOf(lines: readonly string[]): string[] {
  const out: string[] = [];
  for (const line of lines.slice(lines.indexOf('Parameters:') + 1, lines.findIndex(l => l.startsWith('Reference: ')))) {
    if (line.startsWith('>   ')) out[out.length - 1] += line.slice(4);
    else out.push(line.slice(2));
  }
  return out;
}
/** What a terminal of this many columns paints for one message: each line cut
 *  at the width wherever the columns run out, with NO prefix on the part that
 *  carries over — which is exactly how a soft wrap forged a line before. */
function paint(message: string, columns: number): Array<{ from: string; row: string }> {
  const rows: Array<{ from: string; row: string }> = [];
  for (const from of message.split('\n')) {
    let row = '', width = 0;
    for (const character of from) {
      const w = displayWidth(character);
      if (width + w > columns) { rows.push({ from, row }); row = ''; width = 0; }
      row += character; width += w;
    }
    rows.push({ from, row });
  }
  return rows;
}

describe('MCP owner confirmation adapter', () => {
  it('T-a: an accepted confirm yields one nonce-bound job and a 240 s grant, from a dialog that is one message and one real input', async () => {
    const s = setup();
    let grant!: OwnerGrant;
    const running = s.adapter.withInvocation('mcp_7', input, undefined, async ask => { grant = await ask.authorize(input); return 'done'; });
    await asked(s);
    s.accept();
    expect(await running).toBe('done');
    const reference = referenceOf(grant);
    // Every fact the old field rows carried is in the message, whole: the
    // house, the identity, the action kind, the capability revision, every
    // parameter, the confirmation reference and its deadline.
    expect(s.asks[0]!.message.split('\n')).toEqual(expectedMessage(['> spot: north gate'], reference));
    expect(s.asks[0]!.message.split('\n').some(line => line.startsWith('Session:'))).toBe(false);
    // And the form is exactly one input, the confirmation — no text box the
    // owner could type into and have ignored, and a box that starts unticked:
    // `default: false`, never `true`.
    expect(s.asks[0]!.requestedSchema).toEqual(theOneField(reference));
    const confirm = (s.asks[0]!.requestedSchema as { properties: Record<string, Record<string, unknown>> }).properties['confirm']!;
    expect(confirm['default']).toBe(false);
    expect(JSON.stringify(s.asks[0]!.requestedSchema)).not.toMatch(/"default":\s*true/);
    expect(Object.keys((s.asks[0]!.requestedSchema as { properties: object }).properties)).toEqual(['confirm']);
    expect(ownerConfirmationSchema(reference)).toEqual(theOneField(reference));
    const nonce = /^mcp-owner:([0-9a-f]{16})$/.exec(grant.jobId)![1]!;
    expect(nonce).toHaveLength(16);
    expect(grant.expiresAt).toBe(start + 240);
    // The one window every owner dialog shares — not a copy of it.
    expect(s.asks[0]!.timeout).toBe(OWNER_APPROVAL_WINDOW_MS);
    expect(OWNER_APPROVAL_WINDOW_MS).toBeGreaterThanOrEqual(360_000);
  });

  it('T-a: every host gets the same dialog — the client name no longer chooses a layout', async () => {
    const two = { spot: 'north gate', note: 'walked the east ridge at dusk' };
    const shown = await Promise.all(['claude-code', 'codex-cli', 'some-editor-we-have-never-heard-of']
      .map(client => dialogFor(two, { client })));
    for (const { lines, schema, reference } of shown) {
      // Canonical sorted key order, each parameter on its own `> ` line.
      expect(lines).toEqual(expectedMessage(['> note: walked the east ridge at dusk', '> spot: north gate'], reference));
      expect(schema).toEqual(theOneField(reference));
    }
    // No parameters at all still says so, rather than leaving a gap.
    const none = await dialogFor({});
    expect(none.lines).toEqual(expectedMessage([], none.reference));
  });

  it('T-a: the confirmation is labelled through the lexicon: "Approve this action" in English, "执行此动作" in Chinese — never "send this draft"', async () => {
    setOwnerLang('zh-CN', 'config');
    const { schema, reference } = await dialogFor({ spot: 'north gate' });
    expect(schema).toEqual({
      type: 'object',
      properties: { confirm: { type: 'boolean', default: false, title: '执行此动作',
        description: `执行上面描述的这一次世界动作（ref ${reference}）。拒绝或取消则什么都不会发生。` } },
      required: ['confirm'],
    });
    setOwnerLang('en', 'config');
    const english = await dialogFor({ spot: 'north gate' });
    expect((english.schema as { properties: { confirm: { title: string } } }).properties.confirm.title).toBe('Approve this action');
    for (const { schema: one } of [english, { schema }]) {
      expect(JSON.stringify(one)).not.toMatch(/draft|草稿/i);
    }
  });

  it('T-a: every parameter is shown whole — a long value, a wide one, many of them, and non-string values in canonical JSON', async () => {
    // Complete and verbatim, hard-wrapped by PopClaw: 400 Chinese characters
    // are 800 columns, and come back character for character.
    const long = '北'.repeat(400);
    const wide = `${'x'.repeat(52)}${'\u2705'.repeat(8)}`;
    const family = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}';
    const params = { a: '1', b: '2', c: '3', d: '4', e: '5', f: '6', long, wide, family,
      n: 42, flag: true, list: [1, 'two'], nested: { z: 1, a: 'x' }, empty: '' };
    const { lines, schema, reference } = await dialogFor(params);
    expect(parametersOf(lines)).toEqual([
      'a: 1', 'b: 2', 'c: 3', 'd: 4', 'e: 5', 'empty: ', 'f: 6', `family: ${family}`,
      'flag: true', 'list: [1,"two"]', `long: ${long}`, 'n: 42', 'nested: {"a":"x","z":1}', `wide: ${wide}`,
    ]);
    // The frame around them is unchanged, and short parameters stay one line.
    expect(lines.slice(0, lines.indexOf('Parameters:') + 1)).toEqual(expectedMessage([], reference).slice(0, 7).map(l => l === 'Parameters: (none)' ? 'Parameters:' : l));
    expect(lines).toContain('> a: 1');
    expect(lines).toContain(`> family: ${family}`);
    // Every parameter row fits the wrap width with its prefix: 4 + 64 columns.
    for (const line of lines.filter(l => l.startsWith('> '))) expect(displayWidth(line), line).toBeLessThanOrEqual(68);
    // Nothing elided: no cut mark the owner did not type.
    expect(lines.filter(line => line.startsWith('> ')).some(line => line.includes('…'))).toBe(false);
    expect(schema).toEqual(theOneField(reference));
    // A key that used to be refused for its width or for looking wrapped is a
    // plain parameter now: there are no field titles left for it to impersonate.
    const keyed = await dialogFor({ ['k'.repeat(70)]: 'ok', 'status (1/2)': 'ok' });
    expect(parametersOf(keyed.lines)).toEqual([`${'k'.repeat(70)}: ok`, 'status (1/2): ok']);
  });

  it('T-a: a terminal soft wrap cannot forge a frame line — the reviewer payload, painted at 76 columns', async () => {
    // A value long enough to wrap in the terminal used to carry on with NO
    // prefix, so padding could land `Reference: 000000` at the start of a
    // painted row, above the real one. Split on '\n' and it is invisible.
    const pad = (text: string) => ' '.repeat(76 - text.length);
    const value = `north gate${pad('> spot: north gate')}Reference: 000000${pad('Reference: 000000')}Parameters: (none)`;
    // Control: painted as one unwrapped `> ` line, the forgery appears — so
    // this painter can see the attack the '\n' tests could not.
    expect(paint(`> spot: ${value}`, 76).map(r => r.row)).toContain(`Reference: 000000${pad('Reference: 000000')}`);
    const s = setup();
    let reference = '';
    const running = s.adapter.withInvocation('mcp_wrap76', { ...input, params: { spot: value } }, undefined,
      async ask => { reference = ask.reference; return ask.authorize({ ...input, params: { spot: value } }); });
    await asked(s);
    s.accept();
    await running;
    const message = s.asks[0]!.message;
    const frame = new Set(expectedMessage(['> spot: north gate'], reference));
    const painted = paint(message, 76);
    // Every painted row that did not come from a frame line starts with `> `.
    for (const { from, row } of painted) {
      if (!frame.has(from)) expect(row.startsWith('> '), JSON.stringify(row)).toBe(true);
    }
    // And the only rows that read as `Reference:` / `Parameters:` are the real ones.
    expect(painted.filter(r => r.row.startsWith('Reference:')).map(r => r.row)).toEqual([`Reference: ${reference}`]);
    expect(painted.filter(r => r.row.startsWith('Parameters:')).map(r => r.row)).toEqual(['Parameters:']);
    // Still complete and verbatim.
    expect(parametersOf(message.split('\n'))).toEqual([`spot: ${value}`]);
  });

  it('T-a: a wrap never splits a grapheme — a ZWJ family at the 64-column edge moves whole to the next row', async () => {
    // `k: ` + 58 x = 61 columns; the family is three wide emoji joined into
    // one glyph, so it cannot fit and must not be cut between its parts.
    const family = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}';
    const value = `${'x'.repeat(58)}${family}tail`;
    const { lines } = await dialogFor({ k: value });
    const rows = lines.filter(l => l.startsWith('> '));
    expect(rows).toEqual([`> k: ${'x'.repeat(58)}`, `>   ${family}tail`]);
    expect(parametersOf(lines)).toEqual([`k: ${value}`]);
    // A surrogate pair at the edge is one step, never halved.
    const pair = await dialogFor({ k: `${'x'.repeat(60)}\u{1D400}\u{1D400}` });
    for (const row of pair.lines) expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(row), row).toBe(false);
  });

  it('T-a: a value cannot fabricate a separate parameter at a wrap boundary — continuations are indented', async () => {
    // Padding puts `amount: 1000` exactly where the wrap falls. Continuation
    // rows start `>   `, so it reads as the rest of `note`, not as `> amount: 1000`.
    const value = `${'x'.repeat(64 - 'note: '.length)}amount: 1000`;
    const { lines } = await dialogFor({ note: value });
    expect(lines).toContain('>   amount: 1000');
    expect(lines).not.toContain('> amount: 1000');
    expect(parametersOf(lines)).toEqual([`note: ${value}`]);
  });

  it('T-a: frame fields cannot carry a labelled line — the invoke schema refuses a house or kind with a space or a capital before any dialog', async () => {
    // House, capability revision and the original request id are the frame
    // lines long enough to wrap. The latter two are hex; a house is a
    // lowercase ASCII origin with no whitespace, so it can never hold `X: `.
    for (const house of ['http://a b.example', 'http://evil.example: Reference', 'http://Reference: 000000', 'http://EXAMPLE.com', 'http://ex\u00e4mple.com']) {
      const s = setup({ refuseToAsk: true });
      const call = { ...input, house };
      await expect(s.adapter.withInvocation('mcp_frame', call, undefined, async ask => ask.authorize(call)), house)
        .rejects.toThrow(/WORLD_COMMAND_INPUT_INVALID|HOUSE_ORIGIN_INVALID/);
      expect(s.elicitInput).not.toHaveBeenCalled();
    }
    // The kind is `[a-z0-9_.]`, at most 64: `Action: ` + 64 = 72 columns, which never wraps at 76.
    for (const kind of ['rangermap.check in', 'rangermap.Reference', 'reference: x.y']) {
      const s = setup({ refuseToAsk: true });
      const call = { ...input, kind };
      await expect(s.adapter.withInvocation('mcp_frame', call, undefined, async ask => ask.authorize(call)), kind)
        .rejects.toThrow('WORLD_COMMAND_INPUT_INVALID');
    }
  });

  it('T-a: the first line is bounded to 72 columns, and a long house is shortened from the START so its real end shows', async () => {
    // The start imitates a trusted name; the registrable domain is at the end.
    // Cut from the right, this would read as a subdomain of popclaw.me.
    const evil = 'http://popclaw.me.check-in-service.official-login.example.evil';
    const shown = setup();
    const evilCall = { ...input, house: evil };
    const shownRun = shown.adapter.withInvocation('mcp_evil', evilCall, undefined, async ask => ask.authorize(evilCall));
    await asked(shown);
    shown.accept();
    await shownRun;
    const lines = shown.asks[0]!.message.split('\n');
    const first = lines[0]!;
    expect(displayWidth(first)).toBeLessThanOrEqual(72);
    expect(first).toMatch(/^rangermap\.check_in at …/);
    expect(first).toContain('example.evil as ');
    expect(first).not.toContain('popclaw.me');
    // The full House line is unchanged below.
    expect(lines).toContain(`House: ${evil}`);
    // The longest kind the schema allows still leaves the end of the host.
    const longest = `${'a'.repeat(24)}.${'b'.repeat(24)}.${'c'.repeat(14)}`;
    const s = setup();
    const call = { ...input, house: evil, kind: longest };
    const running = s.adapter.withInvocation('mcp_evil2', call, undefined, async ask => ask.authorize(call));
    await asked(s);
    s.accept();
    await running;
    const tight = s.asks[0]!.message.split('\n')[0]!;
    expect(displayWidth(tight)).toBeLessThanOrEqual(72);
    expect(tight.endsWith('example.evil')).toBe(true);
    expect(tight).not.toContain('popclaw');
    expect(tight).toMatch(/^a{24}\.b{24}\.c*… at …/);
    // An ordinary host is not touched.
    const plain = await dialogFor(input.params);
    expect(plain.lines[0]).toBe(summary);
  });

  it('T-a: a parameter value cannot forge a line — a line break is refused, with a fake frame line riding on it', async () => {
    // The attack the field form made impossible and a message makes possible:
    // a value that ends its own line and writes the next one — a house the
    // owner is not dealing with, or a reassurance nobody wrote.
    for (const forged of [
      'north gate\nHouse: http://safe.example',
      'ok\nDuplicate check: none — this is the first request',
      'ok\r\nAction: rangermap.say_hello',
      'ok\n> spot: the value you think you are approving',
    ]) {
      await expect(refusalFor({ spot: forged }), JSON.stringify(forged))
        .rejects.toThrow('OWNER_CONFIRMATION_UNREADABLE reason=parameter_not_one_line key=spot limit=1 measured=2 unit=lines');
    }
    // Inside a nested value it is refused too: the check runs over the line
    // as rendered, not only over top-level strings.
    await expect(refusalFor({ spot: { at: 'x\u2028House: http://safe.example' } })).rejects.toThrow('reason=parameter_not_one_line key=spot');
    // And a KEY carrying a break is the same attack from the other side.
    await expect(refusalFor({ 'spot\nHouse: http://safe.example': 'x' }))
      .rejects.toThrow('reason=parameter_not_one_line');
    const s = setup();
    const broken = { ...input, params: { spot: 'north gate\nHouse: http://safe.example' } };
    await expect(s.adapter.withInvocation('mcp_11b', broken, undefined, async ask => ask.authorize(broken)))
      .rejects.toThrow('OWNER_CONFIRMATION_UNREADABLE');
    expect(s.elicitInput).not.toHaveBeenCalled();
  });

  it('T-a: every character a terminal breaks the row on is refused, not only LF and CR', async () => {
    // The JSON profile rejects a RAW byte under 0x20 but accepts its escape, and
    // `params` takes arbitrary values, so each of these is reachable from a tool
    // call. Each would start a line the owner reads as PopClaw's own.
    for (const [name, character] of [['VT', '\u000b'], ['FF', '\u000c'], ['NEL', '\u0085'],
      ['LS', '\u2028'], ['PS', '\u2029'], ['CRLF', '\r\n']] as const) {
      const s = setup();
      const broken = { ...input, params: { spot: `north${character}gate` } };
      await expect(s.adapter.withInvocation('mcp_11c', broken, undefined, async ask => ask.authorize(broken)),
        `${name} must be refused`).rejects.toThrow('reason=parameter_not_one_line key=spot limit=1 measured=2 unit=lines');
      expect(s.elicitInput).not.toHaveBeenCalled();
    }
  });

  it('T-a: control characters are refused rather than measured, because none of them can be', async () => {
    // ESC paints nothing or repaints the row, NUL paints zero columns, TAB paints
    // up to eight: measuring them is the wrong answer, refusing them is the right
    // one for a line that exists only to be read.
    for (const [name, character, count] of [['ESC', '\u001b', 1], ['NUL', '\u0000', 1],
      ['TAB', '\t', 1], ['DEL', '\u007f', 1], ['C1 CSI', '\u009b', 1],
      ['an ANSI colour run', '\u001b[31m\u001b[0m', 2]] as const) {
      const s = setup();
      const sneaky = { ...input, params: { spot: `north${character}gate` } };
      await expect(s.adapter.withInvocation('mcp_11d', sneaky, undefined, async ask => ask.authorize(sneaky)),
        `${name} must be refused`).rejects.toThrow(
        `OWNER_CONFIRMATION_UNREADABLE reason=parameter_not_printable key=spot limit=0 measured=${count} unit=controls`);
      expect(s.elicitInput).not.toHaveBeenCalled();
    }
  });

  it('T-a: format characters and lone surrogates are refused as not printable — a bidi override or a zero-width character misleads the reader', async () => {
    // A right-to-left override makes a value display reordered; a zero-width
    // character makes two different values look identical. Neither has a
    // legitimate place in a parameter, and both mislead the person approving.
    for (const [name, value] of [
      ['RLO U+202E', 'pay \u202Eeceno\u202C'], ['LRI U+2066', 'north \u2066gate\u2069'],
      ['ZWSP U+200B', 'north\u200Bgate'], ['ZWNJ U+200C', 'north\u200Cgate'],
      // A joiner is allowed only BETWEEN two emoji; everywhere else it is an
      // invisible difference between two strings that look the same.
      ['ZWJ between Latin letters', 'no\u200Drth gate'],
      ['ZWJ at the start', '\u200Dnorth gate'], ['ZWJ at the end', 'north gate\u200D'],
      ['ZWJ after an emoji, before a letter', '\u{1F469}\u200Dx'],
      ['ZWJ after a letter, before an emoji', 'x\u200D\u{1F4BB}'],
      ['ZWJ alone after an emoji', '\u{1F469}\u200D'],
    ] as const) {
      const s = setup({ refuseToAsk: true });
      const call = { ...input, params: { spot: value } };
      await expect(s.adapter.withInvocation('mcp_cf', call, undefined, async ask => ask.authorize(call)), name)
        .rejects.toThrow('OWNER_CONFIRMATION_UNREADABLE reason=parameter_not_printable key=spot');
      expect(s.elicitInput, name).not.toHaveBeenCalled();
    }
    // A lone surrogate never gets this far: the invoke schema's JSON profile
    // refuses it at capture. Still no dialog, which is the property; the
    // dialog's own `\p{Cs}` refusal stays behind it as a second line.
    const lone = setup({ refuseToAsk: true });
    const surrogate = { ...input, params: { spot: 'north\uD800gate' } };
    await expect(lone.adapter.withInvocation('mcp_cs', surrogate, undefined, async ask => ask.authorize(surrogate)))
      .rejects.toThrow('JSON_SURROGATE_INVALID');
    expect(lone.elicitInput).not.toHaveBeenCalled();
    // In a KEY too: the check runs over the whole `key: value` line.
    await expect(refusalFor({ 'sp\u200Bot': 'north gate' })).rejects.toThrow('reason=parameter_not_printable');
    // U+2028 and U+2029 are line separators, so they are the line-forging
    // attack again, and are refused as line breaks.
    for (const separator of ['\u2028', '\u2029']) {
      await expect(refusalFor({ spot: `north gate${separator}House: http://safe.example` }))
        .rejects.toThrow('reason=parameter_not_one_line key=spot limit=1 measured=2 unit=lines');
    }
  });

  it('T-a: a zero-width joiner inside an emoji sequence is ordinary input, accepted and shown verbatim', async () => {
    // ZWJ's one legitimate job is joining emoji into one glyph; a person
    // types these in an ordinary check-in.
    for (const [name, emoji] of [
      ['family', '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}'],
      ['technologist', '\u{1F469}\u200D\u{1F4BB}'],
      ['rainbow flag (carries U+FE0F)', '\u{1F3F3}\uFE0F\u200D\u{1F308}'],
      ['technologist with a skin tone', '\u{1F469}\u{1F3FD}\u200D\u{1F4BB}'],
    ] as const) {
      const value = `with ${emoji} at work`;
      const { lines } = await dialogFor({ spot: value });
      expect(lines, name).toContain(`> spot: ${value}`);
    }
  });

  it('T-a: an ideographic space and a no-break space are ordinary input, accepted and shown as typed', async () => {
    // Deliberately NOT the seam's class: a Chinese IME produces U+3000 in a
    // place name, and a world parameter is not escaped, so refusing it would
    // refuse ordinary input.
    const value = '西湖\u3000断桥\u00A0north';
    const { lines } = await dialogFor({ spot: value });
    expect(lines).toContain(`> spot: ${value}`);
  });

  it('T-a: a parameter named like a frame line cannot produce a line with the frame\'s shape', async () => {
    // In the field form a key was a field TITLE, so a parameter named `house`
    // could not pose as the real house. In a message it could — unless every
    // parameter line carries a prefix only trusted code writes and no frame
    // line ever starts with.
    const clean = await dialogFor({ spot: 'north gate' });
    const frame = clean.lines.filter(line => !line.startsWith('> '));
    const impostors = {
      house: 'http://safe.example', House: 'http://safe.example', action: 'rangermap.say_hello',
      Action: 'rangermap.say_hello', Identity: 'you', 'Capability revision': 'c'.repeat(64),
      Reference: 'abcdef', Answer: 'within 999 s.', DUPLICATE: 'none', PopClaw: 'confirm world action',
      Parameters: '(none)', spot: 'north gate',
    };
    const { lines, reference } = await dialogFor(impostors);
    // The lines without the prefix are exactly the frame the clean dialog had —
    // the impostors added nothing to it — and every one of them is a `> ` line.
    expect(lines.filter(line => !line.startsWith('> ')))
      .toEqual(frame.map(line => (line === `Reference: ${clean.reference}` ? `Reference: ${reference}` : line)));
    expect(parametersOf(lines)).toHaveLength(Object.keys(impostors).length);
    for (const row of lines.filter(line => line.startsWith('>'))) expect(row.startsWith('> ')).toBe(true);
    expect(lines).toContain('> house: http://safe.example');
    expect(lines).toContain('> action: rangermap.say_hello');
    // Named, not inferred: no line that is not the real one has a frame's head.
    for (const head of ['House:', 'Action:', 'Identity:', 'Capability revision:', 'Reference:', 'Answer within', 'PopClaw:', 'Parameters:']) {
      expect(lines.filter(line => line.startsWith(head)), head).toHaveLength(1);
    }
    for (const head of ['house:', 'action:', 'DUPLICATE']) expect(lines.filter(line => line.startsWith(head)), head).toEqual([]);
  });

  it('T-a: the message is bounded by the invoke schema\'s own parameter limit, which refuses before any dialog', async () => {
    // The field budget used to cap a dialog at five rows. What caps it now is
    // what the invoke schema already enforced before any dialog was built —
    // `L_PARAMS_MAX_BYTES` of parameter JSON — plus a frame whose every fact
    // is schema-bounded (house ≤ 253, kind ≤ 64, 64-hex revision, 44-char id).
    const limit = WORLD_PROTOCOL_LIMITS.L_PARAMS_MAX_BYTES;
    const overhead = '{"note":""}'.length;
    const biggest = { note: 'x'.repeat(limit - overhead) };
    expect(new TextEncoder().encode(JSON.stringify(biggest)).length).toBe(limit);
    const shown = await dialogFor(biggest);
    const bytes = new TextEncoder().encode(shown.lines.join('\n')).length;
    // Hard wrapping adds a `\\n>   ` (5 bytes) per 64 columns.
    expect(bytes).toBeLessThanOrEqual(limit + 2048);
    // Many tiny keys: each `> k: v` line costs at most two bytes more than the
    // same pair in JSON, and each pair costs at least five JSON bytes.
    const many: Record<string, number> = {};
    for (let i = 0; JSON.stringify(many).length < limit - 16; i += 1) many[i.toString(36)] = 0;
    const crowded = await dialogFor(many);
    expect(new TextEncoder().encode(crowded.lines.join('\n')).length).toBeLessThanOrEqual(2 * limit);
    // One byte over and nothing is shown: the owner is never asked about it.
    const s = setup({ refuseToAsk: true });
    const over = { ...input, params: { note: 'x'.repeat(limit - overhead + 1) } };
    await expect(s.adapter.withInvocation('mcp_big', over, undefined, async ask => ask.authorize(over)))
      .rejects.toThrow('JSON_SIZE_LIMIT');
    expect(s.elicitInput).not.toHaveBeenCalled();
  });

  it('T-a: whatever the host sends back beside `confirm` cannot change what gets signed', async () => {
    const s = setup();
    let grant!: OwnerGrant;
    const running = s.adapter.withInvocation('mcp_15a', input, undefined, async ask => { grant = await ask.authorize(input); });
    await asked(s);
    // A host that hands back an extra field, with text in it.
    s.acceptWith({ confirm: true, param1: 'spot: SOMEWHERE ELSE' });
    await running;
    // Only `confirm` is ever read: the grant is the nonce this adapter minted and
    // carries nothing the host sent back.
    expect(grant.jobId).toMatch(/^mcp-owner:[0-9a-f]{16}$/);
    expect(JSON.stringify(grant)).not.toContain('SOMEWHERE ELSE');
    // And the edited text cannot become the action either: what may be authorized
    // is fixed by the invoke input the invocation captured, before any dialog.
    const tampered = { ...input, params: { spot: 'SOMEWHERE ELSE' } };
    const second = setup();
    await expect(second.adapter.withInvocation('mcp_15b', input, undefined, async ask => ask.authorize(tampered)))
      .rejects.toThrow('OWNER_CONFIRMATION_INPUT_MISMATCH');
    expect(second.elicitInput).not.toHaveBeenCalled();
  });

  it('T-b: consent is accept with confirm === true and nothing else', async () => {
    const answers: Array<[string, ElicitResult, string | null]> = [
      ['accept + true', { action: 'accept', content: { confirm: true } }, null],
      ['accept + false', { action: 'accept', content: { confirm: false } }, 'OWNER_CONFIRMATION_DECLINED'],
      ['accept + missing', { action: 'accept', content: {} }, 'OWNER_CONFIRMATION_DECLINED'],
      ['accept + no content', { action: 'accept' }, 'OWNER_CONFIRMATION_DECLINED'],
      ['accept + "true"', { action: 'accept', content: { confirm: 'true' } }, 'OWNER_CONFIRMATION_DECLINED'],
      ['decline + true', { action: 'decline', content: { confirm: true } }, 'OWNER_CONFIRMATION_DECLINED'],
      ['cancel + true', { action: 'cancel', content: { confirm: true } }, 'OWNER_CONFIRMATION_CANCELLED'],
    ];
    for (const [name, result, code] of answers) {
      const s = setup();
      let resolve!: (value: ElicitResult) => void;
      s.elicitInput.mockImplementationOnce(async () => new Promise<ElicitResult>(r => { resolve = r; }));
      const running = s.adapter.withInvocation('mcp_consent', input, undefined, async ask => ask.authorize(input));
      await vi.waitFor(() => expect(s.elicitInput).toHaveBeenCalledOnce());
      resolve(result);
      if (code === null) expect((await running).jobId, name).toMatch(/^mcp-owner:[0-9a-f]{16}$/);
      else await expect(running, name).rejects.toThrow(code);
    }
  });

  // An untouched box under `default: false` comes back `accept {confirm:false}`
  // (Claude Code 2.1.283 / codex-cli 0.157.1, 2026-09-27). What runs after
  // authorization is the action; count it.
  it('T-b: an untouched accept {confirm:false} runs nothing, and says only the refusal code', async () => {
    const s = setup();
    let executed = 0;
    const running = s.adapter.withInvocation('mcp_untouched', input, undefined, async ask => {
      await ask.authorize(input);
      executed += 1;
    });
    await asked(s);
    s.accept(false);
    const error = await running.then(() => null, (e: unknown) => e as Error);
    expect(executed).toBe(0);
    // The code and nothing else: no sentence claiming the owner said no.
    expect(error?.message).toBe('OWNER_CONFIRMATION_DECLINED');
  });

  it('T-b: a ticked accept runs the action exactly once', async () => {
    const s = setup();
    let executed = 0;
    const running = s.adapter.withInvocation('mcp_ticked', input, undefined, async ask => {
      await ask.authorize(input);
      executed += 1;
    });
    await asked(s);
    s.accept();
    await running;
    expect(executed).toBe(1);
  });

  it('T-b: accept with confirm:false is a decline and issues nothing (the Codex-observed case)', async () => {
    const s = setup();
    const running = s.adapter.withInvocation('mcp_9', input, undefined, async ask => ask.authorize(input));
    await asked(s);
    s.accept(false);
    await expect(running).rejects.toThrow('OWNER_CONFIRMATION_DECLINED');
  });

  it('T-c: decline, cancel, timeout and a broken transport map to four distinct codes with no grant', async () => {
    for (const [action, code] of [['decline', 'OWNER_CONFIRMATION_DECLINED'], ['cancel', 'OWNER_CONFIRMATION_CANCELLED']] as const) {
      const s = setup();
      const running = s.adapter.withInvocation('mcp_10', input, undefined, async ask => ask.authorize(input));
      await asked(s);
      s.respond(action);
      await expect(running).rejects.toThrow(code);
    }
    const timed = setup();
    const timing = timed.adapter.withInvocation('mcp_11', input, undefined, async ask => ask.authorize(input));
    await asked(timed);
    timed.breakElicit(new McpError(ErrorCode.RequestTimeout, 'Request timed out'));
    // The code, and the clause that stops an open dialog's approval vanishing unexplained.
    await expect(timing).rejects.toThrow(`OWNER_CONFIRMATION_TIMEOUT: ${renderCopy('en', 'world.action.approval.timedOut')}`);
    await expect(timing).rejects.toThrow('approving it now will not run the action');
    const broken = setup();
    const breaking = broken.adapter.withInvocation('mcp_12', input, undefined, async ask => ask.authorize(input));
    await asked(broken);
    broken.breakElicit(new Error('transport closed'));
    await expect(breaking).rejects.toThrow('OWNER_CONFIRMATION_FAILED');
  });

  it('T-d: a client without form elicitation is refused, with the host hint, before any ask', async () => {
    const s = setup({ form: false });
    await expect(s.adapter.withInvocation('mcp_13', input, undefined, async ask => ask.authorize(input)))
      .rejects.toThrow('OWNER_CONFIRMATION_UNAVAILABLE');
    await expect(s.adapter.withInvocation('mcp_14', input, undefined, async ask => ask.authorize(input)))
      .rejects.toThrow('Claude Code 2.1+ or Codex 0.155+');
    expect(s.elicitInput).not.toHaveBeenCalled();
    expect(() => s.adapter.assertActive()).toThrow('OWNER_CONFIRMATION_UNAVAILABLE');
    s.setForm(true);
    expect(() => s.adapter.assertActive()).not.toThrow();
    s.unbind();
    expect(() => s.adapter.assertActive()).toThrow('OWNER_CONFIRMATION_UNAVAILABLE');
  });

  it('T-e: a second concurrent invocation is refused as busy and the first is unaffected', async () => {
    const s = setup();
    const first = s.adapter.withInvocation('mcp_15', input, undefined, async ask => ask.authorize(input));
    await asked(s);
    await expect(s.adapter.withInvocation('mcp_16', input, undefined, async ask => ask.authorize(input)))
      .rejects.toThrow('OWNER_CONFIRMATION_BUSY');
    expect(s.elicitInput).toHaveBeenCalledOnce();
    s.accept();
    expect((await first).jobId).toMatch(/^mcp-owner:[0-9a-f]{16}$/);
    // The slot is released, so the next tool call may ask again.
    const second = s.adapter.withInvocation('mcp_17', input, undefined, async ask => ask.authorize(input));
    await vi.waitFor(() => expect(s.asks).toHaveLength(2));
    s.accept();
    await second;
  });

  it('T-f: authorizing a different canonical input than the invocation captured is refused before asking', async () => {
    const s = setup();
    const swapped = { ...input, params: { spot: 'south gate' } };
    await expect(s.adapter.withInvocation('mcp_18', input, undefined, async ask => ask.authorize(swapped)))
      .rejects.toThrow('OWNER_CONFIRMATION_INPUT_MISMATCH');
    expect(s.elicitInput).not.toHaveBeenCalled();
    // Key order is not a difference: the canonical form sorts keys.
    const reordered = { expected_capability_revision: input.expected_capability_revision, params: { spot: 'north gate' }, kind: input.kind, house };
    const running = s.adapter.withInvocation('mcp_19', input, undefined, async ask => ask.authorize(reordered));
    await asked(s);
    s.accept();
    await running;
  });

  it('T-g: a grant that outlives its invocation, or whose call was aborted, fails assertCurrent', async () => {
    const s = setup();
    let escaped!: OwnerGrant;
    const running = s.adapter.withInvocation('mcp_20', input, undefined, async ask => { escaped = await ask.authorize(input); escaped.assertCurrent(); });
    await asked(s);
    s.accept();
    await running;
    expect(() => escaped.assertCurrent()).toThrow('OWNER_CONFIRMATION_INACTIVE');

    // The tool call's signal is handed to the elicitation itself, so cancelling
    // the call also cancels the dialog instead of leaving it open for the whole window.
    const controller = new AbortController();
    const aborting = setup();
    let used = false;
    const pending = aborting.adapter.withInvocation('mcp_21', input, controller.signal, async ask => {
      const grant = await ask.authorize(input);
      used = true;
      grant.assertCurrent();
    });
    await asked(aborting);
    // The adapter hands the elicitation a signal composed from the call's signal
    // and its own shutdown signal, so it is not the call's signal object itself.
    const observed = aborting.asks[0]!.signal!;
    expect(observed.aborted).toBe(false);
    controller.abort();
    expect(observed.aborted).toBe(true);
    await expect(pending).rejects.toThrow('OWNER_CONFIRMATION_INACTIVE');
    expect(used).toBe(false);
    // A late answer to a cancelled dialog changes nothing.
    aborting.accept();
    await expect(pending).rejects.toThrow('OWNER_CONFIRMATION_INACTIVE');

    const expiring = setup();
    let late!: OwnerGrant;
    const held = expiring.adapter.withInvocation('mcp_22', input, undefined, async ask => {
      late = await ask.authorize(input);
      expiring.setNow(start + 240);
      expect(() => late.assertCurrent()).toThrow('OWNER_CONFIRMATION_EXPIRED');
    });
    await asked(expiring);
    expiring.accept();
    await held;
  });

  it('T-h: stop() aborts the dialog it is waiting on, issues nothing and kills the lane', async () => {
    const s = setup();
    const running = s.adapter.withInvocation('mcp_23', input, undefined, async ask => ask.authorize(input));
    await asked(s);
    const observed = s.asks[0]!.signal!;
    expect(observed.aborted).toBe(false);
    s.adapter.stop();
    // Shutdown cancels the open form instead of blocking for the full window.
    expect(observed.aborted).toBe(true);
    s.accept();
    await expect(running).rejects.toThrow('OWNER_CONFIRMATION_INACTIVE');
    expect(() => s.adapter.assertActive()).toThrow('OWNER_CONFIRMATION_UNAVAILABLE');
    await expect(s.adapter.withInvocation('mcp_24', input, undefined, async ask => ask.authorize(input)))
      .rejects.toThrow('OWNER_CONFIRMATION_UNAVAILABLE');
  });

  it('T-o: one invocation may ask only once; a second ask inside the same call is busy', async () => {
    const s = setup();
    let second!: Promise<OwnerGrant>;
    const running = s.adapter.withInvocation('mcp_25', input, undefined, async ask => {
      const first = ask.authorize(input);
      second = ask.authorize(input);
      await expect(second).rejects.toThrow('OWNER_CONFIRMATION_BUSY');
      await asked(s);
      s.accept();
      return first;
    });
    expect((await running).jobId).toMatch(/^mcp-owner:[0-9a-f]{16}$/);
    expect(s.elicitInput).toHaveBeenCalledOnce();
    await expect(second).rejects.toThrow('OWNER_CONFIRMATION_BUSY');
  });

  // Measured against a real Server/Client pair, because the thing under test is
  // the SDK's own behaviour: on `accept` it validates the returned content
  // against the schema we sent (server/index.js, the `form` branch of
  // elicitInput). The optional display fields that made an untouched field
  // answered as `null` a hazard are gone; what is left is that an answer the
  // SDK cannot match to the form is the HOST's fault, under its own code.
  it('T-a: over a real pair, one boolean is the whole form, and a host answer that does not fit it is named as the host\'s', async () => {
    const { Server: McpServer } = await import('@modelcontextprotocol/sdk/server/index.js');
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
    const { ElicitRequestSchema } = await import('@modelcontextprotocol/sdk/types.js');

    const run = async (content: Record<string, unknown>): Promise<string> => {
      const box: { current?: InstanceType<typeof McpServer> } = {};
      const adapter = createMcpOwnerAuthorization({ actorId, server: box as never, duplicates: { unresolved: () => [] } });
      const server = new McpServer({ name: 'popclaw-test', version: '0' }, { capabilities: { tools: {} } });
      box.current = server;
      const client = new Client({ name: 'vitest-host', version: '0' }, { capabilities: { elicitation: { form: {} } } });
      client.setRequestHandler(ElicitRequestSchema, () => ({ action: 'accept' as const, content }));
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
      try {
        const grant = await adapter.withInvocation('mcp_16', input, undefined, ask => ask.authorize(input));
        return `granted ${/^mcp-owner:[0-9a-f]{16}$/.test(grant.jobId)}`;
      } catch (error) { return String(error); }
      finally { adapter.stop(); await client.close(); await server.close(); }
    };

    expect(await run({ confirm: true })).toBe('granted true');
    expect(await run({ confirm: false })).toContain('OWNER_CONFIRMATION_DECLINED');
    // A confirmation the SDK cannot read as a boolean is the host's answer
    // failing the form, not the owner declining and not a broken transport.
    const nulled = await run({ confirm: null });
    expect(nulled).toContain('OWNER_CONFIRMATION_ANSWER_INVALID');
    expect(nulled).toContain('returned a form answer PopClaw could not read');
    expect(nulled).not.toContain('OWNER_CONFIRMATION_FAILED');
  }, 30_000);

  it('T-b: the reference is in the message and the confirm description, is cut from the job id nonce, and names THIS ask', async () => {
    // The dialog cannot name the request: none exists until after the owner has
    // answered. The reference is the only thing a person can carry from the
    // dialog to the receipt, so it has to be in both and it has to match.
    const s = setup();
    let grant!: OwnerGrant;
    const running = s.adapter.withInvocation('mcp_20a', input, undefined, async ask => {
      // Available before the answer, because the nonce is minted per invocation.
      expect(ask.reference).toMatch(/^[0-9a-f]{6}$/);
      grant = await ask.authorize(input);
      expect(grant.jobId).toBe(`mcp-owner:${ask.reference}${grant.jobId.slice(-10)}`);
      return ask.reference;
    });
    await asked(s);
    s.accept();
    const reference = await running;
    expect(reference).toBe(referenceOf(grant));
    expect(s.asks[0]!.message.split('\n')).toContain(`Reference: ${reference}`);
    expect(JSON.stringify(s.asks[0]!.requestedSchema)).toContain(`(ref ${reference})`);
    // Two invocations, two nonces, two references: it identifies THIS ask.
    const again = setup();
    const second = again.adapter.withInvocation('mcp_20b', input, undefined, async ask => ask.reference);
    expect(await second).not.toBe(reference);
  });

  it('T-b: an unresolved twin puts the warning FIRST in the message, naming the original request in full and calling this a second action', async () => {
    for (const client of ['claude-code', 'codex-cli']) {
      const { lines, schema, reference } = await dialogFor(input.params, { client, duplicates: () => [twin] });
      // First, so a host that folds the message after one line still shows
      // the alarm without a keystroke, and it is read before the facts it
      // qualifies. The whole 64-hex id, not a prefix: there is room now.
      expect(lines).toEqual(expectedMessage(['> spot: north gate'], reference, TWIN_LINES));
      expect(lines[0]).toBe('DUPLICATE: an earlier request with the same input is unresolved.');
      // Still one real input: the warning is text to read, not a box to type in.
      expect(schema).toEqual(theOneField(reference));
    }
    // The lookup is asked the CAPTURED input and the adapter's own actor, and
    // nothing else: there is no field in which a model could steer the answer.
    const s = setup({ duplicates: () => [twin] });
    const running = s.adapter.withInvocation('mcp_21a', input, undefined, async ask => ask.authorize(input));
    await asked(s);
    s.accept();
    await running;
    expect(s.queries).toEqual([{ actorId, input }]);
    expect(Object.keys(s.queries[0]!.input).sort()).toEqual(['expected_capability_revision', 'house', 'kind', 'params']);
    expect(Object.isFrozen(s.queries[0]!.input)).toBe(true);
  });

  it('T-b: with no unresolved twin the dialog carries no duplicate line at all', async () => {
    const s = setup();
    let reference = '';
    const running = s.adapter.withInvocation('mcp_22a', input, undefined, async ask => { reference = ask.reference; return ask.authorize(input); });
    await asked(s);
    s.accept();
    await running;
    expect(s.asks[0]!.message.split('\n')).toEqual(expectedMessage(['> spot: north gate'], reference));
    expect(s.asks[0]!.message).not.toMatch(/DUPLICATE|SECOND action|UNKNOWN/);
    expect(s.queries).toHaveLength(1);
  });

  it('T-b: a duplicate check that cannot run says the state is UNKNOWN instead of reading as "no duplicate"', async () => {
    // Every way of not knowing is the same answer to the owner. Silence here
    // would be indistinguishable from a clean check, which is the one thing it
    // is not — so the dialog is still shown, carrying the failure first.
    const broken: Array<[string, () => readonly string[] | Promise<readonly string[]>]> = [
      ['a throw', () => { throw new Error('DB_LOCKED'); }],
      ['a rejected promise', () => Promise.reject(new Error('WORLD_RUNTIME_STOPPED'))],
      ['an answer that is not a list', () => ('nope' as unknown as readonly string[])],
      ['a list carrying something that is not a request id', () => ['not-a-request-id']],
    ];
    for (const [name, duplicates] of broken) {
      const { lines, schema, reference } = await dialogFor(input.params, { duplicates });
      expect(lines, `${name} must be reported`).toEqual(expectedMessage(['> spot: north gate'], reference, UNKNOWN_LINES));
      expect(schema).toEqual(theOneField(reference));
    }
  });

  it('T-b: a lookup that never answers gives up on a deadline, and an aborted call stops waiting for it at once', async () => {
    // The one way of not knowing that cannot report itself. `elicitTimeoutMs`
    // covers the dialog, not the lookup, so without a deadline of its own a
    // hung lookup means no dialog at all — louder than any wrong warning.
    const { lines, reference } = await dialogFor(input.params,
      { duplicates: () => new Promise<readonly string[]>(() => {}), duplicateTimeoutMs: 25 });
    expect(lines).toEqual(expectedMessage(['> spot: north gate'], reference, UNKNOWN_LINES));

    // And the deadline is not the only exit: the tool call being cancelled ends
    // the wait immediately. The timeout here is a minute, so this case can only
    // pass if the abort is raced against the lookup rather than merely checked
    // after it.
    const aborted = setup({ duplicates: () => new Promise<readonly string[]>(() => {}), duplicateTimeoutMs: 60_000 });
    const controller = new AbortController();
    const call = aborted.adapter.withInvocation('mcp_26b', input, controller.signal, async ask => ask.authorize(input));
    controller.abort();
    await expect(call).rejects.toThrow('OWNER_CONFIRMATION_INACTIVE');
    expect(aborted.elicitInput).not.toHaveBeenCalled();
  });

  it('T-a: display width counts wide and fullwidth characters as two columns and joiners as none', async () => {
    // No longer a layout rule for this dialog; still the measurement the draft
    // registrant composes its rows with, so it stays pinned here.
    expect(displayWidth('north gate')).toBe(10);
    expect(displayWidth('北门')).toBe(4);            // CJK unified ideographs
    expect(displayWidth('한글')).toBe(4);            // Hangul syllables
    expect(displayWidth('ｆｕｌｌ')).toBe(8);         // fullwidth forms
    expect(displayWidth('かな')).toBe(4);            // kana
    expect(displayWidth('🚩')).toBe(2);              // emoji
    expect(displayWidth('é')).toBe(1);        // combining acute adds no column
    for (const wide of ['✅', '⚡', '⌚', '⭐', '\u{1F21A}', '⭕', '❌', '\u{1F18E}']) {
      expect(displayWidth(wide)).toBe(2);
    }
    expect('\u{1D400}'.length).toBe(2);
    expect(displayWidth('\u{1D400}')).toBe(1);
  });

  it('rejects a malformed call id and a non-world actor before touching the client', async () => {
    const s = setup();
    await expect(s.adapter.withInvocation('mcp 25 with spaces', input, undefined, async ask => ask.authorize(input)))
      .rejects.toThrow('OWNER_CONFIRMATION_INVOCATION_INVALID');
    expect(s.elicitInput).not.toHaveBeenCalled();
    expect(() => createMcpOwnerAuthorization({ actorId: 'not-a-world-key', server: { current: undefined }, duplicates: { unresolved: () => [] } }))
      .toThrow('OWNER_CONFIRMATION_ACTOR_INVALID');
  });
});

/** The two joints `src/mcp.ts` used to hold inline. That file is imported by no
 *  test, so a wrong slice in one or a wrong input passed to the other — which
 *  answers "no twin" SILENTLY — was caught by nothing. Both are exercised here
 *  against the REAL adapter, so what is pinned is the whole hand-off and not a
 *  restatement of either side. */
describe('the MCP root world-invoke wiring', () => {
  it('carries the reference the adapter minted out to the work, unchanged', async () => {
    const s = setup();
    const context = { readCapabilities: () => null, client: () => { throw new Error('NO_CLIENT'); } } as unknown as WorldCommandContext;
    const seen: Array<[WorldCommandContext, string | undefined]> = [];
    let grant!: OwnerGrant;
    let handed: OwnerConfirmation | undefined;
    const invoke = ownerConfirmedWorldInvoke(s.adapter,
      { ownerCommandContext: (ask: OwnerConfirmation) => { handed = ask; return context; } });
    const running = invoke('mcp_30', input, undefined, async (ctx, reference) => {
      seen.push([ctx, reference]);
      grant = await handed!.authorize(input);
      return 'done';
    });
    await asked(s);
    s.accept();
    expect(await running).toBe('done');
    // The context handed to the work is the runtime's, and the reference is the
    // adapter's own — the first six characters of the nonce that became the job
    // id, not a different slice of it and not a fresh string.
    expect(seen).toHaveLength(1);
    expect(seen[0]![0]).toBe(context);
    expect(seen[0]![1]).toBe(referenceOf(grant));
    expect(grant.jobId).toBe(`mcp-owner:${seen[0]![1]}${grant.jobId.slice(-10)}`);
  });

  it('hands the duplicate lookup the captured input and the actor unchanged', async () => {
    const calls: Array<[string, Readonly<WorldInvokeInput>]> = [];
    const lookup = worldDuplicateLookup({
      unresolvedOwnerRequests: async (actor: string, value: Readonly<WorldInvokeInput>) => {
        calls.push([actor, value]); return [twin];
      },
    });
    const answer = await lookup.unresolved({ actorId, input });
    // Passed straight through, not rebuilt: a lookup asked about a different
    // action answers "no twin" and nothing anywhere says so.
    expect(calls).toEqual([[actorId, input]]);
    expect(calls[0]![1]).toBe(input);
    expect(answer).toEqual([twin]);
  });
});
