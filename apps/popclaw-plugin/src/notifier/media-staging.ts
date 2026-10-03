/**
 * The last gate for notifications carrying an image: **copy** the image
 * headed for the owner **into a directory the host is allowed to send from**.
 *
 * Real-machine incident (2026-07-28): `L1 send to telegram failed
 * (partial_failed): FsSafeError: file not found` → the whole batch judged as
 * failed → the item re-enqueued → the next notification dragged the old
 * corpse along and re-sent it. Both the image and the text actually reached
 * the owner's phone; the "failure" was purely the host's media safety layer
 * rejecting it.
 *
 * Forensics (read-only inspection of the OpenClaw 6.x dist, host unmodified)
 * — `sendDurableMessageBatch`'s allowed local media roots come from
 * `local-roots.js::buildMediaLocalRoots(stateDir, configDir)`:
 *   <tmp>/openclaw · <configDir>/media · <stateDir>/media
 *   <stateDir>/canvas · <stateDir>/workspace · <stateDir>/sandboxes
 * (`read-capability.js::resolveAgentScopedOutboundMediaAccess` further appends
 * a per-agent workspaceDir; on this machine, real-world testing confirmed it's
 * exactly the five above.) We write decrypted images to
 * `<popclawRoot>/data/dm-media/` — none of the six roots cover it, so the host
 * can't read it. Corroborating evidence: images the agent generates itself
 * land in `<stateDir>/workspace/.openclaw-cli-images/`, and sending images
 * through that same durable-send channel has always succeeded.
 *
 * Why `<stateDir>/media` instead of the workspace: it's on the **static**
 * allow-list (doesn't depend on agentId / session / tools policy resolution),
 * and media is literally what it's for — we shouldn't stuff our intermediate
 * artifacts into the owner's workspace. stateDir is given by the host
 * (`api.runtime.state.resolveStateDir()`, overridable host-side via
 * `OPENCLAW_STATE_DIR`); nothing here hardcodes a home path.
 *
 * Discipline preserved: the original is still written to `data/dm-media/`
 * (`inbox.media_path` points there — popclaw's assets live in popclaw's
 * directory); this only **copies** an outbound-use copy.
 */
import { copyFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';

/** Home for the outbound copy: our own cell under the host's static allowed
 *  root `<stateDir>/media`. */
export function dmMediaStagingDir(stateDir: string): string {
  return join(stateDir, 'media', 'popclaw-dm');
}

/**
 * Copy a file to `dir`, returning the new path that can be handed to
 * `mediaUrls`; returns `null` if the copy fails.
 *
 * **Never throws**: an image staging failure should only degrade this
 * notification to plain text (the attachment marker stays), never block the
 * text along with it — that was the most expensive half of this real-machine
 * incident.
 *
 * The file name reuses the original's (`<ts>-<first 8 chars of sender
 * id>.<ext>`, itself deterministic) → resending the same message overwrites
 * instead of piling up.
 * ponytail: no cleanup task exists — the staging directory grows unbounded as
 * images arrive. Add an mtime-based sweeper once it actually takes up space.
 */
export function stageMediaForSend(
  src: string,
  dir: string,
  onError?: (err: unknown) => void,
): string | null {
  try {
    mkdirSync(dir, { recursive: true });
    const dest = join(dir, basename(src));
    copyFileSync(src, dest);
    return dest;
  } catch (err) {
    onError?.(err);
    return null;
  }
}

/**
 * The host stores attachments **the owner sent in** here (`<stateDir>/media/inbound`).
 *
 * Why the plugin needs to know this path: when the owner records a voice clip
 * in an IM app and sends it to their own agent, the host writes it as
 * `<original name>---<uuid>.ogg` into this directory — verified on three real
 * machines (Telegram / Feishu / WeChat) to be the same location. But **the
 * agent doesn't know where it is**: on a real machine on 2026-07-31, host-c's
 * machine (running kimi-k2.7), when asked to "send that voice clip just now to
 * host-a," replied "host-c currently has no tool to download or read the
 * owner's voice attachment" — while that .ogg file was sitting right there in
 * this directory the whole time. host-a's machine (running Claude) guessed
 * correctly; a weaker model won't guess.
 *
 * So this path needs to be **spelled out explicitly in the tool description
 * and the list tool**, not left for the model to infer on its own. Same
 * lesson as #231: give the agent a legitimate door, and also write clearly in
 * the description where it is.
 */
export function hostInboundMediaDir(stateDir: string): string {
  return join(stateDir, 'media', 'inbound');
}

/**
 * The same answer for a host that has no state dir to derive it from (#585).
 *
 * The MCP bridge is not an OpenClaw gateway: it never learns the host's inbound
 * convention, so `popclaw_recent_attachments` had nothing to list there. Whoever
 * runs the bridge can name the directories themselves —
 * `POPCLAW_INBOUND_MEDIA_DIRS=/path/one:/path/two` (commas work too) — and the
 * tool lists them exactly as it does on OpenClaw. Unset is a perfectly normal
 * answer: the tool registers anyway and says no inbound directory is configured.
 *
 * Env, not config: this is read inside `register()`, which must not touch the
 * data root (ADR-0035), so it has to be answered from the environment alone.
 * Relative entries are dropped rather than resolved against a cwd the owner
 * never chose.
 */
export function inboundMediaDirsFromEnv(env: Record<string, string | undefined>): string[] {
  return (env['POPCLAW_INBOUND_MEDIA_DIRS'] ?? '')
    .split(/[:,]/)
    .map((d) => d.trim())
    .filter((d) => d.length > 0 && isAbsolute(d));
}

/** A file the owner sent in. `path` is absolute and can be fed directly to
 *  `attachment_path`. */
export interface InboundAttachment {
  readonly path: string;
  readonly size: number;
  readonly mtimeMs: number;
}

/**
 * List the owner's most recently sent-in attachments, newest first. **Never
 * throws** — a directory that can't be read (not yet created, wrong
 * permissions) is simply skipped; one directory must never fail the whole
 * listing.
 *
 * Two call sites share this one: the `popclaw_recent_attachments` tool, and
 * the per-turn prompt injection (see index.ts's before_prompt_build). One
 * piece of material, two outlets — don't write it twice.
 */
export function recentInboundAttachments(
  dirs: readonly string[],
  opts: { limit?: number; newerThanMs?: number; now?: number } = {},
): InboundAttachment[] {
  const now = opts.now ?? Date.now();
  const out: InboundAttachment[] = [];
  for (const dir of dirs) {
    try {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        const st = statSync(path);
        if (!st.isFile() || st.size === 0) continue;
        if (opts.newerThanMs !== undefined && now - st.mtimeMs > opts.newerThanMs) continue;
        out.push({ path, size: st.size, mtimeMs: st.mtimeMs });
      }
    } catch {
      /* This directory couldn't be read this time — skip it, don't let it drag
       * down the other directories */
    }
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return opts.limit === undefined ? out : out.slice(0, opts.limit);
}
