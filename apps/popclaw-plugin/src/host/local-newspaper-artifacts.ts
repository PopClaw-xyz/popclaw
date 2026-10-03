/** Local newspaper artifacts: archived editions, the latest copy and the dispatch ledger. */
import {
  appendFileSync,
  existsSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import type { NewspaperIssueArchive } from '../newspaper/newspaper-artifacts.js';
import type { NewspaperDispatchRecord } from '../newspaper/dedicated-session.js';

/**
 * How long an issue stays in the archive. **Fixed, not a knob**: the value the
 * owner would actually tune is "keep the paper", and that is already the whole
 * design — this only stops a machine that publishes daily from carrying an
 * unbounded pile of 2MB pages forever.
 *
 * The dispatch ledger below sweeps on the SAME window: one retention policy for everything
 * the newspaper leaves on disk, not two that drift.
 */
export const ISSUE_RETENTION_DAYS = 14;

// ---------------------------------------------------------------------------
// The dispatch ledger — what every newspaper run actually produced
// ---------------------------------------------------------------------------

/**
 * A failed run used to leave one line in the container's volatile log and nothing else
 * (2026-09-13: both workshop pages arrived truncated, the writer could not read the body
 * text to quote its anchors, the run ended with no publish receipt, and the only trace was
 * `popclaw: newspaper dispatch failed (ok)` in a log that dies with the container). A
 * failure rate nobody can count is a failure rate nobody fixes, so every outcome — the
 * published ones included, or there is no denominator — is appended here.
 *
 * JSONL, not a table: this lands during a release freeze and a new sqlite migration is
 * schema risk the diagnosis does not need. One line per dispatch, `grep`-able as it stands,
 * in the newspaper data directory beside the `issues/` archive.
 *
 * This host module owns the newspaper's on-disk artifacts and their retention policy;
 * publication and dispatch orchestration depend on it without owning filesystem IO.
 *
 * Two contracts:
 *   · **It can never cost the owner a paper.** Every IO path is wrapped; a failure is logged
 *     through the injected logger and swallowed. The caller wraps it a second time.
 *   · **It never grows without bound.** Records past `ISSUE_RETENTION_DAYS` are dropped, on the
 *     same write-path schedule `sweepOldIssues` runs on — but only on the appends that
 *     actually have something to drop. The ordinary append adds one line and rewrites
 *     nothing: this ledger exists to record the runs that die, and a file rewritten on every
 *     append is a file that can lose its whole history to exactly such a death.
 */
const DISPATCH_LOG_FILE = 'dispatches.jsonl';

/** `<newspaperDir>/dispatches.jsonl` — beside `issues/`, not inside it. */
export function dispatchLogPath(newspaperDir: string): string {
  return join(newspaperDir, DISPATCH_LOG_FILE);
}

/**
 * The records still inside the retention window, as raw lines, or `undefined` when there is
 * no ledger on disk yet.
 *
 * A line whose `at` cannot be read is DROPPED rather than kept: it carries no fact anybody
 * can use, and keeping it would be the one way this file could grow forever.
 */
function keptDispatchLines(file: string, nowMs: number): string[] | undefined {
  const cutoff = nowMs - ISSUE_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  let raw: string;
  try {
    raw = readFileSync(file, 'utf-8');
  } catch {
    return undefined; // no ledger yet — the common case on a fresh machine
  }
  return raw.split('\n').filter((line) => {
    if (!line.trim()) return false;
    try {
      const at = (JSON.parse(line) as { at?: unknown }).at;
      return typeof at === 'string' && Date.parse(at) >= cutoff;
    } catch {
      return false;
    }
  });
}

/** Drop every record past the retention window. Best-effort, exactly like `sweepOldIssues`. */
export function sweepDispatchLog(newspaperDir: string, nowMs: number = Date.now()): void {
  try {
    const file = dispatchLogPath(newspaperDir);
    const kept = keptDispatchLines(file, nowMs);
    if (kept === undefined) return; // nothing on file — never create one just to sweep it
    writeFileSync(file, kept.length ? `${kept.join('\n')}\n` : '', 'utf-8');
  } catch {
    /* unwritable — housekeeping must never cost the owner the paper it keeps house for */
  }
}

/**
 * The timestamp of the oldest readable record, or `undefined` when there is nothing on file.
 * Records are appended in time order, so the first line bounds the whole ledger — a head line
 * that cannot be read reports `0`, which is simply "sweep me".
 */
function oldestDispatchRecordAt(file: string): number | undefined {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf-8');
  } catch {
    return undefined;
  }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const at = (JSON.parse(line) as { at?: unknown }).at;
      if (typeof at === 'string') {
        const t = Date.parse(at);
        if (Number.isFinite(t)) return t;
      }
    } catch {
      /* unreadable head line — fall through to 0 so the sweep drops it */
    }
    return 0;
  }
  return undefined;
}

/**
 * Append one dispatch outcome, then drop anything past retention — in that order, and the
 * second step only when there is something to drop.
 *
 * The append stands alone on purpose. Re-writing the whole file around each new record puts
 * every earlier record at risk on every write, and the events this ledger is kept for are
 * precisely the ones where the process does not survive the paper.
 */
export function recordNewspaperDispatch(
  newspaperDir: string,
  record: NewspaperDispatchRecord,
  opts: { now?: number; log?: (m: string) => void } = {},
): void {
  try {
    const now = opts.now ?? Date.now();
    mkdirSync(newspaperDir, { recursive: true });
    const file = dispatchLogPath(newspaperDir);
    appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf-8');
    const oldest = oldestDispatchRecordAt(file);
    if (oldest !== undefined && oldest < now - ISSUE_RETENTION_DAYS * 24 * 60 * 60 * 1000) {
      sweepDispatchLog(newspaperDir, now);
    }
  } catch (err) {
    // info, never warn: an MCP host swallows warn and error entirely.
    opts.log?.(`popclaw: newspaper dispatch record not written (non-fatal) — ${String(err)}`);
  }
}

/** Every record currently on file, newest last. Diagnostics and tests only. */
export function readDispatchLog(newspaperDir: string): NewspaperDispatchRecord[] {
  const out: NewspaperDispatchRecord[] = [];
  let raw: string;
  try {
    raw = readFileSync(dispatchLogPath(newspaperDir), 'utf-8');
  } catch {
    return out;
  }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as NewspaperDispatchRecord);
    } catch {
      /* one unreadable line is not worth losing the rest */
    }
  }
  return out;
}

/** `<YYYYMMDD-HHmmss>-<issue id>.html`, in local time — sortable, and legible to a human `ls`. */
function issueFileName(token: string, now: Date): string {
  const p2 = (n: number): string => String(n).padStart(2, '0');
  const stamp =
    `${now.getFullYear()}${p2(now.getMonth() + 1)}${p2(now.getDate())}` +
    `-${p2(now.getHours())}${p2(now.getMinutes())}${p2(now.getSeconds())}`;
  // The token is ours (`tok_…` / `c…`), but it reaches here from the agent's
  // hand-in, so it is never spliced into a path unsanitized.
  const id = token.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64) || 'issue';
  return `${stamp}-${id}.html`;
}

/**
 * Where this issue's archive copy goes — never a path that is already taken.
 *
 * The stamp was minute-resolution until 2026-09-12, and the name also carries the
 * issue id, so republishing the same issue inside one minute wrote the same name
 * twice and the second page silently ate the first. The archive is the record of
 * what was published; a republish must be able to add to it but never to erase
 * from it. Seconds settle nearly every case, and the `-2`, `-3`… suffix settles
 * the rest (two publishes inside one second) without ever reusing a name.
 *
 * `last-newspaper.html` is untouched by this: it is the always-the-latest copy and
 * is meant to be overwritten every time. This exists-then-write check protects
 * sequential saves; it does not provide atomic protection between concurrent writers.
 */
function issuePath(dir: string, token: string, now: Date): string {
  const base = issueFileName(token, now);
  let path = join(dir, base);
  for (let n = 2; existsSync(path); n += 1) path = join(dir, `${base.slice(0, -'.html'.length)}-${n}.html`);
  return path;
}

/**
 * Drop archived issues older than the retention window. Best-effort by contract,
 * exactly like `sweepStaleIssues`: a directory we cannot read or a file we cannot
 * stat is skipped, never thrown. Housekeeping must not be able to cost the owner
 * the paper it is housekeeping for.
 */
function sweepOldIssues(dir: string, nowMs: number): void {
  const cutoff = nowMs - ISSUE_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  try {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.html')) continue;
      const f = join(dir, name);
      try {
        if (statSync(f).mtimeMs < cutoff) rmSync(f, { force: true });
      } catch {
        /* one unreadable file is not worth a failed publish */
      }
    }
  } catch {
    /* no archive yet / unreadable directory — nothing to sweep */
  }
}

/**
 * Create the local archive capability without IO. Saving writes the master copy and
 * returns a handle to that same edition. **Throws** on failure, and that is
 * the point: everything downstream (the social-log row, the author set, the
 * upload) is a statement that the paper exists, so none of it may run if the file
 * did not get written.
 *
 * `last-newspaper.html` is kept alongside as the always-the-latest convenience
 * copy — the path the guides, the docs and the owner's muscle memory already name.
 */
export function createLocalNewspaperIssueArchive({
  issuesDir,
  lastNewspaperHtml,
}: {
  issuesDir: string;
  lastNewspaperHtml: string;
}): NewspaperIssueArchive {
  return {
    save({ token, html, nowMs }) {
      mkdirSync(issuesDir, { recursive: true });
      const file = issuePath(issuesDir, token, new Date(nowMs));
      writeFileSync(file, html, 'utf-8');
      mkdirSync(dirname(lastNewspaperHtml), { recursive: true });
      writeFileSync(lastNewspaperHtml, html, 'utf-8');
      sweepOldIssues(issuesDir, nowMs);
      return {
        path: file,
        rewrite(html) {
          writeFileSync(file, html, 'utf-8');
          writeFileSync(lastNewspaperHtml, html, 'utf-8');
        },
      };
    },
  };
}
