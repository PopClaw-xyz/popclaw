import {expect, it} from 'vitest';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {InMemoryHostDb} from '../../../src/host/in-memory-host-db.js';
import {runMigrations} from '../../../src/host/migrations.js';
import {openRelationReception} from '../../../src/social-graph/relation-reception.js';
import {KnownFollowersStore} from '../../../src/social-graph/followers-sync.js';
import {firstErrorAbortsShutdown, guardedShutdown} from '../../../src/runtime/assembly/core.js';

const migrations=resolve(dirname(fileURLToPath(import.meta.url)),'../../../migrations');
const settle=async()=>{for(let n=0;n<4;n++)await new Promise<void>(resolve=>setImmediate(resolve));};

it('joins a held follower notification and a rejected resend, then permanently stops the real schedule',async()=>{
  const db=new InMemoryHostDb();runMigrations(db,migrations);
  new KnownFollowersStore(db).noteVerifiedFollow('synthetic','synthetic-follower');
  let release!:()=>void;
  const held=new Promise<void>(resolve=>{release=resolve;});
  const warnings:string[]=[];let announcements=0,sweeps=0;
  const reception=await openRelationReception({
    db,recipientPopclawId:'synthetic-owner',signer:{} as never,readAuthorityFor:()=>({} as never),onMessage() {},
    autostart:false,drainIntervalMs:10,
    notifyNewFollowers:async batch=>{announcements++;expect(batch).toHaveLength(1);await held;db.queryOne('SELECT 1');return batch.length;},
    resendRelations:async valid=>{sweeps++;await held;expect(valid()).toBe(false);throw Error('synthetic resend failed');},
    log:{warn:message=>warnings.push(message)},
  });
  let joined=false;
  try {
    reception.host.start();expect({announcements,sweeps}).toEqual({announcements:1,sweeps:1});
    reception.stop();const idle=reception.whenIdle().then(()=>{joined=true;});await settle();expect(joined).toBe(false);
    release();await idle;expect(joined).toBe(true);expect(warnings).toEqual([expect.stringContaining('synthetic resend failed')]);
    reception.host.start();await new Promise(resolve=>setTimeout(resolve,30));
    expect({announcements,sweeps}).toEqual({announcements:1,sweeps:1});
  } finally {release();reception.stop();await reception.whenIdle();db.close();}
});

it.each(['MCP','Native'] as const)('%s failed relation join cannot close databases or release storage',async kind=>{
  const db=new InMemoryHostDb();let released=false,closed=false;const warnings:string[]=[];
  const noop=()=>{};const host={db};const worlds={stop:noop,whenIdle:async()=>{}};
  const reception={stop:noop,whenIdle:async()=>{throw Error('synthetic join failed');}};
  const houses={stop:async()=>{}};const executionStores={close:()=>{closed=true;}};
  const platform={releaseStorage:()=>{released=true;}};
  const shutdown=kind==='MCP'?firstErrorAbortsShutdown({host,ports:{platform},loops:{},lane:{stop:noop},worlds,reception,houses,houseStores:[],executionStores} as never)
    :guardedShutdown({host,platform,log:{warn:(message:string)=>warnings.push(message)},
      hostOps:{markStorageShuttingDown:noop,resetOwnerApprovals:noop,snapshotStorageBackups:()=>[]},
      lane:{stop:noop},worlds,reception,houses,houseStores:[],executionStores} as never);
  try {
    if(kind==='MCP')await expect(shutdown()).rejects.toThrow('synthetic join failed');else await shutdown();
    expect({released,closed}).toEqual({released:false,closed:false});expect(db.queryOne('SELECT 1 AS open')).toEqual({open:1});
    if(kind==='Native')expect(warnings).toEqual([expect.stringContaining('synthetic join failed')]);
  } finally {db.close();}
});
