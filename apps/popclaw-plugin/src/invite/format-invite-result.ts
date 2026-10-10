import type { InviteInitiateResult } from './invite-initiator.js';
import { renderCopy } from '../lexicon/index.js';
import { ownerLang } from '../lexicon/owner-language.js';

/**
 * Render the owner-facing message for a `/popclaw invite` attempt.
 *
 * The post the owner makes does double duty (ADR-0009): it both PROVES the
 * account — via the `<handle>#<sigil>` bound token the rangers match (see
 * verify-invite-handler; binding the handle defeats quote-tweet replay) — and
 * INVITES others, via the popclaw.me/invite link, the reverse funnel for
 * people without openclaw. The owner edits the wording; the bound token and
 * the link are the two load-bearing bits, both must stay in the post. On a 409
 * "already verified" conflict (ADR-0026) we show the same copy behind the
 * --replace prompt.
 */
function inviteLink(webBaseUrl: string, sigil: string, handle: string): string {
  return `${webBaseUrl.replace(/\/$/, '')}/invite/${sigil}?name=${encodeURIComponent(handle)}`;
}

/** Owner-editable post copy + a one-line why for each half. */
function postableCopy(
  handle: string,
  sigil: string,
  webBaseUrl: string,
): string[] {
  const lang = ownerLang();
  const link = inviteLink(webBaseUrl, sigil, handle);
  return [
    renderCopy(lang, 'invite.result.postLine1', { handle, sigil, link }),
    '',
    renderCopy(lang, 'invite.result.tokenBullet', { handle, sigil }),
    renderCopy(lang, 'invite.result.linkBullet'),
  ];
}

export function formatInviteResult(
  result: InviteInitiateResult,
  platform: string,
  handle: string,
  webBaseUrl: string,
  proofUrl?: string,
  mirrorOptin?: boolean,
): string {
  const lang = ownerLang();
  const { push } = result;
  const sigil = result.expectedSigil;
  const eventId = result.pushedEventId ?? '(pending)';
  if (push.status >= 200 && push.status < 300) {
    // A house without a task receipt provides no background tracking capability.
    const tracked = !!push.taskId;
    if (proofUrl) {
      // ADR-0034 one-shot proof flow: the post already exists, rangers fetch it by id.
      return [
        renderCopy(lang, 'invite.result.initiated', { platform, handle, eventId }),
        renderCopy(lang, 'invite.result.proofAttached', { proofUrl }),
        renderCopy(lang, 'invite.result.proofNote', { handle, sigil }),
        renderCopy(lang, tracked ? 'invite.result.proofEta' : 'invite.result.noTracking'),
      ].join('\n');
    }
    // ADR-0040 act one: show the owner's posting step and the actual tracking
    // capability carried by this receipt.
    // Three steps + three reassurances (48h valid / sigil never changes / no
    // penalty on expiry).
    return [
      renderCopy(lang, 'invite.result.initiated', { platform, handle, eventId }),
      '',
      renderCopy(lang, 'invite.result.threeStepsIntro'),
      renderCopy(lang, 'invite.result.step1', { platform, handle, sigil }),
      '',
      ...postableCopy(handle, sigil, webBaseUrl),
      '',
      // Honesty by design: never fake an honor guard — quorum is currently 1,
      // and the ranger headcount is never hardcoded into the copy.
      renderCopy(lang, 'invite.result.step2'),
      renderCopy(lang, tracked ? 'invite.result.step3' : 'invite.result.noTracking'),
      '',
      renderCopy(lang, 'invite.result.reassurance'),
      // Said either way, so the default is a stated choice rather than a silence.
      // Verification used to sign people up for this without ever asking.
      renderCopy(lang, mirrorOptin ? 'invite.result.syncOn' : 'invite.result.syncOff', { platform }),
      // Said here, before they post, rather than buried in a document: the ranger
      // keeps what it saw. Owner ruling 2026-08-26 — the post is public and the
      // record is mundane, but "you can delete it" and "we keep a copy" have to
      // arrive in the same breath or the first one reads as a promise we broke.
      renderCopy(lang, 'invite.result.recordNote'),
      '',
      // ADR-0034: the scraper's search index often can't see a new/small
      // account; that's when a direct by-post-id lookup is needed. The
      // rate limit only blocks an "in progress" request — a rejected one
      // frees up immediately for retry; only a still-pending one needs the 24h wait.
      renderCopy(lang, 'invite.result.smallAccountHint', { platform, handle }),
      renderCopy(lang, 'invite.result.proofRetryCmd', { platform, handle }),
      '',
      ...(tracked ? [renderCopy(lang, 'invite.result.checkStatus')] : []),
    ].join('\n');
  }
  if (push.status === 409 && push.detail?.includes('already verified')) {
    return [
      renderCopy(lang, 'invite.result.alreadyVerified', { platform, detail: push.detail }),
      renderCopy(lang, 'invite.result.oneAccountPerPlatform', { handle }),
      `  /popclaw invite ${platform} ${handle} --replace`,
      '',
      renderCopy(lang, 'invite.result.postAfterReplace'),
      ...postableCopy(handle, sigil, webBaseUrl),
      '',
      renderCopy(lang, 'invite.result.replaceNote'),
    ].join('\n');
  }
  const reason = push.detail ? `: ${push.detail}` : '';
  return `⚠️ invite push rejected (HTTP ${push.status})${reason}; lore-house reachable but refused the payload`;
}
