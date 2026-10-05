// Explicit opt-in rehearsal against the selected official OpenClaw CLI.
// No real host config, provider request, Gateway start or PopClaw package is used.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = process.env.OPENCLAW_NATIVE_CLI;
assert.ok(cli && path.isAbsolute(cli), 'Select OPENCLAW_NATIVE_CLI explicitly; never discover a daily host CLI.');
assert.equal(JSON.parse(fs.readFileSync(path.join(path.dirname(fs.realpathSync(cli)),'package.json'),'utf8')).version,'2026.9.8','This rehearsal requires the pinned 9.8 CLI.');
const installer = fileURLToPath(new URL('../install-popclaw.sh', import.meta.url));
const hash = b => crypto.createHash('sha256').update(b).digest('hex');

for (const defined of [true, false]) test(`official CLI preserves ${defined ? 'defined' : 'undefined'} provider env reference`, async () => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'popclaw-env-native-')));
  try {
    const home = path.join(base, 'home'); fs.mkdirSync(home);
    const state = path.join(home, '.openclaw'); fs.mkdirSync(state);
    const config = path.join(state, 'openclaw.json');
    // Choose an unused local port so native application reporting cannot query
    // a normal Gateway. No listener or Gateway is started by this fixture.
    const probe = net.createServer();
    await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
    const port = probe.address().port;
    await new Promise(resolve => probe.close(resolve));
    const original = JSON.stringify({gateway:{mode:'local',port,auth:{mode:'token',token:'synthetic-local-token'}},models:{providers:{deepseek:{baseUrl:'https://example.invalid/v1',api:'openai-completions',apiKey:'${DEEPSEEK_API_KEY}',models:[]}}}},null,2)+'\n';
    fs.writeFileSync(config, original, {mode:0o600});
    const pkg = path.join(base, 'package'); fs.mkdirSync(pkg);
    fs.writeFileSync(path.join(pkg, 'package.json'),JSON.stringify({name:'popclaw-env-fixture',version:'0.0.0',type:'module',openclaw:{extensions:['./index.js']}}));
    fs.writeFileSync(path.join(pkg, 'openclaw.plugin.json'),JSON.stringify({id:'popclaw',name:'Synthetic env fixture',configSchema:{type:'object',properties:{},additionalProperties:false}}));
    fs.writeFileSync(path.join(pkg, 'index.js'),"export default {id:'popclaw',name:'Synthetic env fixture',register(){}};\n");
    const archive = path.join(base, 'synthetic-popclaw.tgz');
    const packed = spawnSync('/usr/bin/tar',['-czf',archive,'-C',base,'package'],{encoding:'utf8'});
    assert.equal(packed.status,0,packed.stderr);
    const receipt = path.join(base, 'receipt.json');
    const secret = 'synthetic-value-never-a-real-key';
    const env = {HOME:home,PATH:path.dirname(process.execPath)+':/usr/bin:/bin',TMPDIR:base,OPENCLAW_NO_RESPAWN:'1',OPENCLAW_DISABLE_COMPILE_CACHE:'1'};
    if (defined) env.DEEPSEEK_API_KEY=secret;
    const result = spawnSync('/bin/sh',[installer,'--node',process.execPath,'--openclaw-cli',cli,'--receipt',receipt,archive],{env,encoding:'utf8',timeout:180000});
    assert.equal(result.error,undefined);
    assert.equal(result.status,0,result.stdout+result.stderr);
    const raw = fs.readFileSync(config,'utf8');
    const reportRaw = fs.readFileSync(receipt,'utf8');
    const report = JSON.parse(reportRaw);
    assert.equal(JSON.parse(raw).models.providers.deepseek.apiKey,'${DEEPSEEK_API_KEY}');
    assert.equal(report.hashes.config,hash(Buffer.from(original)));
    assert.equal(report.commands.length,3);
    assert.deepEqual(report.commands.map(c=>c.exitCode),[0,0,0]);
    assert.equal(JSON.parse(raw).plugins.entries.popclaw.hooks.allowConversationAccess,true);
    assert.equal(report.runtimeVerified,false);
    assert.equal((raw+reportRaw+result.stdout+result.stderr).includes(secret),false);
    console.log(JSON.stringify({defined,nativeExitCodes:report.commands.map(c=>c.exitCode),installReported:report.installReported,originalHashMatched:true,referencePreserved:true}));
  } finally { fs.rmSync(base,{recursive:true,force:true}); }
});
