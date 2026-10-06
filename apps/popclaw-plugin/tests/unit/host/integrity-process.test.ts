import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalHostDb } from '../../../src/host/local-host-db.js';
import { runIntegrityChecksInProcess } from '../../../src/host/integrity-process.js';
import { markIntegrityAnnounced } from '../../../src/host/integrity-check.js';
const resources: Array<() => void> = [];
afterEach(() => { for (const close of resources.splice(0).reverse()) close(); });
function fixture() {
 const root = mkdtempSync(join(tmpdir(), 'integrity-process-')); resources.push(() => rmSync(root, {recursive: true, force: true}));
 const path = join(root, 'social.db'), db = new LocalHostDb(path); resources.push(() => db.close());
 return {db, path, deps: {dbs: [{label: 'social', path}], stateFile: join(root, 'state.json'), build: 'test'}};
}
it('runs large live database scans outside the resident process while its event loop responds', async () => {
 const f = fixture(); f.db.execute('CREATE TABLE big(id INTEGER PRIMARY KEY, value BLOB)');
 f.db.execute('WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<25000) INSERT INTO big SELECT x, zeroblob(4096) FROM n');
 let ticks = 0, childPid = 0, scanMs = 0; const timer = setInterval(() => { ticks++; }, 5);
 try {
  const findings = await runIntegrityChecksInProcess({...f.deps, onMeasured: reply => { childPid = reply.pid; scanMs = reply.results[0]!.elapsedMs; }});
  expect(findings).toEqual([]); expect(childPid).not.toBe(process.pid); expect(ticks).toBeGreaterThan(0);
  // Resident writes and a fresh read connection still see the same WAL after the child exits.
  f.db.execute('INSERT INTO big VALUES(25001, zeroblob(4096))'); const reader = new LocalHostDb(f.path);
  try { expect(reader.queryOne<{n: number}>('SELECT count(*) n FROM big')?.n).toBe(25001); } finally { reader.close(); }
  console.log('INTEGRITY_REAL_PROCESS', JSON.stringify({residentPid: process.pid, childPid, ticks, scanMs, sizeMiB: 100}));
 } finally { clearInterval(timer); }
});
it('preserves FK findings, schema drift, build upgrades and delivered-only dedupe', async () => {
 const f = fixture(); f.db.execute('CREATE TABLE p(id INTEGER PRIMARY KEY)'); f.db.execute('CREATE TABLE c(parent INTEGER REFERENCES p(id))');
 expect(await runIntegrityChecksInProcess(f.deps)).toEqual([]);
 f.db.execute('PRAGMA foreign_keys=OFF'); f.db.execute('INSERT INTO c VALUES(99)'); f.db.execute('PRAGMA foreign_keys=ON');
 const findings = await runIntegrityChecksInProcess(f.deps); expect(findings.map(row => row.kind)).toEqual(['foreign_key_check']);
 expect(await runIntegrityChecksInProcess(f.deps)).toEqual(findings); markIntegrityAnnounced(f.deps.stateFile, findings);
 expect(await runIntegrityChecksInProcess(f.deps)).toEqual([]);
 f.db.execute('CREATE INDEX added ON c(parent)'); expect((await runIntegrityChecksInProcess(f.deps)).map(row => row.kind)).toEqual(['schema_drift']);
 expect(await runIntegrityChecksInProcess({...f.deps, build: 'upgrade'})).toEqual([]);
});
it('aborts and drains the child before writing any state', async () => {
 const f = fixture(); const controller = new AbortController();
 const task = runIntegrityChecksInProcess({...f.deps, signal: controller.signal}); controller.abort();
 expect(await task).toEqual([]); expect(existsSync(f.deps.stateFile)).toBe(false);
});

it('reports an unreadable corrupted SQLite image as a nonfatal probe error', async () => {
 const f = fixture(); f.db.close(); writeFileSync(f.path, 'corrupt SQLite image');
 const errors: string[] = [];
 const result = await runIntegrityChecksInProcess({...f.deps, onError: (label, error) => errors.push(`${label}: ${String(error)}`)});
 expect(result).toEqual([]); expect(errors).toHaveLength(1); expect(errors[0]).toContain('not a database');
});
