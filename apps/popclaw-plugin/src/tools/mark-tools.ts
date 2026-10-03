/**
 * Mark / unmark / show marks (Task 9): a public +1 on a post, signed by the owner.
 * Lightweight and reversible, so they execute directly.
 *
 * Split out of register-tools.ts (2026-08-25).
 */

import { failureText } from '../lexicon/owner-language.js';
import { MarkIdSchema, ShowMarksSchema } from './tool-schemas.js';
import {
  runPopclawMarkCommand,
  runPopclawUnmarkCommand,
  runPopclawMarksCommand,
} from '../commands/popclaw-mark.js';
import type { ToolsCtx } from './tools-context.js';

/** Mark-tool registrations, in their original order. */
export function registerMarkTools(ctx: ToolsCtx): void {
  const { api, runtime } = ctx;

  // === MARK TOOLS (Task 9: direct-execute, lightweight reversible value annotation) ===
  // Mark/unmark are a +1/-1 on a post, signed by the owner — lightweight and reversible,
  // so they execute directly (no draft+confirm pattern). Same rule as popclaw_follow.

  api.registerTool({
    name: 'popclaw_mark',
    description:
      'Mark a feed item as valuable (a +1 on the post, signed by you; local snapshot feeds taste). ' +
      'Lightweight and reversible — execute directly without confirmation. ' +
      'id = event_id hex prefix (≥6 chars) or [platform:]postId.',
    parameters: MarkIdSchema,
    execute: async (_callId: string, params: unknown) => {
      try {
        const p = params as { id: string };
        const rt = await runtime();
        const reply = await runPopclawMarkCommand(
          { positional: [p.id] },
          {
            cache: rt.worldFeedCache,
            markService: rt.markService,
            socialLog: rt.socialLog,
            nameOf: rt.nameOf,
          },
        );
        return { type: 'text' as const, text: reply.text };
      } catch (err) {
        return { type: 'text' as const, text: failureText('popclaw_mark', err) };
      }
    },
  });

  api.registerTool({
    name: 'popclaw_unmark',
    description:
      'Revoke a previous mark on a feed item (idempotent — safe to call even if not currently marked). ' +
      'Lightweight and reversible — execute directly without confirmation. ' +
      'id = event_id hex prefix (≥6 chars) or [platform:]postId.',
    parameters: MarkIdSchema,
    execute: async (_callId: string, params: unknown) => {
      try {
        const p = params as { id: string };
        const rt = await runtime();
        const reply = await runPopclawUnmarkCommand(
          { positional: [p.id] },
          {
            cache: rt.worldFeedCache,
            markService: rt.markService,
            store: rt.marksStore,
            socialLog: rt.socialLog,
            nameOf: rt.nameOf,
          },
        );
        return { type: 'text' as const, text: reply.text };
      } catch (err) {
        return { type: 'text' as const, text: failureText('popclaw_unmark', err) };
      }
    },
  });

  api.registerTool({
    name: 'popclaw_show_marks',
    description:
      "List the user's marked items (newest first) with short ids usable for follow-up actions (reply/quote/unmark). " +
      'Use when user asks "what did I mark", "my marks".',
    parameters: ShowMarksSchema,
    execute: async (_callId: string, params: unknown) => {
      try {
        const p = params as { limit?: number };
        const rt = await runtime();
        const reply = await runPopclawMarksCommand(
          { flags: p.limit ? { limit: String(Math.floor(p.limit)) } : {} },
          { store: rt.marksStore, nameOf: rt.nameOf },
        );
        return { type: 'text' as const, text: reply.text };
      } catch (err) {
        return { type: 'text' as const, text: failureText('popclaw_show_marks', err) };
      }
    },
  });

}
