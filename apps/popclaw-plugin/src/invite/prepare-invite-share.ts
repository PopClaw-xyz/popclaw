import { deriveSigil } from './sigil.js';
import { canonicalPlatform } from '../scraper/platform-scraper.js';
import { ownerLang } from '../lexicon/owner-language.js';
import { renderCopy } from '../lexicon/index.js';
import type { PluginRuntime } from '../runtime/plugin-runtime.js';

/** Existing connected identity only; preparation owns no signer or network port. */
export interface InviteShareIdentity {
  readonly popclawId: string;
  readonly nickname: string;
  readonly webBaseUrl: string;
}

export function currentInviteShareIdentity(rt: PluginRuntime | null | undefined): InviteShareIdentity | null {
  if (!rt) return null;
  try {
    if (!rt.houseRuntime.publicReadGate(rt.boot.loreHouseUrl).isActive()) return null;
    return { popclawId: rt.boot.popclawId, nickname: rt.boot.nickname, webBaseUrl: rt.boot.webBaseUrl };
  } catch { return null; }
}

export function isSupportedInvitePlatform(rawPlatform: string): boolean {
  return canonicalPlatform(rawPlatform.trim()) === 'x';
}

export function unsupportedInvitePlatform(rawPlatform: string) {
  const platform = canonicalPlatform(rawPlatform.trim());
  return { status: 'unsupported' as const, code: 'INVITE_PLATFORM_UNSUPPORTED', platform,
    guidance: renderCopy(ownerLang(), 'invite.tool.unsupported', { platform }) };
}

export function normalizeInviteHandle(rawHandle: string): string {
  return rawHandle.trim().replace(/^@/, '');
}

/** Cheap entry preflight: no runtime, signer, ledger or external query. */
export function inviteAccountError(rawPlatform: string, rawHandle: string): string | undefined {
  if (!isSupportedInvitePlatform(rawPlatform)) return unsupportedInvitePlatform(rawPlatform).guidance;
  if (!/^[A-Za-z0-9_]{1,15}$/.test(normalizeInviteHandle(rawHandle))) {
    return renderCopy(ownerLang(), 'invite.invalidHandle');
  }
  return undefined;
}

/** The share URL is fixed; arbitrary owner-edited social copy is not evidence. */
export function prepareInviteShare(identity: InviteShareIdentity, rawPlatform: string, rawHandle: string) {
  const platform = canonicalPlatform(rawPlatform.trim());
  const handle = normalizeInviteHandle(rawHandle);
  if (inviteAccountError(rawPlatform, rawHandle)) throw new Error('INVITE_SHARE_ACCOUNT_REQUIRED');
  const sigil = deriveSigil(identity.popclawId);
  const inviteUrl = `https://popclaw.me/invite/${sigil}`;
  const posting = renderCopy(ownerLang(), 'invite.prepare.postingInstructions', { handle });
  const editing = renderCopy(ownerLang(), 'invite.prepare.editingInstructions');
  const guidance = renderCopy(ownerLang(), 'invite.prepare.guidance', { handle });
  const copy = renderCopy(ownerLang(), 'invite.result.postLine1', { handle, sigil, link: inviteUrl }).trim();
  return {
    status: 'prepared' as const, platform, handle, popclaw_id: identity.popclawId, sigil,
    invite_url: inviteUrl,
    postable_copy: copy,
    posting_instructions: posting,
    editing_instructions: editing,
    guidance,
    display_text: `${posting}\n${editing}\n\n\`\`\`text\n${copy}\n\`\`\`\n\n${guidance}`,
    after_posting: { tool: 'popclaw_invite', arguments: { posted: true, platform, handle } },
    agent_instruction: 'In this invitation flow, a natural owner posting acknowledgement such as "posted" or "done", in any language, requests verification. Use after_posting from the MOST RECENT successfully prepared account in this conversation. A later preparation for B replaces A as this conversation’s target, even though the invitation URL is unchanged. Call popclaw_invite; do not merely read a namecard or claim a ranger will scan periodically. This next-call suggestion does not itself authorize execution: wait for the owner’s posting acknowledgement. Do not create a global last-account state across chats.',
  };
}
