import type {PluginRuntime} from '../runtime/plugin-runtime.js';
import type {DraftSnapshot} from './draft-store.js';
import {runPopclawMessageCommand, type PopclawMessageDeps} from '../commands/popclaw-message.js';
import {runPopclawReplyCommand, type PopclawReplyDeps} from '../commands/popclaw-reply.js';
import {runPopclawPostCommand} from '../commands/popclaw-post.js';
import {assertHouseActionActive} from '../runtime/house-lifecycle/action-context.js';

export interface DraftSendPlan {
  readonly nickname: string;
  readonly origin?: string;
  readonly participation?: Readonly<{opSeq: number; sessionId: string; installationId: string}> | null;
  readonly person?: PopclawMessageDeps['approvedRecipient'];
  readonly replySource?: ReturnType<PopclawReplyDeps['cache']['lookup']>;
  readonly postSource?: import('../world/thread-post-source.js').NativePostSource | null;
  readonly replyTo?: string;
  readonly quoteOf?: string;
  readonly receiptPrefix?: string;
  readonly receiptSuffix?: string;
}
function participation(rt: PluginRuntime, origin: string): DraftSendPlan['participation'] {
  const row = rt.host.db.queryOne<{op_seq: number; session_id: string; installation_id: string}>(
    'SELECT op_seq,session_id,installation_id FROM house_participation WHERE house_origin=?', [origin]);
  return row ? {opSeq: row.op_seq, sessionId: row.session_id, installationId: row.installation_id} : null;
}
export function pinSocialSendPlan(rt: PluginRuntime, house: string | undefined): Pick<DraftSendPlan, 'nickname' | 'origin' | 'participation'> {
  const target = rt.egress.capturePlan?.().targets.find(t => t.slug === house);
  return {nickname: rt.boot.nickname, ...(target?.origin ? {origin: target.origin} : {}),
    ...(target?.origin ? {participation: participation(rt, target.origin)} : {})};
}
/** Rebuild only the send operation using this process's signer and current
 * invocation. Pinned routing cannot silently follow a new home or rejoined House. */
export async function sendSocialDraft(snapshot: DraftSnapshot, rt: PluginRuntime): Promise<{text: string}> {
  const plan = snapshot.sendPlan!;
  if (plan.origin) {
    const target = rt.egress.capturePlan().targets.find(t => t.slug === snapshot.house);
    if (target?.origin !== plan.origin) throw new Error('SOCIAL_DRAFT_HOUSE_CHANGED');
    assertHouseActionActive(plan.origin);
    // In-memory gate generations reset on restart. Preserve the existing
    // durable op_seq/session generation instead, never a callback or lease.
    if (JSON.stringify(participation(rt, plan.origin)) !== JSON.stringify(plan.participation)) throw new Error('SOCIAL_DRAFT_HOUSE_CHANGED');
  }
  const egress = {
    push: (bytes: Uint8Array) => rt.egress.pushTo(snapshot.house, bytes),
    pushTo: (_house: string | undefined, bytes: Uint8Array) => rt.egress.pushTo(snapshot.house, bytes),
  };
  const common = {signer: rt.boot.signer, nickname: plan.nickname, egress, socialLog: rt.socialLog};
  if (snapshot.kind === 'reply') return runPopclawReplyCommand({positional: [snapshot.target!, snapshot.body]},
    {...common, cache: {lookup: () => plan.replySource ?? null}});
  if (snapshot.kind === 'post') return runPopclawPostCommand({positional: [snapshot.body], flags: {
    ...(plan.replyTo ? {reply: plan.replyTo} : {}), ...(plan.quoteOf ? {quote: plan.quoteOf} : {}),
  }}, {...common, webBaseUrl: rt.boot.webBaseUrl, cache: {
    findByEventIdPrefix: () => ({item: plan.postSource ?? null, ambiguous: []}),
  } as unknown as Parameters<typeof runPopclawPostCommand>[1]['cache']});
  const media = snapshot.attachments[0];
  const reply = await runPopclawMessageCommand({positional: snapshot.body ? [snapshot.recipientId!, snapshot.body] : [snapshot.recipientId!], flags: {}},
    {...common, approvedRecipient: plan.person, resolveRecipient: async () => ({kind: 'resolved' as const, ...plan.person!}),
      houseOfRecipient: () => snapshot.house, replyToEventId: snapshot.target,
      ...(media ? {media: {bytes: media.bytes, mime: media.mime, name: media.name}} : {})});
  if (snapshot.kind === 'feedback' && reply.text.startsWith('✉')) return {text: `${plan.receiptPrefix ?? ''}${reply.text}${plan.receiptSuffix ?? ''}`};
  return reply;
}
