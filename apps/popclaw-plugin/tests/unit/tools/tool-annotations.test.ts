import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { makeToolCollector } from '../../../src/tools/mcp-adapter.js';
import { registerPopclawTools } from '../../../src/tools/register-tools.js';
import { MCP_ONLY_TOOLS, TOOL_ANNOTATIONS, toolAnnotations } from '../../../src/tools/tool-annotations.js';
import { consumeOwnerApproval, resetOwnerApprovals } from '../../../src/host/owner-approval.js';

/**
 * The MCP `ToolAnnotations` a host reads before it decides whether a call
 * needs a permission prompt. Claude Code in auto mode refused
 * `popclaw_send_draft` as an "external system write" before PopClaw's own
 * owner dialog could appear, and INSTALL found every tool listed with no
 * hints at all — so a host had to guess about all of them.
 *
 * The hints are advisory, but `readOnlyHint: true` is a claim a host may act
 * on by skipping the prompt. On a tool that sends, pushes or signs that would
 * be a lie with a security cost, so this file pins the read-only set by name
 * and checks the tools that reach the outside world against it.
 */

const MANIFEST_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '../../../openclaw.plugin.json');
const declared = (JSON.parse(readFileSync(MANIFEST_PATH, 'utf-8')) as { contracts: { tools: string[] } }).contracts.tools;

/** Every lazy gate on, as each composition root wires them. */
function registerAs(root: 'mcp' | 'native'): string[] {
  const c = makeToolCollector();
  registerPopclawTools({
    api: c.api,
    runtime: async () => ({}) as never,
    inboundMediaDirs: [tmpdir()],
    getOrchestrator: async () => ({}) as never,
    getWorldDeps: async () => ({}) as never,
    getHouseCommandContext: async () => ({}) as never,
    getWorldCommandContext: async () => ({}) as never,
    ...(root === 'native'
      ? { bindNativeWorldInvoke: () => async () => undefined as never, declaredWorldActionParameters: () => null }
      : { bindMcpWorldInvoke: () => async () => undefined as never }),
  } as unknown as Parameters<typeof registerPopclawTools>[0]);
  return c.tools.map((t) => t.name);
}

/**
 * The ONLY tools allowed to claim `readOnlyHint: true`. Adding a name here is
 * a statement that the tool acts on nobody's behalf: no push, no signature
 * (not even on a read request), no upload, no outbound message, and no
 * owner-visible state change (nothing marked read or reported, decided, set,
 * logged or settled). Cache fills and the nudge ledger are
 * bookkeeping, not actions.
 */
const READ_ONLY = [
  'popclaw_find_bonds',
  'popclaw_list_pending_proposals',
  'popclaw_onboarding_status',
  'popclaw_recent_attachments',
  'popclaw_search_feed',
  'popclaw_show_bonds',
  'popclaw_show_feed',
  'popclaw_show_marks',
  'popclaw_show_namecard',
  'popclaw_show_recommend',
  'popclaw_world_capabilities',
  'popclaw_world_guide',
  'popclaw_world_private_messages',
  'popclaw_world_summary',
];

/**
 * Tools whose call can reach the outside world as a WRITE: a signed event to
 * `/v1/push`, an outbound message or letter, a canvas upload, a browser
 * pairing, a login credential, a house session, or a ranger job. None may be
 * read-only, and all must admit to an open world.
 */
const EXTERNAL_WRITES = [
  'popclaw_send_draft',
  'popclaw_follow',
  'popclaw_unfollow',
  'popclaw_mark',
  'popclaw_unmark',
  'popclaw_set_name',
  'popclaw_invite',
  'popclaw_world_invoke',
  'popclaw_house_login',
  'popclaw_house_logout',
  'popclaw_house_entry_link',
  'popclaw_pair_browser',
  'popclaw_canvas',
  'popclaw_publish_newspaper',
  'popclaw_onboarding_continue',
  'popclaw_world_action_status', // signs a status read, POSTs it, settles the result ledger
];

/** Tools that change owner-visible local state even though their name reads like a read. */
const READ_LOOKING_WRITES = [
  'popclaw_check_status', // settles pending invites/verifications and enqueues a notification
  'popclaw_show_inbox', // marks a message retrieved; resolve_message_id closes it
  'popclaw_show_pings', // marks the shown batch read
  'popclaw_show_dream_review', // marks the shown bond dynamics reported
  'popclaw_notifications', // records offered IDs; acknowledgement is a separate tool
  'popclaw_author_latest', // writes `person_asked` into the permanent social log
  'popclaw_newspaper', // mints candidate / publish ledger entries
  'popclaw_dream', // records the owner-language observation and mints a dream token
];

beforeEach(() => { resetOwnerApprovals(); });
afterEach(() => { resetOwnerApprovals(); });

describe('tool annotations table', () => {
  it('has exactly one entry per tool either root can list', () => {
    const surface = new Set([...registerAs('mcp'), ...registerAs('native'), ...MCP_ONLY_TOOLS]);
    expect(Object.keys(TOOL_ANNOTATIONS).sort()).toEqual([...surface].sort());
  });

  it('keeps the shared annotated tool set in the OpenClaw manifest, including recovery and notifications', () => {
    const shared = Object.keys(TOOL_ANNOTATIONS).filter((name) => !MCP_ONLY_TOOLS.includes(name));
    expect([...declared].sort()).toEqual(shared.sort());
    for (const name of declared) expect(toolAnnotations(name), name).toBeDefined();
    for (const name of MCP_ONLY_TOOLS) expect(declared).not.toContain(name);
  });

  it('declares all four hints as booleans, and no read-only tool claims to destroy', () => {
    for (const [name, a] of Object.entries(TOOL_ANNOTATIONS)) {
      expect(Object.keys(a).sort(), name).toEqual(['destructiveHint', 'idempotentHint', 'openWorldHint', 'readOnlyHint']);
      for (const v of Object.values(a)) expect(typeof v, name).toBe('boolean');
      if (a.readOnlyHint) expect(a.destructiveHint, name).toBe(false);
    }
  });

  it('lets only the pinned read set claim readOnlyHint', () => {
    const readOnly = Object.entries(TOOL_ANNOTATIONS).filter(([, a]) => a.readOnlyHint).map(([n]) => n);
    expect(readOnly.sort()).toEqual([...READ_ONLY].sort());
  });

  it('never marks a tool that writes to the outside world as read-only or closed-world', () => {
    const registered = new Set([...registerAs('mcp'), ...registerAs('native')]);
    for (const name of EXTERNAL_WRITES) {
      // A stale name here would guard nothing.
      expect(registered.has(name), `${name} is not a registered tool`).toBe(true);
      expect(toolAnnotations(name)?.readOnlyHint, name).toBe(false);
      expect(toolAnnotations(name)?.openWorldHint, name).toBe(true);
    }
  });

  it('never marks a read-looking tool that changes owner-visible state as read-only', () => {
    for (const name of READ_LOOKING_WRITES) {
      expect(toolAnnotations(name), name).toBeDefined();
      expect(toolAnnotations(name)?.readOnlyHint, name).toBe(false);
    }
  });

  it('never marks a tool behind the owner-approval seam as read-only (derived from the registry roots fill)', () => {
    const names = [...registerAs('mcp'), ...registerAs('native')];
    const gated = [...new Set(names)].filter(
      (name) => (consumeOwnerApproval(name, {}, 'annotation-probe') as { reason?: string }).reason !== 'SUBJECT_NOT_REGISTERED',
    );
    // The three subjects that exist today; the probe itself must be live.
    expect(gated.sort()).toEqual(['popclaw_house_reconfirm', 'popclaw_world_invoke']);
    for (const name of gated) {
      expect(toolAnnotations(name)?.readOnlyHint, name).toBe(false);
      expect(toolAnnotations(name)?.openWorldHint, name).toBe(true);
    }
  });

  it('flags only the tools that retract something already public, or run an arbitrary house action, as destructive', () => {
    const destructive = Object.entries(TOOL_ANNOTATIONS).filter(([, a]) => a.destructiveHint).map(([n]) => n);
    expect(destructive.sort()).toEqual(['popclaw_unfollow', 'popclaw_unmark', 'popclaw_world_invoke']);
  });

  it('answers undefined for a name it does not know, so a listing omits the hints rather than inventing them', () => {
    expect(toolAnnotations('popclaw_no_such_tool')).toBeUndefined();
    expect(toolAnnotations('toString')).toBeUndefined();
  });
});
