/** Read delivery eligibility without loading a private letter or its attachments. */
import type { HostDb } from '../host/host-db.js';
export function isQueuedInboxNotification(db: HostDb, id: number, sender: unknown): boolean {
  if (typeof sender !== 'string') return false;
  return !!db.queryOne(`SELECT 1 FROM inbox WHERE id=? AND from_popclaw_id=?
    AND notification_state='queued' AND resolved_at_ms IS NULL`, [id, sender]);
}
