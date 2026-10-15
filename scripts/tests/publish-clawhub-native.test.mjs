import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {NAMES,publishNative,getRegistryPackage,withRegistryCommands} from '../publish-clawhub-native.mjs';
const packages=()=>NAMES.map(name=>({name,version:'0.1.3',filename:name+'-0.1.3.tgz',sha256:'a'.repeat(64)}));
function harness(states={}){
 const events=[];
 return {events,packages:packages(),dryRun:false,getPackage:async name=>{
  events.push(['read',name]);const state=states[name]??{name,versions:{'0.0.0':{}}};if(state instanceof Error)throw state;return state;
 },verify:async pkg=>{events.push(['verify',pkg.name]);},publish:async pkg=>{events.push(['publish',pkg.name]);},dryPublish:async pkg=>{events.push(['dry',pkg.name]);}};
}
test('dry run never publishes and clearly reports bootstrap required',async()=>{
 const h=harness({[NAMES[4]]:{missing:true}});h.dryRun=true;const r=await publishNative(h);
 assert.equal(h.events.filter(e=>e[0]==='publish').length,0);assert.deepEqual(r.bootstrapRequired,[NAMES[4]]);assert.equal(h.events.filter(e=>e[0]==='dry').length,5);
});
test('all package names are preflighted before first real publish; bootstrap blocks all',async()=>{
 const h=harness({[NAMES[4]]:{missing:true}});await assert.rejects(publishNative(h),/BOOTSTRAP_REQUIRED/);assert.equal(h.events.filter(e=>e[0]==='publish').length,0);assert.equal(h.events.filter(e=>e[0]==='read').length,5);
});
test('existing versions verify first, only missing versions publish then verify',async()=>{
 const h=harness({[NAMES[0]]:{name:NAMES[0],versions:{'0.1.3':{}}}});await publishNative(h);
 assert.equal(h.events.filter(e=>e[0]==='publish').length,4);assert.ok(!h.events.some(e=>e[0]==='publish'&&e[1]===NAMES[0]));assert.deepEqual(h.events.slice(0,5).map(e=>e[0]),Array(5).fill('read'));
 for(const name of NAMES.slice(1)){const i=h.events.findIndex(e=>e[0]==='publish'&&e[1]===name);assert.deepEqual(h.events[i+1],['verify',name]);}
});
test('unknown registry state or existing byte mismatch blocks every publish',async()=>{
 for(const state of [new Error('HTTP 401'),new Error('HTTP 503'),{name:'wrong',versions:{}},{name:NAMES[4],versions:[]}]){
  const h=harness({[NAMES[4]]:state});await assert.rejects(publishNative(h));assert.equal(h.events.filter(e=>e[0]==='publish').length,0);
 }
 const h=harness({[NAMES[4]]:{name:NAMES[4],versions:{'0.1.3':{}}}});h.verify=async()=>{throw new Error('bytes mismatch')};await assert.rejects(publishNative(h),/bytes mismatch/);assert.equal(h.events.filter(e=>e[0]==='publish').length,0);
});
test('receipt cannot select a main package, duplicate, missing or extra native',async()=>{
 for(const mutate of [p=>p[0].name='popclaw-clawhub',p=>p.push({...p[0]}),p=>p.pop(),p=>p[4].name=p[0].name]){
  const h=harness();mutate(h.packages);await assert.rejects(publishNative(h));assert.equal(h.events.length,0);
 }
});
test('post-publish verification failure prevents subsequent packages',async()=>{
 const h=harness();h.verify=async()=>{throw new Error('registry bytes mismatch')};await assert.rejects(publishNative(h));assert.equal(h.events.filter(e=>e[0]==='publish').length,1);
});
test('only an explicit registry package 404 means bootstrap; all other failures stay unknown',async()=>{
 const missing=await getRegistryPackage(NAMES[0],async()=>new Response(JSON.stringify({error:'Not found'}),{status:404}));
 assert.deepEqual(missing,{missing:true});
 const present={name:NAMES[0],versions:{'0.1.3':{}}};
 assert.deepEqual(await getRegistryPackage(NAMES[0],async()=>new Response(JSON.stringify(present))),present);
 for(const response of [new Response('{}',{status:404}),new Response('<html>error</html>',{status:404}),new Response('{}',{status:401}),new Response('{}',{status:503}),new Response('broken json',{status:200}),new Response('{"missing":true}',{status:200})]){
  await assert.rejects(getRegistryPackage(NAMES[0],async()=>response));
 }
 await assert.rejects(getRegistryPackage(NAMES[0],async()=>{throw new Error('network timeout')}),/timeout/);
});
test('no missing version is published before every pre-existing version is verified',async()=>{
 const h=harness({[NAMES[4]]:{name:NAMES[4],versions:{'0.1.3':{}}}});await publishNative(h);
 const firstPublish=h.events.findIndex(e=>e[0]==='publish');const oldVerify=h.events.findIndex(e=>e[0]==='verify'&&e[1]===NAMES[4]);
 assert.ok(oldVerify>0&&oldVerify<firstPublish);
});

const missingNames = () => Object.fromEntries(NAMES.map(name => [name, {missing: true}]));
function bootstrap(states = missingNames()) {
 const h = harness(states);
 return {...h, authMode: 'bootstrap-token', environment: {NPM_BOOTSTRAP_TOKEN: 'test-only-credential'}};
}
test('explicit bootstrap creates all five real targets only after the entire preflight', async () => {
 const h = bootstrap();
 const result = await publishNative(h);
 assert.deepEqual(result.published, NAMES);
 assert.equal(result.authMode, 'bootstrap-token');
 assert.deepEqual(h.events.slice(0, 5), NAMES.map(name => ['read', name]));
 for (const name of NAMES) {
  const i = h.events.findIndex(event => event[0] === 'publish' && event[1] === name);
  assert.deepEqual(h.events[i + 1], ['verify', name]);
 }
});
test('bootstrap refuses any other version before publishing any package', async () => {
 for (const versions of [{'0.0.0': {}}, {'0.0.0': {}, '0.1.3': {}}, {}]) {
  const h = bootstrap({...missingNames(), [NAMES[4]]: {name: NAMES[4], versions}});
  await assert.rejects(publishNative(h), /BOOTSTRAP_NAME_CONFLICT/);
  assert.equal(h.events.filter(event => event[0] === 'read').length, 5);
  assert.equal(h.events.filter(event => event[0] === 'publish').length, 0);
 }
});
test('bootstrap resumes a partial first release only after verifying all existing target bytes and provenance', async () => {
 const h = bootstrap({...missingNames(), [NAMES[4]]: {name: NAMES[4], versions: {'0.1.3': {}}}});
 const result = await publishNative(h);
 assert.deepEqual(result.alreadyVerified, [NAMES[4]]);
 assert.deepEqual(result.published, NAMES.slice(0, 4));
 assert.deepEqual(h.events[5], ['verify', NAMES[4]]);
 const bad = bootstrap({...missingNames(), [NAMES[4]]: {name: NAMES[4], versions: {'0.1.3': {}}}});
 bad.verify = async () => {throw new Error('provenance mismatch')};
 await assert.rejects(publishNative(bad), /provenance mismatch/);
 assert.equal(bad.events.filter(event => event[0] === 'publish').length, 0);
});
test('real bootstrap requires its dedicated nonempty credential before registry work', async () => {
 for (const value of [undefined, '', '   ']) {
  const h = bootstrap();
  h.environment = {NPM_BOOTSTRAP_TOKEN: value};
  await assert.rejects(publishNative(h), /NPM_BOOTSTRAP_TOKEN is required/);
  assert.equal(h.events.length, 0);
 }
});
test('OIDC rejects nonempty npm credentials instead of silently falling back', async () => {
 for (const key of ['NPM_BOOTSTRAP_TOKEN', 'NODE_AUTH_TOKEN', 'NPM_TOKEN', 'NPM_AUTH_TOKEN', 'NPM_ID_TOKEN', 'npm_config__auth', 'NPM_CONFIG_//registry.npmjs.org/:_authToken']) {
  const h = harness();
  h.environment = {[key]: 'must-not-be-used'};
  await assert.rejects(publishNative(h), /OIDC forbids npm credentials/);
  assert.equal(h.events.length, 0);
 }
});
test('bootstrap rejects other credential sources and dry runs never accept a token', async () => {
 const h = bootstrap();
 h.environment.NODE_AUTH_TOKEN = 'ambiguous-token';
 await assert.rejects(publishNative(h), /bootstrap-token accepts only NPM_BOOTSTRAP_TOKEN/);
 assert.equal(h.events.length, 0);
 const dry = bootstrap();
 dry.dryRun = true;
 await assert.rejects(publishNative(dry), /dry runs must not receive npm credentials/);
 assert.equal(dry.events.length, 0);
});
test('bootstrap dry run needs no credential and never publishes', async () => {
 const h = bootstrap();
 h.dryRun = true;
 h.environment = {};
 const result = await publishNative(h);
 assert.equal(result.authMode, 'bootstrap-token');
 assert.equal(h.events.filter(event => event[0] === 'publish').length, 0);
 assert.equal(h.events.filter(event => event[0] === 'dry').length, 5);
});
test('unknown authentication modes fail before any registry or publication work', async () => {
 const h = harness();
 h.authMode = 'token';
 await assert.rejects(publishNative(h), /invalid authentication mode/);
 assert.equal(h.events.length, 0);
});
test('bootstrap registry failures and post-publish mismatches stop the remaining packages', async () => {
 const unknown = bootstrap({...missingNames(), [NAMES[4]]: new Error('HTTP 503')});
 await assert.rejects(publishNative(unknown), /503/);
 assert.equal(unknown.events.filter(event => event[0] === 'publish').length, 0);
 const mismatch = bootstrap();
 mismatch.verify = async () => {throw new Error('registry bytes mismatch')};
 await assert.rejects(publishNative(mismatch), /bytes mismatch/);
 assert.equal(mismatch.events.filter(event => event[0] === 'publish').length, 1);
});
test('OIDC after bootstrap only verifies existing target versions without a publish attempt', async () => {
 const h = harness(Object.fromEntries(NAMES.map(name => [name, {name, versions: {'0.1.3': {}}}])));
 const result = await publishNative(h);
 assert.equal(result.authMode, 'oidc');
 assert.deepEqual(result.published, []);
 assert.deepEqual(result.alreadyVerified, NAMES);
 assert.equal(h.events.filter(event => event[0] === 'publish').length, 0);
});
test('partial bootstrap dry run verifies existing versions and only dry-publishes missing ones', async () => {
 const h = bootstrap({...missingNames(), [NAMES[0]]: {name: NAMES[0], versions: {'0.1.3': {}}}});
 h.dryRun = true;
 h.environment = {};
 const result = await publishNative(h);
 assert.deepEqual(result.alreadyVerified, [NAMES[0]]);
 assert.deepEqual(h.events.filter(event => event[0] === 'dry').map(event => event[1]), NAMES.slice(1));
});

function commandFixture() {
 const directory = mkdtempSync(join(tmpdir(), 'popclaw-native-commands-test-'));
 const bin = join(directory, 'bin');
 mkdirSync(bin);
 const audit = join(directory, 'audit.jsonl');
 const bytes = Buffer.from('retained test archive bytes');
 const pkg = {...packages()[0], bytes: bytes.length,
  sha256: createHash('sha256').update(bytes).digest('hex'),
  integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`};
 writeFileSync(join(directory, pkg.filename), bytes);
 writeFileSync(join(directory, '.npmrc'), '//registry.npmjs.org/:_authToken=unused-test-credential\n');
 // A local recording executable substitutes only the registry-facing npm process.
 // The real verifier shell still checks integrity against the retained file.
 writeFileSync(join(bin, 'npm'), `#!${process.execPath}
const fs = require('node:fs');
const row = {args: process.argv.slice(2), cwd: process.cwd(),
 userconfig: fs.readFileSync(process.env.NPM_CONFIG_USERCONFIG, 'utf8'),
 globalconfig: fs.readFileSync(process.env.NPM_CONFIG_GLOBALCONFIG, 'utf8'),
 credentials: Object.keys(process.env).filter(key => /^(NODE_AUTH_TOKEN|NPM_TOKEN|NPM_AUTH_TOKEN|NPM_ID_TOKEN|NPM_BOOTSTRAP_TOKEN)$/i.test(key)),
 bootstrapMatches: process.env.NODE_AUTH_TOKEN === 'test-only-credential'};
fs.appendFileSync(process.env.POPCLAW_TEST_AUDIT, JSON.stringify(row) + '\\n');
if (process.argv[2] === 'view') console.log(JSON.stringify({integrity: process.env.POPCLAW_TEST_INTEGRITY, attestations: {url: 'https://registry.npmjs.org/test'}}));
`, {mode: 0o755});
 const environment = {PATH: `${bin}:${process.env.PATH}`, HOME: directory,
  POPCLAW_TEST_AUDIT: audit, POPCLAW_TEST_INTEGRITY: pkg.integrity,
  npm_config_userconfig: join(directory, '.npmrc'), npm_config_registry: 'https://invalid.example'};
 return {directory, pkg, audit, environment};
}
test('actual publish subprocess alone receives bootstrap credential; verify and dry run use empty isolated configs', async () => {
 const fixture = commandFixture();
 try {
  await withRegistryCommands({...fixture, authMode: 'bootstrap-token',
   environment: {...fixture.environment, NPM_BOOTSTRAP_TOKEN: 'test-only-credential'}}, async commands => {
    commands.publish(fixture.pkg);
    commands.verify(fixture.pkg);
    commands.dryPublish(fixture.pkg);
   });
  const rows = readFileSync(fixture.audit, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0].credentials, ['NODE_AUTH_TOKEN']);
  assert.equal(rows[0].bootstrapMatches, true);
  assert.equal(rows[0].userconfig, '//registry.npmjs.org/:_authToken=${NODE_AUTH_TOKEN}\n');
  assert.ok(rows[0].args.includes('--provenance'));
  assert.ok(rows[0].args.includes(join(fixture.directory, fixture.pkg.filename)));
  assert.equal(rows[1].args[0], 'view');
  assert.ok(rows[2].args.includes('--dry-run'));
  for (const row of rows.slice(1)) {
   assert.deepEqual(row.credentials, []);
   assert.equal(row.userconfig, '');
  }
  for (const row of rows) {
   assert.equal(row.globalconfig, '');
   assert.notEqual(row.cwd, fixture.directory);
   assert.equal(existsSync(row.cwd), false, 'temporary npm configuration is removed');
  }
 } finally {rmSync(fixture.directory, {recursive: true, force: true});}
});
test('OIDC publish subprocess cannot inherit auth from user, project, or environment npm config', async () => {
 const fixture = commandFixture();
 try {
  await withRegistryCommands({...fixture, authMode: 'oidc'}, commands => commands.publish(fixture.pkg));
  const row = JSON.parse(readFileSync(fixture.audit, 'utf8'));
  assert.deepEqual(row.credentials, []);
  assert.equal(row.userconfig, '');
  assert.equal(row.globalconfig, '');
  assert.ok(row.args.includes('--provenance'));
  const registryIndex = row.args.indexOf('--registry');
  assert.notEqual(registryIndex, -1);
  assert.equal(row.args[registryIndex + 1], 'https://registry.npmjs.org');
 } finally {rmSync(fixture.directory, {recursive: true, force: true});}
});
test('changed retained bytes never reach the publish subprocess and temporary configs are removed after failure', async () => {
 const fixture = commandFixture();
 try {
  let session;
  await assert.rejects(withRegistryCommands({...fixture, authMode: 'oidc', execute: () => {
   throw new Error('must not execute');
  }}, commands => {
   writeFileSync(join(fixture.directory, fixture.pkg.filename), 'changed bytes');
   commands.publish(fixture.pkg);
  }), /retained bytes changed/);
  assert.equal(existsSync(fixture.audit), false);
  await assert.rejects(withRegistryCommands({...fixture, authMode: 'oidc', execute: (_cmd, _args, options) => {
   session = options.cwd;
   throw new Error('publish failed');
  }}, commands => {
   writeFileSync(join(fixture.directory, fixture.pkg.filename), 'retained test archive bytes');
   commands.publish(fixture.pkg);
  }), /publish failed/);
  assert.equal(existsSync(session), false);
 } finally {rmSync(fixture.directory, {recursive: true, force: true});}
});

function nativeWorkflowPolling() {
 // Read the simple numeric scalars from the actual job/step. The tests below
 // execute them through the publisher and real bash verifier, not a copy of
 // the polling loop. actionlint separately validates the complete YAML.
 const yaml = readFileSync(new URL('../../.github/workflows/release-clawhub-native.yml', import.meta.url), 'utf8');
 const job = yaml.split('\n  publish-native:\n')[1];
 assert.ok(job, 'native publication job is present');
 const step = job.split('      - name: Preflight all five names, publish missing native versions, verify each\n')[1];
 assert.ok(step, 'final native publication step is present');
 const environment = Object.fromEntries([...step.matchAll(/^          (REGISTRY_POLL_(?:ATTEMPTS|SLEEP)): ["']?(\d+)["']?\s*$/gm)]
  .map(([, key, value]) => [key, value]));
 return {environment, timeoutMinutes: Number(job.match(/^    timeout-minutes: (\d+)$/m)?.[1])};
}

async function delayedRegistry({environment = {}, readyAt = 7, mismatch = false} = {}) {
 const fixture = commandFixture();
 const counter = join(fixture.directory, 'view-count');
 const sleeps = join(fixture.directory, 'sleep-calls.jsonl');
 const bin = join(fixture.directory, 'bin');
 writeFileSync(join(bin, 'npm'), `#!${process.execPath}
const fs = require('node:fs');
if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(['view', process.env.POPCLAW_TEST_PACKAGE, 'dist', '--json', '--registry=https://registry.npmjs.org', '--prefer-online', '--fetch-retries=0', '--fetch-timeout=15000'])) process.exit(2);
const file = process.env.POPCLAW_TEST_COUNTER;
const count = (fs.existsSync(file) ? Number(fs.readFileSync(file, 'utf8')) : 0) + 1;
fs.writeFileSync(file, String(count));
if (count < Number(process.env.POPCLAW_TEST_READY_AT)) process.exit(1);
console.log(JSON.stringify({integrity: process.env.POPCLAW_TEST_INTEGRITY, attestations: {url: 'https://registry.npmjs.org/test'}}));
`, {mode: 0o755});
 writeFileSync(join(bin, 'sleep'), `#!${process.execPath}
require('node:fs').appendFileSync(process.env.POPCLAW_TEST_SLEEPS, JSON.stringify(process.argv.slice(2)) + '\\n');
`, {mode: 0o755});
 let result;
 try {
  await withRegistryCommands({...fixture, authMode: 'oidc', environment: {...fixture.environment, ...environment,
   POPCLAW_TEST_COUNTER: counter, POPCLAW_TEST_SLEEPS: sleeps, POPCLAW_TEST_READY_AT: String(readyAt),
   POPCLAW_TEST_PACKAGE: `${fixture.pkg.name}@${fixture.pkg.version}`,
   POPCLAW_TEST_INTEGRITY: mismatch ? 'sha512-not-the-retained-bytes' : fixture.pkg.integrity},
  execute: (command, args, options) => {
   assert.equal(command, 'bash');
   try {
    result = {status: 0, stdout: execFileSync(command, args, {...options, stdio: 'pipe', encoding: 'utf8', timeout: 20000})};
   } catch (error) {
    if (error.status === null) throw error;
    result = {status: error.status, stdout: error.stdout, stderr: error.stderr};
   }
  }}, commands => commands.verify(fixture.pkg));
  return {...result, attempts: Number(readFileSync(counter, 'utf8')),
   sleeps: existsSync(sleeps) ? readFileSync(sleeps, 'utf8').trim().split('\n').map(JSON.parse) : []};
 } finally {rmSync(fixture.directory, {recursive: true, force: true});}
}

test('the shared verifier default reaches a seventh readable response', async () => {
 const result = await delayedRegistry();
 assert.equal(result.status, 0, result.stderr);
 assert.equal(result.attempts, 7);
 assert.equal(result.sleeps.length, 6);
 assert.match(result.stdout, /attestation present, registry bytes match/);
});

test('native workflow polling reaches a seventh response and verifies the real retained digest', async () => {
 const result = await delayedRegistry(nativeWorkflowPolling());
 assert.equal(result.status, 0, result.stdout + (result.stderr || ''));
 assert.equal(result.attempts, 7);
 assert.deepEqual(result.sleeps, Array.from({length: 6}, () => ['10']));
 assert.match(result.stdout, /attestation present, registry bytes match the tested tarball/);
});

test('native workflow polling still rejects a real integrity mismatch after registry delay', async () => {
 const result = await delayedRegistry({...nativeWorkflowPolling(), mismatch: true});
 assert.equal(result.status, 1);
 assert.equal(result.attempts, 7);
 assert.match(result.stderr, /registry is serving bytes that were never tested here/);
});

test('native workflow polling remains bounded when the registry never becomes readable', async () => {
 const {environment} = nativeWorkflowPolling();
 const result = await delayedRegistry({environment, readyAt: Infinity});
 assert.equal(result.status, 1);
 assert.equal(result.attempts, Number(environment.REGISTRY_POLL_ATTEMPTS));
 assert.equal(result.sleeps.length, result.attempts - 1);
 assert.match(result.stdout + result.stderr, /is not readable from the registry/);
});

test('native publication job allows all five scan windows and preparation overhead', () => {
 const {environment, timeoutMinutes} = nativeWorkflowPolling();
 const oneWindowSeconds = (Number(environment.REGISTRY_POLL_ATTEMPTS) - 1) * Number(environment.REGISTRY_POLL_SLEEP);
 assert.equal(oneWindowSeconds, 15 * 60);
 assert.ok(timeoutMinutes * 60 >= NAMES.length * oneWindowSeconds + 10 * 60);
});
