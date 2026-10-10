/** Native run identity and input presence. No authority, history or runtime boot lives here. */
// eslint-disable-next-line no-restricted-imports -- Native host execution boundary owns async context; no business module imports Node APIs.
import { AsyncLocalStorage } from 'node:async_hooks';
import { getOrCreatePerProcess } from '../runtime/once.js';
import type { GuideReadScope } from '../runtime/read-request-scope.js';
import { observedHouseGuideKeys } from '../world/house-guide-context.js';

export interface NativeInputObservation { readonly scope: GuideReadScope; readonly keys: ReadonlySet<string> }
export interface NativeReadContext {
  observe(event: unknown, context: unknown): NativeInputObservation | undefined;
  beforeToolCall(event: unknown, context: unknown): void;
  afterToolCall(event: unknown, context: unknown): void;
  endRun(event: unknown, context: unknown): void;
  reset(event: unknown, context: unknown): void;
  closeAll(): void;
  current(): GuideReadScope | undefined;
  run<T>(context: unknown, toolName: string, callId: unknown, signal: unknown, work: () => Promise<T>): Promise<T>;
}
type Fields = Record<string, unknown>;
const fields = (value: unknown): Fields => value && typeof value === 'object' ? value as Fields : {};
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const identityFields = ['agentId', 'sessionKey', 'sessionId', 'runId'] as const;
type Identity = Record<typeof identityFields[number], string>;
function agreed(event: Fields, context: Fields, name: string): string | undefined {
  const left = event[name], right = context[name];
  if (left !== undefined && !text(left) || right !== undefined && !text(right)) return;
  if (left !== undefined && right !== undefined && left !== right) return;
  return text(left) ? left : text(right) ? right : undefined;
}
function identity(event: Fields, context: Fields): Identity | undefined {
  const values = identityFields.map(name => agreed(event, context, name));
  if (values.some(value => value === undefined)) return;
  return Object.fromEntries(identityFields.map((name, i) => [name, values[i]])) as Identity;
}
const runKey = (id: Identity) => JSON.stringify(identityFields.map(name => id[name]));
const callKey = (id: Pick<Identity, 'agentId' | 'sessionKey' | 'sessionId'>, name: string, callId: string) =>
  JSON.stringify([id.agentId, id.sessionKey, id.sessionId, name, callId]);
type Run = { readonly id: Identity; readonly scope: GuideReadScope; live: boolean };
type Call = { readonly run: Run };
type PendingGuide = Parameters<NonNullable<GuideReadScope['stageGuideEmission']>>[1];

export function createNativeReadContext(): NativeReadContext {
  const runs = new Map<string, Run>(), calls = new Map<string, Call>();
  const storage = new AsyncLocalStorage<{ scope: GuideReadScope | undefined; pending: Map<string, PendingGuide> }>();
  const close = (run: Run) => {
    run.live = false;
    if (runs.get(runKey(run.id)) === run) runs.delete(runKey(run.id));
    for (const [key, call] of calls) if (call.run === run) calls.delete(key);
  };
  const closeMatching = (source: Fields, names: readonly string[] = identityFields) => {
    const supplied = names.filter(name => text(source[name]));
    // Unknown input cannot establish continuity. Invalidation is conservative;
    // it never creates a new scope or substitutes another conversation.
    for (const run of runs.values()) if (supplied.every(name => run.id[name as keyof Identity] === source[name])) close(run);
  };
  const callIdentity = (event: unknown, context: unknown) => {
    const e = fields(event), c = fields(context), id = identity(e, c);
    const name = agreed(e, c, 'toolName'), callId = agreed(e, c, 'toolCallId');
    return id && name && callId ? {id, name, key: callKey(id, name, callId)} : undefined;
  };
  return {
    observe(event, context) {
      const e = fields(event), c = fields(context), id = identity(e, c);
      if (!id || !Array.isArray(e.historyMessages)) {
        closeMatching(c); closeMatching(e); return;
      }
      const key = runKey(id), previous = runs.get(key);
      if (previous) close(previous);
      const observed = observedHouseGuideKeys(e.historyMessages), emitted = new Set<string>();
      const scope: GuideReadScope = Object.freeze({ token: Object.freeze({}),
        isCurrent: () => run.live && runs.get(key) === run,
        get presentGuideKeys(): ReadonlySet<string> { return new Set([...observed, ...emitted]); },
        stageGuideEmission(text: string, render: PendingGuide) {
          const consumer = storage.getStore();
          if (consumer?.scope === scope && scope.isCurrent()) consumer.pending.set(text, render);
        },
        recordEmittedGuideKeys(keys: Iterable<string>) {
          if (scope.isCurrent()) for (const guide of keys) emitted.add(guide);
        },
      });
      const run: Run = { id, scope, live: true }; runs.set(key, run);
      return { scope, keys: observed };
    },
    beforeToolCall(event, context) {
      const call = callIdentity(event, context);
      if (!call) {
        const e = fields(event), c = fields(context);
        if ([e.toolName, c.toolName].some(name => text(name) && name.startsWith('popclaw_'))) {
          closeMatching(c); closeMatching(e);
        }
        return;
      }
      if (!call.name.startsWith('popclaw_')) return;
      const run = runs.get(runKey(call.id)), previous = calls.get(call.key);
      if (!run?.scope.isCurrent()) { if (previous) close(previous.run); return; }
      if (previous && previous.run !== run) {
        // Factory contexts have no runId. Neither colliding run may win by
        // arrival order, including a scope an earlier execute already captured.
        close(previous.run); close(run); return;
      }
      if (!previous) calls.set(call.key, {run});
    },
    afterToolCall(event, context) {
      const call = callIdentity(event, context);
      if (call && calls.get(call.key)?.run.id.runId === call.id.runId) calls.delete(call.key);
    },
    endRun(event, context) {
      const id = identity(fields(event), fields(context));
      const run = id && runs.get(runKey(id));
      if (run) close(run);
    },
    reset(event, context) {
      const e = fields(event), c = fields(context);
      // A compaction can rotate the physical session. Revoke both generations;
      // a subsequent llm_input, not this event, establishes new input presence.
      const base = {...c, ...e};
      closeMatching(base, ['agentId', 'sessionKey', 'sessionId']);
      if (text(e.previousSessionId)) closeMatching({...base, sessionId:e.previousSessionId}, ['agentId', 'sessionKey', 'sessionId']);
    },
    closeAll() { for (const run of runs.values()) close(run); },
    // Preserve the captured object after revocation. Returning undefined would
    // let a caller mistake an expired request for an ordinary unscoped read.
    current: () => storage.getStore()?.scope,
    async run<T>(context: unknown, name: string, callId: unknown, signal: unknown, work: () => Promise<T>) {
      const ctx = fields(context);
      const bound = ['agentId', 'sessionKey', 'sessionId'].every(field => text(ctx[field]));
      const key = bound && text(callId) ? callKey(ctx as unknown as Identity, name, callId) : undefined;
      const call = key ? calls.get(key) : undefined;
      let scope = call?.run.scope;
      if (ctx.runId !== undefined && ctx.runId !== call?.run.id.runId) scope = undefined;
      if (typeof ctx.assertInvocationCurrent !== 'function') scope = undefined;
      try {
        if (typeof ctx.assertInvocationCurrent === 'function') ctx.assertInvocationCurrent();
        if (signal instanceof AbortSignal) signal.throwIfAborted();
        // run(undefined) intentionally masks a parent ALS scope when the exact
        // bridge is unavailable; there is no "last session" fallback.
        const pending = new Map<string, PendingGuide>();
        let result: T = await storage.run({scope, pending}, work);
        if (signal instanceof AbortSignal) signal.throwIfAborted();
        if (typeof ctx.assertInvocationCurrent === 'function') ctx.assertInvocationCurrent();
        // Rewrite only a text value registered by this tool's own tail. Notice
        // and route awaits have finished; aborted consumers cannot publish a
        // suppression key, and a successful sibling wins atomically here.
        const finalizeText = (value: unknown): unknown => {
          if (typeof value !== 'string') return value;
          const render = pending.get(value);
          if (!render || !scope) return value;
          const current = scope.isCurrent();
          const rendered = render(current ? scope.presentGuideKeys : new Set<string>());
          if (current) scope.recordEmittedGuideKeys(rendered.keys);
          return rendered.text;
        };
        if (pending.size && result && typeof result === 'object') {
          const output = result as { text?: unknown; content?: unknown[] };
          if (typeof output.text === 'string') result = {...output, text: finalizeText(output.text)} as T;
          else if (Array.isArray(output.content)) result = {...output, content: output.content.map(block => {
            const item = fields(block);
            return item.type === 'text' && typeof item.text === 'string' ? {...item, text: finalizeText(item.text)} : block;
          })} as T;
        }
        return result;
      } finally {
        if (key && calls.get(key) === call) calls.delete(key);
      }
    },
  };
}

/** Hook and tool registrations may come from distinct bundles in one process. */
export function sharedNativeReadContext(): NativeReadContext {
  return getOrCreatePerProcess('native-read-context-v1', createNativeReadContext);
}
