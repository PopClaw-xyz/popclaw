/**
 * Install/upgrade echo (issue #270) — #271's last-build.json only leaves a trace on disk that
 * the owner never sees; this file turns "just installed / just upgraded" into a human-readable
 * sentence and hands it to the caller (index.ts) to send via OwnerNotifier.
 *
 * Pure decision function, no IO: persisting to disk (writing back announcedBuild) and sending
 * (deliverNow) both happen in the caller. The `record` passed in is what was read after this
 * boot's recordBuildOnBoot already finished — so record.build is this boot's build, no need to
 * pass it separately.
 *
 * Owner's ironclad rule: the four copy variants must include the literal words "popclaw plugin"
 * so it can't be misread as an openclaw host upgrade (that's exactly how the false alarm on the
 * host-c machine on 2026-07-29 happened).
 */
import { DEV_BUILD, type LastBuildRecord } from './last-build.js';
import { renderCopy } from '../lexicon/index.js';
import { ownerLang } from '../lexicon/owner-language.js';

export interface InstallNoticeInput {
  /** The record read after recordBuildOnBoot writes back; null = never persisted yet
   *  (dev builds never persist) — either way there's no evidence, so don't guess, don't send. */
  readonly record: LastBuildRecord | null;
  /** boot.identityGenerated — true = master.key was just generated on this boot (a true first install). */
  readonly identityGenerated: boolean;
  /** stage === 'completed' as read from OnboardingStateRepository. */
  readonly onboardingCompleted: boolean;
}

/**
 * `0.1.0 2026-08-26 12:21+08 c27aab30 (HEAD)` → `0.1.0 · 8/26 12:21`.
 *
 * Through the release sprint both ends of an upgrade read `0.1.0`, so the date and time are
 * the only things that tell two packages apart — a version number alone can't carry this line.
 * A build string that doesn't split into those parts (a bare sha, a test fixture) is shown
 * whole: better a string the owner can still match against the boot log than a guess.
 */
export function shortBuildStamp(build: string): string {
  const [version, date, time] = build.split(' ');
  if (!date || !time || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return build;
  return `${version} · ${date.slice(5).replace('-', '/').replace(/^0/, '')} ${time.slice(0, 5)}`;
}

/**
 * Which sentence to say (or not say) after a build transition. The once-only gate isn't here:
 * this function only answers "what's the copy for this state" — "whether to actually send this
 * time / whether it's already been sent" is the caller's job (see last-build.ts's
 * announcedBuild + markBuildAnnounced).
 */
export function decideInstallNotice(input: InstallNoticeInput): string | null {
  const { record, identityGenerated, onboardingCompleted } = input;
  const lang = ownerLang();
  // Blast shield: if record's shape is off (readLastBuild in theory already guards against this
  // once, this is a second guard so it doesn't become a landmine if upstream ever changes implementation).
  if (record === null || typeof record.build !== 'string') return null;
  if (record.build === DEV_BUILD) return null; // a direct tsx run has no stable build number
  if (record.announcedBuild === record.build) return null; // once-only: this build has already been delivered

  // The hint is its own line. Hung off the end of the sentence with a comma it read as a
  // footnote to the upgrade; it's the only thing in the message the owner has to act on.
  const tail = onboardingCompleted ? '' : `\n${renderCopy(lang, 'runtime.install.continueHintTail')}`;
  const build = shortBuildStamp(record.build);

  if (!record.previous) {
    // No previous: can't tell "fresh install" apart from "upgraded from an old version that
    // predates this feature" — recordBuildOnBoot itself can't judge this either, so
    // identityGenerated is the fallback.
    return identityGenerated
      ? renderCopy(lang, 'runtime.install.freshInstall', { build })
      : renderCopy(lang, 'runtime.install.updated', { build, tail });
  }

  return renderCopy(lang, 'runtime.install.upgraded', { build, tail });
}
