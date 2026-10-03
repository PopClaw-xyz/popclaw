/** Identity reads: someone's namecard, and the owner's own status report. */

import { EmptySchema, ShowNamecardSchema } from './tool-schemas.js';
import { renderDirective } from '../lexicon/directive.js';
import { runStatusCommand } from '../commands/status.js';
import { statusDepsFrom } from '../commands/status-deps.js';
import { unresolvedText } from '../identity/person-resolver.js';
import { runProfileCommand } from '../commands/profile.js';
import { collectingLogger } from '../runtime/collecting-logger.js';
import { type ToolsCtx } from './tools-context.js';
import { resolvePersonRef } from './person-sources.js';
import type { DreamCron } from './dream-taste-tools.js';

/**
 * The names a host has actually put the person under. `person` is the declared
 * parameter; the other three are what hosts guessed when they sent something
 * else, and an answer the owner can read beats a schema lecture nobody sees.
 * Order is precedence: the declared name wins over any guess.
 */
const NAMECARD_PERSON_KEYS = ['person', 'popclaw_id', 'name', 'id'] as const;

/**
 * The person argument, coerced at the tool boundary.
 *
 * `popclaw_show_namecard` registers through plain `api.registerTool` (no
 * `withTail` wrapper), so anything thrown in `execute` is handed to the agent
 * verbatim: `{}` used to come back as "Cannot read properties of undefined
 * (reading 'trim')". Empty string is the sentinel the resolver already answers
 * with `person.mustSayWho`, so everything unusable collapses onto it — the same
 * per-tool coercion the sibling tools do (name-taste-tools, world-tools).
 */
function namecardPersonArg(params: unknown): string {
  if (typeof params !== 'object' || params === null) return '';
  const record = params as Record<string, unknown>;
  for (const key of NAMECARD_PERSON_KEYS) {
    const value = record[key];
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  return '';
}

/** popclaw_show_namecard. */
export function registerNamecardTool(ctx: ToolsCtx): void {
  const { api, runtime, deps } = ctx;
  api.registerTool({
    name: 'popclaw_show_namecard',
    description:
      'Call this tool when the owner asks who someone is — "who is this?", "show me their namecard", ' +
      '"is that really them?", "are they verified?". ' +
      'Pass the person exactly as the owner referred to them, the tool resolves them itself ' +
      '(a nickname / name#sigil / a bare sigil / a full popclaw_id are all accepted). ' +
      'Returns their namecard: name#sigil, profile URL, verified accounts, and for each verified account ' +
      'the public proof post anyone can open and check for themselves. ' +
      'Relay the proof link verbatim — the whole point is that the owner does not have to take our word for it. ' +
      "The owner's own name works here too; popclaw_check_status is the fuller report on the owner themselves.",
    parameters: ShowNamecardSchema,
    execute: async (_callId: string, params: unknown) => {
      const ref = namecardPersonArg(params);
      // Resolve first: the by-id endpoint is the only one person-resolution can
      // address (a nickname is not a verified popclaw handle). Unresolved =>
      // say so; never fetch a namecard for a person we couldn't name.
      const person = await resolvePersonRef(ref, deps);
      if (person.kind !== 'resolved') {
        return { type: 'text' as const, text: unresolvedText(ref, person) };
      }
      const rt = await runtime();
      const r = await runProfileCommand(
        { target: person.popclawId },
        // The namecard is an unauthenticated GET at the house; it goes down
        // the public read lane so a second host (MCP beside a running
        // gateway) can answer it without owning the lifecycle.
        {
          loreHouseUrl: rt.boot.loreHouseUrl,
          ...(rt.boot.webBaseUrl === undefined ? {} : { webBaseUrl: rt.boot.webBaseUrl }),
          // So the owner's own card renders even on an identity no house has
          // ever been told about (a fresh `ranger-xxxxxx` is never published).
          ...(rt.boot.popclawId ? { self: { popclawId: rt.boot.popclawId, nickname: rt.boot.nickname ?? '' } } : {}),
          fetch: rt.houseRuntime?.houseReadFetch(rt.boot.loreHouseUrl) ?? globalThis.fetch,
        },
      );
      return { type: 'text' as const, text: r.text };
    },
  });
}

/** popclaw_check_status. */
export function registerStatusTool(ctx: ToolsCtx, dreamCron: DreamCron): void {
  const { api, runtime } = ctx;
  api.registerTool({
    name: 'popclaw_check_status',
    description:
      'Call this tool when the owner says "my status", "how am I doing", "how is my account". ' +
      "Show the owner's popclaw identity report: name#sigil, popclaw_id, profile URL, " +
      'verified accounts, follow/bond-book/DM counts, notify channel, and what is still missing. ' +
      'If the tool fails, tell the owner it failed — never make up a result. ' +
      'The result carries its own instructions for how to lay it out; follow them.',
    parameters: EmptySchema,
    execute: async () => {
      const rt = await runtime();
      const logger = collectingLogger();
      // Same deps as the slash-command path minus `buildStamp` — the host LLM
      // has no use for a build hash, but it DOES need the todo lines' commands.
      // `currentChannel` is omitted too: tools are registered as plain objects
      // (only the factory form gets a ctx with deliveryContext), so the notify-channel
      // line stays neutral instead of guessing "this channel".
      await runStatusCommand({
        ...(await statusDepsFrom(rt, logger)),
        // For the host LLM to relay: follow entries carry the full popclaw_id (so it can act directly), and the todo list gives all 3 items.
        audience: 'agent',
        dreamCron: await dreamCron(),
      });
      // The layout instruction rides in the RESULT, not in this tool's description.
      // That's where the nine call sites of `languageDirective()` put the same kind of
      // instruction, and `read-tools.ts`'s old description-side "relay verbatim" line was
      // already observed being ignored on a real host: a description is read once when the
      // model picks a tool, while the result sits in context next to the material it governs.
      return { type: 'text' as const, text: `${logger.lines.join('\n')}\n\n${renderDirective()}` };
    },
  });
}
