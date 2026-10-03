/**
 * The standalone rename tool and the always-open append into the
 * owner-sovereign taste core. Both lightweight and reversible.
 *
 * Split out of register-tools.ts (2026-08-25).
 */

import { SetNameSchema, NoteTasteSchema } from './tool-schemas.js';
import { ownerLang, failureText } from '../lexicon/owner-language.js';
import { renderCopy } from '../lexicon/index.js';
import { appendCorePrivate } from '../taste/taste-writer.js';
import { runPopclawNameCommand } from '../commands/popclaw-name.js';
import type { PopclawPaths } from '../host/popclaw-paths.js';
import type { ToolsCtx } from './tools-context.js';

/** Name + taste registrations, in their original order. */
export function registerNameTasteTools(ctx: ToolsCtx): void {
  const { api, runtime } = ctx;

  // === NAME TOOL (standalone rename, lightweight + reversible → execute directly) ===

  api.registerTool({
    name: 'popclaw_set_name',
    description:
      'Call when the owner explicitly asks to rename: "change my name to X / rename me to X / I want to be called X". ' +
      'Pass the name he wants as nickname. Renaming is lightweight and reversible — execute directly without confirmation; ' +
      'it re-signs the namecard. A name longer than 32 characters is refused and nothing changes. ' +
      'While onboarding is in progress, a naming answer is NOT a rename: pass it as answer to popclaw_onboarding_continue, ' +
      'which shows the owner a confirmation before anything is written.',
    parameters: SetNameSchema,
    execute: async (_callId: string, params: unknown) => {
      const p = params as { nickname?: unknown };
      const rt = (await runtime()) as {
        host: Parameters<typeof runPopclawNameCommand>[1]['host'];
        boot: {
          signer: Parameters<typeof runPopclawNameCommand>[1]['signer'];
          popclawId: string;
          loreHouseUrls: readonly string[];
          webBaseUrl?: string;
        };
        egress: Parameters<typeof runPopclawNameCommand>[1]['egress'];
      };
      const r = await runPopclawNameCommand(
        { nickname: typeof p.nickname === 'string' ? p.nickname : '' },
        {
          host: rt.host,
          signer: rt.boot.signer,
          egress: rt.egress,
          popclawId: rt.boot.popclawId,
          clock: rt.host.clock,
          houseOrigins: rt.boot.loreHouseUrls,
          ...(rt.boot.webBaseUrl === undefined ? {} : { webBaseUrl: rt.boot.webBaseUrl }),
        },
      );
      return { type: 'text' as const, text: r.text };
    },
  });

  // === TASTE TOOL (append to the owner-sovereign taste core) ===
  // The onboarding question only solves the cold-start problem; the sovereignty layer must
  // be appendable **at any time**, otherwise an owner who has already finished onboarding
  // could never add taste again. This goes through the same appendCorePrivate — no separate
  // write path is invented.

  api.registerTool({
    name: 'popclaw_note_taste',
    description:
      'Call whenever the owner mentions in passing what he cares about / does not want to see / likes or dislikes reading — ' +
      '"lately I am really into the implementation details of spaceflight engineering", "stop showing me this crypto shilling", ' +
      '"I like long pieces that explain the principles clearly, I dislike clickbait", "note this down, I am following distributed systems". ' +
      'Do not wait for the owner to say "please record my taste" — he never will; ' +
      'the moment his words carry an interest, a dislike or a field of attention, jot it down. ' +
      "Pass the owner's own words as note, do not summarise them for him or reduce them to tags. " +
      'It is written into the taste space private to his own machine (never uploaded), and the daily paper and recommendations follow it; ' +
      'lightweight and reversible — execute directly without confirmation.',
    parameters: NoteTasteSchema,
    execute: async (_callId: string, params: unknown) => {
      try {
        const p = params as { note?: unknown };
        const note = typeof p.note === 'string' ? p.note.trim() : '';
        if (!note) {
          return { type: 'text' as const, text: renderCopy(ownerLang(), 'taste.note.empty') };
        }
        const rt = (await runtime()) as { paths: PopclawPaths };
        await appendCorePrivate({ tasteRoot: rt.paths.tasteDir() }, note);
        return {
          type: 'text' as const,
          text: renderCopy(ownerLang(), 'taste.note.saved'),
        };
      } catch (err) {
        return { type: 'text' as const, text: failureText('popclaw_note_taste', err) };
      }
    },
  });
}
