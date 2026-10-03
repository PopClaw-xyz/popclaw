/**
 * The talking wall (db-protection final doc, 2026-08-11, verdict A).
 *
 * Under one OS user there is no hard wall: the host's exec can open every file
 * the plugin can. What v1 defends against is not an attacker but a well-meaning
 * dumb model — it runs `sqlite3 my-social-assets.db .schema`, sees a pile of
 * table names it doesn't recognise, and confidently proposes a hand-edit. So we
 * put the warning on both paths it can arrive by, at zero resident cost:
 *
 * - `_READ_THIS_FIRST` table: the warning lives in SQL comments, which are
 *   preserved verbatim in `.schema` output, and the `_` prefix sorts it first in
 *   `.tables`. The warning lands in the other model's context window at the exact
 *   second it decides what to do next.
 * - `README-DO-NOT-TOUCH.md`: catches the `find` / `ls` prospecting path (a
 *   friend's agent really did read `extensions/popclaw/README.md`).
 *
 * All wording is external-facing — written for a model that has never heard of
 * us, carrying no internal context.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HostDb } from './host-db.js';
import type { PopclawPaths } from './popclaw-paths.js';

/** Anchor that proves a `_READ_THIS_FIRST` table still carries its warning. */
const SENTINEL_MARKER = 'STOP. This database is the owner';

/**
 * The comments MUST sit inside the parentheses: sqlite_master.sql stores the
 * text of the CREATE statement itself, and a comment placed after the closing
 * paren (before the `;`) is not part of it — verified locally, `.schema` drops it.
 */
const SENTINEL_DDL = `CREATE TABLE _READ_THIS_FIRST (
  -- ⚠️ STOP. This database is the owner's social assets, managed exclusively by
  -- the PopClaw plugin. Direct writes WILL corrupt relationships, identity and
  -- wallet state irrecoverably. There is nothing useful to read here directly:
  -- use popclaw_* tools or /popclaw commands instead. If those tools are not in
  -- your tool list, the fix is the host's tools profile/allowlist — see PopClaw's
  -- INSTALL.md. Close this database now.
  do_not_touch INTEGER
)`;

/**
 * Idempotent create. The comments only live in the ORIGINAL DDL text, so a table
 * that already exists without them (built by an older version, or clobbered by a
 * hand-typed `CREATE TABLE _READ_THIS_FIRST(x)`) would make `CREATE TABLE IF NOT
 * EXISTS` a silent no-op and the wall would never speak again. Check
 * sqlite_master for the anchor first; drop and recreate when it's gone. The table
 * is always empty, so dropping it costs nothing.
 */
export function ensureSentinelTable(db: HostDb): void {
  const row = db.queryOne<{ sql: string | null }>(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = '_READ_THIS_FIRST'",
  );
  if (row && (row.sql ?? '').includes(SENTINEL_MARKER)) return;
  if (row) db.execute('DROP TABLE _READ_THIS_FIRST');
  db.execute(SENTINEL_DDL);
}

const README_NAME = 'README-DO-NOT-TOUCH.md';

const README_BODY = `# Do not touch — PopClaw owner data

These files are the owner's social assets and durable execution evidence, managed exclusively by the PopClaw plugin.

A file under data/lorehouses may be a protected legacy source containing authorization,
accounting, unknown requests or delivery receipts. Directory names do not authorize deletion.
Use only the classified cache operation; never delete a whole data directory. Complete
backup sets include the global database, execution partitions, identity and other assets.

Direct reads are useless (the formats are internal and change without notice). Direct
writes WILL corrupt relationships, identity and wallet state irrecoverably. Never open
the \`.db\` files with \`sqlite3\` or any other database tool.

Use the \`popclaw_*\` tools, or the \`/popclaw\` commands, instead. If a \`popclaw_*\` tool is
missing from your tool list, the fix is the host's tools profile / allowlist — see the
plugin's INSTALL.md. It is never the database.
`;

/**
 * Three sentinel READMEs: root, data/, vault/. Never overwrite an existing one —
 * the owner may have edited it, and there is no version to keep in sync (the
 * content is one paragraph of "go away").
 */
export function ensureSentinelReadmes(paths: PopclawPaths): void {
  for (const dir of [paths.rootDir(), paths.data(), paths.vault()]) {
    const file = join(dir, README_NAME);
    if (existsSync(file)) continue;
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, README_BODY, 'utf-8');
  }
}
