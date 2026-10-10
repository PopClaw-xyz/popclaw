import { afterEach, describe, expect, it } from 'vitest';
import { initializeTestRoot } from '../helpers/initialize-test-root.js';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { LocalHostDb } from '../../src/host/local-host-db.js';
import { ensureHouseLifecycleSchema } from '../../src/runtime/house-lifecycle/participation-store.js';
import { resolveInstallationId } from '../../src/runtime/house-lifecycle/installation.js';
import { popclaw } from '@popclaw/contracts';
import nacl from 'tweetnacl';

const pkgRoot = resolve(__dirname, '../..');
const origin = 'http://127.0.0.1:19991';
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));

function sandbox(connected = false) {
  const root = mkdtempSync(join(tmpdir(), 'house-cli-business-')); roots.push(root);
  const home = join(root, 'home'), data = join(root, 'data');
  initializeTestRoot(data);
  const attempts = join(root, 'network-attempts'), lifecycle = join(root, 'process-lifecycle');
  mkdirSync(home); mkdirSync(join(data, 'config'), { recursive: true });
  writeFileSync(join(data, 'config/plugin.json'), JSON.stringify({ lore_houses: [origin], ranger_profile: { nickname: 'CLI Test Owner' } }));
  const dbPath = join(data, 'vault/social/my-social-assets.db');
  mkdirSync(join(data, 'vault/social'), { recursive: true });
  const db = new LocalHostDb(dbPath);
  try {
    ensureHouseLifecycleSchema(db);
    const installation = resolveInstallationId(db);
    if (connected) db.execute(`INSERT INTO house_participation
      (house_origin, installation_id, desired, phase, op_seq, session_id, lease_expires_at, ack_key_hex)
      VALUES (?, ?, 'enabled', 'connected', 1, 'fixture-session', ?, 'fixture-pin')`,
    [origin, installation, Math.floor(Date.now() / 1000) + 600]);
  } finally { db.close(); }
  const guard = join(root, 'offline.mjs');
  // Same process-entry isolation as house-entry-process.test.ts. tsx's Unix
  // loader socket is allowed; every TCP/DNS/HTTP/fetch attempt is a failure.
  writeFileSync(guard, `import net from 'node:net';
import http from 'node:http'; import https from 'node:https'; import dns from 'node:dns';
import {appendFileSync} from 'node:fs'; import {createRequire,syncBuiltinESMExports} from 'node:module';
const deny = () => { const error = new Error('offline CLI test forbids networking'); appendFileSync(${JSON.stringify(attempts)}, error.stack + '\\n'); throw error; };
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const target = Array.isArray(args[0]) ? args[0][0] : args[0];
  if (typeof target?.path === 'string' || (typeof target === 'string' && target.startsWith('/'))) return connect.apply(this,args);
  return deny();
};
http.request=deny; http.get=deny; https.request=deny; https.get=deny; dns.lookup=deny; dns.resolve=deny;
globalThis.fetch=deny; syncBuiltinESMExports();
const Database=createRequire(${JSON.stringify(join(pkgRoot, 'src/main.ts'))})('better-sqlite3');
const close=Database.prototype.close;
Database.prototype.close=function(...args){const result=close.apply(this,args);appendFileSync(${JSON.stringify(lifecycle)},'db-closed\\n');return result;};
process.on('beforeExit',()=>appendFileSync(${JSON.stringify(lifecycle)},'before-exit\\n'));
`);
  const env = { HOME: home, PATH: process.env.PATH ?? '', TMPDIR: root, LANG: 'en_US.UTF-8', POPCLAW_LANG: 'en',
    POPCLAW_DATA_ROOT: data, POPCLAW_WEB_BASE_URL: origin, POPCLAW_CANVAS_BASE_URL: origin };
  return { root, data, dbPath, attempts, lifecycle, guard, env };
}

async function runCli(box: ReturnType<typeof sandbox>, args: string[], interruptWhenQueued = false) {
  const proc = spawn(process.execPath, ['--import', box.guard, '--import', 'tsx', join(pkgRoot, 'src/main.ts'), ...args],
    { cwd: pkgRoot, env: box.env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  proc.stdout.setEncoding('utf8'); proc.stderr.setEncoding('utf8');
  proc.stdout.on('data', chunk => { stdout += chunk; }); proc.stderr.on('data', chunk => { stderr += chunk; });
  const done = new Promise<number | null>((resolveExit, reject) => { proc.on('error', reject); proc.on('close', resolveExit); });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (interruptWhenQueued) {
      const deadline = Date.now() + 10000;
      let queued = false;
      while (Date.now() < deadline && proc.exitCode === null) {
        const db = new LocalHostDb(box.dbPath);
        try {
          const table = db.queryOne("SELECT name FROM sqlite_master WHERE type='table' AND name='house_lifecycle_commands'");
          queued = !!table && db.queryAll("SELECT request_id FROM house_lifecycle_commands WHERE kind='push' AND state='pending'").length === 1;
        } finally { db.close(); }
        if (queued) break;
        await new Promise(resolveWait => setTimeout(resolveWait, 20));
      }
      expect(queued, stdout + stderr).toBe(true);
      proc.kill('SIGTERM');
    }
    const code = await Promise.race([done, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`CLI did not drain and exit: ${stdout}\n${stderr}`)), interruptWhenQueued ? 10000 : 40000);
    })]);
    return { code, stdout, stderr };
  } finally {
    clearTimeout(timer);
    if (proc.exitCode === null && proc.signalCode === null) {
      proc.kill('SIGTERM');
      const killTimer = setTimeout(() => proc.kill('SIGKILL'), 2000);
      try { await done; } finally { clearTimeout(killTimer); }
    } else await done;
  }
}

function assertOfflineAndDrained(box: ReturnType<typeof sandbox>, minClosedDbs = 1) {
  expect(existsSync(box.attempts) ? readFileSync(box.attempts, 'utf8') : '').toBe('');
  const lifecycle = readFileSync(box.lifecycle, 'utf8').trim().split('\n');
  expect(lifecycle.filter(line => line === 'db-closed').length).toBeGreaterThanOrEqual(minClosedDbs);
  expect(lifecycle.at(-1)).toBe('before-exit');
  const db = new LocalHostDb(box.dbPath);
  try {
    expect(db.queryAll('SELECT * FROM house_lifecycle_owner')).toEqual([]);
    expect(db.queryOne<{ integrity_check: string }>('PRAGMA integrity_check')?.integrity_check).toBe('ok');
  } finally { db.close(); }
}

describe('ordinary CLI business commands share the lifecycle reader', () => {
  it.each([
    ['follow', 'test-followee'],
    ['invite', 'x', 'cli_test_handle', '--poll-timeout-sec=0'],
  ])('CLI %s refuses an unjoined house without direct networking', async (...args) => {
    const box = sandbox();
    const result = await runCli(box, args);
    expect(result.code, result.stdout + result.stderr).toBe(1);
    // Names the CURRENT success wording. A negative assertion against a
    // phrase the code stopped producing passes for free.
    expect(result.stdout).not.toMatch(/✓ Following|invite submitted/i);
    assertOfflineAndDrained(box, 1);
  }, 45000);

  it('CLI status keeps local state readable with no owner', async () => {
    const box = sandbox();
    const result = await runCli(box, ['status']);
    expect(result.code, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toBeTruthy();
    expect(result.stdout).toMatch(/unreachable|offline|unavailable|couldn.t/i);
    assertOfflineAndDrained(box, 1);
  }, 45000);


  // The vehicle is `invite`, not `follow`. This case is about the lifecycle
  // queue — exact signed bytes reach it and the command does not claim
  // success — and follow can no longer carry it: a relation write is refused
  // before anything is signed while the ordered producer is not installed, so
  // there would be no bytes to queue and the coverage would quietly vanish.
  it.each(['X', 'Twitter'])('queues exact signed invite bytes for %s/@handle without claiming success', async platform => {
    const box = sandbox(true);
    const result = await runCli(box, ['invite', platform, '@cli_test_handle', '--poll-timeout-sec=0']);
    expect(result.code, result.stdout + result.stderr).toBe(1);
    expect(result.stdout).not.toMatch(/invite submitted/i);
    const db = new LocalHostDb(box.dbPath);
    try {
      const rows = db.queryAll<{ request_id: string; state: string; payload_bytes: Uint8Array }>("SELECT request_id, state, payload_bytes FROM house_lifecycle_commands WHERE kind='push'");
      expect(rows).toHaveLength(1);
      expect(rows[0]!.state).toBe('pending');
      expect(rows[0]!.payload_bytes.length).toBeGreaterThan(0);
      const signed = popclaw.identity.SignedPayload.decode(rows[0]!.payload_bytes);
      expect(nacl.sign.detached.verify(signed.payload, signed.signature, signed.signerPubkey)).toBe(true);
      expect(popclaw.event.EventEnvelope.decode(signed.payload).inviteRequest).toMatchObject({ platform: 'x', handle: 'cli_test_handle' });
      expect(result.stdout + result.stderr).toContain(rows[0]!.request_id);
      expect(result.stdout + result.stderr).toContain('execution not confirmed');
    } finally { db.close(); }
    assertOfflineAndDrained(box);
  }, 45000);

  it('SIGTERM drains a queued command and leaves its operation available for the resident', async () => {
    const box = sandbox(true);
    const result = await runCli(box, ['invite', 'x', 'cli_test_handle', '--poll-timeout-sec=0'], true);
    expect(result.code).not.toBeNull();
    expect(result.code).not.toBe(0);
    expect(result.stdout).not.toMatch(/invite submitted/i);
    assertOfflineAndDrained(box);
  }, 25000);
});
