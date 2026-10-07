/**
 * publishToken → the whole issue, shared between the popclaw_newspaper (gather)
 * and popclaw_publish_newspaper (render + publish) tools.
 *
 * Before v0.2 this held only an allowlist of the links the agent was permitted to
 * cite, because the agent rendered the page itself. Now the **page** is rendered
 * here, so what has to survive between the two tool calls is the issue's whole
 * material — every item, person, letter, mantel and figure. The renderer never
 * goes back to the database, which is also what lets the offline harness
 * reproduce a real issue exactly.
 *
 * **On disk, not in-process memory** (slice H, real-machine incident 2026-07-31):
 * that day host-a's main agent delegated publishing the daily paper to a
 * **subagent** (`sessionKey=agent:main:subagent:…`, with three concurrent sessions
 * at the time), so gathering the materials and publishing landed in two different
 * plugin contexts. The ledger back then was a module-level Map, so the lookup was
 * bound to miss, and the agent kept reporting "token expired" — even for a token
 * it had just received. Disk is the only ledger that's reliable across
 * processes/sessions.
 *
 * The in-memory Map stays as a deliberate same-process fast path (zero disk reads
 * when gather and publish share a process). The disk tier is wired everywhere
 * register-tools runs (both tools pass `dir: rt.paths.newspaperManifestsDir()`);
 * the `dir?` fallback to memory-only behavior remains only for older test rigs —
 * an honest degradation, never let a paper fail to publish just because the
 * ledger isn't wired.
 */
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { todayDateLabel, type IssueData } from './issue.js';
import type { NewspaperEdit } from './render-newspaper.js';
import { isCandidateId } from './issue-identity.js';

/**
 * How many issues the same-process fast path keeps. Was 64 when an entry was a
 * list of links; an entry is now the whole issue (≈100KB of JSON on a busy day),
 * and gather→publish is a single pass, so a handful is plenty — the disk tier is
 * what actually carries a token across processes.
 */
const MAX = 8;
/** A ledger entry lives at most 2 hours — render+publish should complete in one pass; two hours is slack for "the owner stepped away mid-task". */
const TTL_MS = 2 * 60 * 60 * 1000;
const store = new Map<string, StoredIssue>();

/** The token doubles as a filename → only these characters are accepted; `/` and `..` are never let through. */
const SAFE_TOKEN = /^[A-Za-z0-9_-]{1,64}$/;

function fileOf(dir: string, token: string): string | null {
  return SAFE_TOKEN.test(token) ? join(dir, `${token}.json`) : null;
}

/** What it looks like on disk. `created_at` is the sole basis for TTL. */
interface StoredIssue {
  issue?: IssueData;
  /**
   * The copy handed in so far, when one issue is being written a batch at a time.
   * Absent until the first hand-in leaves something unwritten. It rides in the same
   * file as the issue on purpose: a second batch is only meaningful against the
   * exact materials the first one was numbered from.
   */
  edit?: NewspaperEdit;
  created_at?: number;
  /**
   * The session this issue's page was SERVED to (gather for candidates, the picks
   * call for issues — both carry `toolCtx.sessionKey`). The same-batch constraint
   * (2026-09-06 content-mismatch P1): a tokenless bind may only reach an issue this
   * very session was handed, because `edit.items`'s numbers mean the numbering of
   * the page the writer is looking at — binding another session's issue puts every
   * summary under somebody else's name. Absent = written before the field existed
   * (old files, test rigs with no session): bindable only by an equally unstamped
   * caller, never across the stamp boundary.
   */
  servedSession?: string;
  /**
   * The candidate page this issue was picked from (2026-09-12). One candidate page
   * can mint several material pages — a real host minted four from one `ctok_` in
   * 92 seconds — so the child records its parent and never the other way round.
   *
   * It exists for one job: a hand-in that carries the CANDIDATE id where the
   * material page's id belongs can still be bound, without guessing, because the
   * issue itself says which candidate page it descends from. Absent on issues
   * written before this field existed (and on candidate pages, which have no parent).
   */
  fromCandidate?: string;
}

/**
 * Sweep expired files while we're at it. Judged by mtime (write time), **not**
 * by parsing every JSON file just to sweep once.
 * ponytail: full-directory readdir — this directory normally holds a handful of
 * files, capped at a few ledgers per day, that's fine; revisit if it ever grows
 * enough to need sharding.
 */
function sweep(dir: string, now: number): void {
  try {
    for (const name of readdirSync(dir)) {
      const f = join(dir, name);
      try {
        if (now - statSync(f).mtimeMs > TTL_MS) rmSync(f, { force: true });
      } catch {
        /* Couldn't touch this one file this pass — skip it, don't let it block the rest */
      }
    }
  } catch {
    /* Directory doesn't exist yet / unreadable — just skip the sweep */
  }
}

/**
 * The ONE liveness rule, both tiers: entry age is measured from `created_at` (when the
 * materials were minted), never from mtime — `putEdit` bumps mtime on purpose so a
 * parked batch's file stays findable, and "the owner stepped away mid-task" must not
 * refresh the clock. One helper, not two hand-kept copies: the memory tier skipped this
 * check entirely before 2026-09-06, and a long-lived process could hand a same-day issue
 * from hours ago to the tokenless binder.
 */
const expired = (createdAt: number | undefined, now: number): boolean => now - (createdAt ?? 0) > TTL_MS;

/** Read one ledger entry. Unreadable, corrupt JSON, expired — all treated as absent, never thrown. */
function readIssueFile(f: string): StoredIssue | undefined {
  try {
    const raw = JSON.parse(readFileSync(f, 'utf-8')) as StoredIssue;
    if (!raw.issue || !Array.isArray(raw.issue.pulse)) return undefined;
    if (expired(raw.created_at, Date.now())) return undefined;
    return raw;
  } catch {
    return undefined;
  }
}

/** One ledger entry, memory tier first, then disk. */
function entryOf(token: string, dir?: string): StoredIssue | undefined {
  const hit = store.get(token);
  if (hit) {
    // Same rule as the disk tier (`expired`), enforced here too. No disk fall-through
    // on expiry: `putIssue` stamps both tiers with the same `created_at`, so if the
    // memory copy is expired, any file copy is too.
    if (expired(hit.created_at, Date.now())) {
      store.delete(token);
      return undefined;
    }
    return hit; // Fast path: no disk read needed within the same process
  }
  const f = dir ? fileOf(dir, token) : null;
  return f ? readIssueFile(f) : undefined;
}

/**
 * No `dir` given = memory-only writes (old assembly). Disk writes are best-effort
 * throughout: a full/read-only disk must never sink the paper — the same-process
 * memory tier still carries it through the usual gather→publish pass.
 */
export function putIssue(
  token: string,
  issue: IssueData,
  dir?: string,
  session?: string,
  fromCandidate?: string,
): void {
  if (store.size >= MAX) store.delete(store.keys().next().value as string);
  const entry: StoredIssue = {
    issue: JSON.parse(JSON.stringify(issue)) as IssueData,
    created_at: Date.now(),
    ...(session !== undefined ? { servedSession: session } : {}),
    ...(fromCandidate !== undefined ? { fromCandidate } : {}),
  };
  store.set(token, entry);
  const f = dir ? fileOf(dir, token) : null;
  if (!dir || !f) return;
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(f, JSON.stringify(entry), 'utf-8');
    sweep(dir, Date.now());
  } catch {
    /* Couldn't write to disk — fall back to the memory half; still publishable within the same process */
  }
}

export function getIssue(token: string, dir?: string): IssueData | undefined {
  const issue = entryOf(token, dir)?.issue;
  return issue ? JSON.parse(JSON.stringify(issue)) as IssueData : undefined;
}

/** The candidate page this issue was picked from, if it was stamped with one. */
export function candidateOf(token: string, dir?: string): string | undefined {
  return entryOf(token, dir)?.fromCandidate;
}

/** The copy handed in for this issue so far, if it is being written a batch at a time. */
export function getEdit(token: string, dir?: string): NewspaperEdit | undefined {
  return entryOf(token, dir)?.edit;
}

/**
 * Park the copy so far against an issue whose writing is not finished. Keeps
 * `created_at` as it was: the two-hour bound is measured from when the materials
 * were gathered, so filling in batches can never hold a ledger entry open forever.
 * A token with no entry is a no-op — there is nothing for the copy to belong to.
 */
export function putEdit(token: string, edit: NewspaperEdit, dir?: string): void {
  const cur = entryOf(token, dir);
  if (!cur) return;
  const next: StoredIssue = { ...cur, edit };
  store.set(token, next);
  const f = dir ? fileOf(dir, token) : null;
  if (!f) return;
  try {
    writeFileSync(f, JSON.stringify(next), 'utf-8');
  } catch {
    /* Couldn't write to disk — the memory tier still carries it for this process */
  }
}

export function deleteIssue(token: string, dir?: string): void {
  store.delete(token);
  const f = dir ? fileOf(dir, token) : null;
  if (f) {
    try {
      rmSync(f, { force: true });
    } catch {
      /* Can't delete it now — let the TTL sweep get it */
    }
  }
}

/**
 * The newest candidate set still inside its TTL **and stamped today**, if there is one.
 *
 * This is deliberately **not** the `latestIssue` that was deleted on 2026-08-29. That one let
 * *finished copy* be published against a ledger entry it was not written for, which put every
 * item under the wrong name. This was its candidate-side sibling, born 2026-08-30 for the
 * scrubbed-token fallback ("the model cannot remember a token — it must re-read it from the
 * tool output and type it verbatim"; the host's own skill workshop had just watched eleven
 * candidate sets get minted in three minutes).
 *
 * Since the no-guess ruling reached the picks side (2026-09-06 r25) nothing in production
 * calls this: a picks call resolves only by an explicit candidate_token/`basis` naming the
 * page, never by "newest in this session" — scope was never proof of which page the writer
 * read. The resolver stays as the candidate face of the shared walk (its mint-ordering, TTL
 * and same-day-deletion semantics are what the tests pin, together with `latestPickedIssue`).
 *
 * Same-day rule (2026-09-03 night ruling): an entry whose `dateLabel` is not TODAY's
 * label is dead on sight — never bound, deleted when tripped over. See `scanLiveIssues`.
 */
export function latestCandidate(
  dir?: string,
  today: string = todayDateLabel(),
  session?: string,
): { token: string; issue: IssueData } | undefined {
  return scanLiveIssues(dir, true, today, session);
}

/**
 * The newest **picked** issue (no `c` prefix) still inside its TTL **and stamped
 * today**, if there is one.
 *
 * Since the no-guess ruling (2026-09-06 r9) publish no longer calls this: a hand-in
 * binds by its `publish_token` or its `edit.basis`, and a hand-in carrying neither is
 * refused outright — "the newest live issue" was never proof of which page the copy's
 * numbers refer to (a lone survivor after an expiry is exactly as unproven as one of
 * many). The resolver stays because it is the picked-issue face of the shared walk
 * (`latestCandidate` is the candidate face, and the picks flow still walks that side):
 * its mint-ordering, TTL and same-day-deletion semantics are the ones the tests pin,
 * and a diagnostic handle for "what is live right now" is worth an export.
 *
 * Same-day rule (2026-09-03 night ruling, from that night's real-machine evidence):
 * an entry whose `dateLabel` is not TODAY's label is dead on sight — skipped and
 * deleted when tripped over. A same-day half-written issue survives.
 */
export function latestPickedIssue(
  dir?: string,
  today: string = todayDateLabel(),
  session?: string,
): { token: string; issue: IssueData } | undefined {
  return scanLiveIssues(dir, false, today, session);
}

/**
 * The newest live material page minted from this candidate page (2026-09-12).
 *
 * Never a binding fallback — publish binds only what a field names. This answers a
 * narrower question the refusals need in order to be useful: "the writer handed in
 * the candidate id; is there a material page it could have meant?" A hand-in whose
 * `edit.basis` is a candidate id used to be told to go back to the candidate page
 * and choose again, renumbering copy that was already written. With this the refusal
 * can name the page instead. Several children per parent is normal (one host minted
 * four in 92 seconds), so the newest mint is named — the writer copies the id from
 * the material page in front of it either way.
 */
export function latestIssueFromCandidate(
  candidate: string,
  dir?: string,
  today: string = todayDateLabel(),
  session?: string,
): { token: string; issue: IssueData } | undefined {
  return candidate ? scanLiveIssues(dir, false, today, session, candidate) : undefined;
}

/**
 * The shared body of the "newest live …" resolvers above.
 *
 * Returns the entry that is live (inside its TTL — `entryOf`/`expired` enforce that
 * on BOTH tiers) AND stamped `today` AND served to the caller's own session, choosing
 * the NEWEST MINT (`created_at`) — mtime never decides, because `putEdit` bumps it and
 * a parked batch must not outrank a page minted after it. Anything stamped another day
 * is dead on sight: skipped and DELETED (memory tier and file alike) — these files are
 * transient scratch by design, the 2h-TTL sweep should have removed them, and this is
 * the belt for the ones it missed. Entries that are merely TTL-dead, corrupt, or
 * another session's are skipped without deletion — the TTL sweep owns the first two,
 * and another session's entry is not ours to judge.
 *
 * (`today` is injectable so tests are deterministic; production callers rely on the
 * default, computed through `todayDateLabel()` — the same formatting gather stamps
 * `dateLabel` with, so the comparison cannot drift.)
 */
function scanLiveIssues(
  dir: string | undefined,
  wantCandidate: boolean,
  today: string,
  session?: string,
  /** When given, only issues stamped as picked from THIS candidate page are considered. */
  fromCandidate?: string,
): { token: string; issue: IssueData } | undefined {
  // The session-family filter (2026-09-06 content-mismatch P1): the serving calls stamp
  // entries with their session key, and the PICKS flow's tokenless fallback resolution
  // (a scrubbed/missing candidate_token) may only resolve to a page served to the
  // calling session — picks numbers mean the numbering of the page that writer read.
  // (Since r9 the publish side binds by `publish_token`/`edit.basis` only and never
  // walks this; scope was never proof of WHICH page the copy's numbers belong to —
  // only the basis, carried back by the writer, says that.) Two deliberate edges:
  //  · a SUBAGENT resolves its parent's pages too (`agent:main:subagent:x` → `agent:main`):
  //    slice H's real shape — the main session was served the page and delegated the
  //    writing. The parent does NOT resolve the child's pages: only the session that
  //    was served inherits;
  //  · a caller with NO session key (MCP hosts, old assemblies) is unconstrained —
  //    there is no identity to constrain by.
  const parentSession = (s: string): string => {
    const cut = s.indexOf(':subagent:');
    return cut === -1 ? s : s.slice(0, cut);
  };
  const bindable = (entry: StoredIssue): boolean =>
    (fromCandidate === undefined || entry.fromCandidate === fromCandidate) &&
    (session === undefined || entry.servedSession === session || entry.servedSession === parentSession(session));
  if (!dir) {
    // Map iteration order IS mint order here: `putIssue` inserts on mint, and a later
    // `putEdit`/`store.set` of an existing key keeps its original position. Walked
    // newest-mint-first, expired and other-day entries evicted as tripped over — so
    // the first bindable entry IS the newest mint.
    for (const [token, entry] of [...store.entries()].reverse()) {
      if (isCandidateId(token) !== wantCandidate) continue;
      if (!entry.issue) continue;
      if (expired(entry.created_at, Date.now())) {
        store.delete(token); // the memory tier's own belt — see `expired`
        continue;
      }
      if (entry.issue.dateLabel !== today) {
        store.delete(token); // dead on sight — a previous day's leftover
        continue;
      }
      if (!bindable(entry)) continue;
      return { token, issue: entry.issue };
    }
    return undefined;
  }
  const files: Array<{ token: string; mtimeMs: number }> = [];
  try {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      if (isCandidateId(name) !== wantCandidate) continue;
      try {
        files.push({ token: name.slice(0, -5), mtimeMs: statSync(join(dir, name)).mtimeMs });
      } catch {
        /* Skip the one file we cannot stat */
      }
    }
  } catch {
    return undefined;
  }
  // `created_at` (the mint) decides; mtime never does, and readdir order is arbitrary —
  // so every file is parsed and the newest mint wins. No early stop: that needed a
  // mtime-sorted walk to be sound, and the directory holds a handful of 2h-TTL files,
  // so the whole walk costs nothing (2026-09-06 r9: the scan/count shape this replaced
  // existed only for publish's scope-count fallback, which the no-guess ruling removed).
  let best: { token: string; issue: IssueData; mint: number } | undefined;
  for (const f of files) {
    const entry = entryOf(f.token, dir); // TTL + shape enforced here, memory tier included
    if (!entry) continue; // TTL-dead / corrupt — the TTL sweep owns these
    if (entry.issue!.dateLabel !== today) {
      deleteIssue(f.token, dir); // dead on sight — a previous day's leftover
      continue;
    }
    if (!bindable(entry)) continue;
    const mint = entry.created_at ?? 0;
    if (!best || mint > best.mint) best = { token: f.token, issue: entry.issue!, mint };
  }
  return best ? { token: best.token, issue: best.issue } : undefined;
}

/**
 * Dispatch-time stale sweep (2026-09-03 night ruling): delete every ledger entry —
 * memory tier and disk alike — whose `dateLabel` is not `today`, candidate sets and
 * picked issues together. Called from the newspaper dispatch entry so every new
 * workshop starts on a clean slate: a fresh paper must never be held hostage
 * by leftover stock (the boss's ruling). The same-day binding guards are the
 * primary guarantee; this is the belt
 * that guarantees it even before any binding question is asked.
 *
 * Best-effort by contract: an unreadable directory or a corrupt file is skipped,
 * never thrown — a sweep must not be able to block a dispatch. Corrupt/foreign
 * files (no parseable `issue.dateLabel`) are left to the TTL sweep, which owns them.
 */
export function sweepStaleIssues(dir: string | undefined, today: string = todayDateLabel()): void {
  for (const [token, entry] of [...store.entries()]) {
    if (entry.issue && entry.issue.dateLabel !== today) store.delete(token);
  }
  if (!dir) return;
  try {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      const f = join(dir, name);
      try {
        const raw = JSON.parse(readFileSync(f, 'utf-8')) as StoredIssue;
        if (raw.issue && raw.issue.dateLabel !== today) rmSync(f, { force: true });
      } catch {
        /* Unreadable/corrupt — not ours to judge here; the TTL sweep owns it */
      }
    }
  } catch {
    /* Directory doesn't exist yet / unreadable — nothing to sweep */
  }
}

// Exported for test teardown only. DO NOT use from production code.
export function _resetIssuesForTest(dir?: string): void {
  store.clear();
  if (dir) rmSync(dir, { recursive: true, force: true });
}

/**
 * Test-only: rewind one entry's `created_at` in BOTH tiers, the way time would have.
 * The TTL is judged by `created_at` (not mtime — `putEdit` bumps mtime on purpose so a
 * parked batch keeps its file findable), so "this issue was gathered hours ago" can
 * only be constructed by editing the stamp itself.
 * DO NOT use from production code.
 */
export function _backdateIssueForTest(token: string, created_at: number, dir?: string): void {
  const cur = entryOf(token, dir); // fresh at the moment a test backdates it
  if (!cur) return;
  const next: StoredIssue = { ...cur, created_at };
  store.set(token, next);
  const f = dir ? fileOf(dir, token) : null;
  if (!f) return;
  try {
    writeFileSync(f, JSON.stringify(next), 'utf-8');
  } catch {
    /* Test rig edge — the memory tier is enough for the assertion at hand */
  }
}
