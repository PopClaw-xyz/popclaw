/**
 * `/popclaw doctor [send "what's wrong"] [--with-text] [--confirm]`
 *
 * The beta diagnostics mechanism (final docs: 2026-08-11-beta-diagnostics-final.md
 * §3 item 2 for the mechanism, 2026-08-11-doctor-ux-final.md for the exact
 * chat copy — the command was renamed mid-flight from `diagnose` to `doctor`,
 * and the UX doc added a three-state output spec: 2 lines when all-green /
 * one line per problem + a 2-line offer otherwise / a 5-line preview on send).
 *
 * Three forms:
 *   - `/popclaw doctor`                  collect + write only. All-green = 2 lines;
 *                                         problems = one line each + a 2-line offer. Never sends.
 *   - `/popclaw doctor send "..."`       collect + print a 5-line preview (a summary, not
 *                                         the full report). Nothing is sent yet.
 *   - `/popclaw doctor send --confirm`   after seeing the preview and nodding, actually
 *                                         send it — **no need to retype the description**:
 *                                         it was already staged in process memory at preview
 *                                         time (ponytail: lost on gateway restart; a stale
 *                                         confirm just means re-running `send "…"` once more,
 *                                         not worth persisting to disk).
 *
 * The confirmation skeleton is borrowed from `/popclaw redpacket create --confirm`
 * (spend-/exfil-class actions always preview first, act only once the owner adds
 * `--confirm`), but doctor's preview has to be readable on a phone, and "don't
 * make the owner retype the description" is a hard requirement from the UX
 * final doc — hence the thin process-level single-slot staging area below
 * (same mechanism as register-tools.ts's draft store: `getOrCreatePerProcess`,
 * hung off globalThis so it survives the host repeatedly reloading the plugin
 * module).
 *
 * `--with-text` keeps `text="…"` (the owner's own words) in the log excerpt;
 * omitted by default. The agent's `popclaw_feedback` path has no such key —
 * it cannot reach this at the type level.
 */

import { getOrCreatePerProcess, resetSingletonForTest } from '../runtime/once.js';
import { ownerLang } from '../lexicon/owner-language.js';
import { renderCopy, type Lang } from '../lexicon/index.js';
import { displayNamed } from '../identity/person-name.js';
import {
  renderDoctorPreview,
  shortVerdictFragment,
  type VerdictRow,
  type ChatSummary,
} from '../diagnostics/bundle.js';
import {
  runPopclawFeedbackCommand,
  type PopclawFeedbackArgs,
  type PopclawFeedbackDeps,
} from './popclaw-feedback.js';

export interface PopclawDoctorArgs {
  positional: string[];
  flags?: Record<string, string>;
}

/** Same shape `diagnostics/collect.ts`'s `DoctorReportResult` produces; kept
 *  as a local interface so this command module doesn't need to import the
 *  IO-wiring layer directly (the seam is `deps.buildReport`, injected by the
 *  composition root). */
export interface DoctorBuildResult {
  readonly path: string;
  readonly bytes: number;
  readonly lineCount: number;
  readonly verdictRows: readonly VerdictRow[];
  readonly chatSummary: ChatSummary;
  readonly fullMarkdown: string;
}

export interface PopclawDoctorDeps {
  /** Collect + write a fresh report (rolling keep-5). All IO lives behind
   *  this one seam — see `diagnostics/collect.ts#buildDoctorReport`. */
  buildReport: (opts: { withText: boolean; ownerNote?: string }) => Promise<DoctorBuildResult>;
  /** `send` reuses the exact same private-message path as `/popclaw feedback`
   *  (ADR-0042) — an attachment is just a feedback letter with a file on it.
   *  Doctor never passes `--house` — it always targets the home house. */
  feedbackDeps: PopclawFeedbackDeps;
  /** Test seam; defaults to the real feedback command. */
  sendFeedback?: (args: PopclawFeedbackArgs, deps: PopclawFeedbackDeps) => Promise<{ text: string }>;
  lang?: Lang;
}

interface PendingSend {
  readonly ownerNote: string;
  readonly report: DoctorBuildResult;
  readonly contactDisplay: string;
}

// Process-level single slot (not a module-level `let`): the host reloads the
// plugin module repeatedly, which a bare `let` would not survive; globalThis
// does, same mechanism as register-tools.ts's draft store. Only one slot —
// doctor can only ever have one "awaiting confirmation" preview at a time, no
// token table needed.
const pendingStore = (): { current: PendingSend | null } =>
  getOrCreatePerProcess('doctor-pending-send', () => ({ current: null as PendingSend | null }));

/** Test teardown only — DO NOT use from production code. */
export const _pendingDoctorSendForTest = {
  clear: (): void => resetSingletonForTest('doctor-pending-send'),
};

/**
 * Dry-run through `runPopclawFeedbackCommand`'s own contact-resolution logic
 * by injecting a spy `sendDm` that captures the resolved recipient + composed
 * body instead of actually pushing anything — reuses the exact same house/
 * contact-fallback rules the real send will use, with zero duplicated logic.
 * `errorText` surfaces honestly (no contact declared, etc.) exactly as the
 * real send would fail.
 */
async function resolveFeedbackTarget(
  feedbackDeps: PopclawFeedbackDeps,
  ownerNote: string,
  attachmentPath: string,
  sendFeedback: (args: PopclawFeedbackArgs, deps: PopclawFeedbackDeps) => Promise<{ text: string }>,
): Promise<{ toId: string } | { errorText: string }> {
  let captured: { toId: string } | null = null;
  const r = await sendFeedback(
    { positional: ['bug', ownerNote] },
    {
      ...feedbackDeps,
      attachmentPath,
      sendDm: async (args) => {
        captured = { toId: args.positional[0] ?? '' };
        return { text: '✉ preview' }; // must contain ✉ so the real command renders its usual receipt tail — discarded, we only need `captured`.
      },
    },
  );
  return captured ?? { errorText: r.text };
}

export async function runPopclawDoctorCommand(
  args: PopclawDoctorArgs,
  deps: PopclawDoctorDeps,
): Promise<{ text: string }> {
  const lang = deps.lang ?? ownerLang();
  const isSend = args.positional[0] === 'send';
  if (args.positional.length > 0 && !isSend) {
    return { text: renderCopy(lang, 'doctor.usage') };
  }

  const withText = args.flags?.['with-text'] !== undefined;
  const typedNote = isSend ? args.positional.slice(1).join(' ').trim() : '';
  const confirmed = args.flags?.confirm !== undefined;

  if (!isSend) {
    const report = await deps.buildReport({ withText });
    return { text: report.chatSummary.text };
  }

  // send --confirm with nothing retyped: use whatever was staged during the
  // last preview in THIS process. Stale (gateway restarted since, or no
  // preview was ever run) → say so plainly; a fresh `send "…"` fixes it.
  if (confirmed && !typedNote) {
    const pending = pendingStore().current;
    if (!pending) return { text: renderCopy(lang, 'doctor.stale') };
    const send = deps.sendFeedback ?? runPopclawFeedbackCommand;
    const r = await send(
      { positional: ['bug', pending.ownerNote] },
      { ...deps.feedbackDeps, attachmentPath: pending.report.path },
    );
    pendingStore().current = null;
    return { text: r.text };
  }

  if (!typedNote) {
    return { text: renderCopy(lang, 'doctor.send.usage') };
  }

  const send = deps.sendFeedback ?? runPopclawFeedbackCommand;

  // Typed description + --confirm together in one shot (power-user path,
  // also what a fresh `send "…" --confirm` with no prior preview means):
  // build once and send immediately, no staged preview involved.
  if (confirmed) {
    const report = await deps.buildReport({ withText, ownerNote: typedNote });
    const r = await send(
      { positional: ['bug', typedNote] },
      { ...deps.feedbackDeps, attachmentPath: report.path },
    );
    return { text: r.text };
  }

  // Plain `send "..."`: build, resolve who it would go to (without sending),
  // stage it for a later `send --confirm`, and show the 5-line preview.
  const report = await deps.buildReport({ withText, ownerNote: typedNote });
  const target = await resolveFeedbackTarget(deps.feedbackDeps, typedNote, report.path, send);
  if ('errorText' in target) return { text: target.errorText };

  const contactDisplay = displayNamed(target.toId, deps.feedbackDeps.nameOf);
  pendingStore().current = { ownerNote: typedNote, report, contactDisplay };

  const fileName = report.path.split(/[/\\]/).pop() ?? report.path;
  return {
    text: renderDoctorPreview({
      houseLabel: renderCopy(lang, 'feedback.receipt.wholePrimary'),
      contactDisplay,
      buildStamp: deps.feedbackDeps.buildStamp,
      verdictFragment: shortVerdictFragment(report.verdictRows, lang),
      ownerNote: typedNote,
      fileName,
      lineCount: report.lineCount,
      reportPath: report.path,
      lang,
    }),
  };
}
