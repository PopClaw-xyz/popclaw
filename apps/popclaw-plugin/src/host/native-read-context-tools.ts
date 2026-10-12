import type { RegisterToolsDeps } from '../tools/tools-context.js';
import type { NativeReadContext } from './native-read-context.js';

/** Outer execution boundary: every tail, notice and read runs under one host scope. */
export function withNativeReadContext(api: RegisterToolsDeps['api'], context: NativeReadContext): RegisterToolsDeps['api'] {
  const wrap = (tool: unknown, hostContext: unknown): unknown => {
    const t = tool as { name?: string; execute?: (...args: unknown[]) => unknown } | null;
    if (typeof t?.name !== 'string' || typeof t.execute !== 'function') return tool;
    const execute = t.execute, name = t.name;
    return { ...t, execute: (...args: unknown[]) => context.run(hostContext, name, args[0], args[2],
      async () => execute.apply(t, args)) };
  };
  return { ...api, registerTool: (tool: unknown, options?: unknown) => {
    const descriptor = tool as { contextVersion?: number; create?: (ctx: unknown) => unknown } | null;
    const create = (ctx: unknown) => {
      const resolved = typeof tool === 'function' ? tool(ctx)
        : descriptor?.contextVersion === 2 && typeof descriptor.create === 'function' ? descriptor.create(ctx) : tool;
      return Array.isArray(resolved) ? resolved.map(t => wrap(t, ctx)) : wrap(resolved, ctx);
    };
    if (descriptor?.contextVersion === 2 && typeof descriptor.create === 'function') {
      api.registerTool({ ...descriptor, create }, options);
    } else {
      const name = typeof tool === 'object' && tool !== null ? (tool as { name?: unknown }).name : undefined;
      const hints = options as { name?: unknown; names?: unknown } | undefined;
      api.registerTool(create, typeof name === 'string' && hints?.name === undefined && hints?.names === undefined
        ? { ...(options as object), name } : options);
    }
  } };
}
