import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ensureBundle } from '../helpers/ensure-bundle.js';
import { initializeTestRoot } from '../helpers/initialize-test-root.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PROFILE = 'POPCLAW-BUNDLE-PROFILE.json';
const OPERATOR_TOKENS = ['POPCLAW_APIFY_TOKEN', 'POPCLAW_TWITTERAPI_IO_KEY', 'POPCLAW_YOUTUBE_API_KEY',
  'POPCLAW_OWNER_PERSONA_PATH', 'api.apify.com', 'api.twitterapi.io', 'www.googleapis.com/youtube/v3',
  'missing scraper creds', 'TwitterApiIoScraper', 'VerifyInviteHandler'];
const temporary: string[] = [];
function temp() { const root = mkdtempSync(join(tmpdir(), 'popclaw-client-profile-')); temporary.push(root); return root; }
function graph(profile: 'bundled' | 'client-bundled') { return join(ROOT, 'dist', profile); }
function source(profile: 'bundled' | 'client-bundled') {
  return readdirSync(graph(profile)).filter(file => file.endsWith('.js')).map(file => readFileSync(join(graph(profile), file), 'utf8')).join('\n');
}
function environment(root: string) {
  const env: NodeJS.ProcessEnv = { ...process.env, POPCLAW_DATA_ROOT: join(root, 'popclaw'), POPCLAW_RECEIVE_ON_START: '0' };
  for (const key of ['POPCLAW_APIFY_TOKEN', 'POPCLAW_TWITTERAPI_IO_KEY', 'POPCLAW_YOUTUBE_API_KEY',
    'POPCLAW_OWNER_PERSONA_PATH', 'POPCLAW_X_BACKEND', 'POPCLAW_X_SCRAPER_BACKEND', 'NODE_OPTIONS', 'NODE_PATH']) delete env[key];
  return env;
}
function state() {
  const root = temp();
  initializeTestRoot(join(root, 'popclaw'));
  mkdirSync(join(root, 'popclaw/config'), { recursive: true });
  writeFileSync(join(root, 'popclaw/config/plugin.json'), JSON.stringify({
    lore_houses: ['http://127.0.0.1:9'], canvas_base_url: 'http://127.0.0.1:9',
  }));
  return root;
}

// Exercise the shipped registration and assembly without a real host, provider,
// remote house, or daily identity. All network requests fail in this child.
const BOOT = String.raw`
  globalThis.fetch = async () => { throw new Error('offline package fixture'); };
  const { default: plugin } = await import(process.argv[1]);
  const services = [], logs = [], tools = [];
  const log = message => logs.push(String(message));
  plugin.register({ registrationMode: 'full', config: { talk: { speechLocale: 'en-US' } }, pluginConfig: {},
    logger: { debug: log, info: log, warn: log, error: log },
    runtime: { state: { resolveStateDir: () => process.argv[2] }, system: { enqueueSystemEvent() {}, runHeartbeatOnce() {} } },
    registerCommand() {}, registerTool(tool) { tools.push(tool.name); }, registerInteractiveHandler() {},
    registerService(service) { services.push(service); }, on() {} });
  const runtime = services.find(service => service.id === 'popclaw-runtime');
  await runtime.start();
  const bag = await globalThis.__popclaw_singleton__runtime;
  const result = { logs, tools, consumers: Boolean(bag.houseRuntime && bag.socialGraph && bag.notifier) };
  await runtime.stop();
  console.log(JSON.stringify(result));
`;

beforeAll(async () => { await ensureBundle(ROOT, join(graph('client-bundled'), 'index.js')); }, 300_000);
afterAll(() => { for (const root of temporary) rmSync(root, { recursive: true, force: true }); });

describe('client distribution capability boundary', () => {
  it('excludes operator implementations and credentials from the complete client graph, with a full-build positive control', () => {
    const full = source('bundled'), client = source('client-bundled');
    for (const token of OPERATOR_TOKENS) {
      expect(full.includes(token), `full build must retain ${token}`).toBe(true);
      expect(client.includes(token), `client must not carry ${token}`).toBe(false);
    }
    const fullProfile = JSON.parse(readFileSync(join(graph('bundled'), PROFILE), 'utf8'));
    const clientProfile = JSON.parse(readFileSync(join(graph('client-bundled'), PROFILE), 'utf8'));
    expect(fullProfile).toMatchObject({ profile: 'full', rangerExecution: true, ownerPersonaFile: true });
    expect(clientProfile).toMatchObject({ profile: 'client', rangerExecution: false, ownerPersonaFile: false });
    expect(fullProfile.sourceInputs).toContain('src/runtime/ranger.ts');
    expect(fullProfile.sourceInputs).toContain('src/onboarding/owner-persona-file.ts');
    expect(clientProfile.sourceInputs).toContain('src/runtime/ranger-client.ts');
    expect(clientProfile.sourceInputs).toContain('src/onboarding/owner-persona-client.ts');
    expect(clientProfile.sourceInputs.filter((path: string) => /src\/scraper\/(?!platform-scraper\.ts$)|src\/runtime\/ranger\.ts|owner-persona-file/.test(path))).toEqual([]);
  });

  it('boots the shipped OpenClaw client with the same tools and consumers, without provider-credential warnings', () => {
    const results = ['bundled', 'client-bundled'].map(profile => {
      const root = state();
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', BOOT,
        pathToFileURL(join(ROOT, 'dist', profile, 'index.js')).href, root], {
        cwd: root, encoding: 'utf8', timeout: 30_000, env: environment(root), maxBuffer: 2 * 1024 * 1024,
      });
      expect(result.status, result.stderr + result.stdout).toBe(0);
      return JSON.parse(result.stdout.trim().split('\n').at(-1)!);
    });
    const [full, client] = results;
    expect(full.consumers).toBe(true);
    expect(client.consumers).toBe(true);
    expect(client.tools.length).toBeGreaterThan(0);
    expect(client.tools).toEqual(full.tools);
    expect(full.logs.join('\n')).toContain('missing scraper creds');
    expect(client.logs.join('\n')).not.toMatch(/scraper registry|missing scraper creds|POPCLAW_(?:APIFY|TWITTERAPI_IO|YOUTUBE)/);
  }, 90_000);

  it('keeps the isolated CLI daemon resident and stops it cleanly without Ranger execution', async () => {
    const root = state();
    cpSync(graph('client-bundled'), join(root, 'dist/bundled'), { recursive: true });
    symlinkSync(join(ROOT, 'dist/native-deps'), join(root, 'dist/native-deps'));
    cpSync(join(ROOT, 'migrations'), join(root, 'migrations'), { recursive: true });
    writeFileSync(join(root, 'package.json'), '{"type":"module"}\n');
    const preload = join(root, 'offline.mjs');
    writeFileSync(preload, "globalThis.fetch = async () => { throw new Error('offline package fixture'); };\n");
    const child = spawn(process.execPath, ['--import', preload, join(root, 'dist/bundled/cli.js'), 'daemon'], {
      cwd: root, env: environment(root), stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '', ready = false;
    try {
      const result = await new Promise<number | null>((resolveExit, reject) => {
        const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('daemon did not stop: ' + output)); }, 20_000);
        const capture = (chunk: Buffer) => {
          output += chunk.toString();
          if (!ready && output.includes('house lifecycle runtime started')) { ready = true; child.kill('SIGTERM'); }
        };
        child.stdout.on('data', capture); child.stderr.on('data', capture);
        child.once('error', error => { clearTimeout(timeout); reject(error); });
        child.once('exit', code => { clearTimeout(timeout); resolveExit(code); });
      });
      expect(ready, output).toBe(true);
      expect(result, output).toBe(0);
      expect(output).toContain('popclaw-plugin shutting down');
      expect(output).not.toMatch(/missing scraper creds|Ranger task execution is unavailable/);
    } finally { if (child.exitCode === null) child.kill('SIGKILL'); }
  }, 30_000);
});
