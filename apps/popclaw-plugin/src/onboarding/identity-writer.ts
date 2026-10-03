/**
 * S3 (three-act spec §3.1) — persistence once the name is finalized: writes
 * nickname back to the plugin config. Only touches
 * ranger_profile.nickname / name_source; every other config field is kept
 * as-is (read-modify-write).
 */
import type { HostAdapter } from '../host/host-adapter.js';

export type NameSource = 'auto' | 'owner' | 'verified';

/**
 * Who wants to hear that the owner's name changed, per host. The boot
 * snapshot (`boot.nickname`) subscribes here so every envelope signed later in
 * this process carries the name the owner just chose — before this, a rename
 * persisted to config while posts and DMs kept signing the startup name until
 * a restart, and a signed envelope cannot be corrected afterwards.
 */
const nicknameListeners = new WeakMap<HostAdapter, Set<(nickname: string) => void>>();

export function onNicknamePersisted(host: HostAdapter, listener: (nickname: string) => void): void {
  let set = nicknameListeners.get(host);
  if (!set) nicknameListeners.set(host, (set = new Set()));
  set.add(listener);
}

export async function persistNickname(
  host: HostAdapter,
  nickname: string,
  source: NameSource = 'owner',
): Promise<void> {
  const trimmed = nickname.trim();
  if (!trimmed) throw new Error('persistNickname: nickname must be non-empty');
  const raw = await host.config.loadJson('plugin');
  const existing =
    raw !== null && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const rangerProfile = (existing.ranger_profile ?? {}) as Record<string, unknown>;
  await host.config.saveJson('plugin', {
    ...existing,
    ranger_profile: { ...rangerProfile, nickname: trimmed, name_source: source },
  });
  for (const listener of nicknameListeners.get(host) ?? []) listener(trimmed);
}

/** Reads ranger_profile.name_source; null when absent (legacy config → never nag). */
export async function readNameSource(host: HostAdapter): Promise<NameSource | null> {
  const raw = await host.config.loadJson('plugin');
  const cfg =
    raw !== null && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const profile = cfg.ranger_profile;
  const src =
    profile !== null && typeof profile === 'object' && !Array.isArray(profile)
      ? (profile as Record<string, unknown>).name_source
      : undefined;
  return src === 'auto' || src === 'owner' || src === 'verified' ? src : null;
}

/**
 * A nickname is 1..32 characters (identity.proto `Profile.nickname`), counted
 * the way the config schema counts them (`RangerProfile.nickname`,
 * `z.string().max(32)`: UTF-16 units, so an emoji counts as two). The config
 * is parsed on every boot, so a longer count here would let a name through
 * that the plugin then cannot start with.
 */
export const NICKNAME_MAX_LENGTH = 32;

/**
 * The one set of rules a nickname has to pass before it is written or
 * offered: non-empty, not the machine placeholder, not all digits (a bare
 * number is a menu pick, never a name), and within the protocol's length.
 * Internal spaces and any script are legal. Never truncates: an over-long
 * name is reported, and the caller asks again.
 */
export function nicknameProblem(
  nickname: string,
): 'empty' | 'placeholder' | 'digits' | 'tooLong' | undefined {
  const n = nickname.trim();
  if (!n) return 'empty';
  if (isPlaceholderNickname(n)) return 'placeholder';
  if (/^\d+$/.test(n)) return 'digits';
  if (n.length > NICKNAME_MAX_LENGTH) return 'tooLong';
  return undefined;
}

/** Detects meaningless default names (spec §3.1: a ranger-<base58> placeholder
 * name must never go straight onto a namecard).
 * popclaw_id is bs58.encode(publicKey); the default name
 * `ranger-${popclawId.slice(0,6)}` uses the base58 alphabet
 * (1-9A-HJ-NP-Za-km-z), is case-sensitive, and excludes 0OIl.
 */
export function isPlaceholderNickname(nickname: string): boolean {
  return /^ranger-[1-9A-HJ-NP-Za-km-z]{6}$/.test(nickname.trim());
}
