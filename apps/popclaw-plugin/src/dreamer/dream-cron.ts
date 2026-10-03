/**
 * "Did the night digest get scheduled?" — **read-only** access to OpenClaw's cron archive.
 *
 * ## Why we read it
 *
 * "Not scheduled yet" and "scheduled but hasn't run" are **two different ailments**
 * requiring completely different actions: the former needs the owner to explicitly
 * authorize it, the latter means the job is broken (most likely a delivery failure,
 * see the real-machine lesson behind ADR-0012). Showing both as "hasn't run in N
 * days" conflates the two conditions, and the owner can't fix it by following that
 * advice.
 *
 * ## Why read-only
 *
 * **popclaw never writes to this file.** Whether to schedule it, and at what time,
 * is the owner's decision (dreaming spends model quota → requires explicit consent,
 * spec 2026-07-26 §5 authorization boundary); a plugin that stuffs a cron job into
 * the user's system on its own is exactly the kind of behavior the open-source
 * community would call out. We read it only to "say something accurate" and to
 * respect the owner's right to know.
 *
 * ## How we recognize a "dream" job
 *
 * The job is scheduled by the owner telling the agent to; the name and wording
 * are free-form. So: **first recognize by the agreed-upon name** (the tool
 * description asks the agent to use `popclaw-dream` — the deterministic path),
 * **then fall back to wording**. The cost of misrecognition is low: failing to
 * recognize = one extra "want this to run every night automatically?" question;
 * a false positive = one fewer question asked.
 */

/** The handful of fields we actually use from the cron archive. */
export interface CronJobLike {
  readonly id: string;
  readonly name?: string;
  readonly displayName?: string;
  readonly enabled?: boolean;
  /** `at` = one-off; `every` / `cron` = recurring. `tz` only exists for cron expressions (IANA). */
  readonly schedule?: { kind?: string; tz?: string };
  readonly payload?: { kind?: string; message?: string };
  readonly state?: { lastRunAtMs?: number; nextRunAtMs?: number };
}

/** The agreed-upon job name. The tool description asks the agent to use it — determinism beats guessing. */
export const DREAM_JOB_NAME = 'popclaw-dream';

/**
 * Fallback word list: for recognizing the job from its name/wording when the
 * agent didn't follow the convention. Union, not gated (not filtered by the
 * owner's locale) — the agent may have named it in Chinese or English, and we
 * need to recognize either.
 */
const DREAM_HINTS = [
  'popclaw_dream',
  'popclaw_record_dream',
  DREAM_JOB_NAME,
  '夜间消化',
  '做梦',
  '做一场梦',
  'dream',
  'nightly digest',
  'night digest',
];

/**
 * Find the owner's **recurring** dream job.
 *
 * Two exclusion rules, both hit for real during real-machine acceptance testing:
 * - **A disabled job counts as not scheduled** — if the owner turned it off, that
 *   means they don't want it running, and that's exactly when we should remind
 *   them, not display "scheduled but hasn't run".
 * - **A one-off job (`schedule.kind === 'at'`) doesn't count as scheduled** — it
 *   deletes itself after running, but can still be sitting in the archive at the
 *   very moment it's executing. The first real-machine acceptance test exposed
 *   this the hard way: triggering a dream once with `--at +1m`, the tool turned
 *   around and mistook this probe for "already scheduled", so the question that
 *   should have been asked never was. "Scheduled" can only mean **it will run
 *   again**.
 */
export function findDreamJob(jobs: readonly CronJobLike[]): CronJobLike | null {
  const live = jobs.filter((j) => j.enabled !== false && j.schedule?.kind !== 'at');
  const byName = live.find((j) => j.name === DREAM_JOB_NAME || j.displayName === DREAM_JOB_NAME);
  if (byName) return byName;
  const hay = (j: CronJobLike) => `${j.name ?? ''} ${j.displayName ?? ''} ${j.payload?.message ?? ''}`.toLowerCase();
  return live.find((j) => DREAM_HINTS.some((h) => hay(j).includes(h.toLowerCase()))) ?? null;
}

/**
 * Health status of the dream cron job. `null` = **couldn't check** (couldn't
 * read the cron archive) — couldn't check ≠ not scheduled, same principle as
 * "don't list a verification to-do when the lore-house is unreachable": when
 * in doubt, say nothing rather than say something wrong.
 */
export type DreamCronState = {
  scheduled: boolean;
  /**
   * The timezone the job is scheduled in (IANA). **Absent = OpenClaw runs on
   * the gateway host machine's local timezone** — after a machine change or a
   * container with `TZ=UTC`, "3am" can quietly shift to a different clock
   * hour, so status must state it honestly (B8).
   */
  tz?: string;
} | null;

/**
 * Read the cron archive once. Any failure (file doesn't exist / format
 * changed / that SDK subpath is gone) always returns `null`: this is a
 * **nice-to-have signal**, and status must never error out just because it
 * couldn't be read.
 */
export async function readDreamCronState(
  load: () => Promise<{ jobs?: readonly CronJobLike[] } | null | undefined>,
): Promise<DreamCronState> {
  try {
    const store = await load();
    if (!store || !Array.isArray(store.jobs)) return null;
    const job = findDreamJob(store.jobs);
    const tz = job?.schedule?.tz?.trim();
    return { scheduled: job !== null, ...(tz ? { tz } : {}) };
  } catch {
    return null;
  }
}
