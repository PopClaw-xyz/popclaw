import { basename, dirname, join, resolve } from 'node:path';
import { existsSync } from 'node:fs';

/**
 * Single source of truth for popclaw's on-disk layout under one root:
 *   <root>/config/   settings (re-settable)
 *   <root>/data/     projections; legacy mixed source files remain protected until classified
 *   <root>/vault/    precious (P-006 sacred): social/, wallet/, taste/
 * Nothing else in the codebase should compute a data path; everything goes
 * through here. See spec 2026-06-17-popclaw-data-dir-layout-design.md.
 */
export class PopclawPaths {
  constructor(private readonly root: string) {}

  /** Root = POPCLAW_DATA_ROOT override, else <stateDir>/popclaw. */
  static resolveRoot(env: NodeJS.ProcessEnv, stateDir: string): string {
    return env.POPCLAW_DATA_ROOT ?? join(stateDir, 'popclaw');
  }

  /**
   * The root an override is stepping over, if a real identity lives there — otherwise
   * `undefined`. Only meaningful when POPCLAW_DATA_ROOT is set: with no override there is
   * no second candidate to compare against, which is also the only way a root goes wrong.
   *
   * `undefined` when the shadowed root is merely an empty directory: telling someone
   * "there might be another you somewhere" is worse than saying nothing.
   */
  static shadowedRootWithIdentity(env: NodeJS.ProcessEnv, stateDir: string): string | undefined {
    const override = env.POPCLAW_DATA_ROOT;
    if (!override) return undefined;
    const shadowed = join(stateDir, 'popclaw');
    if (resolve(shadowed) === resolve(override)) return undefined;
    return existsSync(join(new PopclawPaths(shadowed).identityDir(), 'master.key')) ? shadowed : undefined;
  }

  /** The root itself (sentinel READMEs live at this level). */
  rootDir(): string { return this.root; }

  // config/
  config(): string { return join(this.root, 'config'); }
  configFile(name: string): string { return join(this.root, 'config', `${name}.json`); }
  cadenceDir(): string { return join(this.root, 'config', 'cadence'); }

  // data/
  data(): string { return join(this.root, 'data'); }
  lorehousesDir(): string { return join(this.root, 'data', 'lorehouses'); }
  lorehouseDb(slug: string): string { return join(this.root, 'data', 'lorehouses', `${slug}.db`); }
  worldFeedProjectionDb(slug: string): string { return join(this.lorehousesDir(), `${slug}.projection-v1.db`); }
  /** The house-connection handshake cache (ADR-0041): the billboard digest + two ETags. Regenerable → data/. */
  houseHandshakeFile(slug: string): string { return join(this.root, 'data', 'lorehouses', `${slug}.handshake.json`); }
  /** This house's guide document body (ADR-0041). The house's own documentation — delete it and a restart brings it back → data/. */
  houseGuideFile(slug: string): string { return join(this.root, 'data', 'lorehouses', `${slug}.guide.md`); }
  /** This house's digest snapshot + ETag for the daily paper (slice G). If the house is down, this is used to degrade gracefully → data/. */
  houseDigestFile(slug: string): string { return join(this.root, 'data', 'lorehouses', `${slug}.digest.json`); }
  scoreCacheFile(): string { return join(this.root, 'data', 'score-cache.json'); }
  newspaperDir(): string { return join(this.root, 'data', 'newspaper'); }
  lastNewspaperHtml(): string { return join(this.root, 'data', 'newspaper', 'last-newspaper.html'); }
  /**
   * The archive of published issues, one `<YYYYMMDD-HHmmss>-<issue id>.html` per paper.
   * **The master copy**: the paper is written here first and the publisher only ever
   * hands out a short link to a copy of it, so a dead/absent publisher costs the owner
   * a link, never the issue. Swept to 14 days on every publish (fixed, not a knob), and
   * re-derivable from nothing — the material is gone with the issue — but disposable in
   * the sense data/ means: losing it loses no identity, no log, no taste.
   */
  newspaperIssuesDir(): string { return join(this.root, 'data', 'newspaper', 'issues'); }
  /**
   * The ledger of F2 material tokens (slice H): gather writes one, publish reads one. **Must
   * persist to disk** — when the main agent delegates producing the daily paper to a subagent,
   * the two calls don't share the same plugin context, so an in-process-memory ledger would
   * inevitably come back empty (a real-machine incident on 2026-07-31). 2-hour TTL, swept
   * opportunistically on write, regenerable → data/.
   */
  newspaperManifestsDir(): string { return join(this.root, 'data', 'newspaper', 'manifests'); }
  /** Faces baked into published issues, kept between issues so a repeat author costs no fetch. */
  newspaperAvatarsDir(): string { return join(this.root, 'data', 'newspaper', 'avatars'); }
  /** The old location of canvas-style.md (data/). **For one-time migration only** — don't write here anymore. */
  legacyCanvasStyleFile(): string { return join(this.root, 'data', 'canvas-style.md'); }
  dreamerStateFile(): string { return join(this.root, 'data', 'dreamer-state.json'); }
  /**
   * Images received via DM (#231). Lives in data/, not vault/: this is a **disposable layer**
   * — the ciphertext still lives at the lore-house and can be re-fetched after deletion; the
   * precious layer is reserved for things that are gone for good once deleted (identity, the
   * social log, taste).
   */
  dmMediaDir(): string { return join(this.root, 'data', 'dm-media'); }
  /** Private (0700) read-only review copies of long drafts, one file per
   *  live draft (src/host/draft-review-files.ts). */
  draftReviewDir(): string { return join(this.root, 'data', 'review'); }
  /** Install-verification evidence (a trace left behind when the gateway restart cuts the agent off mid-install). Regenerable → data/. */
  lastBuildFile(): string { return join(this.root, 'data', 'last-build.json'); }
  /** #236: last failed notification delivery (time + the channel's own words). */
  deliveryFailureFile(): string { return join(this.root, 'data', 'notify-delivery-failure.json'); }
  /**
   * The owner's observed language (`src/lexicon/owner-language.ts`). **Deliberately not folded
   * into cadence.json**: a field there would get read back on the next boot as "the owner's
   * explicit configuration", permanently locking in a single observation. Regenerable → data/.
   */
  ownerLanguageFile(): string { return join(this.root, 'data', 'owner-language.json'); }
  /** Last boot-integrity result (fingerprint + build + announced marker). Regenerable → data/. */
  dbIntegrityFile(): string { return join(this.root, 'data', 'db-integrity.json'); }
  /** `/popclaw doctor` report directory (rolling, keep 5). Re-collectable → data/. */
  doctorDir(): string { return join(this.root, 'data', 'doctor'); }

  // vault/
  vault(): string { return join(this.root, 'vault'); }
  vaultSocialDir(): string { return join(this.root, 'vault', 'social'); }
  socialDb(): string { return join(this.root, 'vault', 'social', 'my-social-assets.db'); }
  storageControlFile(): string { return join(this.vaultSocialDir(), 'storage-control.json'); }
  executionDir(): string { return join(this.vaultSocialDir(), 'execution'); }
  executionDb(storeId: string): string {
    if (!/^[a-f0-9]{32}$/.test(storeId)) throw new Error('EXECUTION_STORE_ID_INVALID');
    return join(this.executionDir(), `${storeId}.db`);
  }
  identityDir(): string { return join(this.root, 'vault', 'social', 'identity'); }
  inboxDir(): string { return join(this.root, 'vault', 'social', 'inbox'); }
  socialGraphDir(): string { return join(this.root, 'vault', 'social', 'social-graph'); }
  /** The social log, YYYY-MM.jsonl (ADR-0023 Revision 2026-07-26). The raw-material warehouse
   *  for the night-digest mechanism — the precious layer, never deleted — deliberately kept
   *  separate from the disposable data/. */
  socialLogDir(): string { return join(this.root, 'vault', 'social', 'log'); }
  backupsDir(): string { return join(this.root, 'vault', 'social', 'backups'); }
  walletDir(): string { return join(this.root, 'vault', 'wallet'); }
  walletDb(): string { return join(this.root, 'vault', 'wallet', 'wallet.db'); }

  /**
   * Is this absolute path one of the places THIS layout puts a SQLite database?
   *
   * The controlled answer to "what kind of file is this", for the callers that
   * walk the root and must decide how to handle each member. It is decided from
   * the layout above rather than from the file's bytes on purpose: while a
   * process holds a live SQLite connection it must not open, close or replace
   * that database outside SQLite's own coordination, and reading a magic number
   * to find out what a file is does exactly that. It is equally deliberately
   * not a bare suffix test — a `.db` somewhere this layout never puts one is
   * not a database this product owns, and a caller that meets an unclassified
   * file which nonetheless holds a database must refuse it rather than pass it
   * through as ordinary bytes.
   */
  isDatabaseFile(absolutePath: string): boolean {
    const path = resolve(absolutePath);
    if (path === resolve(this.socialDb()) || path === resolve(this.walletDb())) return true;
    const directory = resolve(dirname(path)), name = basename(path);
    if (directory === resolve(this.executionDir())) return /^[a-f0-9]{32}\.db$/.test(name);
    // Both the legacy mixed source `<slug>.db` and its `<slug>.projection-v1.db`.
    if (directory === resolve(this.lorehousesDir())) return /\.db$/.test(name);
    return false;
  }

  tasteDir(): string { return join(this.root, 'vault', 'taste'); }
  /**
   * `--feedback` layout-taste notes. **A signal given by the owner's own hand = the precious
   * layer** (P-004: a preference signal must have a home that's never deleted; data/ is
   * public / regenerable / disposable at any time).
   * Lives in taste/ but is deliberately not registered in manifest.json → taste-loader won't
   * read it; this is purely building it a precious home.
   * Legacy users' data/canvas-style.md gets moved here once by migrateStyleNotesToVault.
   */
  canvasStyleFile(): string { return join(this.root, 'vault', 'taste', 'canvas-style.md'); }
}
