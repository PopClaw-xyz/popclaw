/** Dreaming and taste: the night digest, its write-back, and the one-time taste harvest. */
declare const __POPCLAW_BUILD__: string;

import { DreamToolSchema, RecordDreamSchema, WriteTasteSchema } from './tool-schemas.js';
import { failureText } from '../lexicon/owner-language.js';
import { readLearnedTaste, writeLearnedTaste, LEARNED_FROM_MEMORY } from '../taste/learned-writer.js';
import { writeTasteFromMemory } from '../taste/write-taste.js';
import {
  gatherDreamMaterials,
  recordDream,
  type GatherDreamDeps,
  type RecordDreamInput,
} from '../dreamer/dream.js';
import { readDreamCronState, type CronJobLike } from '../dreamer/dream-cron.js';
import { proposeTierChanges } from '../bonds/propose-tier-changes.js';
import type { Notifier } from '../notifier/notifier.js';
import { runDailyBackup } from '../host/daily-backup.js';
import { fileLastRun } from '../runtime/last-run.js';
import { readSocialLog } from '../social-log/social-log.js';
import { timeContext } from '../time/time-context.js';
import type { BondsStore } from '../bonds/bonds-store.js';
import type { ProposalsStore } from '../bonds/proposals-store.js';
import type { PopclawPaths } from '../host/popclaw-paths.js';
import { noteOwnerLanguage, type ToolsCtx } from './tools-context.js';
import { CRON_GRANT_ADVICE } from './cron-grant-advice.js';

// The single source of truth for "is it scheduled or not." **Read-only** — whether to
// schedule it and at what time is the owner's decision (spec §1); popclaw never writes
// this file. Unreadable is always treated as null (can't-find ≠ not-scheduled), and this
// nice-to-have signal must never be allowed to break the real work.
// `openclaw` is an **optional** peer dep: this module is host-agnostic and also runs under
// the MCP composition root (src/mcp.ts), where OpenClaw isn't installed. A static import
// would make the entire tool set fail to load there, so it's switched to an import-on-use;
// if the import fails, that degrades to null the same as an unreadable file.
const loadDreamCronStore = async (): Promise<{ jobs?: readonly CronJobLike[] } | null> => {
  const m = await import('openclaw/plugin-sdk/cron-store-runtime');
  return (await m.loadCronStore(m.resolveCronStorePath())) as { jobs?: readonly CronJobLike[] } | null;
};

export type DreamCron = () => ReturnType<typeof readDreamCronState>;

/** One reader shared by status (the "hasn't dreamed" todo) and the dream tools. */
export function createDreamCron(): DreamCron {
  return () => readDreamCronState(loadDreamCronStore);
}

/** popclaw_dream, popclaw_record_dream, popclaw_write_taste. */
export function registerDreamTasteTools(ctx: ToolsCtx, dreamCron: DreamCron): void {
  const { api, runtime } = ctx;
  // Dreaming has the same shape as the daily paper: popclaw_dream hands over materials, the
  // agent digests them using the host's model, and popclaw_record_dream files the result away.
  // The plugin never touches an LLM at any point (spec 2026-07-26 §0). The scheduled leg goes
  // through OpenClaw cron, **and it's the owner's single instruction that gets the agent to
  // schedule it** — the plugin never plants a scheduled task on the user's system on its own
  // initiative (§1).
  api.registerTool({
    name: 'popclaw_dream',
    // The description is squeezed into one line (ADR-0044 §4). Only two points that still
    // carry real weight are kept: the write-back step, and the two hard requirements for
    // scheduling (the job name `dream-cron` is the key for recognizing "has this been
    // scheduled"; leaving delivery on marks every night's dream as failed and, in turn, pushes
    // a failure notification that bothers the owner — confirmed on real hardware).
    description:
      'Dream / night digest (the owner says "have a dream", "digest things", or cron wakes you at the hour): ' +
      'take the material from "last dream → now" (new posts by the people they follow + the owner\'s own social actions), ' +
      'work out ① what you now know about each person ② the owner\'s taste tags, then call popclaw_record_dream to write it back. ' +
      "If the owner asks you to schedule it: name the job `popclaw-dream`, and turn that job's result delivery off. " +
      CRON_GRANT_ADVICE,
    parameters: DreamToolSchema,
    execute: async (_callId: string, params: unknown) => {
      try {
        // Dreaming = the settling-the-books moment: take the opportunity to also note down "what language the owner has actually been speaking lately" (the S1 observation lane).
        noteOwnerLanguage((params as { owner_language?: unknown } | undefined)?.owner_language);
        const rt = (await runtime()) as {
          bondsStore: BondsStore;
          worldFeedCache: GatherDreamDeps['cache'];
          tasteLoader: { enabledSources(): Promise<{ path: string; content: string }[]> };
          paths: PopclawPaths;
        };
        // The sovereignty layer's raw text: only feed in core/* (learned is my own previous conclusions, supplied separately, to avoid circularly confirming myself).
        const core = (await rt.tasteLoader.enabledSources())
          .filter((s) => s.path.startsWith('core/'))
          .map((s) => s.content.trim())
          .filter(Boolean)
          .join('\n\n');
        const r = gatherDreamMaterials({
          bondsStore: rt.bondsStore,
          cache: rt.worldFeedCache,
          readSocialLog: (from, to) => readSocialLog(rt.paths.socialLogDir(), from, to),
          coreTaste: core,
          learned: await readLearnedTaste({ tasteRoot: rt.paths.tasteDir() }),
          fromMemory: await readLearnedTaste({ tasteRoot: rt.paths.tasteDir() }, LEARNED_FROM_MEMORY),
          lastDreamAt: fileLastRun(rt.paths.dreamerStateFile()).get(),
          now: () => Math.floor(Date.now() / 1000),
          mintToken: () => `dream_${Math.random().toString(36).slice(2, 12)}`,
        });
        return { type: 'text' as const, text: r.kind === 'empty' ? r.message : r.payload };
      } catch (err) {
        return { type: 'text' as const, text: failureText('popclaw_dream', err) };
      }
    },
  });

  api.registerTool({
    name: 'popclaw_record_dream',
    description:
      'Call once the dream is thought through: writes the conclusions into the bond book and the taste file ' +
      '(not writing back means the whole dream was for nothing); ' +
      'taste.tags is required and non-empty — only tags can be matched locally. ' +
      'Pass the dream_basis the material printed back as the dream_basis argument (or copied into every people entry, same value) — ' +
      'checked exactly like dream_token, and it works even with no people to report; a hand-in with neither a real dream_token nor ' +
      'the basis is refused, and a refusal never consumes the material.',
    parameters: RecordDreamSchema,
    execute: async (_callId: string, params: unknown) => {
      try {
        noteOwnerLanguage((params as { owner_language?: unknown } | undefined)?.owner_language);
        const p = coerceRecordDream(params);
        const rt = (await runtime()) as {
          bondsStore: BondsStore;
          proposalsStore: ProposalsStore;
          host: { db: import('../host/host-db.js').HostDb };
          boot: {popclawId: string};
          paths: PopclawPaths;
          notifier: Notifier;
        };
        const now = () => Math.floor(Date.now() / 1000);
        const r = await recordDream(
          {
            bondsStore: rt.bondsStore,
            writeLearnedTaste: (t) => writeLearnedTaste({ tasteRoot: rt.paths.tasteDir() }, t),
            proposeTierChanges: () =>
              proposeTierChanges({ bondsStore: rt.bondsStore, proposalsStore: rt.proposalsStore, now }),
            // The night's findings go out as L2 — read to the owner the next
            // time they speak, which is what the dreamer's work was for.
            notify: (item) => rt.notifier.enqueue(item),
            stampDream: (ts) => fileLastRun(rt.paths.dreamerStateFile()).set(ts),
            dreamCron,
            backup: () =>
              runDailyBackup({
                paths: rt.paths,
                actorId: rt.boot.popclawId,
                installationId: rt.host.db.queryOne<{value:string}>("SELECT value FROM house_lifecycle_meta WHERE key='installation_id'")?.value ?? null,
                codeVersion: typeof __POPCLAW_BUILD__ !== 'undefined' ? __POPCLAW_BUILD__ : 'dev (unbundled)',
                date: timeContext(Math.floor(Date.now() / 1000)).ymd, // The owner's local date (ADR-0045: only this way does keep=7 match the owner's mental "the last 7 days")
                keep: 7,
              }),
            now,
            logger: api.logger
              ? { info: (m) => api.logger!.info(`popclaw: ${m}`), warn: (m) => api.logger!.info(`popclaw: ${m}`) }
              : undefined,
          },
          p,
        );
        return { type: 'text' as const, text: r.text };
      } catch (err) {
        return { type: 'text' as const, text: failureText('popclaw_record_dream', err) };
      }
    },
  });

  // A one-time harvest: the agent digs "who the owner is" out of **its own** memory, using
  // what it already knows.
  // popclaw does not read lcm.db — that's OpenClaw core's territory, and also the owner's
  // most private material; architecturally this is squarely the agent's job (the plugin
  // supplies structure, the agent supplies content). This tool only provides the write path.
  api.registerTool({
    name: 'popclaw_write_taste',
    description:
      'Call when the owner says "write up my taste", "what do you know about me" (for the full dig run /popclaw taste): ' +
      'write what you dug out of **your own memory** (memory_search / lcm_grep across all sessions / memory_get) about ' +
      '"what he has been caring about lately" into the taste file — **do not pad it with the persona from USER.md/SOUL.md** — ' +
      'and once written, read the returned content back to the owner verbatim, so he can overturn it on the spot.',
    parameters: WriteTasteSchema,
    execute: async (_callId: string, params: unknown) => {
      try {
        const rt = (await runtime()) as { paths: PopclawPaths };
        const r = await writeTasteFromMemory({ tasteRoot: rt.paths.tasteDir() }, params as never);
        return { type: 'text' as const, text: r.text };
      } catch (err) {
        return { type: 'text' as const, text: failureText('popclaw_write_taste', err) };
      }
    },
  });
}

/**
 * Normalizes popclaw_record_dream's input parameters. A host handing over a nested object
 * **stuffed into a JSON string** is a common reality (tool-call serialization is
 * inconsistent across hosts), and losing a whole night's dream conclusions to this is too
 * costly — if it's a string, try parsing it once; if the parse doesn't take, treat it as not
 * provided.
 */
export function coerceRecordDream(params: unknown): RecordDreamInput {
  const p = (params ?? {}) as Record<string, unknown>;
  const maybe = <T>(v: unknown): T | undefined => {
    if (typeof v === 'string') {
      try {
        return JSON.parse(v) as T;
      } catch {
        return undefined;
      }
    }
    return (v ?? undefined) as T | undefined;
  };
  const people = maybe<RecordDreamInput['people']>(p.people);
  return {
    dreamToken: String(p.dream_token ?? ''),
    // The basis leg travels under a plain, non-token name — a plain scalar (or
    // absent), no JSON-string coaxing needed; recordDream's cleanId strips any
    // surrounding quotes a chatty host adds.
    ...(typeof p.dream_basis === 'string' ? { dreamBasis: p.dream_basis } : {}),
    ...(Array.isArray(people) ? { people } : {}),
    ...(p.taste !== undefined ? { taste: maybe<RecordDreamInput['taste']>(p.taste) } : {}),
  };
}
