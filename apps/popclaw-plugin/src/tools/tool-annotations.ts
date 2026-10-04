/**
 * MCP `ToolAnnotations` for every tool the MCP root lists — the one table.
 *
 * A host reads these hints before a call to decide whether it needs a
 * permission prompt. With none declared, Claude Code in auto mode had to guess,
 * and it refused `popclaw_send_draft` as an "external system write" before
 * PopClaw's own owner dialog could appear. The hints are advisory and change
 * nothing about what a tool does; the owner-approval seam still decides every
 * send.
 *
 * What each hint claims here, because a host may skip a prompt on the
 * strength of it:
 *
 * - `readOnlyHint: true` — the call acts on nobody's behalf: no push, no
 *   signature (not even on a read request), no upload, no outbound message,
 *   and no owner-visible state change (nothing marked read or reported,
 *   decided, set, logged or settled). Cache fills and the
 *   nudge ledger are bookkeeping, not actions. A tool that merely LOOKS like a
 *   read (`show_inbox` marks a message retrieved, `show_pings` marks a batch
 *   read, `author_latest` writes the social log, `check_status` settles
 *   pending invites/verifications and enqueues a notification) is not
 *   read-only.
 * - `openWorldHint: true` — the call may talk to anything outside this
 *   machine: a LoreHouse, the canvas, a ranger, or a model provider. Reads
 *   count, as the MCP spec's own web-search example does. Note that
 *   `find_bonds` stays read-only yet sends bond-book content, remark names
 *   included, to the configured model; that egress is recorded here so a
 *   later policy on it has something to point at.
 * - `destructiveHint: true` — the call retracts something already public
 *   (the retraction is itself published and cannot be un-sent), or performs
 *   an action whose effect this plugin cannot bound (`world_invoke` runs
 *   whatever the house declared). A local, reversible overwrite such as a bond
 *   tier or an alias is not destructive.
 * - `idempotentHint: true` — repeating the call with the same arguments has no
 *   further effect. Claimed only where that is plainly so; a call that mints a
 *   draft, token or event every time is not idempotent.
 *
 * The hints describe the MCP root, the only place they are published. Keyed by
 * tool name; tests/unit/tools/tool-annotations.test.ts fails when a tool either
 * root registers has no entry, when an entry names no tool, and when a tool
 * that writes to the outside world claims to be read-only.
 */

export interface PopclawToolAnnotations {
  readonly readOnlyHint: boolean;
  readonly destructiveHint: boolean;
  readonly idempotentHint: boolean;
  readonly openWorldHint: boolean;
}

/** Reads of this machine's own stores. */
const READ_LOCAL: PopclawToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
/** Reads that may ask a LoreHouse or a model provider. */
const READ_REMOTE: PopclawToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
/** Owner-local writes (a draft, a mark-as-read, a taste note) that leave the machine only later, if at all. */
const WRITE_LOCAL: PopclawToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
/** Owner-local "set to this value" writes. */
const SET_LOCAL: PopclawToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
/** Local writes that may also read from outside (a resolution fallback, a guide fetch). */
const WRITE_LOCAL_OPEN: PopclawToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
/** Writes that reach the outside world: a signed push, an upload, a session, a credential. */
const WRITE_REMOTE: PopclawToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
/** Retractions of something already public. */
const RETRACT_REMOTE: PopclawToolAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };

/** Listed by `src/mcp.ts` only: inside an MCP host PopClaw cannot push notices, so the agent pulls them. */
export const MCP_ONLY_TOOLS = ['popclaw_notifications', 'popclaw_acknowledge_notifications'] as const;

export const TOOL_ANNOTATIONS: Readonly<Record<string, PopclawToolAnnotations>> = Object.freeze({
  // --- reads ---
  popclaw_show_namecard: READ_REMOTE, // resolves and GETs the namecard at the house
  popclaw_show_feed: READ_REMOTE, // world feed client
  popclaw_search_feed: READ_LOCAL, // local cache only
  popclaw_recent_attachments: READ_LOCAL, // lists the inbound media directory
  popclaw_show_recommend: READ_LOCAL, // scores the local cache (the score cache is bookkeeping)
  popclaw_show_bonds: READ_LOCAL,
  popclaw_find_bonds: READ_REMOTE, // sends bond-book content, remark names included, to the configured model
  popclaw_list_pending_proposals: READ_LOCAL,
  popclaw_show_marks: READ_LOCAL,
  popclaw_onboarding_status: READ_LOCAL, // does not advance the walkthrough; zero network
  popclaw_world_guide: READ_REMOTE, // fetches the guide text
  popclaw_world_summary: READ_REMOTE,
  popclaw_world_capabilities: READ_LOCAL, // the verified login context and public status already stored locally
  popclaw_world_private_messages: READ_LOCAL, // local cache; consumes nothing

  // --- reads that change owner-visible state ---
  // GETs /v1/profile, but checkInviteOnce also settles pending invites/verifications
  // (pending.claimResolved) and enqueues a notification; repeating settles nothing
  // new, so idempotentHint stays true.
  popclaw_check_status: { ...WRITE_REMOTE, idempotentHint: true },
  popclaw_show_inbox: SET_LOCAL, // marks a message retrieved; resolve_message_id closes it
  popclaw_show_pings: WRITE_LOCAL, // marks the shown batch read, so the next call shows another
  popclaw_show_dream_review: WRITE_LOCAL, // marks the shown bond dynamics reported, so each surfaces once
  popclaw_notifications: WRITE_LOCAL, // drains / acknowledges settled items
  popclaw_acknowledge_notifications: SET_LOCAL,
  popclaw_author_latest: WRITE_LOCAL_OPEN, // logs `person_asked` to the permanent social log
  popclaw_newspaper: WRITE_LOCAL, // gathers local material and mints candidate / publish ledger entries
  popclaw_dream: WRITE_LOCAL, // records the owner-language observation and mints a dream token

  // --- owner-local writes ---
  popclaw_draft_reply: WRITE_LOCAL, // parks a draft; popclaw_send_draft sends it
  popclaw_draft_post: WRITE_LOCAL,
  popclaw_draft_message: WRITE_LOCAL_OPEN, // the recipient may be resolved at the house
  popclaw_feedback: WRITE_LOCAL_OPEN, // drafts only; reads the house guide for the contact
  popclaw_record_dream: WRITE_LOCAL,
  popclaw_write_taste: WRITE_LOCAL, // merges into the taste file
  popclaw_note_taste: WRITE_LOCAL, // appends
  popclaw_set_bond_tier: SET_LOCAL,
  popclaw_set_remark_name: SET_LOCAL,
  popclaw_decide_bond_tier_proposal: WRITE_LOCAL,
  popclaw_update_cadence: SET_LOCAL,
  popclaw_mute_notices: SET_LOCAL,
  popclaw_onboarding_skip: WRITE_LOCAL_OPEN, // advances the walkthrough; the next act may read the houses

  // --- writes that reach the outside world ---
  popclaw_send_draft: WRITE_REMOTE, // behind the owner-approval seam
  popclaw_follow: WRITE_REMOTE,
  popclaw_unfollow: RETRACT_REMOTE,
  popclaw_mark: WRITE_REMOTE, // public +1, signed by the owner
  popclaw_unmark: { ...RETRACT_REMOTE, idempotentHint: true }, // safe to repeat, per its own contract
  popclaw_set_name: WRITE_REMOTE, // re-signs and publishes the namecard
  popclaw_invite: WRITE_REMOTE, // the confirmed call puts rangers to work
  popclaw_onboarding_continue: WRITE_REMOTE, // an act may name, follow or stamp
  popclaw_house_recovery_prepare: WRITE_LOCAL_OPEN,
  popclaw_house_reconfirm: WRITE_LOCAL_OPEN,
  popclaw_house_login: WRITE_REMOTE,
  popclaw_house_logout: { ...WRITE_REMOTE, idempotentHint: true }, // deletes nothing; leaving twice is leaving
  popclaw_house_entry_link: WRITE_REMOTE, // the confirmed call signs a seven-day login key
  popclaw_pair_browser: WRITE_REMOTE,
  popclaw_canvas: WRITE_REMOTE, // uploads a page for a shareable link
  popclaw_publish_newspaper: WRITE_REMOTE,
  // Creates no new action, but signs a status read with the owner's key, POSTs it,
  // and settles the local result ledger and reservations from the answer.
  popclaw_world_action_status: { ...WRITE_REMOTE, idempotentHint: true },
  // Whatever the house declared, so its effect cannot be bounded here; the owner confirms each call.
  popclaw_world_invoke: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
});

/** The hints for one tool, or undefined for a name the table does not know (a listing then omits them). */
export function toolAnnotations(name: string): PopclawToolAnnotations | undefined {
  return Object.hasOwn(TOOL_ANNOTATIONS, name) ? TOOL_ANNOTATIONS[name] : undefined;
}
