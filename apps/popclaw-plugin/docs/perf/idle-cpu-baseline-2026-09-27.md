# Idle CPU baseline: plugin house runtime (2026-09-27)

Phase 1 of the idle Gateway CPU investigation measured an unmodified
candidate; phase 2(a) (a statement cache in `LocalHostDb`) was then measured
against it, and two further fixtures were tried. Every number below comes
from the harness command quoted with it. Raw outputs are on the measuring
machine, outside the repository, under `<OUT_DIR>`.

**Framing.** Unless a section says otherwise, the numbers describe the
**refuse-connection fixture**: one configured house that is a loopback stub
answering 404 to everything. That is neither normal connected idle nor the
live Gateway's plugin increment. The connected-idle fixture is reported
separately (Experiment B). Throughout, "± x" is the standard deviation of the
per-window values, a spread figure, not a confidence interval.

Method note. The phase-1 tables below were taken with a forced GC between
windows (outside the timed interval). The phase 2(a) before/after that decides
the budgets uses natural GC in the uninstrumented processes; forced GC is kept
only in the instrumented runs, for the live-object and handle checks. A flat
post-GC heap over five minutes shows short-window live-object stability only,
not long-run memory behaviour.

## What was measured

| Item | Value |
|---|---|
| Source | `253a2db027707af955b39d948cad1024a55ae3a2` (branch `perf/idle-cpu`, clean tree, `dirty: false` in results) |
| Artifact | `dist/bundled/index.js` built from that SHA with `POPCLAW_NATIVE_DEPS_MINIMAL=1 pnpm run build:bundle` (stamp `0.1.0 2026-09-27 16:35+08 253a2db0`) |
| Native SQLite | vendored `better-sqlite3` 12.11.1 from `dist/native-deps` (the same module the bundle loads) |
| Node | v26.8.2, darwin-arm64 (macOS VM, Apple M4 Pro (Virtual)) |
| Run window | 2026-09-27 08:47:06Z to 09:22:16Z, scenarios run one at a time |

### Composition

The harness does not rebuild the runtime by hand. It imports the bundled
artifact the OpenClaw Gateway imports, calls `register(api)` with a stub
OpenClaw API, then calls `start()` on every service the plugin registers,
in registration order (eight services: `popclaw-runtime`,
`onboarding-orchestrator`, `popclaw-l1-delivery`, `popclaw-daily-backup`,
`popclaw-default-house-pinning`, `popclaw-follower-sync`,
`popclaw-follow-doorbell`, `popclaw-page-state-sync`; all started). This is
the Gateway path: `index.ts` constructs `HouseRuntime` in the runtime boot and
calls `houses.start()`. The harness then reads the live runtime from the
process memo and wraps only the instance method `bus.pump` for counting.

Isolation:

- Each scenario gets a one-off data root under the run directory, with
  `config/plugin.json` = `{"lore_houses": ["http://127.0.0.1:<port>"]}`. A fresh
  identity is generated there. The worker's environment is rebuilt from scratch:
  only `PATH`, `LANG`, and `HOME`/`TMPDIR` inside the one-off root. No
  `POPCLAW_*` or `OPENCLAW_*` variables are passed through.
- The configured house is a loopback HTTP stub started by the harness that
  answers 404 to everything and counts requests. There is no house session,
  subscription, DM or push.
- Network guard in every worker: `fetch` and `net.Socket.prototype.connect` refuse
  every non-loopback target and record the attempt. Four attempts to
  `canvas.popclaw.me:443` per plugin boot were refused and recorded; nothing
  else was attempted.
- A reference Gateway process on the same host (read-only `ps` only) and
  every other process were left alone. The only contact was two
  `ps -o pid,time,pcpu,etime -p <REF_PID>` snapshots of that reference process.

### Command

```
node apps/popclaw-plugin/scripts/perf/idle-cpu.mjs \
  --out <OUT_DIR> --ref-pid <REF_PID>
```

Defaults: scenarios `owner-bare,control-no-bus,control-node,owner,pair`; one
60 s warm-up window (discarded) plus 5 x 60 s windows per process; stack
sampling 1 in 20 prepares; experiments `whatif-stmt-cache,pump-suppressed,bus-timer-cleared`
(one 60 s window each, after the five main windows). Workers run with
`--expose-gc`, and a GC runs between windows, outside the timed interval, so
the heap numbers reflect reachable memory.

Exit code **0** (captured beside `<OUT_DIR>` with stdout and stderr). Raw data:
`<OUT_DIR>/run-<timestamp>/results.json`, `summary.txt`, and one log per worker.

Scenarios:

| Scenario | Instrumented | What runs |
|---|---|---|
| `owner-bare` | no | full plugin boot; the process holds the owner lease |
| `control-no-bus` | no | the same boot, then the command-bus interval is cleared right after boot (runtime composed, bus not running) |
| `control-node` | no | same worker process, guard and windows, with no plugin imported |
| `owner` | yes | full plugin boot, owner, with counters and stack sampling |
| `pair` | yes | two processes on **one** root: A boots first and owns the lease; B boots second and stays a non-owner; windows aligned |

## Results

CPU is `process.cpuUsage()` user+system delta divided by wall time for each
window, expressed as a percentage of one core.

### CPU per window (one-core %)

| Process | w1 | w2 | w3 | w4 | w5 | mean ± sd |
|---|---|---|---|---|---|---|
| owner-bare | 0.910 | 0.880 | 0.884 | 0.981 | 1.094 | **0.950 ± 0.090** |
| control-no-bus | 0.144 | 0.136 | 0.117 | 0.118 | 0.136 | **0.130 ± 0.012** |
| control-node | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | **0.000 ± 0.000** |
| owner (instrumented) | 1.109 | 1.047 | 1.056 | 1.165 | 1.042 | 1.084 ± 0.053 |
| pair A, owner (instrumented) | 1.023 | 1.005 | 0.962 | 0.996 | 1.046 | 1.006 ± 0.031 |
| pair B, non-owner (instrumented) | 0.627 | 0.616 | 0.609 | 0.592 | 0.688 | 0.626 ± 0.037 |

User and system split for owner-bare w1: 0.457 s user, 0.089 s system per 60 s.
Event-loop utilization for owner-bare is 0.009–0.014. For control-no-bus it
is 0.001.

### Attributable increments (uninstrumented processes)

The mean of the difference, with the two window SDs combined as sqrt(sd1² + sd2²):

| Increment | One-core % |
|---|---|
| Command bus running, in the composed runtime (`owner-bare − control-no-bus`) | **0.82 ± 0.09** |
| Rest of the composed plugin runtime at idle (`control-no-bus − control-node`) | 0.13 ± 0.01 |
| Whole plugin increment over a bare Node process (`owner-bare − control-node`) | **0.95 ± 0.09** |

In this composition, the command bus is about 86% of the plugin's own idle CPU.

### Rates (owner, instrumented, 5 x 60 s)

| Metric | Per second (window range) |
|---|---|
| `bus.pump()` calls (direct count) | 19.30–19.35 |
| `Database.prototype.prepare` | 154.5–155.6 (mean 155.1) |
| Statement executions (`run/get/all/iterate`) | 194.1–195.2 |
| `LocalHostDb.transaction()` wrapper constructions | 19.8 |
| Timer callbacks fired (interval + timeout + immediate) | 20.80–20.85 |
| of which: the 50 ms bus interval | 19.32 |
| `existsSync` calls (storage control files) | 189.7 (`storage-control.json` 126.5, `.restore-reservation` 63.2) |

Non-owner (pair B): pump 19.35/s, prepare 62.6/s, exec 62.6/s, no
transactions, timer callbacks 20.7/s, `existsSync` 119.8/s.

Owner (pair A): the same as the single owner within noise (prepare 155.3/s,
pump 19.35/s).

### Top SQL by prepare count (owner, instrumented, 300 s total, 46,533 prepares)

| /s | Share | SQL (normalized) | Caller, from stacks and SQL text |
|---|---|---|---|
| 63.24 | 40.8% | `SELECT name FROM sqlite_master WHERE type='table' AND name='storage_control_required_v1'` | storage guard `storageDatabasePathAllowed`, called 3 times per owner tick: from `pump`, `OwnerLease.isOwnerNow`, and `OwnerLease.isGenerationCurrent` |
| 42.54 | 27.4% | `SELECT generation, holder, renewed_at FROM house_lifecycle_owner WHERE id = 1` | `OwnerLease.readRow`, twice per tick: from `captureEpoch` and `isEpochCurrent` |
| 19.32 | 12.5% | `SELECT * FROM house_lifecycle_commands WHERE kind = 'push' AND state = 'running' AND running_epoch != ?` | bus orphan scan, inside the transaction |
| 19.32 | 12.5% | `SELECT * FROM house_lifecycle_commands WHERE (state = 'pending' OR …) ORDER BY … LIMIT 32` | bus pending scan (static form: no busy origins at idle) |
| 4.18 | 2.7% | `SELECT * FROM house_participation WHERE house_origin = ?` | gate `isActive` checks (resident / relation reception) |
| ≤0.7 each | ≤0.5% | others (relation outbox, followers, stream gaps, participation sweep) | 2 s and 5 s resident and relation timers |

`BEGIN IMMEDIATE` and `COMMIT` run 19.8/s each. They use statements that
better-sqlite3 caches for each connection, so they are not prepares.

**Measured per idle owner tick: 7 prepares** (3 storage guard, 2 owner row,
2 command queries), plus BEGIN/COMMIT, one transaction wrapper, and about 9.8
`existsSync` calls. **Per non-owner tick: 3 prepares** (2 storage guard, 1
owner row). The earlier source estimate of "at least 4 per tick, about 80/s"
did not include the storage guard. The measured bus-driven rate is about
135/s; the total rate is 155/s.

Attribution by stack sampling (1 in 20 prepares, 2,327 samples over the five
owner windows):

| Group | Share |
|---|---|
| storage guard, called from `bus.pump` | 37.8% |
| owner lease, called from `bus.pump` | 24.8% |
| command-bus SQL, called from `bus.pump` | 24.8% |
| **bus.pump total** | **87.4%** |
| resident (2 s interval) | 8.1% |
| other | 4.5% |

The `bus-timer-cleared` experiment window confirms this with no sampling:
with the bus interval cleared, prepare falls from 155/s to 20.05/s.

### JS timer callbacks

These are callbacks run by Node timers in this process, not OS or hardware
wakeups, and they say nothing about power.

Live intervals at steady state in the owner process: **8**. Exactly one is
`HouseCommandBus.start [50ms]`. The others are `OwnerLease.start [10000ms]`,
`ResidentLifecycle.start [2000ms]`, relation reception `startHost [2000ms]`, a
`[5000ms]` L1 delivery drain, and three at 30 min or 6 h. There is one
`HouseCommandBus` construction per process (the `CREATE TABLE IF NOT EXISTS
house_lifecycle_commands` prepare ran once during boot) and one `HouseRuntime`
(`house_origin_bindings` creation ran once). The non-owner has 7 intervals,
also with exactly one bus interval.

Interval callback rates (owner): bus 19.32/s, the two 2 s timers 0.50/s each,
the 5 s timer 0.20/s, and the lease renewal 0.10/s. Timeouts fire at
0.17–0.43/s: stream reconnect backoff against the 404 stub. Without the bus,
JS timer callbacks total **1.48/s**.

### Experiments (one 60 s window each, after the main windows)

| Window | owner (instrumented) | owner-bare |
|---|---|---|
| main windows, mean | 1.084 | 0.950 |
| `whatif-stmt-cache`: harness-side `prepare` cache for each connection and SQL string (probe only, not a fix) | **0.709** | n/a (needs the wrapper) |
| `pump-suppressed`: the 50 ms interval still fires; `pump` returns immediately | 0.238 | 0.352 |
| `bus-timer-cleared`: no bus interval | 0.134 | 0.169 |

What these single windows indicate:

- The pump's work, not the timer firing, dominates. Pump work is roughly
  0.60–0.85 one-core points. The 19.3 bus timer callbacks/s with no work cost
  roughly 0.10–0.18.
- Caching prepared statements alone removed about 0.37 one-core points
  (−35% of the instrumented process). The rest of the pump's cost remains:
  executions, the storage-control `existsSync` calls, and transaction wrapper
  construction.
- Each experiment is one window, so its variation is unknown. Treat these as
  direction and rough size, not as a result.

### Harness overhead

Instrumented owner 1.084 ± 0.053 versus uninstrumented owner-bare
0.950 ± 0.090: **+0.13 one-core points (about +14%)**. The instrumented pair A,
at 1.006 ± 0.031, gives +0.06. These are separate processes, so process-to-process
variance is included. All increments above use only the uninstrumented
processes.

### Resource growth across idle windows

| Process | heapUsed MB, warm-up → w5 | RSS MB | Statements alive after GC | DB handles open | Active libuv resources |
|---|---|---|---|---|---|
| owner-bare | 99.935 → 100.094 | 227 → 164 (falling) | n/a | n/a | constant (PipeWrap 3, Timeout 1) |
| control-no-bus | 99.892 → 100.064 | 305 → 199 | n/a | n/a | constant |
| owner | 101.468 → 101.517 (peak 101.663) | 285 → 236 | 0 (7 in one window, collected by the next) | 3, constant | constant |
| pair B (non-owner) | 100.240 → 100.357 | 247 → 165 | 0 | 3, constant | constant |

Heap stays flat to within 0.2 MB over six minutes, and no statement or handle
count grows with idle duration. The owner process creates about 9,300 statement
objects per minute and every one is collected. That churn is the cost, not a
leak.

The DB handle figure is corrected. The full run's worker counted the harness's
own probe connection as a close, so its raw `dbClosed` is one too high and its
raw `dbOpen` reads 2. The committed harness fixes this. The confirming run is
below.

### Stop and start leave nothing behind

Run: `node apps/popclaw-plugin/scripts/perf/idle-cpu.mjs --out <OUT_DIR>
--scenarios owner,pair --windows 1 --window-sec 10 --warmup-sec 5 --experiments ""`.
Exit code 0. Raw data: `<OUT_DIR>/run-<timestamp>/`.

After `gateway_stop` plus service `stop()`, followed by a GC, for owner, pair A
and pair B:

- 0 live intervals
- bus timer unset
- 0 open DB handles (19/19 or 26/26 opened and closed)
- 0 live statements

During the windows, 3 DB handles were open.

### Other machine load

`ps -Ao pid,pcpu,time,comm -r`, captured in `results.json` as `psBefore` and
`psAfter`.

- **Before:** fseventsd 53.5%, the reference Gateway process 26.1%, a Claude Code process 18.4%,
  a transient node 16.7%, others at 4.5% or less.
- **After:** the reference Gateway process 24.5%, a transient bun 19.0%, ChatGPT 15.1%, the Codex
  renderer 6.9%, WindowServer 6.7%, others at 4.7% or less.

Reference only: a reference Gateway process on the same host (read-only `ps` only); its cumulative CPU went from 2711:41.95 to
2719:37.24 over the 2,110 s run, which is **22.5% of one core**. That matches
the independent diagnosis (23.3–23.9%).

## Reading the numbers

1. In this composition the plugin's whole idle increment is **0.95% of one
   core**, and the command bus is 0.82 of that. The bus polls at 19.3 Hz and
   issues 7 prepares per owner tick. It dominates the plugin's own idle work.
2. The live Gateway runs at **22.5%** in the same period. That is about 24 times
   this harness's entire plugin increment. **This baseline does not reproduce
   the live level and does not show that the bus causes it.** The live-process
   facts that differ from this composition, none of which were measured here:
   - a different build (`fdd2c235`, better-sqlite3 13.0.3)
   - a connected house with live streams and real traffic
   - a large, long-lived database
   - nine days of uptime
   - OpenClaw core itself
3. prepare/s, JS timer callbacks/s and CPU are separate findings:
   - prepare: 155/s, 87% from the pump (this measured figure replaces the
     earlier source estimate of about 80/s)
   - JS timer callbacks: 20.8/s, 93% from the bus interval
   - CPU: the pump's work outweighs its timer callbacks by roughly 4 to 1 or more

## What this does NOT establish

- **The share of the real Gateway's 22–24% that the bus, or the plugin,
  accounts for.** Nothing here ran inside the reference Gateway process. Machine heat, fan or power
  behaviour cannot be attributed to the plugin either.
- **Behaviour with a connected house.** The stub refuses every request, so
  there is no session, SSE subscription, inbox, relation stream or DM. The
  CPU of those paths at "connected idle" is unmeasured. The stub's reconnect
  traffic (for example 64 `/world-feed/stream` requests in owner-bare's
  8 minutes) is inside the control-no-bus residual.
- **The live build.** The live bundle (`fdd2c235`) and its native module
  version were not measured.
- **Database size.** The databases are fresh and small. Prepare and step cost
  against the live database, WAL size, or other writers were not measured.
- **Latency.** No enqueue-to-claim, takeover or follow/DM latency was measured
  in this phase.
- **Multi-house roots and storage states.** Only the no-`storage-control.json`
  state was run (that is the path that issues the `sqlite_master` query).
  Maintenance or recovery states and several configured houses were not run.
- **The experiment windows' variation.** Each is a single 60 s window.

## Proposed budgets (fixed now, before any fix)

These are **pre-fix engineering targets for the refuse-connection fixture
only**. They do not substitute for a connected-idle budget, which is proposed
separately, from its own baseline, before any fix is judged against it
(Experiment B). They apply to: one configured house, the loopback stub, normal
storage state, zero pending commands, the same harness command, and 5 x 60 s
windows. Each metric gets its own verdict, and each verdict
requires both the absolute level and the change to clear the baseline window
variation. A percentage drop alone does not close anything.

### (a) Idle cost (uninstrumented CPU; rates from the instrumented owner)

| Metric | Baseline | Budget | Grounding |
|---|---|---|---|
| Bus CPU increment (`owner-bare − control-no-bus`) | 0.82 ± 0.09 | **≤ 0.25 one-core %**, and the post-fix mean more than 2 combined SDs below 0.82 | The no-work control is 0.13. The `pump-suppressed` window (timer fires, no work) was 0.24–0.35 whole-process. A bus that only fires its timer, with nothing to compile or scan redundantly, fits under 0.25. |
| Whole plugin increment (`owner-bare − control-node`) | 0.95 ± 0.09 | **≤ 0.40 one-core %** | The 0.25 bus budget plus the 0.13 non-bus residual, rounded up. |
| Prepare rate, owner idle | 155/s (bus 135/s) | **≤ 5/s total at steady state** | With statements cached for each connection, stable SQL compiles once per connection. Without the bus, the remainder was 20/s, all stable SQL, and it goes to near 0 once cached. |
| Prepare rate, non-owner idle | 62.6/s | **≤ 5/s** | The same reasoning applies. |
| JS timer callbacks, owner idle | 20.8/s | **Verdict held separately.** Phase 2(a) does not touch polling, so this is reported as not addressed. Any polling change (phase 2b) is not approved in this round. | — |
| Resource growth | flat heap; 0 live statements after GC; 3 DB handles | heapUsed drift ≤ 1 MB across the 5 windows; live statements after GC bounded by the cache size and not growing; DB handles constant; no new libuv resources | Measured flatness above. |

Necessary low-cost keepalives are allowed: lease renewal at TTL/3, the 2 s
resident sweep, and stream reconnect backoff. High-frequency repeated no-op
scans and recompiles are not.

### (b) Recovery and command latency

| Budget | Current behaviour (from code; not measured by this harness) | Proposed bound | Grounded? |
|---|---|---|---|
| Same-process enqueue-to-claim | `enqueue()` and `push()` call `pump()` synchronously in the same tick | **Unchanged: claimed in the same synchronous call.** No timer may sit on this path. | Yes, by code. It still needs a measured number before the fix; the harness does not measure it yet. |
| Cross-process enqueue-to-claim (non-owner enqueues, owner claims) | Measured on the unmodified candidate (phase 2(a) section): p50 24–26 ms, p99 51 ms | **This round: no regression beyond run-to-run variation against that measurement.** Phase 2(a) does not touch polling. No backoff increase is approved, and "whatever the new fallback is, that much latency is allowed" is rejected as a rule. A numeric budget is set by the architect only if a polling change is ever proposed. | Measured baseline; no product latency budget exists. |
| Owner takeover after the owner dies | `OwnerLease` TTL 30 s, renewal every 10 s (the test helper uses 3 s TTL). Takeover happens on the survivor's next renewal after expiry: a **code-derived estimate** of at most about 40 s, not a measured bound. | **No regression:** unchanged code path in this round. | Code constants only. Not measured. |
| Stop and start | Measured: 0 intervals, 0 DB handles, 0 live statements after stop | **Stays 0/0/0**, including a cleared statement cache | Yes, measured (stop check above). |

Hard constraints on any fix (restated):

- No saving by delaying follow/DM handling, or by dropping or backlogging work.
- No caching of authorization or ownership results. The owner row and storage
  guard must be read from durable state at every decision point they gate
  today.
- No cross-process notification infrastructure.
- Not approved in this round: storage-guard deduplication, caching
  authorization results, polling backoff. Permission and recovery boundaries
  are not touched to reduce this fixture's CPU.

### (c) Applicability

- **Owner and non-owner are budgeted separately.** The non-owner bus costs 3
  prepares per tick, versus 7 for the owner.
- **One configured house.** Bus cost does not depend on the number of houses
  (one bus per runtime, one pending scan per tick). The busy-origin
  `NOT IN (?,?…)` form appears only while commands are executing, so it does
  not apply at idle.
- **Normal storage state (no `storage-control.json`).** When a control file
  exists, the guard skips the `sqlite_master` query but still reads the file.
  That path was not measured.
- **Connected, subscribed idle** needs its own baseline before its budget can
  be checked. The budgets above only cover the stub-refused composition.

## Phase 2(a): statement cache in `LocalHostDb`

### Change

`d72d885b2f87fb64382c16d76f253f06b8f28e73`, one commit with its tests.

`queryOne`, `queryAll` and `execute` take compiled statements from an LRU map
held by each `LocalHostDb` instance, keyed by SQL text. The capacity is 64,
about 3 times the largest measured idle distinct-SQL count (21 per 60 s
window, process-wide). The capacity bounds the cached entries, not the number
of native statements alive: an evicted statement lives until GC collects it.

- Only compilation is reused. Each call binds its own parameters and runs the
  statement again, so no result, ownership or storage decision is cached.
- Owner-row, storage-guard and command queries run exactly as often as before.
- `close()` drops the cache, and a failing prepare caches nothing.

Tests (in `tests/unit/host/local-host-db.test.ts` and
`tests/unit/runtime/house-lifecycle-owner-lease.test.ts`) cover:
- hit and miss counts
- the LRU bound, including under 200 generated `NOT IN (?,…)` variants
- `close()` clearing the cache
- no sharing across connections
- the prepare-error and execution-error paths
- `SELECT *` picking up an `ALTER TABLE … ADD COLUMN` made on the same connection and on another connection
- `DROP` and re-`CREATE` behind a cached statement
- no read transaction left open after a single-row read (`wal_checkpoint(TRUNCATE)` reports `busy = 0`)
- owner authority still read fresh through a cached statement after another connection takes over

Focused run: 4 files, 38 tests, all pass. With the cache lookup disabled, 6 of
them fail (mutation check).

### Method

The same harness and fixture, with `--experiments ""`. Uninstrumented
processes (natural GC) decide the CPU budgets. Instrumented processes (forced
GC between windows) give the rates and the live-object and handle checks.

| | Run | Tree | Bundle sha256 |
|---|---|---|---|
| Before | `<OUT_DIR>/run-<timestamp>/`, 09:40–10:05Z, exit 0 | `98335770` (product code = `253a2db0`) | `badcb5b6…402d5` |
| After | 10:05–10:42Z, exit 0 | `d72d885b` | `d918a4bd…9b50a5` |

The instrumented "before" figures are the phase-1 owner and pair runs above,
which used the same forced-GC method.

### Uninstrumented CPU (one-core %, 5 x 60 s, natural GC)

| Process | Before, per window | Before, mean ± sd | After, per window | After, mean ± sd |
|---|---|---|---|---|
| owner-bare | 0.957 1.186 0.893 1.117 0.882 | 1.007 ± 0.137 | 0.841 0.533 0.789 0.543 0.585 | **0.658 ± 0.146** |
| control-no-bus | 0.410 0.093 0.345 0.123 0.141 | 0.222 ± 0.144 | 0.468 0.133 0.376 0.123 0.227 | 0.265 ± 0.152 |
| control-node | 0.002–0.003 | 0.002 | 0.001–0.002 | 0.001 |
| pair-bare A (owner) | 1.233 0.820 1.103 0.914 0.866 | 0.987 ± 0.175 | 0.844 0.556 0.830 0.554 0.612 | 0.679 ± 0.146 |
| pair-bare B (non-owner) | 0.930 0.497 0.747 0.569 0.552 | 0.659 ± 0.178 | 0.696 0.382 0.625 0.352 0.401 | **0.491 ± 0.158** |

| Increment | Before | After |
|---|---|---|
| Bus (`owner-bare − control-no-bus`) | 0.785 ± 0.199 | **0.393 ± 0.211** |
| Whole plugin, owner (`owner-bare − control-node`) | 1.005 ± 0.137 | **0.657 ± 0.146** |
| Whole plugin, non-owner (`pair-bare B − control-node`) | 0.657 ± 0.178 | 0.490 ± 0.158 |

With natural GC the per-window spread is larger than in phase 1, because GC
now lands inside windows. For owner-bare, every "after" window is below every
"before" window. The means differ by 0.35, about 1.7 combined SDs.

### Instrumented (forced GC between windows)

| Metric (5 x 60 s) | Before | After |
|---|---|---|
| owner CPU, one-core % | 1.084 ± 0.053 | 0.737 ± 0.047 |
| pair A (owner) CPU | 1.006 ± 0.031 | 0.775 ± 0.028 |
| pair B (non-owner) CPU | 0.626 ± 0.037 | 0.536 ± 0.037 |
| owner prepare/s | 155.1 | **0** in every window |
| non-owner prepare/s | 62.6 | **0** in every window |
| owner statement executions/s | 195 | 195–198 (unchanged, as intended) |
| owner pump ticks/s | 19.3 | 19.4–19.6 |
| owner JS timer callbacks/s | 20.8 | 20.9–21.2 (not addressed) |
| owner `existsSync`/s | 190 | 194 (unchanged: storage guard untouched) |
| statements alive after GC | 0 (compiled per call) | owner 142, non-owner 56, constant across windows (cached, bounded) |
| statements compiled since boot | grows ~9,300/min | 642 at every window: no compile at idle |
| DB handles open | 3 | 3, constant |
| heapUsed after GC, first → last window | 101.47 → 101.52 MB | 101.35 → 101.54 MB (non-owner 100.29 → 100.38) |
| after stop: intervals / DB handles / live statements | 0 / 0 / 0 | 0 / 0 / 0 |

### Cross-process enqueue-to-claim

Scenario `latency`: two uninstrumented processes on one root. The non-owner
enqueues 400 `status` probes at random 100–400 ms gaps. The owner records the
time from the row's `created_at` to its claim. Same-process: 100 probes
enqueued by the owner itself. Three runs each; all exit 0.

| | p50 (ms) | p90 | p99 | max | Same-process p50 / p99 / max |
|---|---|---|---|---|---|
| Before, 3 runs | 26, 26, 24 | 46, 46, 46 | 51, 51, 51 | 301, 66, 55 | 0 / 1–3 / 1–181 |
| After, 3 runs | 26, 27, 24 | 47, 47, 45 | 51, 51, 51 | 61, 76, 52 | 0 / 1 / 1–2 |

**No regression.** p50 and p99 are within the before-run spread. The single
301 ms and 181 ms "before" maxima are one-off outliers.

### Verdicts (each metric on its own)

| Budget (refuse-connection fixture, pre-fix engineering target) | After | Verdict |
|---|---|---|
| Bus increment ≤ 0.25 one-core %, and more than 2 combined SDs below before | 0.393 ± 0.211; drop 0.39 = 1.35 combined SDs | **MISSED** (both parts) |
| Whole plugin increment ≤ 0.40 | 0.657 ± 0.146 | **MISSED** |
| Prepare ≤ 5/s, owner | 0/s | **MET** |
| Prepare ≤ 5/s, non-owner | 0/s | **MET** |
| Heap drift ≤ 1 MB across windows (forced-GC runs) | +0.19 MB owner, +0.09 MB non-owner | **MET** (short-window stability only) |
| Live statements and handles bounded, not growing | 142 / 56 statements, 3 handles, constant | **MET** |
| Stop leaves 0 intervals / 0 handles / 0 statements | 0 / 0 / 0 | **MET** |
| Cross-process enqueue-to-claim: no regression | p50 24–27, p99 51 (before 24–26, 51) | **MET** |
| JS timer callbacks | ~21/s | **Not addressed** (polling unchanged by design) |

The budgets are not retuned. On the forced-GC method the drop is clear:
1.084 → 0.737, no overlap between windows. But that method is not the one the
budget names.

What remains in the bus after the cache is 19.6 ticks per second of:
- 7 statement executions
- BEGIN/COMMIT
- one transaction wrapper construction
- about 10 `existsSync` calls
- the timer callback itself

Reducing any of these needs one of the options this round does not approve:
storage-guard deduplication, a polling change, or transaction-wrapper reuse.
The last is not an authorization change but was not in scope.

## Experiment A: the live bundle, read-only copy

**Not run.** A read-only listing of the in-service extension directory was
refused by this session's permission policy. The denial stands; nothing was
read, copied or hashed, and it was neither retried nor routed around. Denial
text:

> Permission for this action was denied by the Claude Code auto mode
> classifier. Reason: [Production Reads].

**Read access requested, one batch, read-only.** Code, native dependencies,
migrations and package descriptors only. No config, identity, database, token
or data-root path.

| Path | Needed for |
|---|---|
| `~/.openclaw/extensions/popclaw/dist/bundled/` | the in-service bundle (`index.js`; sha256 must still be `828826e2664ad6de3898a8de58d3478d8fc11adc8e2e59f803db9a3439624afe`, checked before and after the copy) and its build stamp (`fdd2c235`) |
| `~/.openclaw/extensions/popclaw/dist/native-deps/` | its vendored `better-sqlite3` (13.0.3), `bindings`, `file-uri-to-path` |
| `~/.openclaw/extensions/popclaw/migrations/`, `~/.openclaw/extensions/popclaw/wallet-migrations/` | schema files the bundle applies when it boots a fresh root |
| `~/.openclaw/extensions/popclaw/package.json`, `~/.openclaw/extensions/popclaw/openclaw.plugin.json` | package and version descriptors |

**Purpose.** Copy these files into
`<temporary-work-directory>/perf/live-copy/`, then run the same
two fixtures with `--plugin-root <copy>`, using the same `openclaw` SDK as the
candidate so the SDK is held constant. Record source and copy hashes, the
build stamp, and the Node and SQLite versions of both suites.

Nothing is installed, built or written in the original directory. A
difference in the result would describe the version suite (`fdd2c235` with
better-sqlite3 13.0.3, against `253a2db0` with 12.11.1). It would not be
attributed to either component alone.

## Experiment B: connected idle (loopback lore-house)

### Fixture

- **House.** One lore-house, built from `4e4598c9` (the deploy tree of the
  running houses; `cargo build -p lore-house`, debug) in a separate private
  worktree.
- **House configuration.** Bound to 127.0.0.1 on a free port with its own
  scratch config file. The repo config, which points at the shared cluster,
  was never read.
- **House database.** A task-dedicated PostgreSQL 16 instance (own data
  directory, own port and socket, loopback only). The shared cluster was not
  touched.
- **House binding.** Established by the house itself: a random signing key
  held in the process environment only, `POPCLAW_HOUSE_ORIGIN`, and an
  incarnation. The house reports `outcome=FirstClaim` and relations `Ordered`.
- **Plugin.** Configured with `lore_houses = [<that origin>]`. Each scenario
  generates a fresh identity. After boot plus a 30 s settle, the plugin
  reports that house as `phase: connected` with world and inbox streams
  `active`, and 3 TCP sockets stay open throughout. There is no house session
  (`sessionId` empty, as with the official houses) and no pending work.
- **Network.** The guard still refuses everything that is not loopback. Only
  the same 3–4 `canvas.popclaw.me:443` attempts per boot were refused.
- **Harness.** The same harness with `--houses <origin> --settle-sec 30`.
  Plugin roots are two staged bundles that differ only in
  `local-host-db.ts`:
  - before: sha256 `621554c4…1d3c`, stamp `d72d885b-dirty` with that file reverted to `253a2db0`
  - after: `d918a4bd…9b50a5`

  Paired processes hold after their last window until all processes in the
  scenario are done, so no lease handover lands inside a window. That hold
  was added after the first connected run, where the non-owner took over
  inside its own w5.

**Discarded runs (contaminated).** Two other agents ran full test suites on
this host, at about 11:27–11:33Z and about 11:40–12:10Z. The connected runs
started 11:28:47Z (before) and 12:01:36Z (after) overlapped them. Both were
stopped and discarded; their output directories are prefixed
`CONTAMINATED-`. Each window now records its UTC bounds and the host's busy
cores outside the measured process ("host other load"). The idle host shows
about 1.1–1.8 of 6 cores, so a test suite shows up in the data.

The clean runs below ran on a second instance of the same house build
(fresh database), 12:16–13:22Z, exit 0.

### First connected run (superseded)

`<OUT_DIR>/run-<timestamp>/`, 10:55–11:22Z, exit 0. This run's figures were
used to write the budget below:
- owner-bare 0.860 ± 0.084
- control-no-bus 0.108 ± 0.039
- bus increment **0.752 ± 0.093**
- owner instrumented 1.026 ± 0.014, prepare 154.6/s

The clean before/after further down supersedes it. All figures are one-core %.

**Reading.** Connected idle costs about the same as the refuse-connection
fixture. With one house, open world and inbox streams and a 15 s house
heartbeat, the streams add nothing measurable. This fixture does **not**
reproduce the live Gateway's roughly 22%, so the two-house run was not
triggered (the architect has since deferred it).

### Proposed connected-idle budget (written before the "after" run)

The numeric targets are the same as for the refuse fixture. The residual
without the bus (0.108) is no higher here, so there is no ground for a
looser target and none for a stricter one.

| Metric | Before | Budget |
|---|---|---|
| Bus increment (`owner-bare − control-no-bus`) | 0.752 ± 0.093 | ≤ 0.25 one-core %, and more than 2 combined SDs below before |
| Whole plugin (`owner-bare − control-node`) | ~0.86 | ≤ 0.40 |
| prepare/s, owner and non-owner | 154.6 / (re-run) | ≤ 5 |
| Heap drift, forced-GC runs | +0.2 MB | ≤ 1 MB |
| Live statements and handles | 0 / 3 | bounded, constant |
| After stop | 0 / 0 / 0 | 0 / 0 / 0 |
| Connection preserved (functional) | owner world and inbox `active` at start and end; non-owner stays non-owner in every window | unchanged |
| JS timer callbacks | 20.9/s | not addressed this round |

### Clean connected before/after, one house (5 x 60 s)

| Process | Before, per window | Before, mean ± sd | After, per window | After, mean ± sd |
|---|---|---|---|---|
| owner-bare | 0.816 0.787 0.782 0.825 0.902 | 0.822 ± 0.048 | 0.598 0.583 0.575 0.557 0.587 | **0.580 ± 0.015** |
| control-no-bus | 0.144 0.244 0.195 0.158 0.217 | 0.192 ± 0.041 | 0.067 0.076 0.055 0.063 0.094 | 0.071 ± 0.015 |
| pair-bare A (owner) | 0.798 0.764 0.793 0.754 0.774 | 0.777 ± 0.019 | 0.577 0.556 0.556 0.555 0.583 | 0.565 ± 0.014 |
| pair-bare B (non-owner) | 0.794 0.484 0.787 0.479 0.521 | 0.613 ± 0.163 | 0.698 0.353 0.614 0.357 0.375 | 0.479 ± 0.164 |
| owner (instrumented) | 1.039 1.025 1.040 1.007 1.048 | 1.032 ± 0.016 | 0.669 0.641 0.639 0.644 0.660 | 0.651 ± 0.013 |
| pair B (instrumented) | | 0.690 ± 0.109 | | 0.449 ± 0.025 |

Host other load ran 1.1–2.3 cores in all windows, except the "before"
control-no-bus at 2.2–3.8 cores. That control may be inflated, which would
make the "before" bus increment look smaller.

Bundle sha256: before `621554c4…`, after `d918a4bd…`.

| Metric | Before | After |
|---|---|---|
| Bus increment | 0.630 ± 0.063 | 0.509 ± 0.021 |
| Whole plugin, owner (`owner-bare − control-node`, control-node 0.001–0.003) | ~0.82 | ~0.58 |
| Prepare/s, owner / non-owner | 153 / 63 | **0 / 0** |
| Statement executions/s, owner | 193 | 194 |
| JS timer callbacks/s | 20.7 | 20.9 |

Resource and state checks, after:
- Heap after GC across the windows: 101.24 → 101.55 MB (owner), 99.73 → 99.74 MB (non-owner).
- Statements: 142 (owner) and 55 (non-owner), constant. DB handles: 3.
- Owner world and inbox streams `active` at start and end.
- Non-owner stayed non-owner in every window.

After stop:
- 0 intervals and 0 open DB handles.
- 8–198 JavaScript statement objects not yet collected at the snapshot (both
  before and after the fix). The connections are closed, which finalizes
  their native statements, so this is GC timing, not a leak.

### Verdicts, connected idle (budget as proposed above)

| Budget | After | Verdict |
|---|---|---|
| Bus increment ≤ 0.25, and more than 2 combined SDs below before | 0.509 ± 0.021 | **MISSED** |
| Whole plugin ≤ 0.40 | ~0.58 | **MISSED** |
| Prepare ≤ 5/s, owner and non-owner | 0 / 0 | **MET** |
| Heap drift ≤ 1 MB (forced GC) | +0.31 MB | **MET** (short-window stability only) |
| Statements and handles bounded, constant | 142 / 55; 3 | **MET** |
| After stop: intervals / handles / statements | 0 / 0 / uncollected wrappers only | **MET** for intervals and handles; statement count **inconclusive** by GC timing, unchanged from before |
| Connection preserved | yes | **MET** |
| JS timer callbacks | 20.9/s | **Not addressed** |

## Transaction-wrapper reuse (measured, not adopted)

### Change tried

One better-sqlite3 transaction function per `LocalHostDb` connection,
created on first use. Every `transaction(fn)` call passes its own `fn` and
the connection as arguments to `.immediate(...)`, so no callback or state is
shared between calls. It keeps BEGIN IMMEDIATE, nested savepoints, return
values, exceptions and close behaviour.

It was tested but not committed:
- Focused tests: 45 pass. They covered each call running its own callback,
  rollback that rethrows the same error, nested savepoint and outer rollback,
  IMMEDIATE (another writer cannot take the lock inside the callback; a
  `.deferred(...)` mutation fails this), a promise-returning callback refused
  and rolled back, and refusal after close.
- Bundle sha256 `92a3d5ef…`.

### Measurement

Refuse-connection fixture, 5 x 60 s. Before = the statement-cache bundle
(`d918a4bd…`). 13:23–14:00Z, both runs exit 0.

| | Cache only | Cache + wrapper reuse |
|---|---|---|
| owner-bare (uninstrumented) | 0.688 ± 0.084 | 0.647 ± 0.102 |
| control-no-bus | 0.201 ± 0.158 | 0.215 ± 0.151 (host other load 2.1–4.2 cores) |
| owner (instrumented) | 0.707 ± 0.018 | 0.668 ± 0.027 |
| Transaction wrappers built/s | 19.85 | 0 (one per connection) |
| Statement executions/s | 195 | 196 |

The difference is about −0.04 one-core points in both processes. That is
about 0.3 combined SDs uninstrumented and 1.2 instrumented, so it is **not a
real increment at this precision**. Per the ruling, the code was left
unchanged; the change is kept only as a scratch copy outside the repo.

## Live Gateway A/B plan (for the architect; NOT approved, not run)

### Target and question

**Target.** The in-service Gateway on this host:
- a `node … openclaw … gateway --port 18789` process
- state root `~/.openclaw`
- effective config `~/.openclaw/openclaw.json`
- Popclaw enabled through its plugin entry
- the loaded Popclaw build is `fdd2c235`

**Question.** How much of that process's roughly 22% of one core goes away
when only Popclaw is disabled, compared on processes of the same age.

### Procedure

Run by the owner, in an agreed maintenance window.

0. **Preconditions.**
   - Owner approval.
   - Contacts told that messages in the window may be delayed.
   - A read-only (`mode=ro`) count shows 0 pending or running rows in
     `house_lifecycle_commands`.
   - No outbound message in flight.
   - No MCP or CLI process on the same root (otherwise it could take the
     owner lease while Popclaw is off).
1. **A0, untouched.** Five 60 s windows of `ps -o time` deltas on the
   Gateway PID.
2. **Backup.** Copy `openclaw.json` to a dated backup and record its sha256.
3. **Disable.** Turn off only the Popclaw plugin entry through the owner's
   normal config path, then `openclaw gateway restart`.
4. **B, Popclaw off.** Wait 5 minutes, then five 60 s windows on the new PID.
5. **Restore.** Copy the backup bytes back, check that the sha256 matches
   step 2, then `openclaw gateway restart`.
6. **A1, Popclaw on, fresh process.** Wait 5 minutes, then five 60 s windows.

**Reading.** The Popclaw share is `A1 − B`: both are fresh processes of the
same age. `A0 − A1` isolates the restart and uptime effect (warm-up, a
9-day-old heap). Each difference must be compared with the window spread.

### Expected interruption

- Two Gateway restarts, each seconds long. The send path is ready 2–5 s
  before the listener.
- About 12–15 minutes with Popclaw disabled (warm-up plus windows).
- Agent turns in flight at a restart are interrupted.

### Loss and delay risks

- **Outbound WhatsApp message.** A restart can silently drop one in-flight
  outbound message. This was observed twice on 2026-09-16 and is still an
  open defect.
- **Popclaw traffic while it is off.** DMs, follows and world events are not
  received or notified. They stay at the house and should arrive when the
  stream cursors resume after re-enable, but that is unverified for this
  build. Owner-facing notifications (the durable L1 queue) are delayed by
  the window.
- **Owner lease.** Another process on the same root could take the owner
  lease while Popclaw is off. The precondition above excludes that.
- **Restart as a confounder.** Handled by comparing with A1, not A0.

### Verification after restore

- The `openclaw.json` sha256 equals the backup's.
- A new Gateway PID is running with the same command line.
- The Gateway log shows `popclaw: identity loaded (restored existing key)`
  with the same `popclaw_id` as before, and no `NEW IDENTITY` line.
- The build stamp is still `fdd2c235`.
- The house is connected, with world and inbox streams active (read-only
  status).
- `house_lifecycle_commands` has 0 pending or running rows.
- One owner-approved follow or DM round trip succeeds.

## Conclusions for this round

- **Confirmed.** The repeated SQL compilation at idle is removed: 155 → 0
  prepares/s for the owner and 62.6 → 0 for the non-owner. There was no
  latency regression, no growth, and stop still leaves nothing behind.
- **Not confirmed.** The CPU targets were missed in the refuse-connection
  fixture (bus 0.393, whole plugin 0.657). They are not relaxed, and the
  performance item stays open.
- **Live level.** The new candidate's isolated fixtures do not reproduce the
  live level. The in-service build, real data and host combination are
  unchecked, so live attribution remains open.

## Reproducing

```
cd <worktree root>
pnpm install --frozen-lockfile
pnpm --dir protocol install --frozen-lockfile --ignore-scripts
(cd apps/popclaw-plugin && POPCLAW_NATIVE_DEPS_MINIMAL=1 pnpm run build:bundle)
node apps/popclaw-plugin/scripts/perf/idle-cpu.mjs --out <scratch dir>
```

About 36 minutes. `results.json` (also on stdout) is the machine-readable
record. `summary.txt` and stderr carry the human summary.
