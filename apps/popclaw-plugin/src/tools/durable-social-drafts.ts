import type {HostDb} from '../host/host-db.js';
import {decodeSocialDraft, encodeSocialDraft} from '../host/social-draft-codec.js';
import {draftContentIsCurrent, draftDigest, forgetDraft, makeDraftToken, peekDraftSnapshot, type DraftKind, type DraftSnapshot} from './draft-store.js';
import type {RegisterToolsDeps} from './tools-context.js';
import {renderCopy} from '../lexicon/index.js';
import {ownerLang} from '../lexicon/owner-language.js';

/** Per identity, in the existing private host database. No TTL or capacity
 * eviction for ordinary social manuscripts. Consumed rows retain only a tombstone. */
export class DurableSocialDrafts {
  constructor(private readonly db: HostDb, private readonly actor: string) {
    if (!actor) throw new Error('SOCIAL_DRAFT_IDENTITY_REQUIRED');
  }
  mint(kind: DraftKind): string {
    return this.db.transaction(tx => {
      const value = tx.queryOne<{value: number}>('SELECT value FROM social_chat_draft_counter WHERE singleton=1')!.value + 1;
      tx.execute('UPDATE social_chat_draft_counter SET value=? WHERE singleton=1', [value]);
      return `${kind}-s${value}`;
    });
  }
  save(id: string, snapshot: DraftSnapshot): void {
    if (!snapshot.binding || !snapshot.sendPlan) throw new Error('SOCIAL_DRAFT_CONTEXT_REQUIRED');
    const payload = encodeSocialDraft({version: 1, snapshot});
    this.db.execute('INSERT INTO social_chat_drafts (actor_id,draft_id,payload,digest,created_at) VALUES (?,?,?,?,?)',
      [this.actor, id, payload, draftDigest(payload), Date.now()]);
  }
  load(id: string): DraftSnapshot | null {
    const row = this.db.queryOne<{payload: string | null; digest: string}>(
      'SELECT payload,digest FROM social_chat_drafts WHERE actor_id=? AND draft_id=? AND consumed_at IS NULL', [this.actor, id]);
    if (!row?.payload) return null;
    if (draftDigest(row.payload) !== row.digest) throw new Error('SOCIAL_DRAFT_MATERIAL_CHANGED');
    const stored = decodeSocialDraft<{version: number; snapshot: DraftSnapshot}>(row.payload);
    if (stored.version !== 1 || !stored.snapshot.binding || !stored.snapshot.sendPlan) throw new Error('SOCIAL_DRAFT_MATERIAL_CHANGED');
    return stored.snapshot;
  }
  /** Single SQLite CAS, also across processes. An uncertain send is spent. */
  consume(id: string): boolean {
    return this.db.execute('UPDATE social_chat_drafts SET consumed_at=?,payload=NULL WHERE actor_id=? AND draft_id=? AND consumed_at IS NULL',
      [Date.now(), this.actor, id]).changes === 1;
  }
}
export async function socialDraftStore(deps: RegisterToolsDeps): Promise<DurableSocialDrafts> {
  const rt = await deps.runtime();
  return new DurableSocialDrafts(rt.host.db, rt.boot.popclawId);
}
/** Short non-secret handles, unique across normal restart and identity changes
 * within this database; never present them as consent or authorization. */
export async function socialDraftToken(deps: RegisterToolsDeps, kind: DraftKind): Promise<string> {
  if (!deps.durableSocialDrafts) return makeDraftToken(kind);
  try { return (await socialDraftStore(deps)).mint(kind); }
  catch (error) { throw new Error(renderCopy(ownerLang(), 'socialSend.saveFailed'), {cause: error}); }
}
/** Persist only after the complete preview/review output is recorded. The
 * closure cache is then discarded without deleting the durable review copy. */
export async function retainSocialDraft(deps: RegisterToolsDeps, id: string): Promise<void> {
  if (!deps.durableSocialDrafts) return;
  const snapshot = peekDraftSnapshot(id);
  if (!snapshot || !draftContentIsCurrent(id)) throw new Error(renderCopy(ownerLang(), 'socialSend.saveFailed'));
  try { (await socialDraftStore(deps)).save(id, snapshot); }
  catch (error) { throw new Error(renderCopy(ownerLang(), 'socialSend.saveFailed'), {cause: error}); }
  forgetDraft(id);
}
