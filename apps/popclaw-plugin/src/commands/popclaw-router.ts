/**
 * /popclaw sub-router. Single entry point replacing the old 11 individual
 * /popclaw-xxx slash commands. Establishes P-001 — exactly one slash command,
 * subcommand naming/add/remove is internal.
 *
 * Each subcommand handler receives the original args object with the
 * positional[0] (which was the subcommand name) stripped off, so existing
 * runXxxCommand bodies can be reused unmodified.
 */

export interface SubcommandContext {
  args: {
    positional: string[];
    [flag: string]: unknown;
  };
}

/** A subcommand reply; `continueAgent` hands control to the agent (e.g. newspaper). */
export type SubcommandResult = { text: string; continueAgent?: boolean };

export type SubcommandHandler = (ctx: SubcommandContext) => Promise<SubcommandResult>;

export type SubcommandMap = Record<string, SubcommandHandler>;

export async function routeSubcommand(
  map: SubcommandMap,
  ctx: SubcommandContext,
): Promise<SubcommandResult> {
  const positional = ctx.args.positional ?? [];
  const subRaw = positional[0];

  if (!subRaw) {
    const help = map['help'];
    if (!help) {
      return { text: 'no subcommand and no help handler configured' };
    }
    return help({ args: { ...ctx.args, positional: [] } });
  }

  const sub = subRaw.toLowerCase();
  const handler = map[sub];
  if (!handler) {
    return {
      text:
        `unknown popclaw subcommand: "${subRaw}"\n` +
        `run /popclaw help for the list`,
    };
  }

  const subCtx: SubcommandContext = {
    args: { ...ctx.args, positional: positional.slice(1) },
  };
  return handler(subCtx);
}
