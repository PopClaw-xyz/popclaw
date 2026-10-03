/**
 * Account verification on the tool path (#585).
 *
 * `/popclaw invite` was slash-only, and MCP hosts (Claude Code / Codex /
 * Hermes) have no slash commands — an MCP citizen could not get verified at
 * all, even though the MCP composition root already builds the initiator, the
 * pending ledger and the watch deps. This module is the missing door, and it
 * is deliberately the ONLY place `popclaw_invite` is registered: both
 * composition roots share this one registration pass (the MCP bridge collects
 * its tool list from it), so wiring it here reaches both hosts at once.
 *
 * Shape: preview → confirm, the same discipline as `popclaw_draft_* →
 * popclaw_send_draft`. Submitting an invite puts rangers to work on someone
 * else's machine, so it must never fire on a single call the agent made up.
 * The first call canonicalises and preflights the arguments, parks the
 * submission behind a token and sends nothing; the second call — carrying that
 * token and nothing else — is the one that signs and pushes.
 */

import { PopclawInviteSchema } from './tool-schemas.js';
import { makeDraftToken, putDraft, takeDraft, type DraftKind } from './draft-store.js';
import type { ToolsCtx } from './tools-context.js';
import { ownerLang, failureText } from '../lexicon/owner-language.js';
import { renderCopy } from '../lexicon/index.js';
import { canonicalPlatform } from '../scraper/platform-scraper.js';
import { extractPostId } from '../quest/verify-invite-handler.js';
import { submitInvite } from '../invite/submit-invite.js';
import { watchInvite } from '../invite/pending-invites.js';

/**
 * The one draft kind this tool may mint and execute. It shares the write
 * chain's draft table (one TTL discipline, one process-level store that
 * survives a plugin reload); `takeDraft` enforces the kind for both doors, so
 * a `message-3` handed here cannot fire that DM through the verification door,
 * and an `invite-7` handed to popclaw_send_draft cannot submit this one.
 */
const INVITE_KINDS = ['invite'] as const satisfies readonly DraftKind[];

/** The agent-facing half of the receipt — same role as write-tools' CONFIRM_DISCIPLINE. */
const CONFIRM_DISCIPLINE =
  'Nothing has been submitted. Read the preview back to the owner in their own language; only after they ' +
  'explicitly say go, call popclaw_invite again with confirm_token alone. That second call is the one that submits.';

/** `popclaw_invite` — registered on every host, whatever else this process wired. */
export function registerInviteTools(ctx: ToolsCtx): void {
  const { api, runtime } = ctx;

  api.registerTool({
    name: 'popclaw_invite',
    description:
      'Call when the owner wants to prove a social account is theirs — "verify my X account", "link my Instagram". ' +
      'They give you the platform and their handle, plus proof_url if they already published the proof post. ' +
      'Always TWO calls: the first returns a preview of exactly what would be submitted, plus a confirm_token, and ' +
      'sends nothing; read it back to the owner, and only once they say go, call this again with confirm_token alone. ' +
      'That second call puts rangers to work, so never make it on your own initiative. A token is single-use and ' +
      'expires in 30 minutes.',
    parameters: PopclawInviteSchema,
    execute: async (_callId: string, params: unknown) => {
      const p = (params ?? {}) as {
        platform?: unknown;
        handle?: unknown;
        proof_url?: unknown;
        nickname?: unknown;
        replace?: unknown;
        sync?: unknown;
        confirm_token?: unknown;
      };
      const lang = ownerLang();
      const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

      // --- second call: the owner said go ---
      const confirmToken = str(p.confirm_token);
      if (confirmToken) {
        const submit = takeDraft(confirmToken, INVITE_KINDS);
        if (!submit) {
          return {
            type: 'text' as const,
            text: renderCopy(lang, 'invite.tool.expiredToken', { token: confirmToken }),
          };
        }
        try {
          return { type: 'text' as const, text: (await submit()).text };
        } catch (err) {
          // The token was spent the moment it was taken (single-use by design),
          // so say so — otherwise the agent retries with a dead token forever.
          return {
            type: 'text' as const,
            text: `${failureText('popclaw_invite', err)}\n${renderCopy(lang, 'invite.tool.submitFailed')}`,
          };
        }
      }

      // --- first call: canonicalise, preflight, park ---
      const rawPlatform = str(p.platform);
      const rawHandle = str(p.handle);
      if (!rawPlatform || !rawHandle) {
        return { type: 'text' as const, text: renderCopy(lang, 'invite.tool.usage') };
      }
      // Canonicalize before signing: "X"/"Twitter" must not become distinct
      // platforms server-side (already-verified checks are keyed by platform).
      const platform = canonicalPlatform(rawPlatform);
      const handle = rawHandle.replace(/^@/, '');
      // "Provided but empty" is a bad proof URL, not an absent one: coercing
      // `proof_url: ""` (or whitespace, or a non-string) to undefined would submit
      // by-search verification while the owner believes their post was attached,
      // and the rejection only surfaces ~5min later. The slash lane already
      // refuses `--proof ""` at preflight; this lane must agree.
      const proofGiven = p.proof_url !== undefined && p.proof_url !== null;
      const proofUrl = str(p.proof_url) || undefined;
      // ADR-0034 preflight: a bad proof URL would otherwise be signed, stored,
      // and only surface ~5min later as an unexplained REJECT behind the 24h gate.
      if (proofGiven && (proofUrl === undefined || !extractPostId(proofUrl))) {
        return {
          type: 'text' as const,
          text: renderCopy(lang, 'invite.badProofUrl', { got: proofUrl ?? String(p.proof_url) }),
        };
      }
      const nickname = str(p.nickname) || undefined;
      const replace = p.replace === true;
      // Mirroring is opt-in and the flag IS the whole
      // opt-in — absent means no. It has to be carried on every invite path, or
      // a consent gate silently stops being one on the path that dropped it.
      const mirrorOptin = p.sync === true;

      const token = makeDraftToken('invite');
      putDraft(token, async () => {
        const rt = await runtime();
        return submitInvite({
          initiate: (opts) => rt.initiator.initiate(opts),
          recordPending: (entry) => rt.pendingInvites.add(entry),
          watch: (taskId) => watchInvite(rt.inviteWatch, taskId),
          onWatchError: (message) => api.logger?.info(message),
          webBaseUrl: rt.boot.webBaseUrl,
        }, {
          platform,
          handle,
          nickname: nickname ?? rt.boot.nickname,
          // ADR-0026: swap an already-verified account on this platform.
          replace,
          // ADR-0034: post URL → rangers verify by-id instead of by search.
          proofUrl,
          mirrorOptin,
        });
      });

      const preview = renderCopy(lang, 'invite.tool.preview', {
        platform,
        handle,
        // Submitted either way (absent → the owner's own name, resolved from boot
        // inside the draft): the owner cannot consent to a field the preview hid.
        // Named here rather than resolved, because previewing must not build the
        // runtime — the first call is preflight only, it touches nothing.
        nickname: nickname ?? renderCopy(lang, 'invite.tool.nicknameDefault'),
        proof: proofUrl ?? renderCopy(lang, 'invite.tool.proofNone'),
        sync: renderCopy(lang, mirrorOptin ? 'invite.tool.syncOn' : 'invite.tool.syncOff'),
      });
      return {
        type: 'text' as const,
        text: `${replace ? `${preview}\n${renderCopy(lang, 'invite.tool.replaceLine')}` : preview}\n\nconfirm_token: ${token}\n${CONFIRM_DISCIPLINE}`,
      };
    },
  });
}
