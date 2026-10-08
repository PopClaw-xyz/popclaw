import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LocalHostDb } from '../../../src/host/local-host-db.js';
import { runMigrations } from '../../../src/host/migrations.js';
import { ensureHouseLifecycleSchema } from '../../../src/runtime/house-lifecycle/participation-store.js';
import { establishTrustInTx } from '../../../src/world/house-binding-pin.js';
import { guideBindingDigest, markGuidesInAgentInput, recordJoinedGuide } from '../../../src/world/house-guide-context.js';
import { mintHouse } from '../../helpers/signed-manifest.js';

const ORIGIN = 'https://guide.invalid';
const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'house-guide-'));
  const db = new LocalHostDb(join(root, 'host.db'));
  runMigrations(db, resolve(dirname(fileURLToPath(import.meta.url)), '../../../migrations'));
  ensureHouseLifecycleSchema(db);
  const house = mintHouse({ origin: ORIGIN });
  db.transaction(tx => {
    establishTrustInTx(tx, { origin: ORIGIN, houseKey: house.houseKey, incarnation: house.incarnation }, 'tofu', 1);
    tx.execute(`INSERT INTO house_participation(house_origin,installation_id,op_seq,desired,phase,updated_at)
      VALUES (?,'guide-test-install',1,'enabled','connected',1)`, [ORIGIN]);
    recordJoinedGuide(tx, { origin: ORIGIN, opSeq: 1,
      rawBytes: new TextEncoder().encode('{"guide_url":"/guide.md"}'), manifestDigest: 'manifest' });
  });
  cleanup.push(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  const row = () => db.queryOne<Record<string, unknown>>('SELECT * FROM house_guide_context WHERE origin=?', [ORIGIN]);
  return { db, row };
}

it('joined replacement synchronously clears an existing body and delivery even at the same pointer', () => {
  const f = fixture();
  f.db.execute(`UPDATE house_guide_context SET guide_body='old',guide_digest='old-digest',delivered_digest='old-digest'`);
  const result = f.db.transaction(tx => recordJoinedGuide(tx, { origin: ORIGIN, opSeq: 2,
    rawBytes: new TextEncoder().encode('{"guide_url":"/guide.md"}'), manifestDigest: 'next-manifest' }));
  expect(result).toBeUndefined();
  expect(f.row()).toMatchObject({ op_seq: 2, guide_url: ORIGIN + '/guide.md', manifest_digest: 'next-manifest',
    guide_body: null, guide_digest: null, delivered_digest: null });
});

it('JSON parsing remains inside the callers SQLite transaction and rolls its prior writes back', () => {
  const f = fixture(), before = f.row();
  expect(() => f.db.transaction(tx => {
    tx.execute('UPDATE house_participation SET op_seq=2 WHERE house_origin=?', [ORIGIN]);
    recordJoinedGuide(tx, { origin: ORIGIN, opSeq: 2, rawBytes: new TextEncoder().encode('{invalid'), manifestDigest: 'bad' });
  })).toThrow();
  expect(f.row()).toEqual(before);
  expect(f.db.queryOne<{op_seq:number}>('SELECT op_seq FROM house_participation WHERE house_origin=?', [ORIGIN])?.op_seq).toBe(1);
});

it('observer requires every captured field and a current binding, through actual serialized wrappers', () => {
  const f = fixture();
  f.db.execute(`UPDATE house_guide_context SET guide_body='complete guide',guide_digest='body-digest'`);
  const context = { status: 'available', origin: ORIGIN, opSeq: 1, bindingDigest: guideBindingDigest(f.db, ORIGIN),
    guideDigest: 'body-digest', guide: 'complete guide' };
  const emit = (value: unknown) => markGuidesInAgentInput(f.db, JSON.stringify({content:[{type:'text',text:'joined\n' + JSON.stringify(value)}]}));
  for (const invalid of [{...context, guide: 'complete'}, {...context, opSeq: 2},
    {...context, bindingDigest: 'other'}, {...context, guideDigest: 'other'}, {...context, origin: 'https://other.invalid'}]) {
    emit(invalid); expect(f.row()?.delivered_digest).toBeNull();
  }
  emit(context); expect(f.row()?.delivered_digest).toBe('body-digest');
  f.db.execute('UPDATE house_guide_context SET delivered_digest=NULL');
  f.db.execute('UPDATE house_binding_pin SET revision=revision+1 WHERE origin=?', [ORIGIN]);
  emit(context); expect(f.row()?.delivered_digest).toBeNull();
});

it('observer preserves the depth-eight limit and permits a shallower positive control', () => {
  const f = fixture();
  f.db.execute(`UPDATE house_guide_context SET guide_body='complete guide',guide_digest='body-digest'`);
  const context = { status: 'available', origin: ORIGIN, opSeq: 1, bindingDigest: guideBindingDigest(f.db, ORIGIN),
    guideDigest: 'body-digest', guide: 'complete guide' };
  const nested = (depth: number) => {
    let value: unknown = context;
    for (let i = 0; i < depth; i++) value = { child: value };
    return JSON.stringify(value);
  };
  markGuidesInAgentInput(f.db, nested(8)); expect(f.row()?.delivered_digest).toBeNull();
  markGuidesInAgentInput(f.db, nested(7)); expect(f.row()?.delivered_digest).toBe('body-digest');
});
