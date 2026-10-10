/** Local invitation copy and account verification share the existing submit path.
 * A Native posting acknowledgement uses the current owner invocation and this
 * conversation's latest prepared account. Other hosts and sensitive changes
 * retain preview/confirmation. Preparation has no signer or network port. */
import { PopclawInviteSchema } from './tool-schemas.js';
import { makeDraftToken, putDraft, takeDraft, type DraftKind } from './draft-store.js';
import type { ToolsCtx } from './tools-context.js';
import { ownerLang, failureText } from '../lexicon/owner-language.js';
import { renderCopy } from '../lexicon/index.js';
import { canonicalPlatform } from '../scraper/platform-scraper.js';
import { extractPostId } from '../quest/verify-invite-handler.js';
import { submitInvite } from '../invite/submit-invite.js';
import { watchInvite } from '../invite/pending-invites.js';
import { prepareInviteShare, isSupportedInvitePlatform, unsupportedInvitePlatform } from '../invite/prepare-invite-share.js';
import { socialDraftBinding, sameSocialDraftBinding, socialSendAssertion, socialToolFactory, withSocialSendInvocation, type SocialDraftBinding } from '../host/social-send-context.js';

const INVITE_KINDS = ['invite'] as const satisfies readonly DraftKind[];
const CONFIRM_DISCIPLINE = 'Nothing has been submitted. Read the preview back to the owner in their own language; only after they explicitly say go, call popclaw_invite again with confirm_token alone. That second call is the one that submits.';
const KEYS = new Set(['platform', 'handle', 'prepare_only', 'posted', 'proof_url', 'nickname', 'replace', 'sync', 'confirm_token']);
const str = (v: unknown): string => typeof v === 'string' ? v.trim() : '';
type Prepared = { platform: string; handle: string; popclawId: string; consumed: boolean };

export function registerInviteTools(ctx: ToolsCtx): void {
  const { api, runtime, deps } = ctx;
  const host = deps.socialSendHost;
  const native = host === undefined || host === 'native';
  // Registration-scoped, keyed by the SDK's complete conversation binding.
  // Failed preparation never overwrites an earlier target; restart requires prepare again.
  const prepared = new Map<string, Prepared>();
  const confirmations = new Map<string, {binding: SocialDraftBinding; assertCurrent?: () => void}>();
  api.registerTool(socialToolFactory(host, toolContext => {
    const binding = socialDraftBinding(host, toolContext);
    const bindingKey = binding ? JSON.stringify(binding) : null;
    const ownerAssertion = (signal?: AbortSignal): (() => void) => {
      const current = socialSendAssertion(host, toolContext, signal);
      if (!current || (native && (toolContext as {senderIsOwner?: unknown})?.senderIsOwner !== true)) throw new Error('INVITE_OWNER_INVOCATION_REQUIRED');
      return () => {
        current();
        if (native && (toolContext as {senderIsOwner?: unknown}).senderIsOwner !== true) throw new Error('INVITE_OWNER_INVOCATION_REQUIRED');
        if (!sameSocialDraftBinding(binding, socialDraftBinding(host, toolContext))) throw new Error('INVITE_CONVERSATION_CHANGED');
      };
    };
    return {
      name: 'popclaw_invite',
      description: 'Prepare editable invitation copy for the owner’s X account, locally. After the owner says posted/done, call posted:true: Native verifies this chat’s most recent successful preparation, using the current owner invocation. Never submit before that acknowledgement. Other hosts, sync, replacement and nickname changes return a preview; confirm only after owner approval, with confirm_token alone. A token is single-use and expires in 30 minutes.',
      parameters: PopclawInviteSchema,
      execute: async (_callId: string, params: unknown, signal?: AbortSignal) => {
        const p = { ...((params && typeof params === 'object' && !Array.isArray(params)) ? params : {}) } as Record<string, unknown>;
        const lang = ownerLang();
        const fail = (code: string, text = renderCopy(lang, 'invite.prepare.mixed')) => ({type: 'text' as const, isError: true, code, text});
        if (Object.keys(p).some(key => !KEYS.has(key))) return fail('INVITE_ARGUMENTS_INVALID');
        if (['posted', 'prepare_only', 'sync', 'replace'].some(key => p[key] !== undefined && typeof p[key] !== 'boolean')) return fail('INVITE_ARGUMENTS_INVALID');
        const token = str(p.confirm_token);
        if (p.confirm_token !== undefined) {
          if (!token || Object.keys(p).length !== 1) return fail('INVITE_CONFIRM_TOKEN_ALONE');
          try {
            const assert = native ? ownerAssertion(signal) : undefined;
            assert?.();
            const confirmation = confirmations.get(token);
            if (native && !sameSocialDraftBinding(confirmation?.binding, binding)) return fail('INVITE_CONFIRM_CONVERSATION_CHANGED');
            const submit = takeDraft(token, INVITE_KINDS);
            confirmations.delete(token);
            if (!submit) return {type:'text' as const, text:renderCopy(lang, 'invite.tool.expiredToken', {token})};
            if (confirmation && assert) confirmation.assertCurrent = assert;
            const result = await submit();
            return {type:'text' as const, text:result.text};
          } catch (error) { return fail('INVITE_SUBMIT_FAILED', `${failureText('popclaw_invite', error)}\n${renderCopy(lang, 'invite.tool.submitFailed')}`); }
        }
        const posted = p.posted === true;
        if (!posted) {
          if (['proof_url', 'nickname', 'replace', 'sync'].some(key => p[key] !== undefined)) return fail('INVITE_PREPARE_ONLY');
          const platform = str(p.platform), handle = str(p.handle);
          if (!platform || !handle) return fail('INVITE_SHARE_ACCOUNT_REQUIRED', renderCopy(lang, 'invite.tool.usage'));
          if (!isSupportedInvitePlatform(platform)) return {type:'text' as const, isError:true, text:JSON.stringify(unsupportedInvitePlatform(platform))};
          try {
            const identity = await deps.getInviteShareIdentity?.();
            if (!identity) return fail('INVITE_SHARE_IDENTITY_UNAVAILABLE', renderCopy(lang, 'invite.prepare.unavailable'));
            const share = prepareInviteShare(identity, platform, handle);
            // Bind only a successful, still-current owner invocation. MCP may prepare copy,
            // but its posted path continues to require the existing explicit confirmation.
            if (native) { const assert = ownerAssertion(signal); assert(); }
            if (bindingKey) prepared.set(bindingKey, {platform:share.platform, handle:share.handle, popclawId:identity.popclawId, consumed:false});
            return {type:'text' as const, text:JSON.stringify({...share, owner_action_required:true})};
          } catch (error) { return fail('INVITE_PREPARE_FAILED', failureText('popclaw_invite', error)); }
        }
        if (p.prepare_only === true) return fail('INVITE_PREPARE_ONLY');
        const target = bindingKey ? prepared.get(bindingKey) : undefined;
        const rawPlatform = str(p.platform) || target?.platform || '';
        const rawHandle = str(p.handle) || target?.handle || '';
        if (!rawPlatform || !rawHandle) return fail('INVITE_PREPARE_REQUIRED', renderCopy(lang, 'invite.tool.usage'));
        const platform = canonicalPlatform(rawPlatform);
        const handle = rawHandle.replace(/^@/, '');
        if (!isSupportedInvitePlatform(platform)) return {type:'text' as const, isError:true, text:JSON.stringify(unsupportedInvitePlatform(platform))};
        if (!/^[A-Za-z0-9_]{1,15}$/.test(handle)) return fail('INVITE_SHARE_ACCOUNT_REQUIRED');
        const proofGiven = p.proof_url !== undefined && p.proof_url !== null;
        const proofUrl = str(p.proof_url) || undefined;
        if (proofGiven && (proofUrl === undefined || !extractPostId(proofUrl))) return fail('INVITE_BAD_PROOF_URL', renderCopy(lang, 'invite.badProofUrl', {got:proofUrl ?? String(p.proof_url)}));
        const nickname = str(p.nickname) || undefined;
        const replace = p.replace === true, mirrorOptin = p.sync === true;
        const submit = async (assert?: () => void, expectedPopclawId?: string) => {
          const rt = await (assert ? withSocialSendInvocation(assert, runtime) : runtime());
          assert?.();
          if (expectedPopclawId && rt.boot.popclawId !== expectedPopclawId) throw new Error('INVITE_IDENTITY_CHANGED');
          return submitInvite({initiate:opts => assert ? withSocialSendInvocation(assert, () => rt.initiator.initiate(opts)) : rt.initiator.initiate(opts), recordPending:entry => rt.pendingInvites.add(entry),
            watch:taskId => watchInvite(rt.inviteWatch, taskId), onWatchError:message => api.logger?.info(message), webBaseUrl:rt.boot.webBaseUrl},
          {platform, handle, nickname:nickname ?? rt.boot.nickname, replace, proofUrl, mirrorOptin});
        };
        const ordinary = !['sync', 'replace', 'nickname'].some(key => p[key] !== undefined);
        if (native && ordinary) {
          try {
            const invocation = ownerAssertion(signal);
            const assert = () => { invocation(); if (bindingKey && prepared.get(bindingKey) !== target) throw new Error('INVITE_PREPARED_TARGET_CHANGED'); };
            assert();
            if (!target || target.consumed || target.platform !== platform || target.handle.toLowerCase() !== handle.toLowerCase()) return fail('INVITE_PREPARED_TARGET_CHANGED');
            const identity = await deps.getInviteShareIdentity?.(); assert();
            if (!identity || identity.popclawId !== target.popclawId || prepared.get(bindingKey!) !== target || target.consumed) return fail('INVITE_PREPARED_TARGET_CHANGED');
            // Reserve before any asynchronous command/bootstrap/signing work.
            // An uncertain failure does not authorize an automatic paid retry.
            target.consumed = true;
            // Only runtime construction, signing and egress retain this turn's
            // invocation. submitInvite resumes in the original House scope to
            // record the accepted receipt and start its existing result watcher.
            const work = async () => { assert(); return submit(assert, target.popclawId); };
            const result = await (deps.runCommand ? deps.runCommand(work) : work()) as {text:string};
            return {type:'text' as const, text:result.text};
          } catch (error) { return fail('INVITE_SUBMIT_FAILED', failureText('popclaw_invite', error)); }
        }
        const confirmToken = makeDraftToken('invite');
        const confirmation = native && binding ? {binding, assertCurrent: undefined as (() => void) | undefined} : undefined;
        putDraft(confirmToken, () => {
          if (native && !confirmation?.assertCurrent) throw new Error('INVITE_OWNER_INVOCATION_REQUIRED');
          return submit(confirmation?.assertCurrent);
        });
        if (confirmation) confirmations.set(confirmToken, confirmation);
        const preview = renderCopy(lang, 'invite.tool.preview', {platform, handle,
          nickname:nickname ?? renderCopy(lang, 'invite.tool.nicknameDefault'), proof:proofUrl ?? renderCopy(lang, 'invite.tool.proofNone'),
          sync:renderCopy(lang, mirrorOptin ? 'invite.tool.syncOn' : 'invite.tool.syncOff')});
        return {type:'text' as const, text:`${replace ? `${preview}\n${renderCopy(lang, 'invite.tool.replaceLine')}` : preview}\n\nconfirm_token: ${confirmToken}\n${CONFIRM_DISCIPLINE}`, owner_action_required:true};
      },
    };
  }, deps.getHostedSocialInvocation, deps.getLocalSocialScope), {name:'popclaw_invite'});
}
