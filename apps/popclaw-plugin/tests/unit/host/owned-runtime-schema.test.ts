import {expect,it} from 'vitest';
import {InMemoryHostDb} from '../../../src/host/in-memory-host-db.js';
import {ensureExecutionStoreIdentitySchema,ensureExecutionStoreCatalogSchema,addPrivateMessageFeatureColumn} from '../../../src/host/execution-catalog-schema.js';
import {ExecutionStoreCatalog} from '../../../src/host/execution-store.js';
import {ensureHouseOriginBindingsSchema,ensureHouseRecoveryCursorEvidenceSchema} from '../../../src/runtime/house-lifecycle/house-runtime-schema.js';
import {PopclawPaths} from '../../../src/host/popclaw-paths.js';

it('schema-only entry points create only the original empty tables; optional marker stays uncertified',()=>{
  const db=new InMemoryHostDb();
  try {
    ensureExecutionStoreIdentitySchema(db);ensureExecutionStoreCatalogSchema(db);
    ensureHouseOriginBindingsSchema(db);ensureHouseRecoveryCursorEvidenceSchema(db);
    const names=db.queryAll<{name:string}>("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").map(row=>row.name);
    expect(names).toEqual(['execution_store_catalog_v1','execution_store_identity_v1','house_origin_bindings','house_recovery_cursor_evidence_v1']);
    for(const name of names)expect(db.queryAll(`SELECT * FROM ${name}`)).toEqual([]);
    expect(db.queryAll<{name:string}>('PRAGMA table_info(execution_store_catalog_v1)').some(row=>row.name==='private_message_feature')).toBe(false);
    db.execute("INSERT INTO execution_store_catalog_v1(origin,actor_id,store_id,layout_version) VALUES('https://synthetic.invalid','actor','store',1)");
    addPrivateMessageFeatureColumn(db);addPrivateMessageFeatureColumn(db);
    expect(db.queryOne('SELECT required_tables,private_message_feature FROM execution_store_catalog_v1')).toEqual({required_tables:'[]',private_message_feature:null});
  } finally {db.close();}
});
it('real catalog constructor uses the same base schema without eagerly adding the optional feature column',()=>{
  const db=new InMemoryHostDb(),expected=new InMemoryHostDb();
  try {
    ensureExecutionStoreIdentitySchema(expected);ensureExecutionStoreCatalogSchema(expected);
    const catalog=new ExecutionStoreCatalog({db,paths:new PopclawPaths('/synthetic-not-opened'),actorId:'synthetic-actor'});
    expect(db.queryAll("SELECT name,sql FROM sqlite_master WHERE type='table' ORDER BY name")).toEqual(expected.queryAll("SELECT name,sql FROM sqlite_master WHERE type='table' ORDER BY name"));
    expect(db.queryOne('SELECT actor_id FROM execution_store_identity_v1')).toEqual({actor_id:'synthetic-actor'});
    catalog.close();
  } finally {db.close();expected.close();}
});
