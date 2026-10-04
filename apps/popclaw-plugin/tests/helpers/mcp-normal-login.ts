/** Explicit owner login through the real MCP process, never a configured-URL seed.
 * The tool may return while its command is pending. Observe the one command this
 * call enqueued by request_id; do not retry login or infer completion from copy.
 */
import {existsSync} from 'node:fs';
import {expect, vi} from 'vitest';
import {LocalHostDb} from '../../src/host/local-host-db.js';
import {PopclawPaths} from '../../src/host/popclaw-paths.js';
import type {LoginResult} from '../../src/runtime/house-lifecycle/manager.js';

type LoginRow = {request_id: string; state: string; result_json: string | null};
export async function loginMcpHouse(dataRoot: string, origin: string,
  call: () => Promise<unknown>, expected: 'configured' | 'connected' = 'configured'): Promise<string> {
  const path = new PopclawPaths(dataRoot).socialDb();
  const rows = (): LoginRow[] => {
    if (!existsSync(path)) return [];
    const db = new LocalHostDb(path, {readOnly: true});
    try {
      if (!db.queryOne("SELECT name FROM sqlite_master WHERE name='house_lifecycle_commands'")) return [];
      return db.queryAll<LoginRow>("SELECT request_id,state,result_json FROM house_lifecycle_commands WHERE kind='login' AND house_origin=?", [origin]);
    } finally {db.close();}
  };
  const before = new Set(rows().map(row => row.request_id));
  await call();
  const added = rows().filter(row => !before.has(row.request_id));
  expect(added, 'one explicit login must enqueue exactly one command').toHaveLength(1);
  const requestId = added[0]!.request_id;
  await vi.waitFor(() => {
    const current = rows().filter(row => !before.has(row.request_id));
    expect(current).toHaveLength(1);
    expect(current[0]).toMatchObject({request_id: requestId, state: 'done'});
    expect(current[0]!.result_json).toEqual(expect.any(String));
    const result = JSON.parse(current[0]!.result_json!) as LoginResult;
    expect(result.origin).toBe(origin);
    if (expected === 'configured') expect(result.admission).toBe('configured');
    else expect(result.status).toBe('connected');
  }, {timeout: 15000, interval: 25});
  return requestId;
}
