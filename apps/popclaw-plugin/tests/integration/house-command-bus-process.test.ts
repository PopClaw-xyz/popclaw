import { expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { LocalHostDb } from '../../src/host/local-host-db.js';

function within<T>(promise: Promise<T>, ms = 8000): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([promise, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error('fixture deadline')), ms); })]).finally(() => clearTimeout(timer));
}
function child(dbPath: string, role: string) {
  const process = spawn(globalThis.process.execPath, ['--import', 'tsx', resolve('tests/helpers/house-command-process.ts'), dbPath, role], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = '';
  const message = new Promise<Record<string, any>>((resolve, reject) => {
    process.once('error', reject);
    process.stdout.on('data', bytes => { stdout += String(bytes); if (stdout.includes('\n')) { try { resolve(JSON.parse(stdout.split('\n')[0]!)); } catch (e) { reject(e); } } });
    process.stderr.on('data', bytes => { stderr = (stderr + String(bytes)).slice(-4000); });
    process.once('exit', code => { if (!stdout.includes('\n')) reject(new Error(`child exited ${code}: ${stderr}`)); });
  });
  const exited = new Promise<number | null>(resolve => process.once('exit', code => resolve(code)));
  return { process, message, exited };
}
async function stop(process: ChildProcess, exited: Promise<number | null>) {
  if (process.exitCode !== null || process.signalCode !== null) return;
  process.kill('SIGTERM');
  try { await within(exited, 2000); } catch { process.kill('SIGKILL'); await within(exited, 2000); }
}

it('a real reader process sends a command to the only owner process over shared SQLite', async () => {
  const root = mkdtempSync(join(tmpdir(), 'popclaw-command-process-'));
  const dbPath = join(root, 'ipc.db');
  const owner = child(dbPath, 'owner'); let reader: ReturnType<typeof child> | undefined;
  try {
    const ready = await within(owner.message); expect(ready.ready).toBe(true);
    await new Promise(resolve => setTimeout(resolve, 2200)); // owner reaches its maximum idle delay
    const started = performance.now();
    reader = child(dbPath, 'reader');
    const reply = await within(reader.message); expect(await within(reader.exited)).toBe(0);
    expect(reply.readerPid).not.toBe(ready.pid);
    const idleWakeMs = performance.now() - started; expect(idleWakeMs).toBeLessThan(2000);
    expect(reply.result).toMatchObject({ status: 'connected', sessionId: `executor-${ready.pid}` });
    const db = new LocalHostDb(dbPath);
    try {
      expect(db.queryAll('SELECT pid, role FROM fixture_executions')).toEqual([{ pid: ready.pid, role: 'owner' }]);
      console.log('HOUSE_COMMAND_REAL_PROCESSES', JSON.stringify({ idleWakeMs, ownerPid: ready.pid, readerPid: reply.readerPid, executor: reply.result.sessionId, commands: db.queryOne('SELECT count(*) AS count FROM house_lifecycle_commands') }));
    } finally { db.close(); }
  } finally {
    if (reader) await stop(reader.process, reader.exited);
    await stop(owner.process, owner.exited);
    rmSync(root, { recursive: true, force: true });
  }
});
