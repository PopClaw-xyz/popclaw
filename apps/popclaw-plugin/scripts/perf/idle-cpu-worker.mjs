// Dev-only idle CPU measurement worker. Spawned by idle-cpu.mjs; never shipped
// (package.json `files` lists dist/ only, and scripts/bundle.mjs reads src/).
//
// Boots the REAL plugin artifact (dist/bundled/index.js, the file the OpenClaw
// Gateway imports) through register() + every registered service start(), the
// same entry the Gateway uses, against a one-off data root. All observation is
// installed here, in this process, before the bundle is imported. Product code
// is not modified.
import { createRequire, syncBuiltinESMExports } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import { join, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

const cfg = JSON.parse(process.env.PERF_WORKER_CONFIG ?? '{}');
const PLUGIN_ROOT = cfg.pluginRoot;
const BUNDLE = join(PLUGIN_ROOT, 'dist/bundled/index.js');
const NATIVE = join(PLUGIN_ROOT, 'dist/native-deps/better-sqlite3');
const INSTRUMENT = cfg.instrument !== false;
// 'plugin' boots the bundle; 'node-only' is the no-plugin control (same process
// shape, same guard, nothing imported). busOff = the runtime is composed but the
// command bus timer is cleared right after boot (bus-not-running control).
const MODE = cfg.mode ?? 'plugin';
process.on('disconnect', () => process.exit(2)); // orchestrator gone: never linger
const STACK_EVERY = Math.max(1, cfg.stackEvery ?? 20);
const HARNESS_MARK = '/scripts/perf/';
const log = (...a) => process.stderr.write(`[worker ${cfg.label}] ${a.join(' ')}\n`);
const emit = (msg) => process.send ? process.send(msg) : process.stdout.write(JSON.stringify(msg) + '\n');

// ---------------------------------------------------------------------------
// Network guard (always on, instrumented or not): loopback only. Anything else
// is refused and recorded, so the run can never reach a real house.
// ---------------------------------------------------------------------------
const blockedNetwork = [];
const isLoopback = (h) => h === '127.0.0.1' || h === '::1' || h === 'localhost' || h === '[::1]';
const origFetch = globalThis.fetch;
globalThis.fetch = async function guardedFetch(input, init) {
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url ?? String(input);
  let host = '';
  try { host = new URL(raw).hostname; } catch { /* relative or odd input: refuse */ }
  if (!isLoopback(host)) {
    blockedNetwork.push({ via: 'fetch', target: raw.slice(0, 200), at: Date.now() });
    throw new TypeError('perf harness: non-loopback network refused');
  }
  return origFetch.call(this, input, init);
};
const origConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function guardedConnect(...args) {
  const opts = typeof args[0] === 'object' && args[0] !== null && !Array.isArray(args[0]) ? args[0]
    : Array.isArray(args[0]) ? args[0][0] : { port: args[0], host: typeof args[1] === 'string' ? args[1] : 'localhost' };
  if (opts && opts.path === undefined) {
    const host = opts.host ?? 'localhost';
    if (!isLoopback(host)) {
      blockedNetwork.push({ via: 'net', target: `${host}:${opts.port}`, at: Date.now() });
      process.nextTick(() => this.destroy(new Error('perf harness: non-loopback network refused')));
      return this;
    }
  }
  return origConnect.apply(this, args);
};

// ---------------------------------------------------------------------------
// Counters.
// ---------------------------------------------------------------------------
const zero = () => ({
  prepare: 0, exec: 0, transaction: 0, stacks: 0,
  prepareBySql: new Map(), execBySql: new Map(), stackSigs: new Map(), groupSampled: new Map(),
  timeoutFires: 0, intervalFires: 0, immediateFires: 0, intervalFiresBySite: new Map(), timeoutFiresBySampledSite: new Map(),
  timeoutsCreated: 0, timeoutSampled: 0,
  fsCalls: new Map(), pumpCalls: 0,
});
let C = zero();
let prepareSeq = 0;
let timeoutSeq = 0;
const inc = (map, key, n = 1) => map.set(key, (map.get(key) ?? 0) + n);
const normSql = (sql) => String(sql).replace(/\s+/g, ' ').trim().replace(/IN \((\s*\?\s*,?)+\)/g, 'IN (?…)');

function appFrames(stack) {
  const out = [];
  for (const line of String(stack).split('\n').slice(1)) {
    if (line.includes(HARNESS_MARK) || line.includes('/native-deps/') || line.includes('node:internal')) continue;
    const m = line.match(/^\s*at (?:async )?(.*?) \((.*):(\d+):\d+\)$/) || line.match(/^\s*at (?:async )?()(.*):(\d+):\d+$/);
    if (!m) continue;
    out.push({ fn: m[1] || '<anonymous>', file: basename(m[2]), line: Number(m[3]) });
  }
  return out;
}
function withStack() {
  const limit = Error.stackTraceLimit; Error.stackTraceLimit = 40;
  try { return appFrames(new Error().stack); } finally { Error.stackTraceLimit = limit; }
}
const DB_METHODS = new Set(['LocalHostDb.queryOne', 'LocalHostDb.queryAll', 'LocalHostDb.execute', 'LocalHostDb.transaction']);
function classify(frames) {
  const names = frames.map(f => f.fn);
  // immediate = first frame outside the DB adapter (and its transaction closure)
  const immediate = names.find(n => !DB_METHODS.has(n) && n !== 'sqliteTransaction' && !/^Database\./.test(n) && n !== 'Object.<anonymous>') ?? '<none>';
  let component = 'other';
  const top = names.slice(0, 6).join(' ');
  if (/storageDatabasePathAllowed|storagePathAllowed/.test(names.slice(0, 3).join(' '))) component = 'storage-guard';
  else if (/OwnerLease\./.test(names.slice(0, 3).join(' '))) component = 'owner-lease';
  else if (/HouseCommandBus\./.test(top)) component = 'command-bus';
  let driver = 'other';
  const all = names.join(' ');
  if (/HouseCommandBus\.pump/.test(all)) driver = 'bus.pump';
  else if (/HouseCommandBus\.wait/.test(all)) driver = 'bus.wait';
  else if (/OwnerLease\.(start|tryAcquire)/.test(all)) driver = 'owner-lease.renewal';
  else if (/ResidentLifecycle\./.test(all)) driver = 'resident';
  return { immediate, component, driver };
}

// ---------------------------------------------------------------------------
// Instrumentation (harness-only wrappers; skipped entirely when INSTRUMENT=false).
// ---------------------------------------------------------------------------
const require = createRequire(import.meta.url);
const Database = require(NATIVE);
let stmtCache = null;
const res = { stmtCreated: 0, stmtCollected: 0, dbOpened: 0, dbClosed: 0 };
const stmtRegistry = new FinalizationRegistry(() => { res.stmtCollected++; }); // what-if statement cache (a measurement probe, not a fix)
const liveIntervals = new Map(); // Timeout -> site
const origSetInterval = globalThis.setInterval, origClearInterval = globalThis.clearInterval;
const origSetTimeout = globalThis.setTimeout, origSetImmediate = globalThis.setImmediate;
const siteOf = (frames) => frames.slice(0, 3).map(f => `${f.fn}@${f.file}:${f.line}`).join(' < ') || '<unknown>';

if (INSTRUMENT) {
  const P = Database.prototype;
  const origPrepare = P.prepare, origTransaction = P.transaction;
  P.prepare = function perfPrepare(sql) {
    if (stmtCache) {
      let per = stmtCache.get(this); if (!per) stmtCache.set(this, per = new Map());
      const hit = per.get(sql); if (hit) { inc(C.prepareBySql, '[what-if cache hit]'); return hit; }
      const made = origPrepare.apply(this, arguments); per.set(sql, made); return made;
    }
    C.prepare++;
    const key = normSql(sql);
    inc(C.prepareBySql, key);
    if (++prepareSeq % STACK_EVERY === 0) {
      const frames = withStack();
      C.stacks++;
      const k = classify(frames);
      inc(C.groupSampled, `${k.component} | driver=${k.driver}`);
      inc(C.stackSigs, `${key.slice(0, 90)} || ${frames.slice(0, 5).map(f => f.fn).join(' < ')}`);
    }
    const made = origPrepare.apply(this, arguments);
    res.stmtCreated++; stmtRegistry.register(made, 0);
    return made;
  };
  const origClose = P.close;
  P.close = function perfClose() { if (this.open) res.dbClosed++; return origClose.apply(this, arguments); };
  // Count handle opens by swapping the cached module export for a subclass.
  const resolved = require.resolve(NATIVE);
  class PerfDatabase extends Database { constructor(...a) { super(...a); res.dbOpened++; } }
  require.cache[resolved].exports = PerfDatabase;
  P.transaction = function perfTransaction(fn) { C.transaction++; return origTransaction.call(this, fn); };
  const probe = new Database(':memory:');
  const SP = Object.getPrototypeOf(probe.prepare('SELECT 1'));
  probe.close();
  res.dbClosed = 0; // the probe above was opened before counting began
  for (const m of ['run', 'get', 'all', 'iterate']) {
    const orig = SP[m];
    SP[m] = function perfExec() { C.exec++; inc(C.execBySql, normSql(this.source)); return orig.apply(this, arguments); };
  }
  globalThis.setInterval = function perfSetInterval(cb, ms, ...rest) {
    const site = `${siteOf(withStack())} [${ms}ms]`;
    const t = origSetInterval(function perfIntervalCb(...a) { C.intervalFires++; inc(C.intervalFiresBySite, site); return cb.apply(this, a); }, ms, ...rest);
    liveIntervals.set(t, site);
    return t;
  };
  globalThis.clearInterval = function perfClearInterval(t) { liveIntervals.delete(t); return origClearInterval(t); };
  globalThis.setTimeout = function perfSetTimeout(cb, ms, ...rest) {
    C.timeoutsCreated++;
    let site = null;
    if (++timeoutSeq % STACK_EVERY === 0) { C.timeoutSampled++; site = `${siteOf(withStack())} [${ms ?? 0}ms]`; }
    if (typeof cb !== 'function') return origSetTimeout(cb, ms, ...rest);
    return origSetTimeout(function perfTimeoutCb(...a) { C.timeoutFires++; if (site) inc(C.timeoutFiresBySampledSite, site); return cb.apply(this, a); }, ms, ...rest);
  };
  globalThis.setImmediate = function perfSetImmediate(cb, ...rest) {
    return origSetImmediate(function perfImmediateCb(...a) { C.immediateFires++; return cb.apply(this, a); }, ...rest);
  };
  for (const name of ['existsSync', 'statSync', 'readFileSync']) {
    const orig = fs[name];
    fs[name] = function perfFs(p, ...rest) { inc(C.fsCalls, `${name}(${typeof p === 'string' ? basename(p) : typeof p})`); return orig.call(this, p, ...rest); };
  }
  syncBuiltinESMExports();
}

// ---------------------------------------------------------------------------
// Boot through the Gateway entry: register() then start every service.
// ---------------------------------------------------------------------------
const services = [];
const hooks = new Map();
const loggerLines = { info: 0, warn: 0, error: 0 };
const logger = {
  debug: () => {},
  info: (m) => { loggerLines.info++; if (cfg.verbose) log('info', m); },
  warn: (m) => { loggerLines.warn++; log('warn', String(m).slice(0, 300)); },
  error: (m) => { loggerLines.error++; log('error', String(m).slice(0, 300)); },
};
const api = {
  id: 'popclaw', name: 'popclaw', registrationMode: 'full', config: {}, pluginConfig: {},
  logger,
  runtime: {
    state: { resolveStateDir: () => cfg.stateDir },
    system: { enqueueSystemEvent: () => {}, runHeartbeatOnce: async () => {} },
  },
  registerCommand: () => {}, registerTool: () => {}, registerInteractiveHandler: () => {},
  registerHook: () => {}, registerHttpRoute: () => {}, registerCli: () => {}, registerChannel: () => {},
  registerService: (s) => services.push(s),
  on: (name, fn) => { const list = hooks.get(name) ?? []; list.push(fn); hooks.set(name, list); },
};

const cpu0 = process.cpuUsage();
const bootT0 = performance.now();
const serviceResults = [];
let houses = null, bus = null;
if (MODE === 'plugin') {
  const mod = await import(pathToFileURL(BUNDLE).href);
  mod.default.register(api);
  for (const s of services) {
    try { await s.start(); serviceResults.push({ id: s.id, ok: true }); }
    catch (e) { serviceResults.push({ id: s.id, ok: false, error: String(e).slice(0, 300) }); log('service start failed', s.id, String(e)); }
  }
  const rt = await globalThis['__popclaw_singleton__runtime'];
  houses = rt?.houseRuntime;
  bus = houses?.bus;
  if (!bus) { emit({ type: 'fatal', error: 'house runtime/bus not reachable after boot', serviceResults }); process.exit(1); }
}
const bootMs = performance.now() - bootT0;
const bootCpu = process.cpuUsage(cpu0);
const bootCounters = INSTRUMENT ? {
  busTableCreates: C.prepareBySql.get(normSql('CREATE TABLE IF NOT EXISTS house_lifecycle_commands ( request_id TEXT PRIMARY KEY, kind TEXT NOT NULL, house_origin TEXT NOT NULL, baseline_seq INTEGER NOT NULL, state TEXT NOT NULL DEFAULT \'pending\', running_epoch INTEGER, result_json TEXT, created_at INTEGER NOT NULL )')) ?? 0,
  runtimeBindingTableCreates: C.prepareBySql.get('CREATE TABLE IF NOT EXISTS house_origin_bindings (slug TEXT PRIMARY KEY, origin TEXT NOT NULL UNIQUE)') ?? 0,
  prepare: C.prepare,
} : null;

// Direct tick counter on the live bus instance (instance property shadows the
// prototype; the interval's arrow calls this.pump() at fire time).
let pumpMode = 'normal';
if (bus) {
  const origPump = bus.pump;
  bus.pump = function perfPump() {
    if (INSTRUMENT) C.pumpCalls++;
    if (pumpMode === 'suppressed') return;
    return origPump.call(this);
  };
  if (cfg.busOff && bus.timer) { clearInterval(bus.timer); bus.timer = null; }
}

async function houseStates() {
  if (!houses) return null;
  const out = {};
  for (const origin of houses.resident.coordinator.knownHouseOrigins()) {
    try {
      const st = await houses.resident.coordinator.getHouseStatus(origin);
      out[origin] = { phase: st.phase, desired: st.desired, gateActive: st.gateActive, sessionId: st.sessionId ? 'set' : '', streams: st.streams, remoteStatus: st.remoteStatus };
    } catch (e) { out[origin] = { error: String(e).slice(0, 200) }; }
  }
  return out;
}
const ownerNow = () => { if (!houses) return null; try { return houses.resident.authority.captureEpoch() !== null; } catch { return null; } };
const snapshotLive = () => {
  const bySite = {};
  for (const site of liveIntervals.values()) bySite[site] = (bySite[site] ?? 0) + 1;
  return { liveIntervals: liveIntervals.size, bySite, busTimerSet: !!bus && bus.timer !== null && bus.timer !== undefined };
};
const top = (map, n = 25) => [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);

async function measure(name, seconds, setup) {
  if (setup) setup();
  C = zero();
  const elu0 = performance.eventLoopUtilization();
  const ru0 = process.resourceUsage();
  // Machine-wide CPU over the same interval, so other load on the host is
  // visible per window (the measured process is subtracted below).
  const cpuTimes = () => os.cpus().reduce((a, c) => { const t = c.times; a.busy += t.user + t.nice + t.sys + t.irq; a.all += t.user + t.nice + t.sys + t.irq + t.idle; return a; }, { busy: 0, all: 0 });
  const m0 = cpuTimes(); const startUtc = new Date().toISOString();
  const c0 = process.cpuUsage(); const t0 = performance.now();
  await new Promise(r => origSetTimeout(r, seconds * 1000));
  const c = process.cpuUsage(c0); const wall = (performance.now() - t0) / 1000;
  const m1 = cpuTimes(); const endUtc = new Date().toISOString();
  const ru = process.resourceUsage();
  const elu = performance.eventLoopUtilization(elu0);
  const cpuS = (c.user + c.system) / 1e6;
  const w = {
    name, startUtc, endUtc, wallS: +wall.toFixed(3),
    machineBusyCores: +((m1.busy - m0.busy) / 1000 / wall).toFixed(3),
    machineOtherBusyCores: +((m1.busy - m0.busy) / 1000 / wall - ((c.user + c.system) / 1e6) / wall).toFixed(3),
    machineCores: os.cpus().length, userS: +(c.user / 1e6).toFixed(4), systemS: +(c.system / 1e6).toFixed(4),
    cpuS: +cpuS.toFixed(4), oneCorePct: +(100 * cpuS / wall).toFixed(3), eventLoopUtilization: +elu.utilization.toFixed(5),
    voluntaryCtxSwitches: ru.voluntaryContextSwitches - ru0.voluntaryContextSwitches,
    involuntaryCtxSwitches: ru.involuntaryContextSwitches - ru0.involuntaryContextSwitches,
    ownerAtEnd: ownerNow(),
  };
  // Resource growth, sampled after the CPU window closes. Instrumented runs
  // force a GC here (so live-object and statement counts reflect what is still
  // reachable); uninstrumented CPU-budget runs keep natural GC.
  if (INSTRUMENT) { globalThis.gc?.(); await new Promise(r => origSetImmediate(r)); }
  const mem = process.memoryUsage();
  const active = {};
  for (const t of process.getActiveResourcesInfo()) active[t] = (active[t] ?? 0) + 1;
  w.memory = { forcedGc: INSTRUMENT, rssMB: +(mem.rss / 2 ** 20).toFixed(2), heapUsedMB: +(mem.heapUsed / 2 ** 20).toFixed(3),
    heapTotalMB: +(mem.heapTotal / 2 ** 20).toFixed(2), externalMB: +(mem.external / 2 ** 20).toFixed(3) };
  w.activeResources = active;
  if (INSTRUMENT) w.handles = { ...res, stmtLive: res.stmtCreated - res.stmtCollected, dbOpen: res.dbOpened - res.dbClosed };
  if (INSTRUMENT) {
    const per = (n) => +(n / wall).toFixed(2);
    Object.assign(w, {
      pumpPerS: per(C.pumpCalls), preparePerS: per(C.prepare), execPerS: per(C.exec), transactionPerS: per(C.transaction),
      intervalFiresPerS: per(C.intervalFires), timeoutFiresPerS: per(C.timeoutFires), immediateFiresPerS: per(C.immediateFires),
      // JS timer callbacks run by this process; not OS or hardware wakeups.
      jsTimerCallbacksPerS: per(C.intervalFires + C.timeoutFires + C.immediateFires),
      timeoutsCreatedPerS: per(C.timeoutsCreated),
      stackSamples: C.stacks, stackSampleRatio: `1/${STACK_EVERY}`,
      prepareBySql: top(C.prepareBySql).map(([k, v]) => ({ sql: k, count: v, perS: per(v) })),
      execBySql: top(C.execBySql).map(([k, v]) => ({ sql: k, count: v, perS: per(v) })),
      sampledGroups: top(C.groupSampled).map(([k, v]) => ({ group: k, samples: v, share: +(v / Math.max(1, C.stacks)).toFixed(4) })),
      sampledStackSignatures: top(C.stackSigs, 15).map(([k, v]) => ({ sig: k, samples: v })),
      intervalFiresBySite: top(C.intervalFiresBySite).map(([k, v]) => ({ site: k, fires: v, perS: per(v) })),
      timeoutFiresBySampledSite: top(C.timeoutFiresBySampledSite, 10).map(([k, v]) => ({ site: k, sampledFires: v })),
      fsCallsPerS: top(C.fsCalls, 12).map(([k, v]) => ({ call: k, perS: per(v) })),
      live: snapshotLive(),
    });
  }
  emit({ type: 'window', label: cfg.label, window: w });
  log(`${name}: ${w.oneCorePct}% one-core` + (INSTRUMENT ? `, pump ${w.pumpPerS}/s, prepare ${w.preparePerS}/s, JS timer callbacks ${w.jsTimerCallbacksPerS}/s` : ''));
  return w;
}

emit({ type: 'booted', label: cfg.label, pid: process.pid, bootMs: Math.round(bootMs), bootCpuS: (bootCpu.user + bootCpu.system) / 1e6,
  serviceResults, hooks: [...hooks.keys()], ownerAtBoot: ownerNow(), bootCounters, live: INSTRUMENT ? snapshotLive() : null,
  busPollMs: bus?.pollMs ?? null, mode: MODE, busOff: !!cfg.busOff, betterSqlite3: require(join(NATIVE, 'package.json')).version, node: process.version });

if (cfg.settleSec) await new Promise(r => origSetTimeout(r, cfg.settleSec * 1000));
emit({ type: 'houses', label: cfg.label, at: 'boot', states: await houseStates() });
// Park until the orchestrator says go (so paired processes align windows).
const inbox = [];
const waiters = [];
process.on('message', m => { const i = waiters.findIndex(w => w.type === m?.type); if (i >= 0) waiters.splice(i, 1)[0].resolve(m); else inbox.push(m); });
const nextMessage = (type) => { const i = inbox.findIndex(m => m?.type === type); if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
  return new Promise(resolve => waiters.push({ type, resolve })); };
if (process.send) await nextMessage('go');

// ---------------------------------------------------------------------------
// Latency mode: enqueue-to-claim, measured on the live bus. The claimer (the
// owner) records Date.now() when bus.execute() starts, which the bus calls
// right after its claiming UPDATE commits, minus the row's created_at (the
// enqueuer's Date.now() at INSERT). Same host, same wall clock. The probe
// command is `status`, which only reads local participation state.
// ---------------------------------------------------------------------------
if (cfg.latencyRole) {
  const sleep = (ms) => new Promise(r => origSetTimeout(r, ms));
  const gap = () => 100 + Math.random() * 300; // random phase against the poll
  if (cfg.latencyRole === 'claimer') {
    let phase = 'same-process';
    const samples = { 'same-process': [], 'cross-process': [] };
    const origExecute = bus.execute;
    bus.execute = function perfExecute(row, epoch) {
      samples[phase].push(Date.now() - Number(row.created_at));
      return origExecute.call(this, row, epoch);
    };
    for (let i = 0; i < (cfg.samePerProcess ?? 100); i++) { await sleep(gap()); await bus.getHouseStatus(cfg.houseOrigin); }
    phase = 'cross-process';
    emit({ type: 'phase-done', label: cfg.label });
    await nextMessage('finish');
    emit({ type: 'latency', label: cfg.label, samples, ownerAtEnd: ownerNow() });
  } else {
    for (let i = 0; i < (cfg.crossSamples ?? 400); i++) { await sleep(gap()); await bus.getHouseStatus(cfg.houseOrigin); }
    emit({ type: 'latency-enqueued', label: cfg.label, n: cfg.crossSamples ?? 400, ownerAtEnd: ownerNow() });
  }
} else {

await measure('warmup', cfg.warmupSec ?? 20);
for (let i = 1; i <= (cfg.windows ?? 5); i++) await measure(`w${i}`, cfg.windowSec ?? 60);
const exp = cfg.experiments ?? [];
if (exp.includes('whatif-stmt-cache') && INSTRUMENT) {
  await measure('whatif-stmt-cache', cfg.windowSec ?? 60, () => { stmtCache = new WeakMap(); });
  stmtCache = null;
}
if (exp.includes('pump-suppressed')) await measure('pump-suppressed', cfg.windowSec ?? 60, () => { pumpMode = 'suppressed'; });
if (exp.includes('bus-timer-cleared')) await measure('bus-timer-cleared', cfg.windowSec ?? 60, () => { pumpMode = 'normal'; if (bus.timer) { clearInterval(bus.timer); bus.timer = null; } });
// Hold until every process in the scenario has finished its windows, so no
// process stops (and hands over the owner lease) inside another's window.
if (process.send) { emit({ type: 'windows-done', label: cfg.label }); await nextMessage('release'); }
}

emit({ type: 'houses', label: cfg.label, at: 'end', states: await houseStates() });
// Shutdown through the Gateway path, then check what outlived it.
let stopOk = true;
try {
  for (const fn of hooks.get('gateway_stop') ?? []) await fn({}, {});
  for (const s of services.reverse()) await s.stop?.();
} catch (e) { stopOk = false; log('stop failed', String(e)); }
globalThis.gc?.(); await new Promise(r => origSetImmediate(r));
emit({ type: 'stopped', label: cfg.label, stopOk,
  afterStop: INSTRUMENT ? { ...snapshotLive(), handles: { ...res, stmtLive: res.stmtCreated - res.stmtCollected, dbOpen: res.dbOpened - res.dbClosed } } : null, blockedNetwork, loggerLines });
process.exit(0);
