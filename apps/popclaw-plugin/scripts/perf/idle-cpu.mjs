#!/usr/bin/env node
// Idle CPU baseline harness for the PopClaw plugin (dev-only; not shipped:
// package.json `files` publishes dist/ only and scripts/bundle.mjs reads src/).
//
// Measures the REAL bundled plugin (dist/bundled/index.js) booted through the
// OpenClaw Gateway entry (register() + service start) against one-off data
// roots under --out, with a loopback stub standing in for the configured
// house. No network beyond loopback is allowed (the worker refuses it and
// records the attempt). Nothing outside --out is read or written.
//
// Prerequisite: the bundle must exist.
//   POPCLAW_NATIVE_DEPS_MINIMAL=1 pnpm --filter popclaw run build:bundle
// Run (from the repo root):
//   node apps/popclaw-plugin/scripts/perf/idle-cpu.mjs --out <scratch dir> \
//     [--scenarios owner-bare,control-no-bus,control-node,owner,pair] [--windows 5] [--window-sec 60] \
//     [--warmup-sec 60] [--stack-every 20] \
//     [--experiments whatif-stmt-cache,pump-suppressed,bus-timer-cleared] [--ref-pid <pid>] [--plugin-root <dir with dist/bundled and dist/native-deps>]
// CPU-budget windows: uninstrumented scenarios, natural GC. Instrumented
// scenarios force a GC between windows (outside the timed interval) for the
// live-object and handle checks only.
// Scenarios:
//   owner       one instrumented process; it acquires the owner lease (HouseRuntime.start()).
//   owner-bare  the same boot with NO counters/wrappers, for harness overhead.
//   control-no-bus  owner-bare's boot, but the command bus interval is cleared
//               right after boot (runtime composed, bus not running). Uninstrumented.
//   control-node    no plugin at all: the same worker process shape, guard and
//               windows with nothing imported. Uninstrumented.
// --houses o1[,o2]  configure these loopback house origins instead of the 404
//               stub (connected-idle fixture); the worker reports the state the
//               plugin reached for each house after boot and after the run.
//   latency     (not in the default set) two uninstrumented processes on one
//               root: the owner first enqueues `status` probes to itself
//               (same-process), then a non-owner enqueues them (cross-process);
//               reports enqueue-to-claim p50/p90/p99/max in ms. --latency-samples N.
//   pair-bare   the pair, uninstrumented (for CPU budgets of the non-owner).
//   pair        two instrumented processes on ONE root: A owns the lease, B boots
//               second and stays a non-owner; windows are aligned.
// Output: <out>/run-<utc>/results.json (also printed on stdout), a human summary
// on stderr, worker logs beside it. Exit 0 = every scenario produced its windows
// with the expected owner state; 1 otherwise.
import { fork, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync, createWriteStream, existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
let PLUGIN_ROOT = resolve(HERE, '../..');
const WORKER = join(HERE, 'idle-cpu-worker.mjs');

function parseArgs(argv) {
  const a = { scenarios: 'owner-bare,control-no-bus,control-node,owner,pair', windows: 5, windowSec: 60, warmupSec: 60, stackEvery: 20,
    experiments: 'whatif-stmt-cache,pump-suppressed,bus-timer-cleared', out: '', refPid: [], latencySamples: 400 };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i], v = argv[i + 1];
    switch (k) {
      case '--scenarios': a.scenarios = v; i++; break;
      case '--windows': a.windows = Number(v); i++; break;
      case '--window-sec': a.windowSec = Number(v); i++; break;
      case '--warmup-sec': a.warmupSec = Number(v); i++; break;
      case '--stack-every': a.stackEvery = Number(v); i++; break;
      case '--experiments': a.experiments = v; i++; break;
      case '--out': a.out = v; i++; break;
      case '--latency-samples': a.latencySamples = Number(v); i++; break;
      case '--settle-sec': a.settleSec = Number(v); i++; break;
      case '--houses': a.houses = v.split(',').filter(Boolean); i++; break;
      case '--plugin-root': a.pluginRoot = resolve(v); i++; break;
      case '--ref-pid': a.refPid.push(v); i++; break;
      default: throw new Error(`unknown argument ${k}`);
    }
  }
  if (!a.out) throw new Error('--out <dir> is required (a scratch directory; nothing is written elsewhere)');
  return a;
}

const args = parseArgs(process.argv.slice(2));
if (args.pluginRoot) PLUGIN_ROOT = args.pluginRoot; // e.g. a read-only copy of another build
// Default warm-up is long enough for the stub-refused stream reconnect backoff to widen.
if (!existsSync(join(PLUGIN_ROOT, 'dist/bundled/index.js'))) {
  process.stderr.write('dist/bundled/index.js missing: run POPCLAW_NATIVE_DEPS_MINIMAL=1 pnpm --filter popclaw run build:bundle\n');
  process.exit(1);
}
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const RUN = join(resolve(args.out), `run-${stamp}`);
mkdirSync(RUN, { recursive: true });

const ps = () => {
  try { return execFileSync('ps', ['-Ao', 'pid,pcpu,time,comm', '-r'], { encoding: 'utf8' }).split('\n').slice(0, 16).join('\n'); }
  catch (e) { return `ps failed: ${e}`; }
};
const refPs = () => args.refPid.map(pid => {
  try { return execFileSync('ps', ['-o', 'pid,time,pcpu,etime', '-p', pid], { encoding: 'utf8' }).trim(); }
  catch { return `pid ${pid}: not running`; }
});
const gitCwd = resolve(HERE, '../..');
const git = (...c) => { try { return execFileSync('git', c, { cwd: gitCwd, encoding: 'utf8' }).trim(); } catch { return 'unknown'; } };

// Loopback stand-in for the configured house: answers 404 to everything and
// counts what the plugin asked for.
const stubHits = new Map();
const stub = createServer((req, res) => {
  const key = `${req.method} ${req.url.split('?')[0]}`;
  stubHits.set(key, (stubHits.get(key) ?? 0) + 1);
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end('{"error":"perf-stub: no house here"}');
});
await new Promise(r => stub.listen(0, '127.0.0.1', r));
const STUB_ORIGIN = `http://127.0.0.1:${stub.address().port}`;

function makeRoot(name) {
  const root = join(RUN, name);
  const stateDir = join(root, 'state');
  mkdirSync(join(stateDir, 'popclaw', 'config'), { recursive: true });
  mkdirSync(join(root, 'home'), { recursive: true });
  mkdirSync(join(root, 'tmp'), { recursive: true });
  writeFileSync(join(stateDir, 'popclaw', 'config', 'plugin.json'), JSON.stringify({ lore_houses: args.houses?.length ? args.houses : [STUB_ORIGIN] }, null, 2));
  return root;
}

function spawnWorker(label, root, instrument, experiments, extra = {}) {
  const config = { label, pluginRoot: PLUGIN_ROOT, stateDir: join(root, 'state'), instrument, ...extra,
    settleSec: args.settleSec ?? 0, windows: args.windows, windowSec: args.windowSec, warmupSec: args.warmupSec, stackEvery: args.stackEvery, experiments };
  // A sanitized environment: no POPCLAW_*/OPENCLAW_* from the caller, HOME and
  // TMPDIR inside the one-off root, so no real root or config can be touched.
  const env = { PATH: process.env.PATH, HOME: join(root, 'home'), TMPDIR: join(root, 'tmp'), LANG: 'en_US.UTF-8',
    PERF_WORKER_CONFIG: JSON.stringify(config) };
  const child = fork(WORKER, [], { env, execArgv: instrument ? ['--expose-gc'] : [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const logf = createWriteStream(join(RUN, `${label}.log`));
  child.stdout.pipe(logf); child.stderr.pipe(logf);
  child.stderr.on('data', d => process.stderr.write(d));
  const w = { label, child, messages: [], booted: null, windows: [], stopped: null, exitCode: null };
  w.bootedP = new Promise((res, rej) => {
    child.on('message', m => {
      w.messages.push(m);
      if (m.type === 'booted') { w.booted = m; res(m); }
      if (m.type === 'fatal') rej(new Error(m.error));
      if (m.type === 'window') w.windows.push(m.window);
      if (m.type === 'stopped') w.stopped = m;
      if (m.type === 'latency') w.latency = m;
      if (m.type === 'houses') (w.houses ??= []).push(m);
      for (const f of w.onMessage ?? []) f(m);
    });
    child.on('exit', code => rej(new Error(`worker ${label} exited ${code} before boot`)));
  });
  w.exitP = new Promise(res => child.on('exit', (code, sig) => { w.exitCode = code ?? sig; res(); }));
  return w;
}

const quant = (xs) => { const v = [...xs].sort((x, y) => x - y); const q = p => v[Math.min(v.length - 1, Math.ceil(p * v.length) - 1)];
  return v.length ? { n: v.length, p50: q(0.5), p90: q(0.9), p99: q(0.99), max: v.at(-1), mean: +(v.reduce((s, x) => s + x, 0) / v.length).toFixed(2) } : null; };
const pick = (w) => ({ label: w.label, exitCode: w.exitCode, booted: w.booted, windows: w.windows, stopped: w.stopped, houses: w.houses ?? null,
  ...(w.latency ? { latency: Object.fromEntries(Object.entries(w.latency.samples).map(([k, xs]) => [k, { ...quant(xs), raw: xs }])) } : {}) });
const scenarios = args.scenarios.split(',').filter(Boolean);
const experiments = args.experiments.split(',').filter(Boolean);
const result = {
  startedAtUtc: new Date().toISOString(), sha: git('rev-parse', 'HEAD'), branch: git('rev-parse', '--abbrev-ref', 'HEAD'),
  dirty: git('status', '--porcelain', '--untracked-files=no') !== '', node: process.version, platform: `${process.platform}-${process.arch}`,
  args, houses: args.houses ?? null, pluginRoot: PLUGIN_ROOT, bundleSha256: createHash('sha256').update(readFileSync(join(PLUGIN_ROOT, 'dist/bundled/index.js'))).digest('hex'),
  stubOrigin: STUB_ORIGIN, psBefore: ps(), refBefore: refPs(), scenarios: {}, failures: [],
};

for (const sc of scenarios) {
  stubHits.clear();
  const t0 = Date.now();
  let workers = [];
  try {
    if (sc === 'owner' || sc === 'owner-bare') {
      // whatif-stmt-cache needs the prepare wrapper, so the bare run skips it.
      const exps = sc === 'owner' ? experiments : experiments.filter(e => e !== 'whatif-stmt-cache');
      const w = spawnWorker(sc, makeRoot(sc), sc === 'owner', exps);
      w.expectedExtra = exps.length;
      workers = [w];
      await w.bootedP;
      if (w.booted.ownerAtBoot !== true) result.failures.push(`${sc}: expected owner at boot, got ${w.booted.ownerAtBoot}`);
      w.child.send({ type: 'go' });
    } else if (sc === 'control-no-bus' || sc === 'control-node') {
      const w = spawnWorker(sc, makeRoot(sc), false, [], sc === 'control-node' ? { mode: 'node-only' } : { busOff: true });
      workers = [w];
      await w.bootedP;
      if (sc === 'control-no-bus' && w.booted.ownerAtBoot !== true) result.failures.push(`${sc}: expected owner at boot, got ${w.booted.ownerAtBoot}`);
      w.child.send({ type: 'go' });
    } else if (sc === 'latency') {
      const root = makeRoot(sc);
      const lat = { houseOrigin: STUB_ORIGIN, samePerProcess: Math.max(20, Math.round(args.latencySamples / 4)), crossSamples: args.latencySamples };
      const a = spawnWorker('latency-A-owner', root, false, [], { ...lat, latencyRole: 'claimer' });
      workers = [a];
      await a.bootedP;
      const b = spawnWorker('latency-B-enqueuer', root, false, [], { ...lat, latencyRole: 'enqueuer' });
      workers.push(b);
      await b.bootedP;
      if (a.booted.ownerAtBoot !== true) result.failures.push(`latency: A expected owner, got ${a.booted.ownerAtBoot}`);
      if (b.booted.ownerAtBoot !== false) result.failures.push(`latency: B expected non-owner, got ${b.booted.ownerAtBoot}`);
      const phaseDone = new Promise(r => { a.onMessage = [m => { if (m.type === 'phase-done') r(); }]; });
      a.child.send({ type: 'go' });
      await phaseDone;
      const enq = new Promise(r => { b.onMessage = [m => { if (m.type === 'latency-enqueued') r(); }]; });
      b.child.send({ type: 'go' });
      await enq;
      a.child.send({ type: 'finish' });
    } else if (sc === 'pair' || sc === 'pair-bare') {
      const bare = sc === 'pair-bare', root = makeRoot(sc);
      const a = spawnWorker(bare ? 'pair-bare-A-owner' : 'pair-A-owner', root, !bare, []);
      workers = [a];
      await a.bootedP;
      const b = spawnWorker(bare ? 'pair-bare-B-nonowner' : 'pair-B-nonowner', root, !bare, []);
      workers.push(b);
      await b.bootedP;
      if (a.booted.ownerAtBoot !== true) result.failures.push(`pair: A expected owner, got ${a.booted.ownerAtBoot}`);
      if (b.booted.ownerAtBoot !== false) result.failures.push(`pair: B expected non-owner, got ${b.booted.ownerAtBoot}`);
      a.child.send({ type: 'go' }); b.child.send({ type: 'go' });
    } else throw new Error(`unknown scenario ${sc}`);
  } catch (e) {
    result.failures.push(`${sc}: ${e.message}`);
    for (const w of workers) w.child.kill('SIGTERM');
  }
  if (sc !== 'latency' && workers.length) {
    await Promise.all(workers.map(w => new Promise(res => {
      if (w.messages.some(m => m.type === 'windows-done')) return res();
      (w.onMessage ??= []).push(m => { if (m.type === 'windows-done') res(); });
      w.child.on('exit', res);
    })));
    for (const w of workers) if (w.child.connected) w.child.send({ type: 'release' });
  }
  await Promise.all(workers.map(w => w.exitP));
  for (const w of workers) {
    if (w.exitCode !== 0) result.failures.push(`${w.label}: exit ${w.exitCode}`);
    const expected = sc === 'latency' ? 0 : 1 + args.windows + (w.expectedExtra ?? 0);
    if (w.windows.length !== expected) result.failures.push(`${w.label}: ${w.windows.length} windows, expected ${expected}`);
    const rt = w.booted?.serviceResults?.find(s => s.id === 'popclaw-runtime');
    if (w.label !== 'control-node' && !rt?.ok) result.failures.push(`${w.label}: popclaw-runtime service did not start`);
  }
  result.scenarios[sc] = { wallS: (Date.now() - t0) / 1000, workers: workers.map(pick),
    stubHits: Object.fromEntries([...stubHits.entries()].sort((x, y) => y[1] - x[1])) };
}
result.psAfter = ps(); result.refAfter = refPs(); result.finishedAtUtc = new Date().toISOString();
stub.close();

// ---- human summary ---------------------------------------------------------
const stats = (xs) => { const n = xs.length; if (!n) return null; const m = xs.reduce((s, x) => s + x, 0) / n;
  const sd = Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, n - 1));
  return { n, mean: +m.toFixed(3), sd: +sd.toFixed(3), min: Math.min(...xs), max: Math.max(...xs) }; };
const lines = [`idle-cpu harness  sha=${result.sha}${result.dirty ? ' (dirty)' : ''}  node=${result.node}  run=${RUN}`];
result.summary = {};
for (const [sc, s] of Object.entries(result.scenarios)) for (const w of s.workers) {
  const main = w.windows.filter(x => /^w\d+$/.test(x.name));
  if (!main.length) continue;
  const sum = { cpuOneCorePct: stats(main.map(x => x.oneCorePct)) };
  for (const k of ['pumpPerS', 'preparePerS', 'execPerS', 'transactionPerS', 'jsTimerCallbacksPerS', 'intervalFiresPerS', 'timeoutFiresPerS'])
    if (main[0]?.[k] !== undefined) sum[k] = stats(main.map(x => x[k]));
  const extra = w.windows.filter(x => !/^w\d+$/.test(x.name) && x.name !== 'warmup').map(x => ({ name: x.name, oneCorePct: x.oneCorePct, pumpPerS: x.pumpPerS, preparePerS: x.preparePerS }));
  result.summary[w.label] = { ...sum, experiments: extra };
  const other = main.map(x => x.machineOtherBusyCores).filter(x => x !== undefined);
  if (other.length) sum.machineOtherBusyCores = stats(other);
  lines.push(`${w.label}: cpu ${sum.cpuOneCorePct?.mean}% ±${sum.cpuOneCorePct?.sd} (min ${sum.cpuOneCorePct?.min}, max ${sum.cpuOneCorePct?.max})`
    + (other.length ? `  [host other load: ${Math.min(...other)}–${Math.max(...other)} cores]` : '')
    + (sum.pumpPerS ? `  pump ${sum.pumpPerS.mean}/s  prepare ${sum.preparePerS.mean}/s  exec ${sum.execPerS.mean}/s  JS timer callbacks ${sum.jsTimerCallbacksPerS.mean}/s` : ''));
  for (const e of extra) lines.push(`   ${e.name}: cpu ${e.oneCorePct}%  pump ${e.pumpPerS ?? '-'}/s  prepare ${e.preparePerS ?? '-'}/s`);
}
// Attributable increments: difference of window means, per-window variation
// combined as sqrt(sd1^2 + sd2^2). Separate processes, so process-to-process
// variance is inside these numbers.
const inc = (a, b) => { const A = result.summary[a]?.cpuOneCorePct, B = result.summary[b]?.cpuOneCorePct;
  return A && B ? { of: a, minus: b, oneCorePct: +(A.mean - B.mean).toFixed(3), sdCombined: +Math.sqrt(A.sd ** 2 + B.sd ** 2).toFixed(3) } : null; };
result.increments = [inc('owner-bare', 'control-no-bus'), inc('control-no-bus', 'control-node'), inc('owner-bare', 'control-node'),
  inc('pair-bare-B-nonowner', 'control-no-bus'), inc('pair-bare-B-nonowner', 'control-node')].filter(Boolean);
for (const x of result.increments) lines.push(`increment ${x.of} - ${x.minus}: ${x.oneCorePct}% one-core (combined sd ${x.sdCombined})`);
for (const s of Object.values(result.scenarios)) for (const w of s.workers) if (w.latency) {
  for (const [k, q] of Object.entries(w.latency)) lines.push(`${w.label} ${k} enqueue-to-claim ms: n=${q.n} p50=${q.p50} p90=${q.p90} p99=${q.p99} max=${q.max} mean=${q.mean}`);
  if (w.latency['cross-process']?.n !== args.latencySamples) result.failures.push(`latency: ${w.latency['cross-process']?.n} cross-process claims, expected ${args.latencySamples}`);
}
lines.push(result.failures.length ? `FAILURES: ${result.failures.join('; ')}` : 'all scenarios OK');
writeFileSync(join(RUN, 'results.json'), JSON.stringify(result, null, 2));
writeFileSync(join(RUN, 'summary.txt'), lines.join('\n') + '\n');
process.stdout.write(JSON.stringify(result) + '\n');
process.stderr.write('\n' + lines.join('\n') + '\n');
process.exit(result.failures.length ? 1 : 0);
