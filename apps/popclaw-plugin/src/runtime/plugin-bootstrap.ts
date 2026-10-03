import type { HostAdapter } from '../host/host-adapter.js';
import { Keystore } from '../identity/keystore.js';
import { MasterKeySigner } from '../identity/master-key-signer.js';
import { loadPluginConfig } from '../config/loader.js';
import type { PluginConfig } from '../config/schema.js';
import type { Signer } from '../identity/signer.js';
import { resolveWebBaseUrl } from '../lshow/sources/web-fallback.js';
import { resolveCanvasBaseUrl } from '../canvas/canvas-fallback.js';
import { hostDbSlug } from '../ingress/host-slug.js';
import { PopclawPaths } from '../host/popclaw-paths.js';
import { onNicknamePersisted } from '../onboarding/identity-writer.js';

export interface BootstrappedPlugin {
  readonly host: HostAdapter;
  readonly signer: Signer;
  readonly popclawId: string;
  readonly config: PluginConfig;
  /** Home lore-house = `config.lore_houses[0]`. The write side and other single-house modules keep using this. */
  readonly loreHouseUrl: string;
  /** All lore-houses to connect to, in config order — `[0]` is still the home house (Spec B
   *  slice ①: the semantics flipped from "take the first one" to "connect to all of them").
   *  Duplicate writes to the same house (same host slug) are deduped to one.
   *  The read side opens a separate cache/stream per house; write-side routing is slice ③. */
  readonly loreHouseUrls: readonly string[];
  /** Base URL of the popclaw.me web app for clickable post/profile links.
   *  config.web_base_url → POPCLAW_WEB_BASE_URL env → https://popclaw.me.
   *  See memory popclaw-web-base-url-localhost-mvp. */
  readonly webBaseUrl: string;
  /** Base URL of the popclaw-canvas service, or `null` when the owner has switched
   *  the publisher off (an explicit empty `canvas_base_url` / `POPCLAW_CANVAS_BASE_URL`).
   *  config.canvas_base_url → POPCLAW_CANVAS_BASE_URL env → canvas.popclaw.me default.
   *  `null` is load-bearing: every publisher surface checks it and stands down. */
  readonly canvasBaseUrl: string | null;
  readonly nickname: string;
  /** True when THIS boot minted a brand-new keypair (no master.key existed).
   *  Callers must log it differently — see index.ts / main.ts boot lines. */
  readonly identityGenerated: boolean;
}

/**
 * `{...boot, ...extra}` without flattening `boot.nickname`'s getter into the
 * value it had at that moment — object spread copies values, not accessors,
 * and that copy is exactly what kept signing the pre-rename name.
 */
export function extendBoot<B extends object, E extends object>(boot: B, extra: E): Omit<B, keyof E> & E {
  return Object.defineProperties({}, {
    ...Object.getOwnPropertyDescriptors(boot),
    ...Object.getOwnPropertyDescriptors(extra),
  }) as Omit<B, keyof E> & E;
}

/**
 * Shared setup for both LocalHostAdapter (dev CLI via main.ts) and
 * OpenClawHostAdapter (plugin via index.ts). Produces identity + signer
 * + merged config + lore-house URL + effective nickname. Callers build
 * transport adapters (scraper/egress/ingress) on top.
 *
 * Fails fast if config.lore_houses is empty (both code paths need at
 * least one URL to push to).
 */
export async function bootstrapPlugin(
  host: HostAdapter,
  /** Where this host would have put the root if POPCLAW_DATA_ROOT weren't set — see `noticeSecondRoot`. */
  defaultStateDir?: string,
): Promise<BootstrappedPlugin> {
  const config = await loadPluginConfig(host);
  const key = await new Keystore(host).loadOrGenerate();
  noticeSecondRoot(host, defaultStateDir, key.popclawId);
  const signer = new MasterKeySigner(key);
  const loreHouseUrl = config.lore_houses[0];
  if (!loreHouseUrl) {
    throw new Error('config.lore_houses must have at least one URL');
  }
  // Writing the same house twice (a config slip) → two SSE streams writing into the same
  // <slug>.db. Reject distinct origins before deduplicating equivalent URLs.
  const bySlug = new Map<string, string>();
  for (const url of config.lore_houses) {
    const slug = hostDbSlug(url);
    const previous = bySlug.get(slug);
    if (previous && new URL(previous).origin !== new URL(url).origin) {
      throw new Error(`HOUSE_ORIGIN_SLUG_COLLISION: ${previous} and ${url}`);
    }
    if (!previous) bySlug.set(slug, url);
  }
  // Live, not a snapshot: a rename in this process (popclaw_set_name,
  // onboarding) updates it, so everything that reads `boot.nickname` at use
  // time — post, reply, DM and mark signing — signs the current name.
  let nickname =
    config.ranger_profile?.nickname ?? `ranger-${key.popclawId.slice(0, 6)}`;
  onNicknamePersisted(host, (next) => {
    nickname = next;
  });
  // …and a rename in ANOTHER process on the same data root (the gateway and
  // an MCP server side by side) never fires that listener. So on access,
  // re-read the persisted name when the config file changed on disk; a stat
  // per access, a read only when the mtime moved. Any failure keeps the
  // in-process value.
  const cfg = host.config;
  let seenVersion: string | null = null;
  const currentNickname = (): string => {
    if (!cfg.versionOf || !cfg.loadJsonSync) return nickname;
    try {
      const version = cfg.versionOf('plugin');
      if (version !== null && version !== seenVersion) {
        const persisted = (cfg.loadJsonSync('plugin') as { ranger_profile?: { nickname?: unknown } } | null)
          ?.ranger_profile?.nickname;
        // Marked seen only after a successful parse, so a read that failed is
        // retried on the next access even if the version has not moved.
        seenVersion = version;
        if (typeof persisted === 'string' && persisted.trim()) nickname = persisted.trim();
      }
    } catch {
      // Unreadable or mid-write: the in-process value stands.
    }
    return nickname;
  };
  const webBaseUrl = resolveWebBaseUrl(config.web_base_url);
  const canvasBaseUrl = resolveCanvasBaseUrl(config.canvas_base_url);
  return {
    host,
    signer,
    popclawId: key.popclawId,
    config,
    loreHouseUrl,
    loreHouseUrls: [...bySlug.values()],
    webBaseUrl,
    canvasBaseUrl,
    get nickname() {
      return currentNickname();
    },
    identityGenerated: key.generated,
  };
}

/**
 * "There are two of you on this machine, and one of them is speaking right now."
 *
 * The 2026-07-26 incident wasn't that two data roots existed — the TUI on the default
 * root and the gateway on an overridden one is a perfectly legal setup, and our own
 * fleet depends on it. It was that nothing said so, so every symptom for the next
 * stretch got debugged against the wrong identity.
 *
 * So: never a warning, never a gate, and `info` for the same reason the mint line is
 * (see keystore.ts). Only detectable when POPCLAW_DATA_ROOT is set — with no override
 * there's no second candidate to name — which is also the only way a root goes wrong.
 */
function noticeSecondRoot(host: HostAdapter, stateDir: string | undefined, popclawId: string): void {
  if (!stateDir) return;
  const other = PopclawPaths.shadowedRootWithIdentity(process.env, stateDir);
  if (!other) return;
  host.logger.info(
    { in_use: process.env.POPCLAW_DATA_ROOT, other, popclaw_id: popclawId },
    'popclaw: another popclaw identity lives at `other` on this machine; this process is using ' +
      '`in_use` (popclaw_id above). Both are legitimate — say which one you meant if something ' +
      'looks like it lost its memory.',
  );
}
