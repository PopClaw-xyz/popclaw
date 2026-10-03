/** CLI-only argv and bounded input adapter. Native/MCP tools use popclaw-world directly. */
// eslint-disable-next-line no-restricted-imports -- This CLI input boundary opens only the explicitly supplied JSON file.
import { constants } from 'node:fs';
// eslint-disable-next-line no-restricted-imports -- Bounded regular-file input belongs to this CLI adapter, not the shared handlers.
import { open } from 'node:fs/promises';
import {
  WORLD_COMMAND_HELP, WORLD_PROTOCOL_LIMITS, captureWorldCommandInput,
  runWorldPrivateMessagesCommand, runWorldCapabilitiesCommand, runWorldInvokeCommand, runWorldActionStatusCommand,
  type WorldPrivateMessagesInput, type WorldCommandContext, type WorldCapabilitiesInput, type WorldActionStatusInput,
} from './popclaw-world.js';
import type { WorldInvokeInput } from '../world/action-client.js';
import { jsonObject, parseWorldJson } from '../world/json-profile.js';

export type ParsedWorldCliArgs =
  | Readonly<{ command: 'help' }>
  | Readonly<{ command: 'capabilities'; input: Readonly<WorldCapabilitiesInput> }>
  | Readonly<{ command: 'private_messages'; input: Readonly<WorldPrivateMessagesInput> }>
  | Readonly<{ command: 'action_status'; input: Readonly<WorldActionStatusInput> }>
  | Readonly<{ command: 'invoke'; input: Readonly<Omit<WorldInvokeInput, 'params'>>; jsonFile: string }>;

export interface WorldCliIo {
  /** CLI stdin is exclusive to this one input. It is closed on error/cancellation. */
  stdin?: AsyncIterable<Uint8Array> & { destroy?(): unknown };
  signal?: AbortSignal;
  /** Applies to JSON input only; the default is 10 seconds, maximum 60 seconds. */
  inputTimeoutMs?: number;
}

function invalid(detail: string): never { throw new Error(`WORLD_CLI_ARGS_INVALID: ${detail}`); }
function parsed<T extends ParsedWorldCliArgs>(value: T): T {
  if ('input' in value) Object.freeze(value.input);
  return Object.freeze(value);
}

/** Parse argv after `world`, without file reads, host construction, or authority. */
export function parseWorldCliArgs(argv: readonly string[]): ParsedWorldCliArgs {
  if (argv.length === 1 && ['help', '-h', '--help'].includes(argv[0]!)) return parsed({ command: 'help' });
  const command = argv[0];
  if (!command || !['capabilities', 'private-messages', 'invoke', 'action-status'].includes(command)) invalid('unknown or missing command');
  const allowed = new Set(command === 'invoke' ? ['params-json', 'expected-capability-revision']
    : command === 'private-messages' ? ['limit', 'cursor', 'message-id', 'state-ref', 'expected-capability-revision', 'expected-session-id']
    : command === 'capabilities' ? ['kind', 'event-kind', 'guide-offset', 'expected-capability-revision', 'expected-session-id', 'schema', 'schema-offset']
    : []);
  const flags = new Map<string, string>(), positions: string[] = [];
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith('-')) { positions.push(arg); continue; }
    if (!arg.startsWith('--') || arg === '--') invalid(`unexpected option ${arg}`);
    const equals = arg.indexOf('='), name = arg.slice(2, equals < 0 ? undefined : equals);
    if (!allowed.has(name)) invalid(`unknown option --${name}`);
    if (flags.has(name)) invalid(`duplicate option --${name}`);
    const value = equals < 0 ? argv[++i] : arg.slice(equals + 1);
    if (!value || (value.startsWith('-') && !(name === 'params-json' && value === '-'))) invalid(`missing or invalid value for --${name}`);
    flags.set(name, value);
  }
  const count = ['capabilities', 'private-messages'].includes(command) ? 1 : 2;
  if (positions.length !== count) invalid(`expected ${count} positional arguments`);
  if (command === 'capabilities') {
    const offset = flags.get('guide-offset'), schemaOffset = flags.get('schema-offset');
    if (schemaOffset !== undefined && !/^(0|[1-9][0-9]*)$/.test(schemaOffset)) invalid('invalid schema offset');
    if (offset !== undefined && !/^(0|[1-9][0-9]*)$/.test(offset)) invalid('invalid guide offset');
    return parsed({command, input: captureWorldCommandInput('capabilities', {house: positions[0],
      ...(flags.has('kind') ? {kind: flags.get('kind')} : {}),
      ...(flags.has('event-kind') ? {event_kind: flags.get('event-kind')} : {}),
      ...(flags.has('schema') ? {schema: flags.get('schema')} : {}),
      ...(schemaOffset !== undefined ? {schema_offset: Number(schemaOffset)} : {}),
      ...(offset !== undefined ? {guide_offset: Number(offset)} : {}),
      ...(flags.has('expected-capability-revision') ? {expected_capability_revision: flags.get('expected-capability-revision')} : {}),
      ...(flags.has('expected-session-id') ? {expected_session_id: flags.get('expected-session-id')} : {})})});
  }
  if (command === 'private-messages') {
    const limit = flags.get('limit');
    if (limit !== undefined && !/^[1-9][0-9]*$/.test(limit)) invalid('invalid limit');
    return parsed({ command: 'private_messages', input: captureWorldCommandInput('private_messages', {
      house: positions[0], ...(limit !== undefined ? { limit: Number(limit) } : {}),
      ...Object.fromEntries(['cursor', 'message-id', 'state-ref', 'expected-capability-revision', 'expected-session-id']
        .filter(name => flags.has(name)).map(name => [name.replaceAll('-', '_'), flags.get(name)])),
    }) });
  }
  if (command === 'action-status') return parsed({ command: 'action_status',
    input: captureWorldCommandInput('action_status', { house: positions[0], request_id: positions[1] }) });
  if (command === 'invoke') {
    const jsonFile = flags.get('params-json'), expected = flags.get('expected-capability-revision');
    if (!jsonFile || !expected) invalid('invoke requires --params-json and --expected-capability-revision');
    const checked = captureWorldCommandInput('invoke', { house: positions[0], kind: positions[1], params: {}, expected_capability_revision: expected });
    return parsed({ command, input: { house: checked.house, kind: checked.kind, expected_capability_revision: checked.expected_capability_revision }, jsonFile });
  }
  invalid('unknown or missing command');
}

/** Abort pending iterator/file work promptly; late promise failures stay handled. */
function cancellable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    // The operation was constructed before this call. A synchronous abort in
    // next()/open() cannot leave its later rejection without a handler.
    void work.catch(() => {});
    return Promise.reject(signal.reason);
  }
  return new Promise<T>((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
    void work.then(value => { signal.removeEventListener('abort', abort); resolve(value); },
      error => { signal.removeEventListener('abort', abort); reject(error); });
  });
}

async function streamBytes(stream: NonNullable<WorldCliIo['stdin']>, limit: number, signal: AbortSignal): Promise<Uint8Array> {
  signal.throwIfAborted();
  const iterator = stream[Symbol.asyncIterator](), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const next = await cancellable(Promise.resolve(iterator.next()), signal);
      if (next.done) break;
      if (!(next.value instanceof Uint8Array) || !next.value.length) throw new Error('WORLD_CLI_INPUT_CHUNK_INVALID');
      size += next.value.length;
      if (size > limit) throw new Error('JSON_SIZE_LIMIT');
      chunks.push(new Uint8Array(next.value));
    }
    signal.throwIfAborted();
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return bytes;
  } catch (error) {
    // A hostile/incomplete injected iterator may never settle return(). Never
    // let it hold CLI shutdown open; Node streams additionally support destroy.
    try { stream.destroy?.(); } catch { /* Preserve the input error. */ }
    try { void Promise.resolve(iterator.return?.()).catch(() => {}); } catch { /* Preserve the input error. */ }
    throw error;
  }
}

async function fileBytes(path: string, limit: number, signal: AbortSignal): Promise<Uint8Array> {
  signal.throwIfAborted();
  const opening = open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  let file: Awaited<typeof opening>;
  try { file = await cancellable(opening, signal); }
  catch (error) { void opening.then(handle => handle.close()).catch(() => {}); throw error; }
  try {
    const stat = await cancellable(file.stat(), signal);
    if (!stat.isFile()) throw new Error('WORLD_CLI_FILE_REQUIRED');
    if (stat.size > limit) throw new Error('JSON_SIZE_LIMIT');
    // Read at most limit + 1 even if the regular file grows after stat().
    const stream = file.createReadStream({ start: 0, end: limit, highWaterMark: 4096, autoClose: false, signal });
    return await streamBytes(stream, limit, signal);
  } finally { await file.close(); }
}

async function inputJson(path: string, limit: number, io: WorldCliIo): Promise<Record<string, unknown>> {
  io.signal?.throwIfAborted();
  const timeoutMs = io.inputTimeoutMs ?? 10000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw new Error('WORLD_CLI_INPUT_TIMEOUT_INVALID');
  const timeout = new AbortController(), signal = io.signal ? AbortSignal.any([io.signal, timeout.signal]) : timeout.signal;
  const timer = setTimeout(() => timeout.abort(new Error('WORLD_CLI_INPUT_TIMEOUT')), timeoutMs);
  try {
    if (path === '-' && !io.stdin && process.stdin.isTTY) throw new Error('WORLD_CLI_STDIN_PIPE_REQUIRED');
    const bytes = path === '-' ? await streamBytes(io.stdin ?? process.stdin, limit, signal) : await fileBytes(path, limit, signal);
    signal.throwIfAborted();
    return jsonObject(parseWorldJson(bytes, limit));
  } finally { clearTimeout(timer); }
}

/** Return the shared handler's JSON unchanged; the CLI root owns output and lifetime. */
export async function runWorldCliCommand(ctx: WorldCommandContext, args: ParsedWorldCliArgs, io: WorldCliIo = {}): Promise<Record<string, unknown>> {
  io.signal?.throwIfAborted();
  if (args.command === 'help') return { text: WORLD_COMMAND_HELP };
  // Capture routing and file names before the first input await.
  if (args.command === 'capabilities') return runWorldCapabilitiesCommand(ctx, { ...args.input });
  if (args.command === 'private_messages') return runWorldPrivateMessagesCommand(ctx, { ...args.input });
  if (args.command === 'action_status') return runWorldActionStatusCommand(ctx, { ...args.input });
  const input = { ...args.input }, path = args.jsonFile;
  const params = await inputJson(path, WORLD_PROTOCOL_LIMITS.L_PARAMS_MAX_BYTES, io);
  io.signal?.throwIfAborted();
  return runWorldInvokeCommand(ctx, { ...input, params });
}
