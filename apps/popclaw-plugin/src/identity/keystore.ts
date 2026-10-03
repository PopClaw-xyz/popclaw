import nacl from 'tweetnacl';
import bs58 from 'bs58';
import type { HostAdapter } from '../host/host-adapter.js';

/**
 * master.key JSON schema:
 *   {
 *     "version": 1,
 *     "type": "master-raw-seed",
 *     "created_at": "<ISO8601>",
 *     "public_key": "<Base58>",
 *     "seed": "<hex 64 chars>"
 *   }
 *
 * `seed` is 32 raw bytes (hex-encoded). Public key is redundant for
 * readability / integrity; Keystore.load verifies it matches a re-derive.
 */

export interface MasterKey {
  readonly seed: Uint8Array;          // 32 bytes
  readonly publicKey: Uint8Array;     // 32 bytes
  readonly secretKey: Uint8Array;     // 64 bytes (tweetnacl format: seed || pubkey)
  readonly popclawId: string;         // Base58(publicKey)
}

/** master.key is a private key: owner read/write only. */
const KEY_MODE = 0o600;
const NS = 'identity';
const KEY = 'master.key';

export class Keystore {
  constructor(private readonly host: HostAdapter) {}

  /** Load the master key; returns null if the file is absent. */
  async load(): Promise<MasterKey | null> {
    const raw = await this.host.storage.read(NS, KEY);
    if (!raw) return null;
    // A zero-length file is not a key and never was one. Until the exclusive
    // write became atomic (local-host-adapter, `link` instead of O_EXCL), a
    // process killed between creating master.key and writing it left this
    // behind -- and because the file then EXISTS, nothing ever mints again and
    // every start dies on JSON.parse with no hint of why. New trees cannot
    // reach this state; a tree that already did deserves a sentence it can
    // act on, because the action is "delete a file called master.key" and
    // nobody should take that step on a guess.
    if (raw.length === 0) {
      throw new Error(
        `master.key at ${this.keyPath()} is empty (0 bytes). It holds no key and never did — ` +
          'it is the remains of a process that died while creating it. Nothing has been lost. ' +
          'Delete that empty file and popclaw mints a fresh identity on the next start.',
      );
    }
    await this.tightenIfLoose();
    const text = new TextDecoder().decode(raw);
    const json = JSON.parse(text) as {
      version: number;
      type: string;
      created_at: string;
      public_key: string;
      seed: string;
    };
    if (json.version !== 1 || json.type !== 'master-raw-seed') {
      throw new Error(`unsupported master.key version/type: ${json.version}/${json.type}`);
    }
    const seed = hexDecode(json.seed);
    if (seed.length !== 32) {
      throw new Error(`master.key seed must be 32 bytes, got ${seed.length}`);
    }
    const kp = nacl.sign.keyPair.fromSeed(seed);
    const expectedB58 = bs58.encode(kp.publicKey);
    if (expectedB58 !== json.public_key) {
      throw new Error(
        `master.key public_key mismatch: file says ${json.public_key}, seed derives ${expectedB58}`,
      );
    }
    return {
      seed,
      publicKey: kp.publicKey,
      secretKey: kp.secretKey,
      popclawId: expectedB58,
    };
  }

  /**
   * Generate a new master key if one doesn't exist; return the current one either way.
   *
   * `generated` rides along so the CALLER's logger (the one an operator actually
   * reads — `api.logger` under OpenClaw) can say "restored" vs "MINTED A NEW
   * IDENTITY" differently. Additive: the result is still a `MasterKey`.
   */
  async loadOrGenerate(): Promise<MasterKey & { readonly generated: boolean }> {
    const existing = await this.load();
    if (existing) return { ...existing, generated: false };

    const seed = nacl.randomBytes(32);
    const kp = nacl.sign.keyPair.fromSeed(seed);
    const popclawId = bs58.encode(kp.publicKey);
    const body = {
      version: 1,
      type: 'master-raw-seed',
      created_at: this.host.clock.now().toISOString(),
      public_key: popclawId,
      seed: hexEncode(seed),
    };
    try {
      await this.host.storage.write(
        NS,
        KEY,
        new TextEncoder().encode(JSON.stringify(body, null, 2)),
        { mode: KEY_MODE, exclusive: true },
      );
    } catch (err) {
      // EEXIST = another host booted this same data root in the gap between our
      // load() and our write(). Real shape, not theory: the OpenClaw plugin is
      // resident while `popclaw-mcp` starts under Claude Code, one shared
      // POPCLAW_DATA_ROOT. Without O_EXCL both mint a keypair and the later write
      // buries the earlier identity for good — no revocation, no recovery. The
      // loser drops its seed on the floor and adopts the winner's key.
      if ((err as NodeJS.ErrnoException)?.code !== 'EEXIST') throw err;
      const winner = await this.load();
      if (!winner) throw err; // EEXIST but unreadable: real problem, don't paper over it.
      this.host.logger.info(
        { path: this.keyPath(), popclaw_id: winner.popclawId },
        'popclaw: another popclaw process minted the master key first — adopting it. ' +
          'This is the expected outcome when two hosts first-run the same data root together.',
      );
      return { ...winner, generated: false };
    }
    // A silent "generated" branch is how a misconfigured data root turns into an
    // irreversible identity loss: no revocation path, and the old boot log was
    // indistinguishable from a normal restore. Make it impossible to miss.
    //
    // `info`, not `warn`, and that is not a downgrade: on an MCP host (Claude Code,
    // Codex) warn and error go to a black hole and only info reaches the owner —
    // mcp.ts even points pino at fd 2. At `warn` this line does not exist on exactly
    // the hosts where pointing POPCLAW_DATA_ROOT at the wrong place is easiest. The
    // ★★★ and the wording carry the severity; the level only decides whether anyone
    // gets to read it.
    const usedRoot = this.rootLooksUsed();
    this.host.logger.info(
      { path: this.keyPath(), popclaw_id: popclawId, likely_wrong_data_root: usedRoot },
      usedRoot
        ? '★★★ popclaw: NEW IDENTITY GENERATED, BUT THIS DATA ROOT ALREADY HAS HISTORY — bonds/marks/' +
            'onboarding rows exist next to a MISSING master.key. That is almost never a first run: the ' +
            'key file is gone or POPCLAW_DATA_ROOT points somewhere half-right. STOP the plugin and ' +
            'restore the original master.key from backup. A lost master.key cannot be recovered or revoked.'
        : '★★★ popclaw: NEW IDENTITY GENERATED — a brand-new keypair was written to the path above. ' +
            'This is expected ONLY on first run. If you have used popclaw before, STOP the plugin: your ' +
            'data root is probably wrong (check POPCLAW_DATA_ROOT) and your real identity lives elsewhere. ' +
            'A lost master.key cannot be recovered or revoked.',
    );
    return {
      seed,
      publicKey: kp.publicKey,
      secretKey: kp.secretKey,
      popclawId,
      generated: true,
    };
  }

  /**
   * "Does this root have a past?" — file existence is useless here: config/plugin.json
   * must exist before the first boot (bootstrapPlugin requires lore_houses) and the
   * adapter creates+migrates my-social-assets.db before Keystore ever runs. Rows that
   * only appear through real use are the signal that survives that.
   *
   * ponytail: three hand-picked tables, best-effort. If a table is renamed the check
   * silently degrades to "not used" — widen it (or count over sqlite_master) if that
   * ever bites.
   */
  private rootLooksUsed(): boolean {
    try {
      const row = this.host.db.queryOne<{ n: number }>(
        'SELECT (SELECT count(*) FROM bonds) + (SELECT count(*) FROM marks)' +
          ' + (SELECT count(*) FROM onboarding_state) AS n',
      );
      return (row?.n ?? 0) > 0;
    } catch {
      return false;
    }
  }

  private keyPath(): string {
    return this.host.storage.pathFor?.(NS, KEY) ?? `${NS}/${KEY}`;
  }

  /**
   * Self-heal: installs shipped before this fix left master.key at 0644. Refusing
   * to boot would brick them, so chmod it down and shout instead. Best-effort —
   * a stat/chmod failure (Windows, exotic FS, no such port) must never block boot.
   */
  private async tightenIfLoose(): Promise<void> {
    try {
      const previous = await this.host.storage.tightenPermissions?.(NS, KEY, KEY_MODE);
      if (previous === null || previous === undefined) return;
      // Only group/other bits mean somebody else could actually have read it.
      // 0700 is over-broad but private — tighten it without crying wolf.
      if ((previous & 0o077) === 0) {
        this.host.logger.info(
          { path: this.keyPath(), from: fmtMode(previous), to: '0600' },
          'popclaw: master.key had surplus permission bits (owner-only, not exposed) — tightened to 0600',
        );
        return;
      }
      this.host.logger.warn(
        { path: this.keyPath(), from: fmtMode(previous), to: '0600' },
        '⚠ popclaw: master.key permissions were too open (group/other readable) and have been ' +
          'tightened to 0600. Anyone with an account on this machine could have read your private ' +
          'key — if this box is shared, treat the identity as compromised.',
      );
    } catch (err) {
      this.host.logger.warn(
        { path: this.keyPath(), err: String(err) },
        'popclaw: could not verify master.key permissions (best-effort check skipped, continuing boot)',
      );
    }
  }
}

function fmtMode(mode: number): string {
  return `0${(mode & 0o777).toString(8).padStart(3, '0')}`;
}

function hexEncode(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

function hexDecode(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error('odd hex length');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return out;
}
