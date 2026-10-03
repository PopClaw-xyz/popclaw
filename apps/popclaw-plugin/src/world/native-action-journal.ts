import { cidFromCanonical } from '@popclaw/algorithms';
import type { HostDb } from '../host/host-db.js';
import { canonicalActionJson, defineActionJournalTable, inspectActionJournalTable, snapshotActionJournalTableOriginalContent,
  assertActionReceiptJournalSchema, snapshotActionReceiptOriginalContent, type ActionReceiptPartition, type ActionOriginalContent } from './action-receipt-journal.js';

export const NATIVE_ACTION_FEATURE_PROFILE = 'native-action-execution-v1' as const;
export const NATIVE_ACTION_SCHEMA_FINGERPRINT = '3d23995264d66b5e82d5089daeb6c7ca6b231a1ea7e2ebb34a16a05fa6633219';
const table = defineActionJournalTable('world_native_action_reservations',
  'binding:TEXT,reservation_id:TEXT,invocation_key:TEXT,principal_json:TEXT,policy_source_json:TEXT,policy_revision:TEXT,policy_scope_json:TEXT,input_json:TEXT,reserved_at:INTEGER,expires_at:INTEGER,request_id:TEXT:?,status:TEXT',
  ['binding','reservation_id'], [['binding','invocation_key'],['binding','request_id']]);
const fail = (): never => { throw new Error('NATIVE_ACTION_SCHEMA_UNSUPPORTED'); };
function inspect(db: HostDb) {
  try {
    const actual = inspectActionJournalTable(db, table.name);
    if (actual && canonicalActionJson(actual) !== canonicalActionJson(table)) fail();
    return actual;
  } catch { return fail(); }
}
/** Read-only actual-schema assertion; neither assertion nor normal opening can
 * create a feature. The original five-table feature is a strict prerequisite. */
export function assertNativeActionJournalSchema(executionDb: HostDb, expectedPartition: ActionReceiptPartition) {
  const { partition } = assertActionReceiptJournalSchema(executionDb, expectedPartition);
  const actual = inspect(executionDb); if (!actual) return fail();
  const schemaFingerprint = cidFromCanonical(new TextEncoder().encode('POPCLAW_NATIVE_ACTION_SCHEMA_V1\n' +
    canonicalActionJson({profile:NATIVE_ACTION_FEATURE_PROFILE,shapeVersion:1,tables:[actual]})));
  if (schemaFingerprint !== NATIVE_ACTION_SCHEMA_FINGERPRINT) return fail();
  return {featureProfile:NATIVE_ACTION_FEATURE_PROFILE,schemaFingerprint,partition};
}
export function snapshotNativeActionOriginalContent(executionDb: HostDb): Record<string, ActionOriginalContent | null> {
  const actual = inspect(executionDb);
  return {[table.name]:actual ? snapshotActionJournalTableOriginalContent(executionDb,table.name) : null};
}
export interface NativeActionPreparationReport {
  featureProfile: typeof NATIVE_ACTION_FEATURE_PROFILE;
  schemaFingerprint: string;
  partition: ActionReceiptPartition;
  createdTables: string[];
  addedColumns: {table:string;column:string}[];
  preservedLegacyCounts: Record<string,string>;
  originalContent: Record<string,{before:ActionOriginalContent|null;after:ActionOriginalContent}>;
  oldActionOriginalContent: Record<string,{before:ActionOriginalContent;after:ActionOriginalContent}>;
}
/** Sole native H31 preparation transaction. G0 persists protection intent in G
 * before this call and verifies returned evidence after it, without wrapping an
 * outer transaction. Fresh stores prepare the old feature separately first. */
export function prepareNativeActionJournal(input: {executionDb:HostDb;expectedPartition:ActionReceiptPartition;expectedSchemaFingerprint:string}): NativeActionPreparationReport {
  if (input.expectedSchemaFingerprint !== NATIVE_ACTION_SCHEMA_FINGERPRINT) return fail();
  return input.executionDb.transaction(tx => {
    assertActionReceiptJournalSchema(tx,input.expectedPartition);
    const oldBefore = snapshotActionReceiptOriginalContent(tx);
    const before = snapshotNativeActionOriginalContent(tx)[table.name]!;
    const createdTables: string[] = [];
    if (!before) {
      const quote = (name:string) => '"' + name.replace(/"/g,'""') + '"';
      const fields = table.columns.map(column => `${quote(column.name)} ${column.type}${column.notNull ? ' NOT NULL' : ''}`);
      for (const index of table.indexes) fields.push(`${index.origin === 'pk' ? 'PRIMARY KEY' : 'UNIQUE'}(${index.keys.map(key=>quote(key.name)).join(',')})`);
      tx.execute(`CREATE TABLE ${quote(table.name)} (${fields.join(',')})`); createdTables.push(table.name);
    }
    const verified = assertNativeActionJournalSchema(tx,input.expectedPartition);
    const after = snapshotNativeActionOriginalContent(tx)[table.name]!;
    if (!after || (before ? canonicalActionJson(before) !== canonicalActionJson(after) : after.rowCount !== '0')) throw new Error('ACTION_ORIGINAL_CONTENT_CHANGED');
    const oldAfter = snapshotActionReceiptOriginalContent(tx);
    if (canonicalActionJson(oldBefore) !== canonicalActionJson(oldAfter)) throw new Error('ACTION_ORIGINAL_CONTENT_CHANGED');
    const oldActionOriginalContent: NativeActionPreparationReport['oldActionOriginalContent'] = {};
    for (const [name,content] of Object.entries(oldBefore)) {
      if (!content || !oldAfter[name]) throw new Error('ACTION_ORIGINAL_CONTENT_CHANGED');
      oldActionOriginalContent[name] = {before:content,after:oldAfter[name]};
    }
    return {...verified,createdTables,addedColumns:[],preservedLegacyCounts:before ? {[table.name]:before.rowCount} : {},
      originalContent:{[table.name]:{before,after}},oldActionOriginalContent};
  });
}
