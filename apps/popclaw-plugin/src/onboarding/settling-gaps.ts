/**
 * The gap list (R1 spec §4 — the nudge backdoor hook).
 *
 * `listGaps()` is the **single** shared source of truth for both the status
 * todo block and the nudge: previously status.ts built up its own chain of
 * ifs, and if the nudge wrote a separate one, the two would sooner or later
 * quietly diverge on "does this count as a gap" (e.g. status changes its
 * taste criterion and the nudge doesn't keep up). Now only this one place
 * grows new ifs — both consumers pick the keys they recognize out of this
 * one `Gap[]`.
 *
 * Order follows spec §4: `resume_onboarding` (has bailed before) goes first,
 * followed by no_follows > no_taste > no_verify > dream_stale > auto_name >
 * no_house_card > `house:<slug>:first_move` (for multiple houses, in
 * mount order, not counting the home house — its "first thing to do" is the
 * six-act onboarding itself, see the same discipline in
 * orchestrator.houseNudge).
 *
 * Zero network, zero LLM: every fact comes from local data the caller
 * already has in hand (config / DB counts / file timestamps); listGaps
 * itself only does boolean composition and never initiates any IO.
 */
import type { HostAdapter } from '../host/host-adapter.js';
import type { NameSource } from './identity-writer.js';

export type GapKey =
  | 'resume_onboarding'
  | 'no_follows'
  | 'no_taste'
  | 'no_verify'
  | 'dream_stale'
  | 'auto_name'
  | 'no_house_card'
  | `house:${string}:first_move`;

export interface Gap {
  readonly key: GapKey;
  /** Only carried by house:* gaps — needed for copy assembly, all data comes from the house's own declared entry. */
  readonly houseName?: string;
  readonly houseHeadline?: string;
  readonly houseFirstMove?: string;
}

/** The minimal house shape listGaps needs (structurally matches `MountedHouse`, doesn't depend on it directly, to avoid a reverse import). */
export interface GapHouse {
  readonly slug: string;
  readonly name: string;
  readonly entry?: { readonly headline?: string; readonly firstMove?: string };
}

export interface GapFacts {
  /** config `onboarding.bailed_at`; null = never bailed / already cleared. */
  readonly bailedAt?: number | null;
  readonly followingCount: number;
  /** null = unknown (taste reader not wired in / read failed) → doesn't count as a gap, unknown ≠ absent. */
  readonly tasteSeeded: boolean | null;
  readonly loreHouseReachable: boolean;
  readonly externalVerifiedCount: number;
  readonly pendingInvitesCount: number;
  readonly dreamStale: boolean;
  readonly nameSource: NameSource | null;
  /**
   * Can the home lore-house find my name card (whether the `card` field in
   * `/v1/profile` is present, not the HTTP status code)?
   * `undefined` = not checked (the nudge path is zero-network) → doesn't count as a gap, unknown ≠ absent.
   */
  readonly cardOnHouse?: boolean;
  /** Whether the name in the local config is a real name (non-empty and not the `ranger-xxxxxx` placeholder). */
  readonly localNameReal?: boolean;
  /** Houses already mounted (including the home house, in mount order); listGaps itself skips `houses[0]` (the home house). */
  readonly houses?: readonly GapHouse[];
  readonly houseStarted?: (slug: string) => boolean;
}

export function listGaps(facts: GapFacts): Gap[] {
  const gaps: Gap[] = [];
  if ((facts.bailedAt ?? null) !== null) gaps.push({ key: 'resume_onboarding' });
  if (facts.followingCount === 0) gaps.push({ key: 'no_follows' });
  if (facts.tasteSeeded === false) gaps.push({ key: 'no_taste' });
  if (facts.loreHouseReachable && facts.externalVerifiedCount === 0 && facts.pendingInvitesCount === 0) {
    gaps.push({ key: 'no_verify' });
  }
  if (facts.followingCount > 0 && facts.dreamStale) gaps.push({ key: 'dream_stale' });
  if (facts.nameSource === 'auto') gaps.push({ key: 'auto_name' });
  // Name-card self-heal ran and it's still not attached (issue #280 §3.3):
  // real name present, home house reachable, yet no card found — the house
  // is refusing it or the projection is broken; this is the only leftover
  // case that needs the owner to step in. Not listed when the lore-house is
  // unreachable / wasn't checked (unknown ≠ absent, same principle as
  // no_verify). The criterion uses **local name is not a placeholder**
  // rather than name_source: an LLM-suggested name accepted via auto is
  // also a real name, and judging by source would mean these owners would
  // never see this item.
  if (facts.loreHouseReachable && facts.cardOnHouse === false && facts.localNameReal === true) {
    gaps.push({ key: 'no_house_card' });
  }

  const houseStarted = facts.houseStarted ?? (() => false);
  for (const h of (facts.houses ?? []).slice(1)) {
    if (!h.entry?.firstMove || houseStarted(h.slug)) continue;
    gaps.push({
      key: `house:${h.slug}:first_move`,
      houseName: h.name,
      ...(h.entry.headline ? { houseHeadline: h.entry.headline } : {}),
      houseFirstMove: h.entry.firstMove,
    });
  }
  return gaps;
}

/** "Is there a taste seed": core-layer body text is non-empty. The status
 *  todo and the nudge share this exact same criterion. Taste reader not
 *  wired in / read failed → null (unknown ≠ absent, same principle as dreamCron). */
export async function tasteSeededOf(tasteLoader?: {
  enabledSources(): Promise<ReadonlyArray<{ path: string; content: string }>>;
}): Promise<boolean | null> {
  if (!tasteLoader) return null;
  try {
    const sources = await tasteLoader.enabledSources();
    return sources.some((s) => s.path.startsWith('core/') && s.content.trim() !== '');
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Small read-modify-write utilities for the config `onboarding` section
// (bail bookkeeping + the nudge ledger share the same parsing discipline:
// all other top-level fields are preserved as-is, following the precedent
// set by orchestrator.recordCadenceChoice).
// ─────────────────────────────────────────────────────────────────────────

export function asRecord(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

async function loadPluginConfig(host: HostAdapter): Promise<Record<string, unknown>> {
  try {
    return asRecord(await host.config.loadJson('plugin'));
  } catch {
    return {};
  }
}

export async function readOnboardingSection(host: HostAdapter): Promise<Record<string, unknown>> {
  return asRecord((await loadPluginConfig(host)).onboarding);
}

/** Read-modify-write the `onboarding` section; failures swallowed — a failure to record must not be allowed to break the real work this turn. */
export async function patchOnboardingSection(
  host: HostAdapter,
  patch: (prev: Record<string, unknown>) => Record<string, unknown>,
): Promise<void> {
  try {
    const cfg = await loadPluginConfig(host);
    const prev = asRecord(cfg.onboarding);
    await host.config.saveJson('plugin', { ...cfg, onboarding: patch(prev) });
  } catch {
    // A failure to record must not be allowed to break the real work this turn.
  }
}

/** Bail persistence fix (spec §5, a real bug in the previous state): bail was only recorded in in-memory gaps and got lost across process restarts. */
export async function readBailedAt(host: HostAdapter): Promise<number | null> {
  const onboarding = await readOnboardingSection(host);
  return typeof onboarding.bailed_at === 'number' ? onboarding.bailed_at : null;
}

export async function writeBailedAt(host: HostAdapter, nowSec: number): Promise<void> {
  await patchOnboardingSection(host, (prev) => ({ ...prev, bailed_at: nowSec }));
}

/** Cleared on normal graduation (walking through it again / graduating directly) — the resume_onboarding gap disappears along with it. */
export async function clearBailedAt(host: HostAdapter): Promise<void> {
  await patchOnboardingSection(host, (prev) => {
    if (prev.bailed_at === undefined) return prev;
    const rest = { ...prev };
    delete rest.bailed_at;
    return rest;
  });
}
