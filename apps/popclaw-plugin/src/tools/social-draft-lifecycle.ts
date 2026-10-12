/** Ordinary social manuscript ownership from freeze through one-use send.
 * Durable drafts never enter the volatile callback table. */
import type {PluginRuntime} from '../runtime/plugin-runtime.js';
import type {RegisterToolsDeps} from './tools-context.js';
import {DurableSocialDrafts, socialDraftStore, socialDraftToken} from './durable-social-drafts.js';
import {pinSocialSendPlan, sendSocialDraft, type DraftSendPlan} from './draft-send-plan.js';
import {draftContentIsCurrent, draftDigest, draftSnapshotDigest, expiredDraftText, freezeDraftSnapshot,
  noteDraftPreview, noteDraftToolOutput, peekDraftSnapshot, putDraft, takeDraft, verifyDraftReview,
  verifySnapshotReview, setDraftReviewFiles, type DraftReviewFiles, type DraftSnapshot} from './draft-store.js';
import {resolveDraftReviewFiles, reviewSnapshot, withDraftReview} from './draft-review.js';
import type {PreviewDeliveryStatus} from './draft-preview-delivery.js';
import {sameSocialDraftBinding, withSocialSendInvocation, type SocialDraftBinding} from '../host/social-send-context.js';
import {renderCopy} from '../lexicon/index.js';
import {ownerLang} from '../lexicon/owner-language.js';

const SEND_KINDS = ['reply', 'message', 'post'] as const;
type SendReply = {text: string; isError?: true};
const saveFailed = (cause?: unknown) => new Error(renderCopy(ownerLang(), 'socialSend.saveFailed'), {cause});

/** Entries capture the egress at their existing source-read boundary, before
 * attachment checks or other awaits. The lifecycle retains that exact route. */
export function captureSocialDraftRoute(rt: PluginRuntime) {
  return {egress: rt.egress?.capturePlan?.().egress ?? rt.egress};
}

/** Capture routing and material once. Only feedback compatibility retains its
 * command's supplied callback (including the legacy live primary relay). */
export async function beginSocialDraft(deps: RegisterToolsDeps, snapshot: DraftSnapshot,
  runtimeAtDraft: PluginRuntime | (() => Promise<PluginRuntime>), plan: Omit<DraftSendPlan, 'nickname'>,
  getBinding: () => SocialDraftBinding | null,
  compatibility?: {egress?: ReturnType<typeof captureSocialDraftRoute>['egress']; recipientRef?: string; feedbackSend?: () => Promise<SendReply>}) {
  const id = await socialDraftToken(deps, snapshot.kind === 'dm' || snapshot.kind === 'feedback' ? 'message' : snapshot.kind);
  // Match the entry boundary: mint first, then bind, before feedback refreshes runtime.
  const binding = getBinding();
  const rt = typeof runtimeAtDraft === 'function' ? await runtimeAtDraft() : runtimeAtDraft;
  let frozen = freezeDraftSnapshot({...snapshot, binding, sendPlan: {
    ...(deps.durableSocialDrafts ? pinSocialSendPlan(rt, snapshot.house) : {nickname: rt.boot.nickname}), ...plan,
  }});
  const digest = draftSnapshotDigest(frozen);
  if (!deps.durableSocialDrafts) {
    let send = compatibility?.feedbackSend;
    if (!send) {
      const egress = compatibility?.egress ?? captureSocialDraftRoute(rt).egress;
      send = async () => sendSocialDraft(frozen, await deps.runtime(), {egress, recipientRef: compatibility?.recipientRef});
    }
    putDraft(id, send, frozen);
  }
  return {
    id,
    snapshot: frozen,
    /** Complete preview, optional review copy and exact tool output together;
     * only then retain the durable manuscript. Formatting stays at the entry. */
    async complete(preview: string, status: PreviewDeliveryStatus, reviewText: string,
      output: (reviewed: string) => string = text => text): Promise<string> {
      if (!deps.durableSocialDrafts) {
        noteDraftPreview(id, preview, status);
        const text = output(withDraftReview(id, reviewText, deps.draftReviewFiles));
        noteDraftToolOutput(id, text);
        return text;
      }
      frozen = freezeDraftSnapshot({...frozen, preview: {digest: draftDigest(preview), status, at: Date.now()}});
      const files = resolveDraftReviewFiles(deps.draftReviewFiles);
      setDraftReviewFiles(files);
      const reviewed = reviewSnapshot(id, frozen, reviewText, files);
      if (reviewed.review) frozen = freezeDraftSnapshot({...frozen, review: reviewed.review});
      const text = output(reviewed.text);
      if (frozen.body.trim() && text.includes(frozen.body)) {
        frozen = freezeDraftSnapshot({...frozen, output: {digest: draftDigest(text), at: Date.now()}});
      }
      if (draftSnapshotDigest(frozen) !== digest) throw saveFailed();
      try { (await socialDraftStore(deps)).save(id, frozen); }
      catch (cause) { throw saveFailed(cause); }
      return text;
    },
  };
}

export type SocialDraftSendResult = {status: 'refused'; text: string} |
  {status: 'sent'; snapshot: DraftSnapshot; reply: SendReply};

/** Load/check without taking ownership of a retained preview. Spend before
 * transport; unknown outcomes stay spent. A pre-consumption refusal retains it. */
export async function sendOrdinarySocialDraft(deps: RegisterToolsDeps, id: string,
  getBinding: () => SocialDraftBinding | null, assertCurrent: () => void): Promise<SocialDraftSendResult> {
  assertCurrent();
  const refused = (key: Parameters<typeof renderCopy>[1]): SocialDraftSendResult => ({status: 'refused', text: renderCopy(ownerLang(), key)});
  const unavailable = (): SocialDraftSendResult => ({status: 'refused', text: deps.durableSocialDrafts
    ? renderCopy(ownerLang(), 'socialSend.draftUnavailable') : expiredDraftText(id)});
  let durable: DurableSocialDrafts | null = null;
  let snapshot: DraftSnapshot | null;
  let rt: PluginRuntime | undefined;
  let files: DraftReviewFiles | null = null;
  if (deps.durableSocialDrafts) {
    if (!SEND_KINDS.some(kind => id.startsWith(`${kind}-`))) return unavailable();
    durable = await socialDraftStore(deps);
    assertCurrent();
    try { snapshot = durable.load(id); }
    catch (error) {
      if (error instanceof Error && error.message === 'SOCIAL_DRAFT_MATERIAL_CHANGED') return refused('socialSend.materialChanged');
      throw error;
    }
    if (!snapshot) return unavailable();
    if (!sameSocialDraftBinding(snapshot.binding, getBinding())) return refused('socialSend.conversationChanged');
    rt = await deps.runtime();
    assertCurrent();
    // Hosted current getters may rotate across either runtime await.
    if (!sameSocialDraftBinding(snapshot.binding, getBinding())) return refused('socialSend.conversationChanged');
    files = resolveDraftReviewFiles(deps.draftReviewFiles);
    if (verifySnapshotReview(snapshot, files) === 'changed') return refused('socialSend.reviewChanged');
  } else {
    snapshot = peekDraftSnapshot(id);
    if (!snapshot) return unavailable();
    if (!sameSocialDraftBinding(snapshot.binding, getBinding())) return refused('socialSend.conversationChanged');
    if (!draftContentIsCurrent(id)) return refused('socialSend.materialChanged');
    if (verifyDraftReview(id) === 'changed') return refused('socialSend.reviewChanged');
  }
  assertCurrent();
  let send: (() => Promise<SendReply>) | null;
  if (durable) {
    if (!durable.consume(id)) return unavailable();
    if (snapshot.review?.file) files?.remove(snapshot.review.file.path);
    send = () => sendSocialDraft(snapshot, rt!);
  } else send = takeDraft(id, SEND_KINDS);
  if (!send) return unavailable();
  const reply = await withSocialSendInvocation(assertCurrent, send);
  return {status: 'sent', snapshot, reply};
}
