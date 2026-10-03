/**
 * MyNamecard — the local authoritative "my namecard" object (namecard
 * self-heal proposal §2.1/§2.2, issue #280).
 *
 * D4 fixed here: material for a re-issue used to be scattered (config
 * nickname plus other sources, and a `declared_at` recomputed as `now()` on
 * every call — so two re-issues never produced identical bytes).
 * `loadMyNamecard` assembles the one object every push site should sign from,
 * and `declared_at` is pinned in config so repeated pushes are byte-identical
 * (this matters for the self-heal loop in announce-namecard.ts: identical
 * bytes hit the house's event dedup instead of growing raw_events forever).
 *
 * D2/D3 fixed by `signMyNamecard` + routing every push site through it
 * (orchestrator.ts / popclaw-name.ts / the renewal roots): one signing point
 * means one set of fields. The public client declares nickname/declaredAt
 * only; because the house's upsert is whole-row (ADR-0008), every push site
 * also passes `guardNamecardWrite` (namecard-write-guard.ts) so a row that
 * carries content this client cannot re-emit is never overwritten.
 */
import type { HostAdapter } from '../host/host-adapter.js';
import type { Signer } from '../identity/signer.js';
import type { SignEnvelopeResult } from '../identity/sign-envelope.js';
import { isPlaceholderNickname } from '../onboarding/identity-writer.js';
import { signProfile } from './sign-profile.js';

export interface MyNamecard {
  readonly nickname: string;
  /** Unix seconds. Pinned in config — see loadMyNamecard/bumpNamecardDeclaredAt. */
  readonly declaredAt: number;
}

export interface LoadMyNamecardDeps {
  readonly host: HostAdapter;
  /** Unix seconds. Only consulted to backfill a legacy config missing the field. */
  readonly now: () => number;
}

function asRecord(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/**
 * Assemble "my namecard". `null` when there is no name to declare yet — no
 * nickname persisted at all, or it's still the machine placeholder
 * `ranger-<id[0:6]>` (isPlaceholderNickname is the literal-pattern check
 * used everywhere else in the codebase; name_source alone is NOT a reliable
 * placeholder signal — an onboarding "skip" accepts an LLM-suggested or
 * fallback name with name_source still 'auto', and that name is real and
 * already pushed, so gating on source would wrongly suppress self-heal for it).
 *
 * AMENDMENT A3 (binding, namecard-rebroadcast-proposal §7): the six other
 * Profile fields (one_line_intro / taste_tags / role_persona / location_hint /
 * avatar_uri) are NOT read here — nobody sets them today. The day a caller
 * starts populating one of them, it MUST be added here (and to any diff the
 * self-heal loop uses to decide whether to push), or the self-heal loop will
 * re-push a card with those fields blank and silently clobber house-side
 * content the owner curated through some other path.
 */
export async function loadMyNamecard(deps: LoadMyNamecardDeps): Promise<MyNamecard | null> {
  const raw = await deps.host.config.loadJson('plugin');
  const cfg = asRecord(raw);
  const profile = asRecord(cfg.ranger_profile);

  const nickname = typeof profile.nickname === 'string' ? profile.nickname.trim() : '';
  if (!nickname || isPlaceholderNickname(nickname)) return null;

  let declaredAt =
    typeof profile.namecard_declared_at === 'number' ? profile.namecard_declared_at : undefined;
  if (declaredAt === undefined) {
    // Legacy config predates this field (declared before this feature shipped).
    // Backfill with now(): newer than any real historical declared_at, so the
    // house's `declared_at >=` still accepts it (harmless — the true original
    // moment is already lost, same as any pre-self-heal history).
    declaredAt = deps.now();
    await deps.host.config.saveJson('plugin', {
      ...cfg,
      ranger_profile: { ...profile, namecard_declared_at: declaredAt },
    });
  }

  return { nickname, declaredAt };
}

/**
 * Content changed → advance declared_at. Monotonic: `max(now(), stored + 1)`.
 * One line covers two real clock faults: a container booting with no RTC
 * (clock reset to epoch — without the max, a rename would be silently
 * rejected by the house's `declared_at >=` and the owner would think it took
 * effect), and a clock that jumps forward once (which must not permanently
 * lock out all future updates — `stored + 1` still advances past it next time).
 */
export async function bumpNamecardDeclaredAt(host: HostAdapter, now: () => number): Promise<number> {
  const raw = await host.config.loadJson('plugin');
  const cfg = asRecord(raw);
  const profile = asRecord(cfg.ranger_profile);
  const stored = typeof profile.namecard_declared_at === 'number' ? profile.namecard_declared_at : 0;
  const next = Math.max(now(), stored + 1);
  await host.config.saveJson('plugin', {
    ...cfg,
    ranger_profile: { ...profile, namecard_declared_at: next },
  });
  return next;
}

/** Thin wrapper over signProfile — the one signing point every push site uses (D2/D3). */
export function signMyNamecard(signer: Signer, card: MyNamecard): Promise<SignEnvelopeResult> {
  return signProfile(signer, {
    nickname: card.nickname,
    declaredAt: card.declaredAt,
  });
}
