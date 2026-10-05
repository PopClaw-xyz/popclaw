import { expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { LocalHostDb } from '../../../src/host/local-host-db.js';
import { runMigrations } from '../../../src/host/migrations.js';
import { SqliteNotifier } from '../../../src/notifier/sqlite-notifier.js';
it('concurrent processes share one SQLite notice gate and only one offer', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'notice-race-'));
  const path = join(dir, 'state.sqlite');
  const db = new LocalHostDb(path);
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    runMigrations(db, resolve(here, '../../../migrations'));
    new SqliteNotifier(db, () => 1700000000).enqueue({
      level: 'L2',
      kind: 'reply',
      payload: {},
    });
    const child = join(dir, 'offer.mjs');
    writeFileSync(
      child,
      `
import {LocalHostDb} from ${JSON.stringify(pathToFileURL(resolve(here, '../../../src/host/local-host-db.ts')).href)};
import {SqliteNotifier} from ${JSON.stringify(pathToFileURL(resolve(here, '../../../src/notifier/sqlite-notifier.ts')).href)};
const db=new LocalHostDb(process.argv[2]);const store=new SqliteNotifier(db,()=>1700000000);
while(Date.now()<Number(process.argv[3])) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5);
const result=store.offerNoticeFor({consumerId:'same',store,active:()=>true,eligible:()=>true},()=> 'notice');
console.log(JSON.stringify(result));db.close();
`,
    );
    const start = String(Date.now() + 1200);
    const run = promisify(execFile);
    const results = await Promise.all([
      run(process.execPath, ['--import', 'tsx', child, path, start]),
      run(process.execPath, ['--import', 'tsx', child, path, start]),
    ]);
    expect(
      results
        .map((result) => JSON.parse(result.stdout))
        .filter((result) => result.text),
    ).toHaveLength(1);
    expect(
      db.queryOne(
        'SELECT COUNT(*) AS n FROM notification_receipts WHERE offered_at>0',
      ),
    ).toEqual({ n: 1 });
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
