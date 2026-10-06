import { createHash } from 'node:crypto';
import type { HostDb } from './host-db.js';
import type { IntegrityKind } from './integrity-check.js';

export function schemaFingerprint(db: HostDb): string {
  const rows = db.queryAll<{ type: string; name: string }>(
    "SELECT type, name FROM sqlite_master WHERE name <> '_READ_THIS_FIRST' ORDER BY type, name",
  );
  const h = createHash('sha256');
  for (const r of rows) h.update(`${r.type} ${r.name}\n`);
  return h.digest('hex').slice(0, 16);
}


export function inspectIntegrityDatabase(db: HostDb): {
  fingerprint: string;
  problems: Array<{ kind: IntegrityKind; key: string; detail: string }>;
} {
  const problems: Array<{ kind: IntegrityKind; key: string; detail: string }> = [];

  const quick = db
    .queryAll<Record<string, string>>('PRAGMA quick_check(1)')
    .map((r) => String(Object.values(r)[0] ?? ''))
    .filter((v) => v !== 'ok');
  if (quick.length > 0) {
    problems.push({ kind: 'quick_check', key: 'quick_check', detail: quick.join('; ') });
  }

  const fk = db.queryAll<Record<string, unknown>>('PRAGMA foreign_key_check');
  if (fk.length > 0) {
    problems.push({
      kind: 'foreign_key_check',
      key: 'foreign_key_check',
      detail: `${fk.length} dangling foreign-key row(s)`,
    });
  }

  return { fingerprint: schemaFingerprint(db), problems };
}

