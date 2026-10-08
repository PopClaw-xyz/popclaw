/** A previously joined test installation, created through normal admission.
 * The signed manifest declares identity reads. The MCP child restores this
 * durable participation; a configured URL alone grants no participation.
 */
import {LocalHostAdapter} from '../../src/host/local-host-adapter.js';
import {PopclawPaths} from '../../src/host/popclaw-paths.js';
import {registerStorageRuntime} from '../../src/host/storage-maintenance.js';
import {bootstrapPlugin} from '../../src/runtime/plugin-bootstrap.js';
import {HouseLifecycleManager} from '../../src/runtime/house-lifecycle/manager.js';
import {HouseCommandBus} from '../../src/runtime/house-lifecycle/command-bus.js';
import {resolveInstallationId} from '../../src/runtime/house-lifecycle/installation.js';
import {localParticipationPort} from '../../src/host/local-participation.js';
import {makeRelationBindingPreparer} from '../../src/social-graph/relation-binding.js';
import {mintHouse} from './signed-manifest.js';
import bs58 from 'bs58';
import {makeWorldManifestPreparer} from '../../src/world/world-capabilities.js';
export const SEEDED_HOUSE_KEY = mintHouse({origin:'https://fixture.invalid',seed:7}).houseKey;
export async function seedTrustedHouse(root:string,houseUrl:string,manifest:Record<string,unknown>={}):Promise<void> {
  const paths=new PopclawPaths(root);
  let release=()=>{};
  const host=new LocalHostAdapter({dataRoot:root,logger:{info(){},warn(){},error(){}},
    beforeDbInitialize:db=>{release=registerStorageRuntime(db,paths);return release;}});
  const boot=await bootstrapPlugin(host),db=host.db;
  const participation=localParticipationPort(()=>undefined);
  const installationId=resolveInstallationId(db);
  const house=mintHouse({origin:houseUrl,seed:7,manifest:{read_auth:{schemes:['popclaw-identity-read-v2']},...manifest}});
  const prepareRelation=makeRelationBindingPreparer({db,allowInsecureOrigin:()=>true});
  const manager=new HouseLifecycleManager({db,installationId,signer:boot.signer,actorId:boot.popclawId,
    participation,fetch:house.fetch as typeof fetch,prepareRelationBinding:async input=>{
      const relation=await prepareRelation(input);
      if(manifest.world_interaction===undefined)return relation;
      // Keep capability and relation verification at the checked join boundary.
      const world=await makeWorldManifestPreparer()({...input,
        ackKeyHex:Buffer.from(bs58.decode(house.houseKey)).toString('hex'),provenance:'configured_pin'});
      return {commit:tx=>{const refusal=relation.commit(tx);if(refusal!==undefined)return refusal;world.commit(tx);}};
    }});
  const bus=new HouseCommandBus({db,pollMs:1,timeoutMs:5000,authority:{captureEpoch:()=>1,isEpochCurrent:epoch=>epoch===1},
    coordinator:{loginHouse:(origin,authority)=>manager.loginHouse(origin,authority),logoutHouse:origin=>manager.logoutHouse(origin),
      getHouseStatus:origin=>manager.getHouseStatus(origin),knownHouseOrigins:()=>[houseUrl]},
    captureLogin:origin=>participation.capture({reason:'explicit_owner_join',origin,actorId:boot.popclawId,installationId})});
  try {
    bus.start();
    const result=await bus.loginHouse(houseUrl);
    if(result.admission!=='configured')throw new Error(`Fixture normal join failed: ${JSON.stringify(result)}`);
  } finally {await bus.stop();manager.stopHost();await manager.waitForQuiet();release();db.close();}
}
