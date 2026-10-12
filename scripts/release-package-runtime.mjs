// Runner-only helper: block network, then probe the extracted package.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire, registerHooks, syncBuiltinESMExports} from 'node:module';
import {fileURLToPath, pathToFileURL} from 'node:url';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
const deny = () => {throw new Error('Network is disabled during release package smoke');};
globalThis.fetch = deny;
http.request = http.get = https.request = https.get = deny;
net.createConnection = net.connect = net.Socket.prototype.connect = deny;
syncBuiltinESMExports();
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, root, sdk, state] = process.argv.slice(2);
  const [major, minor] = process.versions.node.split('.').map(Number);
  assert((major === 24 && minor >= 16) || (major === 26 && minor >= 1), 'Unsupported smoke Node runtime');
  if (mode === 'sqlite') {
    const require = createRequire(path.join(root, 'package.json'));
    const Database = require(path.join(root, 'dist/native-deps/better-sqlite3'));
    const binding = path.join(root, 'dist/native-deps/better-sqlite3/build/Release/better_sqlite3-'+process.platform+'-'+process.arch+'-node'+major+'.node');
    const db = new Database(':memory:', {nativeBinding: binding});
    try {
      db.exec('CREATE TABLE smoke(value TEXT)');
      db.prepare('INSERT INTO smoke VALUES (?)').run('packaged-binding');
      assert.equal(db.prepare('SELECT value FROM smoke').get().value, 'packaged-binding');
    } finally {db.close();}
    console.log(JSON.stringify({status:'PASS', mode, node:process.version, abi:process.versions.modules, platform:process.platform, arch:process.arch, binding}));
  } else if (mode === 'native') {
    registerHooks({resolve(specifier, context, next) {
      return specifier.startsWith('openclaw/') ? next(specifier, {...context, parentURL:pathToFileURL(path.join(sdk,'package.json')).href}) : next(specifier,context);
    }});
    fs.mkdirSync(state);
    const manifest = JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
    const plugin = (await import(pathToFileURL(path.join(root,manifest.main)))).default;
    const expected = JSON.parse(fs.readFileSync(path.join(root,'openclaw.plugin.json'),'utf8')).contracts.tools;
    const tools = [], noop = () => {}, context = {agentId:'main',getRuntimeConfig:()=>({})};
    plugin.register({registrationMode:'full',config:{},pluginConfig:{},logger:{debug:noop,info:noop,warn:noop,error:noop},
      runtime:{state:{resolveStateDir:()=>state},system:{enqueueSystemEvent:noop,runHeartbeatOnce:noop}},
      registerTool(value) {
        const result = typeof value === 'function' ? value(context) : 'contextVersion' in value ? value.create(context) : value;
        tools.push(...(Array.isArray(result) ? result : result ? [result] : []));
      }, registerCommand:noop,registerService:noop,registerInteractiveHandler:noop,on:noop});
    assert.equal(plugin.id,'popclaw');
    assert.deepEqual(tools.map(x=>x.name).sort(), [...expected].sort());
    assert.equal(tools.length,55);
    assert.deepEqual(fs.readdirSync(state),[]);
    console.log(JSON.stringify({status:'PASS',mode,node:process.version,toolCount:tools.length,sdkVersion:JSON.parse(fs.readFileSync(path.join(sdk,'package.json'),'utf8')).version,servicesStarted:0,stateWrites:0}));
  } else {throw new Error('Unknown runtime probe mode');}
}
