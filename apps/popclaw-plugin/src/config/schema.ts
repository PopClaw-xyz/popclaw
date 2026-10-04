import { z } from 'zod';
import { worldPublicKey } from '../world/action-wire.js';

const executionUtc = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/).refine(value => {
  const at = Date.parse(value);
  return Number.isFinite(at) && new Date(at).toISOString().replace('.000Z', 'Z') === value;
});
const executionIdentity = z.string().refine(value => { try { worldPublicKey(value); return true; } catch { return false; } });
/** Host-owned configuration only; intentionally not a field of PluginConfig. */
export const WorldExecutionPolicy = z.object({
  agentId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/),
  actorId: executionIdentity,
  house: z.string().refine(value => {
    try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && url.origin === value && !url.username && !url.password; }
    catch { return false; }
  }),
  houseKey: executionIdentity.optional(),
  // An owner must explicitly bind a standing grant to the completed recovery.
  recoveryDecisionId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).optional(),
  kinds: z.array(z.string().regex(/^[a-z0-9]{1,24}\.[a-z0-9_]{1,24}(?:\.[a-z0-9_]{1,24})?$/)).min(1).max(256)
    .refine(values => new Set(values).size === values.length),
  authorizedAt: executionUtc,
  expiresAt: executionUtc,
}).strict().refine(policy => {
  const duration = Date.parse(policy.expiresAt) - Date.parse(policy.authorizedAt);
  return duration > 0 && duration <= 86_400_000;
}, 'Execution policy lifetime must be positive and at most 24 hours');
export const WorldExecutionConfig = z.object({ policies: z.array(WorldExecutionPolicy).max(64) }).strict();
export type WorldExecutionPolicy = z.infer<typeof WorldExecutionPolicy>;

export const ScraperConfig = z.object({
  interval_ms: z.number().int().positive().default(5000),
  dir: z.literal('events').default('events'),
});

export const RangerProfile = z.object({
  nickname: z.string().min(1).max(32).optional(),
  /** Pinned namecard declared_at (unix seconds), namecard self-heal proposal
   *  §2.1 (issue #280). Read/written raw via loadJson (like name_source) —
   *  not through the parsed PluginConfig — so this entry documents the shape
   *  rather than gating access to it. */
  namecard_declared_at: z.number().int().optional(),
});

// Plan 10: watch-loop pacing for ranger_mode plugins.
export const WatchConfig = z.object({
  tick_interval_ms: z.number().int().positive().default(10_000),
  heartbeat_interval_ms: z.number().int().positive().default(60_000),
  max_scan_items: z.number().int().positive().default(20),
});
export type WatchConfig = z.infer<typeof WatchConfig>;

/**
 * The newspaper's own profile (cut 2 of the 2026-09-03 dedicated-session
 * proposal): producing a paper is the heaviest LLM job popclaw ever hands a
 * host, and it deserves its own model, independent of whatever model the owner
 * picked for chatting.
 */
export const NewspaperConfig = z.object({
  /**
   * What the finished page is allowed to reach for (owner ruling 2026-09-12:
   * **zero dependency, not zero network**). A paper saved to disk must need no
   * popclaw service to be a paper, and must hand nobody a record of what the
   * owner reads — but it may still pull the same third-party static assets the
   * hosted page pulls, so the local copy looks like the one online.
   *
   * `web` (default): link the font stylesheets (zeoseven, jsdelivr, Google
   * Fonts), as today. Offline that falls back to the system stacks.
   * `system`: link nothing, set everything in the faces the machine already has
   *  — for an owner who would rather his browser asked no one for anything.
   */
  fonts: z.enum(['web', 'system']).default('web'),
  /**
   * `inline` (default): the faces are fetched once at publish time and baked
   * into the page as data URIs, so no reader ever reaches unavatar.io; a face
   * that cannot be baked falls back to the monogram we draw ourselves.
   * `off`: no face is fetched at all, by anyone — every face is the monogram.
   */
  avatars: z.enum(['inline', 'off']).default('inline'),
  /**
   * The model the dedicated newspaper workshop session writes on. Empty or
   * absent = the host's default model — the dispatch then omits the `model`
   * key entirely, which needs no host-side authorization. Setting it requires
   * the HOST-side grant `plugins.entries.popclaw.subagent.allowModelOverride:
   * true` (optionally an `allowedModels` whitelist); without that grant the
   * host refuses the dispatch and the paper falls back to the in-session flow
   * on the default model — which says so in its receipt, never silently.
   */
  model: z.string().optional(),
});
export type NewspaperConfig = z.infer<typeof NewspaperConfig>;

export const PluginConfig = z.object({
  /** The lore-houses to connect to — **connects to all of them**, with `[0]` as the home house.
   *  The structure is unchanged, zero-config migration — what changed is the semantics: before,
   *  only `[0]` was ever consumed; now the read side opens a separate cache and world stream
   *  per house (Spec B slice ①/②). The write side still routes everything through the home
   *  house, with routing left to slice ③. */
  lore_houses: z.array(z.string().url()).min(1),
  /** Base URL of the popclaw-canvas service. Lives in popclaw's own config (like
   *  lore_houses) so off-box hosts point at the dev/prod canvas without touching
   *  the host environment. Absent → POPCLAW_CANVAS_BASE_URL env → public default.
   *
   *  `""` is a value, not a mistake: it is how the owner says **there is no
   *  publisher**. The paper is still written and saved on this machine; nothing
   *  is uploaded, the follow doorbell stops polling, and the publisher-only tools
   *  say so. A bare `.url()` rejected it, which left "off" unsayable in the one
   *  file where the decision belongs. */
  canvas_base_url: z.union([z.literal(''), z.string().url()]).optional(),
  /** Base URL of the popclaw.me web app for clickable post/profile links. Same
   *  reasoning as canvas_base_url — lives in popclaw config, not the client env.
   *  Absent → POPCLAW_WEB_BASE_URL env → https://popclaw.me. */
  web_base_url: z.string().url().optional(),
  /** The newspaper's own model profile (see NewspaperConfig). Absent = the
   *  workshop follows the host's default model. */
  newspaper: NewspaperConfig.optional(),
  scraper: ScraperConfig.default({ interval_ms: 5000, dir: 'events' }),
  ranger_mode: z.boolean().default(false),
  ranger_profile: RangerProfile.optional(),
  watch: WatchConfig.default({
    tick_interval_ms: 10_000,
    heartbeat_interval_ms: 60_000,
    max_scan_items: 20,
  }),
});

export type PluginConfig = z.infer<typeof PluginConfig>;
