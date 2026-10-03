// Component fixture: real processes, OwnerLease and SQLite command transport.
// The command executor is synthetic; two real Rust houses belong to S4.
import { LocalHostDb } from '../../src/host/local-host-db.js';
import { OwnerLease } from '../../src/runtime/house-lifecycle/owner-lease.js';
import { ensureHouseLifecycleSchema } from '../../src/runtime/house-lifecycle/participation-store.js';
import { HouseCommandBus, type HouseCommandPort } from '../../src/runtime/house-lifecycle/command-bus.js';

const [dbPath, role] = process.argv.slice(2);
if (!dbPath || !role) throw new Error('fixture needs DB path and role');
const db = new LocalHostDb(dbPath);
ensureHouseLifecycleSchema(db);
db.execute('CREATE TABLE IF NOT EXISTS fixture_executions (pid INTEGER NOT NULL, role TEXT NOT NULL)');
const lease = new OwnerLease({ db, token: `fixture-${process.pid}`, ttlMs: 3000 });
const coordinator: HouseCommandPort = {
  loginHouse: async (origin: string) => {
    db.execute('INSERT INTO fixture_executions (pid, role) VALUES (?, ?)', [process.pid, role]);
    return { scope: 'local_installation' as const, origin, status: 'connected' as const, sessionId: `executor-${process.pid}` };
  },
  knownHouseOrigins: () => [],
  logoutHouse: async () => { throw new Error('not part of this component fixture'); },
  getHouseStatus: async () => { throw new Error('not part of this component fixture'); },
};
const bus = new HouseCommandBus({ db, coordinator, pollMs: 10, timeoutMs: 5000, authority: {
  captureEpoch: () => lease.isOwnerNow() ? lease.knownGeneration() : null,
  isEpochCurrent: epoch => lease.isGenerationCurrent(epoch),
} });
try {
  if (role === 'owner') {
    if (!lease.tryAcquire()) throw new Error('fixture could not acquire ownership');
    lease.start(); bus.start();
    const keepAlive = setInterval(() => {}, 1000);
    process.stdout.write(JSON.stringify({ ready: true, pid: process.pid }) + '\n');
    await new Promise<void>(resolve => process.once('SIGTERM', () => resolve()));
    clearInterval(keepAlive);
  } else {
    const result = await bus.loginHouse('https://synthetic.invalid');
    process.stdout.write(JSON.stringify({ readerPid: process.pid, result }) + '\n');
  }
} finally {
  await bus.stop();
  if (role === 'owner') lease.release();
  db.close();
}
