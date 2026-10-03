/**
 * Onboarding state machine (Plan C, six acts; spec 2026-07-29 §1).
 *
 *   idle → arrival → passport → lantern → attune → errand → cadence → completed
 *
 *   arrival   naming kickoff (one line of positioning + name candidates, no lore-house concept)
 *   passport  claiming the passport (sign the namecard → broadcast to each house → passport canvas, the vermilion moment)
 *   lantern   meeting the houses (guide + quick overview merged + world-at-a-glance canvas)
 *   attune    finding the taste (one question → write the taste core → reorder that same batch of entries, the centerpiece)
 *   errand    the first task (recognize someone → follow → the first line written into the bond book)
 *   cadence   setting the rhythm (ask about the morning paper → closing words + guide canvas)
 *
 * The old act1/act2/act3 chain of names (along with the even older 11-stage
 * one) are all retired: normalizeStage sends every one of them straight back
 * to idle to be walked again — there is no way to map an in-progress state
 * onto the new arc, so replaying it is the only honest migration.
 *
 * Two non-spine edges are **spec requirements**, not casually-added escape
 * hatches:
 *  - `lantern → errand`: skipping lantern also skips attune (asking about
 *    taste without having seen any content is running on empty);
 *  - `passport → arrival`: once the passport is out, if the owner says
 *    "let me change the name" they need to be able to go back and change it.
 * Every other in-progress stage can go straight to completed (the owner can
 * always say "that's enough for now").
 */
export type OnboardingStage =
  | 'idle'
  | 'arrival'
  | 'passport'
  | 'lantern'
  | 'attune'
  | 'errand'
  | 'cadence'
  | 'completed';

export const ALL_STAGES: ReadonlyArray<OnboardingStage> = [
  'idle',
  'arrival',
  'passport',
  'lantern',
  'attune',
  'errand',
  'cadence',
  'completed',
];

/** spec §1 transition table. Order is load-bearing: the orchestrator's
 *  spineNext() takes the **first** non-completed entry as the spine
 *  successor — branch targets are always listed after the spine entry. */
export const legalNextStages: Record<OnboardingStage, ReadonlyArray<OnboardingStage>> = {
  'idle': ['arrival'],
  'arrival': ['passport', 'completed'],
  'passport': ['lantern', 'arrival', 'completed'], // arrival = going back to change the name
  'lantern': ['attune', 'errand', 'completed'],    // errand = skipping lantern also skips attune
  'attune': ['errand', 'completed'],
  'errand': ['cadence', 'completed'],
  'cadence': ['completed'],
  'completed': [],
};

export function isStage(v: unknown): v is OnboardingStage {
  return typeof v === 'string' && (ALL_STAGES as ReadonlyArray<string>).includes(v);
}

/**
 * Persistence-layer migration: any old enum value or unknown string → the
 * new enum. completed is preserved (already graduated, not replayed);
 * everything else goes back to idle.
 */
export function normalizeStage(raw: string): OnboardingStage {
  if (isStage(raw)) return raw;
  return raw === 'completed' ? 'completed' : 'idle';
}
