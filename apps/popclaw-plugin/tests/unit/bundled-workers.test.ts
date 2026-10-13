import { beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Worker } from 'node:worker_threads';
import Database from 'better-sqlite3';
import { buildSchemaWorker } from '../../scripts/build-schema-worker.mjs';
import { buildIntegrityWorker } from '../../scripts/build-integrity-worker.mjs';

const require = createRequire(import.meta.url);

describe('the worker sources embedded in distributed bundles', () => {
  let schemaSource: string;
  let integritySource: string;

  beforeAll(async () => {
    schemaSource = (await buildSchemaWorker()).source;
    integritySource = (await buildIntegrityWorker()).source;
  });

  it('keeps the embedded schema validator below 160 KiB', () => {
    expect(Buffer.byteLength(schemaSource)).toBeLessThanOrEqual(160 * 1024);
  });

  it.each([
    [{ type: 'string', pattern: '^.$', maxLength: 1 }, '😀', { valid: true }],
    [{ type: 'string', pattern: '^.$', maxLength: 1 }, 'ab', { valid: false }],
    [{ type: 'invalid-schema-type' }, true, { failed: true }],
  ])('executes the emitted validator with schema %j and payload %j', async (schema, payload, expected) => {
    const worker = new Worker(schemaSource, { eval: true, workerData: { schema, payload } });
    try {
      const reply = await new Promise((resolve, reject) => {
        worker.once('message', resolve);
        worker.once('error', reject);
      });
      expect(reply).toEqual(expected);
    } finally {
      await worker.terminate();
    }
  });

  it('executes the emitted integrity worker in a separate process against real SQLite files', () => {
    const root = mkdtempSync(join(tmpdir(), 'popclaw-bundled-integrity-'));
    const path = join(root, 'social.db');
    const corruptPath = join(root, 'corrupt.db');
    const db = new Database(path);
    try {
      db.pragma('journal_mode = WAL');
      db.exec('CREATE TABLE parent(id INTEGER PRIMARY KEY); CREATE TABLE child(parent_id INTEGER REFERENCES parent(id))');
      db.pragma('foreign_keys = OFF');
      db.exec('INSERT INTO child VALUES(99)');
      db.pragma('foreign_keys = ON');
      writeFileSync(corruptPath, 'not a SQLite database');
      const nativeModule = require.resolve('better-sqlite3');
      const bindings = require.resolve('bindings', { paths: [dirname(nativeModule)] });
      const nativeModules = {
        'better-sqlite3': nativeModule,
        bindings,
        'file-uri-to-path': require.resolve('file-uri-to-path', { paths: [dirname(bindings)] }),
      };
      const child = spawnSync(process.execPath, ['--input-type=commonjs', '-e', integritySource], {
        cwd: root,
        input: JSON.stringify({ nativeModule, nativeModules, dbs: [
          { label: 'social', path }, { label: 'corrupt', path: corruptPath },
        ] }),
        encoding: 'utf8', timeout: 15_000,
      });
      expect(child.status, child.stderr).toBe(0);
      const reply = JSON.parse(child.stdout);
      expect(reply.pid).not.toBe(process.pid);
      expect(reply.results[0].result.fingerprint).toMatch(/^[a-f0-9]{16}$/);
      expect(reply.results[0].result.problems).toEqual([{
        kind: 'foreign_key_check', key: 'foreign_key_check', detail: '1 dangling foreign-key row(s)',
      }]);
      expect(reply.results[1].error).toContain('not a database');
      db.exec('INSERT INTO parent VALUES(99)');
      expect(db.pragma('foreign_key_check')).toEqual([]);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
