import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { firstReleaseView } from '../../fixtures/world/first-release-view.js';
import { popclaw } from '@popclaw/contracts';
import { WORLD_COMMAND_HELP, type WorldCommandContext } from '../../../src/commands/popclaw-world.js';
import { parseWorldCliArgs, runWorldCliCommand } from '../../../src/commands/world-cli.js';

const origin = 'https://world.invalid', revision = 'a'.repeat(64), request = 'b'.repeat(64);
const actor = '11111111111111111111111111111111', now = '2026-09-08T00:00:00Z';
const input = (file: string) => ['invoke', origin, 'example.reply', '--params-json', file, '--expected-capability-revision', revision];
const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
function files() {
  const root = mkdtempSync(join(tmpdir(), 'world-cli-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return { root, write: (bytes: string | Uint8Array) => { const path = join(root, 'input.json'); writeFileSync(path, bytes); return path; } };
}
function context() {
  const authority = { executionReference: {kind: 'owner_action' as const, reservationId: 'c'.repeat(64)}, expiresAt: 2000000000, check() {}, record() {} };
  const invoke = vi.fn(async () => ({ request_id: request, status: 'unknown' as const, code: 'ACTION_RESULT_UNKNOWN' }));
  const status = vi.fn(async () => ({ request_id: request, status: 'succeeded' as const, code: 'OK',
    result: popclaw.world.ActionResult.fromObject({ status: 3, statusRevision: '18446744073709551615' }) }));
  const client = vi.fn(() => ({ invoke, status })), readCapabilities = vi.fn(() => firstReleaseView(origin, actor, true));
  const actionAuthority = vi.fn(() => authority);
  const ctx: WorldCommandContext = { client, readCapabilities, actionAuthority, now: () => now };
  return { ctx, client, invoke, status, readCapabilities, authority, actionAuthority };
}

describe('world CLI parser', () => {
  it('uses the frozen help text without reading input or context', async () => {
    const f = context();
    for (const flag of ['help', '--help', '-h']) {
      const args = parseWorldCliArgs([flag]);
      expect(args.command).toBe('help');
      expect(await runWorldCliCommand(f.ctx, args)).toEqual({ text: WORLD_COMMAND_HELP });
    }
    expect(f.client).not.toHaveBeenCalled(); expect(f.readCapabilities).not.toHaveBeenCalled();
  });

  it.each([
    [], ['unknown'], ['capabilities'], ['capabilities', origin, 'extra'], ['capabilities', origin, '--params-json', 'x'],
    ['action-status', origin], ['action-status', origin, request, '--confirm'],
    ['invoke', origin, 'example.reply'], [...input('x'), 'extra'], [...input('x'), '--params-json=y'],
    ['invoke', origin, 'example.reply', '--params-json', '--expected-capability-revision', revision],
    ['invoke', origin, 'example.reply', '--params-json=', '--expected-capability-revision', revision],
    [...input('x'), '--authority=owner'], [...input('x'), '--'], [...input('x'), '-q'],
    ['capabilities', 'https://world.invalid/'], ['action-status', origin, 'bad'],
    ['capabilities', origin, '--help'],
  ])('rejects invalid argv before dispatch: %j', (...argv) => {
    expect(() => parseWorldCliArgs(argv)).toThrow();
  });

  it('rejects the retired participation command on the same path as any unknown command', () => {
    const unknown = 'WORLD_CLI_ARGS_INVALID: unknown or missing command';
    expect(() => parseWorldCliArgs(['participation', 'view', origin, 'part_1'])).toThrow(unknown);
    expect(() => parseWorldCliArgs(['unknown'])).toThrow(unknown);
  });

  it('captures argv and accepts separated or equals flag values', () => {
    const argv = input('original.json'), parsed = parseWorldCliArgs(argv);
    argv[4] = 'changed.json';
    expect(parsed).toEqual(parseWorldCliArgs(['invoke', '--params-json=original.json', origin, 'example.reply', `--expected-capability-revision=${revision}`]));
    expect(Object.isFrozen(parsed)).toBe(true);
  });
});

describe('world CLI input and shared dispatch', () => {
  it('routes capabilities and exact status JSON through the existing handlers', async () => {
    const f = context(); f.ctx.readCapabilities = (house) => { (f.readCapabilities as (...args: unknown[]) => unknown)(house); return null; };
    expect(await runWorldCliCommand(f.ctx, parseWorldCliArgs(['capabilities', origin]))).toMatchObject({
      house: { origin }, capability_revision: null, context_complete: false, code: 'CAPABILITY_CONTEXT_INCOMPLETE' });
    expect(await runWorldCliCommand(f.ctx, parseWorldCliArgs(['action-status', origin, request]))).toMatchObject({
      request_id: request, status: 'succeeded', result: { status_revision: '18446744073709551615' } });
    expect(f.readCapabilities).toHaveBeenCalledWith(origin); expect(f.status).toHaveBeenCalledWith(request);
  });

  it('returns unsupported before CLI authority when no local consumer is installed', async () => {
    const f = context(); f.ctx.readCapabilities = () => firstReleaseView(origin, actor);
    await expect(runWorldCliCommand(f.ctx, parseWorldCliArgs(input(files().write('{}'))))).rejects.toThrow('WORLD_LOCAL_UNSUPPORTED');
    expect(f.actionAuthority).not.toHaveBeenCalled(); expect(f.client).not.toHaveBeenCalled();
  });

  it('reads a real file and chunked stdin into the same exact invoke input', async () => {
    const f = context(), path = files().write('{"text":"你好🙂","count":1}');
    const bytes = new TextEncoder().encode('{"text":"你好🙂","count":1}');
    await runWorldCliCommand(f.ctx, parseWorldCliArgs(input(path)));
    await runWorldCliCommand(f.ctx, parseWorldCliArgs(input('-')), { stdin: Readable.from([bytes.slice(0, 12), bytes.slice(12, 14), bytes.slice(14)]) });
    expect(f.invoke).toHaveBeenCalledTimes(2);
    expect(f.invoke).toHaveBeenNthCalledWith(1, { house: origin, kind: 'example.reply', params: { text: '你好🙂', count: 1 }, expected_capability_revision: revision }, f.authority);
    expect(f.invoke.mock.calls[0]).toEqual(f.invoke.mock.calls[1]);
  });

  it.each([
    '{"x":1,"x":2}', '{"x":1,"\\u0078":2}', '{"x":9007199254740992}', '\ufeff{}', '[]', '{} {}',
    '{"x":0.5}', '{"constructor":1}', '{"x":"\\ud800"}', '{"a":{"b":{"c":{"d":{"e":{"f":{"g":{"h":1}}}}}}}}',
  ])('rejects strict JSON violations before authorization: %s', async text => {
    const f = context(), path = files().write(text);
    await expect(runWorldCliCommand(f.ctx, parseWorldCliArgs(input(path)))).rejects.toThrow();
    await expect(runWorldCliCommand(f.ctx, parseWorldCliArgs(input('-')), { stdin: Readable.from([Buffer.from(text)]) })).rejects.toThrow();
    expect(f.actionAuthority).not.toHaveBeenCalled(); expect(f.client).not.toHaveBeenCalled();
  });

  it('enforces input bytes before decoding, including invalid UTF-8 and exact limits', async () => {
    const f = context(), storage = files();
    const valid = '{"x":"' + 'x'.repeat(16384 - 8) + '"}';
    expect(Buffer.byteLength(valid)).toBe(16384);
    await runWorldCliCommand(f.ctx, parseWorldCliArgs(input(storage.write(valid))));
    for (const bytes of [Buffer.from(valid + ' '), new Uint8Array([123, 34, 120, 34, 58, 34, 255, 34, 125])]) {
      await expect(runWorldCliCommand(f.ctx, parseWorldCliArgs(input(storage.write(bytes))))).rejects.toThrow();
      const stream = Readable.from([bytes]);
      await expect(runWorldCliCommand(f.ctx, parseWorldCliArgs(input('-')), { stdin: stream })).rejects.toThrow();
    }
    expect(f.invoke).toHaveBeenCalledOnce();
    await expect(runWorldCliCommand(f.ctx, parseWorldCliArgs(input(storage.root)))).rejects.toThrow('WORLD_CLI_FILE_REQUIRED');
  });

  it('cancels oversized or stalled stdin without invoking any handler', async () => {
    const f = context();
    for (const mode of ['oversized', 'stalled'] as const) {
      const finish = vi.fn(async () => ({ done: true as const, value: undefined }));
      const stream = { [Symbol.asyncIterator]: () => ({ return: finish,
        next: mode === 'oversized' ? async () => ({ done: false, value: new Uint8Array(16385) }) : () => new Promise<IteratorResult<Uint8Array>>(() => {}) }) };
      await expect(runWorldCliCommand(f.ctx, parseWorldCliArgs(input('-')), { stdin: stream, inputTimeoutMs: 20 })).rejects.toThrow(mode === 'oversized' ? 'JSON_SIZE_LIMIT' : 'WORLD_CLI_INPUT_TIMEOUT');
      expect(finish).toHaveBeenCalledOnce();
    }
    const abort = new AbortController(); abort.abort();
    await expect(runWorldCliCommand(f.ctx, parseWorldCliArgs(input('-')), { stdin: Readable.from([]), signal: abort.signal })).rejects.toThrow();
    expect(f.actionAuthority).not.toHaveBeenCalled(); expect(f.client).not.toHaveBeenCalled();
  });

  it('handles a read rejecting after synchronous cancellation and destroys an active Node stream', async () => {
    const f = context(), abort = new AbortController();
    const late = { [Symbol.asyncIterator]: () => ({ next: () => {
      abort.abort(new Error('STOP_INPUT'));
      return Promise.reject(new Error('LATE_READ_FAILURE'));
    } }) };
    await expect(runWorldCliCommand(f.ctx, parseWorldCliArgs(input('-')), { stdin: late, signal: abort.signal })).rejects.toThrow('STOP_INPUT');
    // Give Node a full turn: a detached rejected read must not become an
    // unhandled rejection after the CLI has already reported cancellation.
    await new Promise(resolve => setImmediate(resolve));
    const activeAbort = new AbortController(), stream = new Readable({ read() {} });
    const running = runWorldCliCommand(f.ctx, parseWorldCliArgs(input('-')), { stdin: stream, signal: activeAbort.signal });
    activeAbort.abort(new Error('STOP_ACTIVE_INPUT'));
    await expect(running).rejects.toThrow('STOP_ACTIVE_INPUT');
    expect(stream.destroyed).toBe(true);
    expect(f.actionAuthority).not.toHaveBeenCalled(); expect(f.client).not.toHaveBeenCalled();
  });

  it('never derives invoke authority from argv', async () => {
    const f = context(), storage = files(); delete f.ctx.actionAuthority;
    await expect(runWorldCliCommand(f.ctx, parseWorldCliArgs(input(storage.write('{}'))))).rejects.toThrow('ACTION_AUTHORITY_REQUIRED');
    expect(f.client).not.toHaveBeenCalled();
  });
});


it('routes bounded material read flags through the shared capability input', () => {
  expect(parseWorldCliArgs(['capabilities', origin, '--kind', 'example.reply', '--guide-offset', '8192',
    '--expected-capability-revision', revision, '--expected-session-id', 'session_1'])).toEqual({command: 'capabilities', input: {
      house: origin, kind: 'example.reply', guide_offset: 8192, expected_capability_revision: revision, expected_session_id: 'session_1'}});
  for (const offset of ['-1', 'NaN', '1.5', '9007199254740993', '524289'])
    expect(() => parseWorldCliArgs(['capabilities', origin, '--guide-offset', offset])).toThrow();
});


it('validates schema-fragment selectors on the same capability CLI surface', () => {
  expect(parseWorldCliArgs(['capabilities', origin, '--kind', 'example.reply', '--schema', 'params', '--schema-offset', '2000']))
    .toEqual({command: 'capabilities', input: {house: origin, kind: 'example.reply', schema: 'params', schema_offset: 2000}});
  for (const flags of [['--schema', 'params'], ['--schema-offset', '1'], ['--kind', 'example.reply', '--schema', 'other'],
    ['--kind', 'example.reply', '--schema', 'params', '--schema-offset', '32769']])
    expect(() => parseWorldCliArgs(['capabilities', origin, ...flags])).toThrow();
});

describe('world CLI event-kind reads', () => {
  it('parses --event-kind and --schema body into the shared capabilities input', () => {
    expect(parseWorldCliArgs(['capabilities', origin, '--event-kind', 'me.post']))
      .toMatchObject({command: 'capabilities', input: {house: origin, event_kind: 'me.post'}});
    expect(parseWorldCliArgs(['capabilities', origin, '--event-kind=world.notice', '--schema=body', '--schema-offset=12']))
      .toMatchObject({command: 'capabilities', input: {event_kind: 'world.notice', schema: 'body', schema_offset: 12}});
  });
  it.each([
    ['capabilities', origin, '--event-kind', 'me.post', '--kind', 'example.reply'],
    ['capabilities', origin, '--event-kind', 'me.post', '--guide-offset', '0'],
    ['capabilities', origin, '--schema', 'body'],
    ['capabilities', origin, '--event-kind', 'me.post', '--schema', 'params'],
  ])('rejects conflicting selectors before dispatch: %j', (...argv) => {
    expect(() => parseWorldCliArgs(argv)).toThrow();
  });
});
