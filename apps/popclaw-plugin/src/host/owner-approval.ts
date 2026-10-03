/**
 * The owner-approval seam: one place a tool call is suspended, shown to the
 * human who owns this install, and resumed only on their answer.
 *
 * It is deliberately NOT world-specific. A tool declares a subject once, next
 * to its own registration, and the seam does everything that must be true for
 * every subject — the origin guard, the prompt budget, the single-use
 * bookkeeping, and the comparison that makes "the parameters changed after the
 * owner approved" structurally impossible rather than a rule both sides have
 * to remember.
 *
 * ## The one property worth reading twice
 *
 * `consumeOwnerApproval(toolName, params)` takes the parameters the tool body
 * is ABOUT TO ACT ON, never a digest a caller computed earlier. The seam runs
 * the registrant's own `canonicalize` on them and compares that against what it
 * ran at approval time. There is no way to hand in bytes that differ from what
 * is about to happen, because the caller never supplies bytes at all.
 *
 * ## How the host suspends the call (OpenClaw native, 2026.9.4)
 *
 * Read from the installed bundle; nothing here has been exercised against a
 * running Gateway.
 *
 *   - a `before_tool_call` TYPED hook may return `requireApproval`
 *     (`dist/agent-harness-runtime-BvaKEkqR.d.ts:773`). The Gateway then opens
 *     a pending approval, SUSPENDS the in-flight tool call
 *     (`dist/agent-tools.before-tool-call-WtmCO7BO.mjs:2859-2874`, waiting at
 *     `:1031`) and resumes it only on `allow-once` / `allow-always` from an
 *     authorized approver. Everything else fails closed (`:871-873`).
 *   - `onResolution` is notification-style (`:860-870`): called synchronously,
 *     and nothing async started inside it is awaited. So it does one
 *     assignment and nothing else. It runs before the tool body does, which is
 *     what lets the answer reach `consumeOwnerApproval`.
 *   - the model cannot reach any of this: `requireApproval` is only producible
 *     by a plugin hook return value, and resolving one is gated on SENDER
 *     IDENTITY (`dist/commands-approve-DFjnxxOt.mjs:143-145`), never on message
 *     content. Self-approval through the shell is refused outright
 *     (`dist/exec-control-command-guard-pKQXH4qr.mjs:189`).
 *   - subagent, cron and heartbeat turns stay unauthorized — but ONE GATE
 *     LATER than an earlier note here claimed, and the earlier argument was
 *     simply wrong. The trigger check at
 *     `dist/agent-tools.before-tool-call-WtmCO7BO.mjs:907` lives inside
 *     `resolveUnavailablePluginApprovalSurfaceReason`, a reason-STRING
 *     producer whose only call site is `:964`, inside
 *     `requestPluginToolApproval` — that is, AFTER this hook has already run
 *     and returned `requireApproval`. The hook DOES run on those turns. What
 *     keeps them unauthorized is what happens next: `:964` refuses, the
 *     request is cancelled, and the host forces a cancellation to TIMEOUT at
 *     `:871-873`, so the seam reads `timeout` and `consumeOwnerApproval`
 *     refuses. Still fails closed; the gate is just not where it was said to
 *     be. Two further gaps at that location, written down so nobody leans on
 *     it again: `:900` returns undefined — no refusal at all — when
 *     `ctx.trigger` is absent, and `trigger` is optional
 *     (`dist/agent-tools-DXxcrXNI.mjs:757`); and the whole check sits after
 *     the embedded-broker early return at `:919-962`, so an embedded-mode host
 *     never reaches it. See the RESIDUAL on `ownerApprovalBeforeToolCall`.
 */
import {
  APPROVAL_TITLE_BUDGET,
  NATIVE_APPROVAL_PROFILE, approvalTextSize,
  type ApprovalDisplayBudget, type ApprovalDialogProfile,
} from './approval-presentation.js';
export {
  APPROVAL_DESCRIPTION_CODE_POINTS, APPROVAL_TITLE_CODE_POINTS,
  APPROVAL_DESCRIPTION_BUDGET, APPROVAL_TITLE_BUDGET, APPROVAL_DESCRIPTION_MAX_LINES,
  NATIVE_APPROVAL_DISPLAY_BUDGET, approvalTextSize,
  type ApprovalDisplayBudget,
} from './approval-presentation.js';

import { OWNER_APPROVAL_WINDOW_SECONDS } from './approval-window.mjs';
import {
  OWNER_APPROVAL_ROUTE_REFUSALS, readOwnerAllowlistState, resolveOwnerApprovalRoute,
  type OwnerApprovalRouteReaders, type OwnerApprovalRouteRefusal,
} from './owner-approval-route.js';

/** The registrant's own canonical form of one call. Compared as a string and
 *  never parsed by the seam, so a registrant may put anything in it that must
 *  be bound — including the immutable digest of content its own earlier step
 *  already delivered and the prompt has no room to repeat. */
export type ApprovalSubject = string;

/**
 * What a registrant hands back.
 *
 * `description` is an ARRAY OF ROWS, and that shape is the security control,
 * not a formatting convenience. The seam joins the rows with `\n` itself and
 * validates EACH ROW against the invisible class, which contains every line
 * separator (`\n` `\r` `\v` `\f` U+0085 U+2028 U+2029, and `\r\n` because both
 * of its halves are in the class). A registrant therefore cannot express a
 * line break inside a value AT ALL: producing a second row requires adding an
 * array element, which is an explicit act by trusted registrant code and is
 * not something a model-supplied value can do.
 *
 * It used to be a flat string checked with `description.split('\n')`. That
 * check was vacuous for exactly the character it claimed to catch — `split`
 * consumes the newlines before `test` ever sees them — so a model-supplied
 * parameter value carrying `\n` reached the owner's dialog as extra rows and
 * could forge a coordinate or a "this publishes nothing" reassurance under the
 * genuine ones. The seam cannot tell a structural newline from an injected one
 * inside a flat string, so the flat string had to go.
 */
export type ApprovalSubjectResult =
  | { readonly kind: 'ask'; readonly title: string; readonly description: readonly string[];
      /**
       * THE SAME SUBJECT, LAID OUT A SECOND TIME FOR A HOST THAT FOLDS.
       *
       * A registrant that can say the same thing in fewer rows may offer that
       * spelling here, and a backend whose host cannot render `description`
       * whole uses it INSTEAD OF REFUSING. Optional, because most subjects have
       * nothing shorter to say and a registrant that offers nothing keeps
       * today's behaviour exactly.
       *
       * IT IS A SECOND RENDERING, NEVER A SECOND QUESTION. `canonicalize` does
       * not see it, so both layouts bind the identical bytes; only one dialog
       * is ever shown, only one answer is ever recorded, and the answer
       * authorizes the same call whichever layout the host rendered. A
       * registrant must not put anything in here that is not true of
       * `description`'s subject — this is a way of SAYING the same thing more
       * briefly, not a way of asking about less.
       *
       * Screened exactly like the primary and dropped if it fails, so a
       * malformed alternative costs a folded host a dialog it never had and
       * costs the richer host nothing at all. The drop is not silent: see
       * `FOLDED_ALTERNATIVE_UNPRESENTABLE`.
       *
       * THE INVARIANT THE SEAM CANNOT CHECK, AND A REVIEWER THEREFORE MUST.
       * What BINDS is the canonical string; what a person READS is this text,
       * and the seam compares the two not at all — it has no way to. So "the
       * folded rendering describes the same action, on the same snapshot, as
       * the primary" is the registrant's promise, enforced only by review. A
       * folded rendering that named a different recipient, a different house,
       * or a shorter action than the primary would be approved and acted on as
       * the primary, because the answer is bound to bytes neither layout can
       * move. Review both layouts together, or do not offer one.
       */
      readonly folded?: { readonly title: string; readonly description: readonly string[] };
      /**
       * The words on the one input an MCP dialog shows — the owner's answer to
       * THIS action ("Send this draft"). Optional: without it the backend uses
       * the seam's generic, localized label, so a registrant that says nothing
       * never shows the owner another registrant's verb. Localize it yourself;
       * the seam does not translate it. Screened exactly like `title`, and an
       * unshowable label refuses the prompt by the same names. Display only:
       * `canonicalize` does not see it, so it binds nothing.
       */
      readonly confirmLabel?: string;
      /**
       * The one line under that input — the part of an MCP dialog a folding
       * host shows without expanding. Optional; absent means the seam's
       * generic line. Same on every host: a registrant may NAME a host inside
       * the sentence, but no backend branches on which client connected.
       * Display only, binds nothing. An unprintable one is DROPPED (the
       * generic line is shown), never a refusal; the MCP backend likewise
       * drops one wider than a dialog line.
       */
      readonly confirmDescription?: string;
      /**
       * The same rows, spelled for a dialog whose MESSAGE shows only its first
       * line (an MCP elicitation on Claude Code): a different first line and
       * the rows under it. Optional; only the MCP backend reads it, and the
       * native backend keeps `title` and `description` exactly. Screened like
       * the primary; an unshowable one is DROPPED (the primary is shown),
       * never a refusal. Display only: it binds nothing, and like `folded` it
       * must describe the same action on the same snapshot.
       */
      readonly firstScreen?: { readonly title: string; readonly description: readonly string[] } }
  | { readonly kind: 'refuse'; readonly reason: string };

export interface OwnerApprovalSubjectDescriptor {
  /**
   * The bytes this approval binds. MUST be pure and total: same input, same
   * output, and never throws — it is called once when the prompt is built and
   * again when the tool body consumes the answer, and a throw on the second
   * call would turn a granted approval into a crash rather than a refusal.
   * Reject a malformed call from `describe` instead.
   */
  canonicalize(params: unknown): ApprovalSubject;
  /**
   * What the owner reads, or a named refusal. The description must carry the
   * real values, not a summary of them — see the budget below for what fits.
   *
   * SIDE-EFFECT FREE BY CONTRACT. It inspects `params` and returns what the
   * owner should see. It delivers nothing, writes nothing, sends nothing, and
   * does no IO of any kind. It runs BEFORE the owner has decided, so anything
   * it did would also have happened on a deny — which is why the permission
   * does not exist at all rather than being narrowly scoped.
   *
   * If a subject has content that cannot fit the prompt, that content is
   * delivered by the registrant's OWN earlier step, not from here, and bound
   * by putting its immutable digest inside `canonicalize`'s output; the seam
   * then binds it with everything else and needs no extra API for it. If that
   * earlier delivery did not happen, return `refuse` with a named reason
   * rather than delivering late.
   *
   * `profile` is supplied by the BACKEND, never by tool parameters. The seam
   * resolves a subject's numeric budget override without changing the host's
   * content policy or layout, and screens against that resolved budget.
   * Absent on a direct call means the native profile.
   */
  describe(params: unknown, profile?: ApprovalDialogProfile): Promise<ApprovalSubjectResult> | ApprovalSubjectResult;
  /**
   * A budget this subject brings with it, used INSTEAD of the asking
   * backend's. For a subject that relies on the seam's screen to bound what
   * it shows (it composes to the native budget and expects over-budget to be
   * refused) rather than composing to whatever budget it is handed: without
   * this it would silently inherit a larger one on another backend.
   */
  readonly displayBudget?: ApprovalDisplayBudget;
  /**
   * A last check made right before the owner is asked, after `describe`: a
   * non-null reason refuses the call by that name and nothing is asked. For a
   * subject whose prompt depends on state outside the parameters that can
   * change under it (a file the owner was pointed at). Read-only like
   * `describe`; a throw is a refusal.
   */
  beforeAsk?(params: unknown): string | null;
}

/** No owner allowlist is configured at all, so the host's owner flag cannot
 *  become true on this channel no matter who sends. Separate from
 *  `ORIGIN_NOT_OWNER_DIRECT` because one is a thing to fix and the other is
 *  this guard doing its job. Once a list exists the two are indistinguishable
 *  from here, and `readOwnerAllowlistState` says exactly why. */
export const OWNER_ALLOWLIST_UNCONFIGURED = 'OWNER_ALLOWLIST_UNCONFIGURED';
/**
 * Why no approval is available. A closed set, because these situations owe the
 * owner different sentences and one shared code is exactly the defect this lane
 * spent a day removing one layer down.
 *
 * THE ROUTE REFUSALS ARE MEMBERS OF IT, not a parallel vocabulary. They were
 * carefully named and then reached nobody: the hook discarded them and
 * `consumeOwnerApproval` answered `ORIGIN_NOT_OWNER_DIRECT` for all of them, so
 * every distinguishable fact arrived at a tool body as one. The defect was
 * never the naming — it was that nothing downstream could tell them apart. This
 * array is the type (see `OWNER_APPROVAL_ROUTE_REFUSALS`), every entry is driven
 * to a caller by `tests/unit/host/owner-approval-reasons.test.ts`, and the
 * seam's own transport for them is `originRefusals` below.
 */
/**
 * How an MCP approval dialog ended WITHOUT an answer and WITHOUT our window
 * closing. Defined here, once, and re-exported by the world action's MCP
 * dialog (`mcp-owner-authorization.ts`), so one name means one thing on both
 * paths. Only our own window closing is a timeout; each of these owes the
 * owner a different sentence, and none of them is ever consent.
 */
/** The host closed the dialog without an answer (MCP `action: 'cancel'`). */
export const OWNER_CONFIRMATION_CANCELLED = 'OWNER_CONFIRMATION_CANCELLED';
/** The dialog failed: the client went away, the transport broke, or the SDK
 *  raised anything other than our own timeout or an unreadable answer. */
export const OWNER_CONFIRMATION_FAILED = 'OWNER_CONFIRMATION_FAILED';
/** The owner answered, but the host's answer did not match the form we asked.
 *  Its own code because the cause is the HOST, not the owner and not the action:
 *  the SDK validates an accepted `content` against `requestedSchema`, so a host
 *  that returns an untouched optional field as `null` instead of omitting it
 *  loses a confirmation the owner already gave. Nothing is granted either way;
 *  what this code buys is that the person is told which of the three it was. */
export const OWNER_CONFIRMATION_ANSWER_INVALID = 'OWNER_CONFIRMATION_ANSWER_INVALID';
/** The call itself ended while the dialog was open: the host aborted the tool
 *  call, or the root shut down. Not our window closing, and not consent. */
export const OWNER_CONFIRMATION_INACTIVE = 'OWNER_CONFIRMATION_INACTIVE';
export const OWNER_APPROVAL_DIALOG_FAILURES = [
  OWNER_CONFIRMATION_CANCELLED, OWNER_CONFIRMATION_FAILED, OWNER_CONFIRMATION_ANSWER_INVALID,
  OWNER_CONFIRMATION_INACTIVE,
] as const;
/** Every named way an MCP dialog can end without an answer, other than our
 *  own window closing. `APPROVAL_SURFACE_ABSENT` is already a reason ("this
 *  host cannot ask") and is reused, not redefined, for a client gone before
 *  the dialog was sent. */
export type OwnerApprovalDialogFailure =
  | typeof OWNER_APPROVAL_DIALOG_FAILURES[number] | 'APPROVAL_SURFACE_ABSENT';
const isDialogFailure = (value: unknown): value is OwnerApprovalDialogFailure =>
  value === 'APPROVAL_SURFACE_ABSENT' || (OWNER_APPROVAL_DIALOG_FAILURES as readonly unknown[]).includes(value);

export const OWNER_APPROVAL_UNAVAILABLE_REASONS = [
  'APPROVAL_SURFACE_ABSENT', 'ORIGIN_NOT_OWNER_DIRECT', 'SUBJECT_NOT_REGISTERED',
  'SUBJECT_REFUSED', 'SUBJECT_CHANGED', 'ALREADY_CONSUMED',
  /** This host gave no usable call identity. Refused, never matched on the
   *  parameters alone: that fallback is the hole restated. */
  'CALL_IDENTITY_ABSENT',
  /** An answer exists for these exact parameters — but for a DIFFERENT call.
   *  Without this, a second call carrying byte-identical parameters, from a
   *  group turn or authored by the model, could reach its body first and spend
   *  a grant the owner gave to the call in front of them. The origin guard
   *  refuses to ASK on an unsafe origin; this is what stops an unsafe origin
   *  CONSUMING what a safe one was granted. */
  'CALL_MISMATCH',
  OWNER_ALLOWLIST_UNCONFIGURED,
  ...OWNER_APPROVAL_ROUTE_REFUSALS,
  ...OWNER_APPROVAL_DIALOG_FAILURES,
] as const;
export type OwnerApprovalUnavailableReason = typeof OWNER_APPROVAL_UNAVAILABLE_REASONS[number];
/** What the origin guard can answer: every route refusal, the setup mistake,
 *  and "the host says this sender is not the owner". All three are members of
 *  `OwnerApprovalUnavailableReason`, which is what lets the seam hand any of
 *  them to a tool body unchanged instead of flattening them. */
export type OwnerApprovalOriginRefusal =
  | OwnerApprovalRouteRefusal | typeof OWNER_ALLOWLIST_UNCONFIGURED | 'ORIGIN_NOT_OWNER_DIRECT';

export type OwnerApprovalOutcome =
  | { readonly decision: 'approved' }
  | { readonly decision: 'denied' }
  | { readonly decision: 'timeout' }
  | { readonly decision: 'unavailable';
      readonly reason: OwnerApprovalUnavailableReason; readonly detail?: string };

/** Characters the host would escape to `\u{XX}` (lengthening the text it then
 *  measures) or that paint nothing at all — the host's own invisible class at
 *  `dist/exec-approval-text-sanitize-Di2YnUSG.mjs:6`. A prompt has no use for
 *  any of them, so a subject carrying one is refused rather than counted.
 *
 *  EVERY LINE SEPARATOR IS IN THIS CLASS, and that is load-bearing: `\p{Cc}`
 *  covers `\n` `\r` `\v` `\f` and U+0085, `\p{Zl}` covers U+2028 and `\p{Zp}`
 *  covers U+2029; `\r\n` is caught because both halves are. The seam tests each
 *  ROW of the description with this class and then joins the rows itself, so a
 *  registrant has no way to express a line break inside a value — a new line
 *  is an array element, and only registrant code writes those.
 *
 *  WHAT THIS COMMENT USED TO SAY WAS FALSE. It claimed `\n` "is checked per
 *  LINE below"; the check was `description.split('\n').some(line => ...)`,
 *  and `split` removes the newlines before the class ever sees them. The check
 *  was vacuous for the one character it named. Do not reintroduce a flat
 *  description: with one string the seam cannot separate the newlines the
 *  registrant meant from the ones a parameter value carried. */
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000\u115F\u1160\u3164\uFFA0]/u;
/** The seam's own class, exported so a registrant can screen its RAW values
 *  and keys against exactly what the seam will screen the rendered rows with.
 *  Belt and braces: the array shape already makes injection inexpressible, and
 *  this makes a malformed value an explicit, named refusal from the registrant
 *  rather than a generic one from the seam. */
export function hasInvisibleCharacter(text: string): boolean { return INVISIBLE.test(text); }
/**
 * The surfaces this release will ask on.
 *
 * WHAT THIS GUARD DOES AND DOES NOT ESTABLISH — corrected after review, which
 * overturned the argument that was here before.
 *
 * The host delivers a pending approval down a ladder
 * (`dist/approval-shared-ouR8XZ--.mjs:347-353`). It tries the FORWARDER first:
 * `delivered` is computed at `:347`, BEFORE `hasTurnSourceRoute` is evaluated
 * at `:348`, and the forwarder delivers into the conversation resolved from
 * the approval's own `sessionKey`. There is an iOS push route as well. So the
 * earlier claim — "on `webchat`/`tui` the host has no chat to fall back into"
 * — was too strong: a forwarder target IS a conversation, and whether a
 * `tui`/`webchat` session resolves to a deliverable one is UNVERIFIED here.
 *
 * What the guard does establish is narrower and still worth having: the
 * TURN-SOURCE fallback at `:353` — the path that would put the prompt, with
 * the real values in it, into whatever chat the turn came from, which is the
 * one surface the model's own context can steer — is unavailable for exactly
 * the channels this set admits. `hasApprovalTurnSourceRoute` (`:146-155`)
 * returns false for MORE than these two (also for an absent or unnormalizable
 * channel, and for any channel whose initiating surface is not `enabled`), so
 * admitting only `webchat` and `tui` is strictly tighter than the host's own
 * predicate rather than a restatement of it.
 *
 * These two are admitted WITHOUT reading any instance configuration: the
 * property holds for them whatever an operator has or has not set.
 *
 * The value compared is `ctx.requester.channel`, which is the very variable
 * the host later passes as `turnSourceChannel` (both read one local
 * `turnSourceChannel` at `dist/agent-tools-DXxcrXNI.mjs:733`, used at `:736`
 * and `:761`) — so this is the same string the delivery ladder will see.
 *
 * THE SECOND WAY IN, ADDED AFTER THE RULING OF 2026-09-21T20:09Z. Any other
 * channel may be admitted for one call when the host's RUNTIME-EFFECTIVE
 * approval routing would deliver that call's prompt only to the owner — see
 * `owner-approval-route.ts`, which owns every part of that question. The
 * safety then rests on delivery being pinned, not on proving the turn was a
 * direct chat, which the survey established cannot be proved from this context
 * at all. `senderIsOwner === true` is still required on top of it: a pinned
 * route says where the prompt GOES, never who asked.
 */
const OWNER_DIRECT_CHANNELS: ReadonlySet<string> = new Set(['webchat', 'tui']);

/** Only the fields of the host's typed hook event the seam reads. */
export interface OwnerApprovalToolEvent {
  toolName: string;
  params: unknown;
  toolCallId?: string;
}
/** Only the fields of `PluginHookToolContext` the seam reads. The host's own
 *  doc comment on `requester` says authorization hooks must fail closed when a
 *  required field is absent, which is what happens below. */
export interface OwnerApprovalToolContext {
  toolCallId?: string;
  /** Both are on the host's context (`buildToolContext`,
   *  `dist/agent-tools.before-tool-call-WtmCO7BO.mjs:2730-2731`) and both are
   *  the SAME values the host later puts on the approval request it routes
   *  (`:985-986`) — so the filter test below is run against this call's own
   *  route request and not against a lookalike. */
  agentId?: string;
  sessionKey?: string;
  /** The turn's own destination. This is `options.hookChannelId ??
   *  options.currentChannelId` (`dist/agent-tools-DXxcrXNI.mjs:759`), which is
   *  the host's `turnSourceTo` (`:734`) unless a channel's threading adapter
   *  supplied a `currentMessagingTarget`. */
  channelId?: string;
  /**
   * The host's own routing variable for the same turn, `currentMessagingTarget
   * ?? currentChannelId` (`:734`), which IS projected onto the hook context
   * (`:762`) — an earlier note here said it was not, and that was wrong for
   * this bundle. It is absent from the DECLARED type
   * (`PluginHookToolContext`, `agent-harness-runtime-BvaKEkqR.d.ts:1700-1722`,
   * which ends at `requester`), so it is declared here as optional and read
   * defensively: present and equal is the only thing it adds, and absent
   * leaves the check exactly as it was. `owner-approval-route.ts`'s
   * `turnSourceTo` argues why that asymmetry is deliberate.
   */
  turnSourceTo?: string;
  requester?: {
    readonly channel?: string;
    readonly accountId?: string;
    readonly senderId?: string;
    readonly senderIsOwner?: boolean;
  };
}
/** Exactly the subset of `PluginHookBeforeToolCallResult` the seam returns.
 *  Declared here rather than imported so this module stays testable without
 *  the host types, and structurally assignable to them. */
export interface OwnerApprovalRequest {
  requireApproval: {
    title: string;
    description: string;
    severity: 'critical';
    allowedDecisions: ['allow-once', 'deny'];
    timeoutMs: number;
    onResolution(decision: string): void;
  };
}

/**
 * How long ANY owner-approval dialog stays answerable — the one value, on every
 * host and every dialog: this seam's native prompt, its MCP dialog, and the
 * world action's own MCP dialog (`mcp-owner-authorization.ts` imports it rather
 * than keeping its own). Two copies of this number drifted before; one cannot.
 *
 * 360 s is the owner's floor (2026-09-26): a long letter is read by expanding a
 * folded dialog, and 120 s lost a real approval. It must stay under every
 * host's own ceiling, or the host kills the call before this window answers:
 * OpenClaw caps a plugin approval at 600 s (`MAX_PLUGIN_APPROVAL_TIMEOUT_MS`,
 * `openclaw/dist/plugin-approvals-*.mjs:5`); Claude Code aborts a silent stdio
 * MCP call after `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT`, 1 800 s by default.
 * `POPCLAW_OWNER_APPROVAL_TIMEOUT_SECONDS` may raise it on MCP, within bounds.
 *
 * The seconds live in `approval-window.mjs`, which setup reads too: Codex's
 * `tool_timeout_sec` is derived there from the same numbers.
 */
export const OWNER_APPROVAL_WINDOW_MS = OWNER_APPROVAL_WINDOW_SECONDS * 1000;
/** An answer nobody came back for must not sit in memory for the life of the
 *  Gateway. Well past the host's own approval ceiling. */
const RECORD_TTL_MS = 900_000;
/** A long-lived Gateway sees an unbounded number of calls, so the store is
 *  bounded: a diagnostic must never become a leak. */
const MAX_RECORDS = 64;

interface ApprovalRecord {
  readonly toolName: string;
  readonly callRef: string;
  readonly subject: ApprovalSubject;
  readonly at: number;
  /** A descriptor that refused names itself here, so the tool body learns WHY
   *  it was never asked rather than inferring it from silence. Mutable only so
   *  the seam can record a backend's `unreadable` answer as the refusal it is;
   *  no backend ever touches a record. */
  refused: string | null;
  decision: string | null;
  /** An MCP dialog that ended without an answer for a reason other than our
   *  window closing. Written only by `askOwnerApprovalBeforeDispatch`, never by
   *  a host's `onResolution`, so the native path's decision table is untouched. */
  failed: OwnerApprovalDialogFailure | null;
  /** The registrant offered a folded rendering and the seam dropped it because
   *  it did not pass the same screen the primary did. Kept so that a backend
   *  which then cannot render the primary either is answered by NAME rather
   *  than with the generic "this host could not render the dialog" — those are
   *  two different things to go and fix, and one of them is a defect in the
   *  registrant nobody would otherwise ever hear about. */
  readonly foldedDropped: boolean;
}

const subjects = new Map<string, OwnerApprovalSubjectDescriptor>();
/** Keyed by `toolName` + NUL + the host's own call identity — NOT by the
 *  subject. One answer authorizes the CALL the owner was asked about, and the
 *  parameters are then checked against it; keying the other way round would
 *  let any call carrying the same bytes spend the answer.
 *
 *  On the OpenClaw native host both sides have that identity and it is
 *  provably the same value: inside one wrapper `execute(toolCallId, …)`
 *  (`dist/agent-tools.before-tool-call-WtmCO7BO.mjs:3196`) the hook is run with
 *  `{ …, toolCallId, … }` (`:3313`) and the tool body with the same
 *  `toolCallId` placed in the argument list at `:3391` and invoked at `:3397`
 *  — one local variable, never reassigned or shadowed between them. The plugin
 *  already threads that first `execute` parameter through as `callId`.
 *
 *  THE PREMISE THIS BINDING RESTS ON, WRITTEN DOWN BECAUSE IT IS NOT ENFORCED
 *  HERE: the ACTOR is not part of the key and is not part of any registrant's
 *  canonical subject. That is sound only while one process serves ONE actor.
 *  It does today — the actor is fixed at boot (`src/index.ts` `boot.popclawId`)
 *  and re-checked downstream (`src/runtime/world-runtime.ts`, `actorId !==
 *  this.options.actorId`) — so no cross-actor confusion is reachable inside one
 *  Gateway. A second registrant on a multi-identity surface, or a process that
 *  ever serves more than one actor, MUST NOT assume the seam binds identity:
 *  the actor would have to go into the registrant's `canonicalize` output (and
 *  into what the owner reads), or into this key. */
const records = new Map<string, ApprovalRecord>();
/** Keys whose answer has already authorized their call. Kept so a second
 *  consume is told it is a REPLAY rather than being handed the same sentence
 *  as a call nobody ever approved. */
const consumed = new Set<string>();
/**
 * THE ONE ROUTE A NAMED ORIGIN REFUSAL HAS OUT OF THIS MODULE.
 *
 * The seam's hook can only answer the host with `requireApproval` or with
 * nothing, so a refusal returned from `ownerApprovalBeforeToolCall` reaches no
 * one — which is how every distinct reason became one `ORIGIN_NOT_OWNER_DIRECT`
 * by the time a tool body read them. The body's own call to
 * `consumeOwnerApproval` is the moment a person can be told, so the refusal is
 * left here under the same key the answer would have used, and that call picks
 * it up. Nothing is admitted by this: every entry here is a call that was
 * refused, and it stays refused.
 *
 * NOT part of `ownerApprovalRecorded`: an origin refusal means the owner was
 * never asked, so the call must keep whatever authorization it had before this
 * seam existed. Bounded and swept exactly like `records` — a diagnostic must
 * never become a leak.
 */
const originRefusals = new Map<string, { readonly reason: OwnerApprovalOriginRefusal; readonly at: number }>();
let surfacePresent = false;
let clock: () => number = () => Date.now();

const codePoints = (text: string): number => [...text].length;
const recordKey = (toolName: string, callRef: string): string => `${toolName}\0${callRef}`;

/**
 * Declare that one tool's calls are owner-approved. Pure declaration, called
 * beside the tool's own registration: it acquires nothing and does no IO
 * (ADR-0035 — `register()` only declares). Re-registering the same tool name
 * replaces the descriptor, so a reload is not an error.
 */
export function registerOwnerApprovalSubject(toolName: string, descriptor: OwnerApprovalSubjectDescriptor): void {
  subjects.set(toolName, descriptor);
}

/**
 * Whether this host can ask the owner at all. Set once by the host backend,
 * and only after the host actually accepted the registration — this plugin has
 * two hook tables and registering into the wrong one fails silently, so an
 * unproven surface must not advertise itself.
 */
export function setOwnerApprovalSurface(present: boolean): void { surfacePresent = present; }
export function ownerApprovalSurfacePresent(): boolean { return surfacePresent; }
/** Gateway shutdown, and the one seam a test resets through. */
export function resetOwnerApprovals(options?: { now?(): number }): void {
  subjects.clear(); records.clear(); consumed.clear(); originRefusals.clear(); surfacePresent = false;
  clock = options?.now ?? (() => Date.now());
}

function sweep(now: number): void {
  for (const [key, record] of records) if (now - record.at > RECORD_TTL_MS) records.delete(key);
  while (records.size >= MAX_RECORDS) records.delete(records.keys().next().value!);
  while (consumed.size >= MAX_RECORDS) consumed.delete(consumed.values().next().value!);
  for (const [key, noted] of originRefusals) if (now - noted.at > RECORD_TTL_MS) originRefusals.delete(key);
  while (originRefusals.size >= MAX_RECORDS) originRefusals.delete(originRefusals.keys().next().value!);
}
/** Leave a refused call the name of what refused it, for the tool body that is
 *  about to ask. Silently does nothing without a call identity: there would be
 *  no key to leave it under, and inventing one is the hole this seam exists to
 *  close. */
function noteOriginRefusal(toolName: string, callRef: unknown, reason: OwnerApprovalOriginRefusal): void {
  const call = callIdentity(callRef);
  if (call === null) return;
  const now = clock();
  sweep(now);
  originRefusals.set(recordKey(toolName, call), { reason, at: now });
}
/** Total by construction: a descriptor that throws here is a broken registrant,
 *  and the seam refuses rather than letting the throw escape into the host. */
/**
 * A throw from a registrant is a fact about the registrant, not something to
 * put in front of the owner or the model: NOTHING of the error survives it.
 *
 * It used to keep the constructor name — `DESCRIBE_THREW_TypeError` — which was
 * already more than a refusal name owes anyone, and became a real leak once
 * every refusal began printing its reason verbatim to the agent: the one frame
 * that promises "no exception text, no class names" would have been printing a
 * class name. Dropped HERE, where it is made, rather than filtered by each
 * reader; this module has no logger, so it is kept nowhere else either. What
 * was diagnosable still is — the refusal says a registrant's `describe` threw,
 * which is the fact that decides what to go and read.
 */
const DESCRIBE_THREW = 'DESCRIBE_THREW';
/** The same, for a registrant's `beforeAsk`. */
const BEFORE_ASK_THREW = 'BEFORE_ASK_THREW';
function refusalOf(): string { return DESCRIBE_THREW; }
/** The host's own identity for one tool call, or nothing. Never invented. */
function callIdentity(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}
function canonicalizeSafely(descriptor: OwnerApprovalSubjectDescriptor, params: unknown): ApprovalSubject | null {
  try {
    const subject = descriptor.canonicalize(params);
    return typeof subject === 'string' ? subject : null;
  } catch { return null; }
}
/**
 * The origin guard. Runs in the seam, BEFORE any descriptor is called, so a
 * registrant cannot cause a prompt on an unsafe surface even by mistake — and
 * `describe`'s one permitted side effect (a preview to the owner) cannot reach
 * a surface that is not the owner's. It is also before the `requireApproval`
 * object exists, so nothing carrying the body has been built when it refuses.
 *
 * `ownerApprovalOriginRefusal` is the same decision with the reason kept, for
 * a caller that has to tell a person WHY; the boolean is the seam's own use.
 *
 * ASYNC BECAUSE THE HOST PACKAGE IS LOADED ON USE — NOT BECAUSE ANYTHING WAITS
 * FOR AN ANSWER. `owner-approval-route.ts` imports `openclaw` dynamically,
 * because a static import of it stopped the MCP composition root from starting
 * at all (see that file's header). NOTHING ABOUT WHEN THIS DECISION IS MADE HAS
 * MOVED: the sole production caller, `ownerApprovalBeforeToolCall`, was already
 * async, already called this FIRST, and now awaits it in the same place — still
 * before `prepare` runs any descriptor and still before the `requireApproval`
 * object carrying the body exists.
 */
export async function ownerApprovalOriginRefusal(
  ctx: OwnerApprovalToolContext | undefined, readers?: Partial<OwnerApprovalRouteReaders>,
): Promise<OwnerApprovalOriginRefusal | null> {
  const channel = ctx?.requester?.channel?.trim().toLowerCase() ?? '';
  // "Can run commands" is not ownership, and the host tells them apart
  // (`dist/command-auth-D4uAtGGe.mjs:330-332`). Only this flag is accepted.
  if (ctx?.requester?.senderIsOwner !== true) {
    // A MIS-SPELLED OWNER ALLOWLIST USED TO LOOK EXACTLY LIKE "you are not the
    // owner", and that silence is the failure this project is most wary of.
    // Off `webchat` — the only channel where the scope producer can fire — an
    // absent owner allowlist makes the flag false for everyone forever, which
    // is a setup mistake rather than this guard working.
    return channel !== 'webchat' && await readOwnerAllowlistState(readers) === 'unconfigured'
      ? OWNER_ALLOWLIST_UNCONFIGURED : 'ORIGIN_NOT_OWNER_DIRECT';
  }
  if (OWNER_DIRECT_CHANNELS.has(channel)) return null;
  const route = await resolveOwnerApprovalRoute({
    channel: ctx.requester.channel ?? null,
    accountId: ctx.requester.accountId ?? null,
    to: ctx.channelId ?? null, turnSourceTo: ctx.turnSourceTo ?? null,
    agentId: ctx.agentId ?? null, sessionKey: ctx.sessionKey ?? null,
  }, readers);
  return route.pinned ? null : route.reason;
}
export async function isOwnerDirectOrigin(
  ctx: OwnerApprovalToolContext | undefined, readers?: Partial<OwnerApprovalRouteReaders>,
): Promise<boolean> {
  return await ownerApprovalOriginRefusal(ctx, readers) === null;
}
/**
 * What the owner cannot read whole, the owner cannot approve. Never shortened:
 * what gets acted on must be exactly what the human read.
 *
 * Returns the NAME of the refusal, or null when the prompt may be shown. The
 * names are separate on purpose — "too long" and "carries a character that
 * paints nothing" are different facts and a reader of the refusal was
 * previously told the wrong one.
 *
 * ORDER MATTERS: every row is screened for invisibles BEFORE anything is
 * joined. Screening after the join is the bug this function was rewritten to
 * remove, because a joined string no longer distinguishes the newlines the
 * registrant put between rows from the ones a value carried.
 */
function presentable(result: { title: string; description: readonly string[] },
  budget: ApprovalDisplayBudget): string | null {
  if (INVISIBLE.test(result.title)) return 'APPROVAL_PROMPT_UNPRINTABLE';
  if (codePoints(result.title) > APPROVAL_TITLE_BUDGET) return 'APPROVAL_PROMPT_TOO_LONG';
  // A prompt with no rows shows the owner nothing to approve.
  if (result.description.length === 0) return 'APPROVAL_PROMPT_EMPTY';
  if (result.description.length > budget.maxLines) return 'APPROVAL_PROMPT_TOO_MANY_LINES';
  for (const line of result.description) {
    if (typeof line !== 'string' || INVISIBLE.test(line)) return 'APPROVAL_PROMPT_UNPRINTABLE';
  }
  if (approvalTextSize(joinDescription(result.description), budget) > budget.descriptionMax) return 'APPROVAL_PROMPT_TOO_LONG';
  return null;
}
/** The registrant's pre-ask check (`beforeAsk`), total: a throw refuses. */
function beforeAskRefusal(descriptor: OwnerApprovalSubjectDescriptor, params: unknown): string | null {
  if (!descriptor.beforeAsk) return null;
  try { return descriptor.beforeAsk(params); } catch { return BEFORE_ASK_THREW; }
}
/** A registrant's confirmation label is prompt text like its title and gets the
 *  title's screen. Absent is fine: the backend then uses the generic label. */
function labelRefusal(label: string | undefined): string | null {
  if (label === undefined) return null;
  if (typeof label !== 'string' || label.trim() === '' || INVISIBLE.test(label)) return 'APPROVAL_PROMPT_UNPRINTABLE';
  if (codePoints(label) > APPROVAL_TITLE_BUDGET) return 'APPROVAL_PROMPT_TOO_LONG';
  return null;
}
/** The seam owns the join. A registrant never produces the separator, which is
 *  why a registrant cannot produce a row. */
function joinDescription(lines: readonly string[]): string { return lines.join('\n'); }

/**
 * The OpenClaw native backend: a typed `before_tool_call` handler.
 *
 * Returns `requireApproval` only for a registered subject, asked by the owner,
 * on an owner-direct surface, that describes itself readably — and returns
 * NOTHING in every other case. It never returns `block`: blocking would take
 * down whatever authorization a tool already had, and this seam is meant to be
 * strictly additive to it. A tool that must not run without an approval
 * enforces that itself, by reading `consumeOwnerApproval`'s outcome.
 *
 * RESIDUAL — THE EMBEDDED-MODE BROKER HAS NO APPROVER AUTHORIZATION. This was
 * an open unknown; review closed it, and the answer is unfavourable. The
 * gateway route's whole identity chain — `/approve` gated on sender identity
 * (`dist/commands-approve-DFjnxxOt.mjs:143-145`), the delivery ladder, the
 * trigger/surface check — belongs to `requestPluginToolApproval`. An embedded
 * host installs its own broker (`getEmbeddedPluginApprovalBroker`, defined at
 * `dist/agent-tools.before-tool-call-WtmCO7BO.mjs:686-688`, call site
 * `:919-962`), and that path RETURNS at `:943-962`: it never reaches the
 * `:964` trigger/surface check, performs no sender-identity check, has no
 * channel custody and runs no delivery ladder. Its only trust boundary is
 * `isEmbeddedMode()` plus whoever called `setEmbeddedPluginApprovalBroker`.
 *
 * On such a host "the owner answered" means no more than "the embedder
 * answered", and this seam cannot tell the difference: the resolution arrives
 * through the same `onResolution` callback either way. Everything else here
 * still holds — single use, the call binding, the canonical-byte comparison —
 * so an approval still authorizes exactly one call with exactly the bytes it
 * was given for. What is NOT established on an embedded host is WHO gave it.
 *
 * STILL UNKNOWN, and it is the question that decides how much this matters:
 * WHICH INSTALL SHAPES RUN IN EMBEDDED MODE. Nobody has established that any
 * PopClaw install does, or that none does. Until someone has, an operator
 * deploying this cannot be told it does not apply to them — which is why it is
 * also written into `docs/known-limitations.md` rather than living only here.
 */
export async function ownerApprovalBeforeToolCall(
  event: OwnerApprovalToolEvent, ctx: OwnerApprovalToolContext,
  /** The host's own route readers; a caller supplies them only to state a
   *  route instead of standing up a Gateway. The native registration passes
   *  nothing, so production always reads the real runtime snapshot. */
  readers?: Partial<OwnerApprovalRouteReaders>,
): Promise<OwnerApprovalRequest | undefined> {
  const descriptor = event?.toolName ? subjects.get(event.toolName) : undefined;
  if (!descriptor || !surfacePresent) return undefined;
  // FIRST, and before `prepare` runs any descriptor or any object carrying the
  // body exists: a refusal here has shown nobody anything.
  //
  // THE REASON IS KEPT, not recomputed as a boolean and dropped. The host's
  // hook contract has nowhere to put it — the only answers are `requireApproval`
  // or nothing — so it is left under this call's own key for the tool body's
  // `consumeOwnerApproval` to collect. Reading the name is the only thing that
  // changes; the call is refused either way.
  const refusal = await ownerApprovalOriginRefusal(ctx, readers);
  if (refusal !== null) {
    noteOriginRefusal(event.toolName, ctx?.toolCallId ?? event.toolCallId, refusal);
    return undefined;
  }
  // No call identity, no approval: a grant that is not tied to one call is a
  // grant any call with the same bytes could spend.
  const callRef = callIdentity(ctx?.toolCallId ?? event.toolCallId);
  if (callRef === null) return undefined;
  const prepared = await prepare(event.toolName, event.params, callRef, NATIVE_APPROVAL_PROFILE);
  if (!prepared) return undefined;
  return {
    requireApproval: {
      title: prepared.prompt.title, description: prepared.prompt.description, severity: 'critical',
      // `allow-always` is never offered. A decision outside this set is not
      // consent and the host converts it to a timeout before it reaches us.
      allowedDecisions: ['allow-once', 'deny'], timeoutMs: prepared.prompt.timeoutMs,
      // Notification-style in the host: called synchronously, and nothing
      // async started here is awaited. One assignment, nothing else.
      onResolution: (decision: string): void => { prepared.record.decision = decision; },
    },
  };
}

/**
 * The OpenClaw native backend's OTHER HALF: a typed `after_tool_call` handler.
 *
 * WHAT IT ANSWERS, AND ONLY THIS: was a grant taken and never consumed? A
 * registrant's tool body is what turns the owner's answer into a decision, by
 * calling `consumeOwnerApproval`. A body that never calls it still had the
 * owner asked and still had an answer recorded — and then ran regardless. That
 * failure shipped once (`popclaw_world_invoke` under MCP) and it was
 * completely silent, because "nobody consumed it" looks exactly like
 * "everything went fine".
 *
 * WHY IT EXISTS NOW. The MCP root has reported this since the round that
 * introduced `discardUnconsumedOwnerApproval`; the native host was written up
 * as having "no after-dispatch moment" and was left silent. That was WRONG.
 * `after_tool_call` is on the same typed `api.on` table this seam already uses
 * for `before_tool_call` (`PluginHookName`,
 * `openclaw/dist/plugin-entry-Cc00OvUf.d.ts:7107`), it is emitted for every
 * completed tool call by the embedded agent runner, and its event carries the
 * `toolCallId` this seam keys records on
 * (`openclaw/dist/plugin-entry-Cc00OvUf.d.ts:7587`). So the guard is symmetric.
 *
 * CITE FILE AND LINE TOGETHER. A bare line number is ambiguous here: the
 * installed gateway ships the SAME declarations in several bundled `.d.ts`
 * entries, and only the line numbers differ — `PluginHookName` is at `:7107`
 * in `plugin-entry-Cc00OvUf.d.ts`, `:19918` in `plugin-entry-C9jaZrZv.d.ts`
 * and `:1269` in `agent-harness-runtime-BvaKEkqR.d.ts`. That last one is why
 * `:1269` was once copied onto the wrong file name in this very comment.
 *
 * REPORT ONLY, and the host agrees — though not for the reason first written
 * down here. The hook's declared return type is `Promise<void> | void`, and
 * the typed runner DOES await each handler: `runVoidHook` wraps it in
 * `Promise.resolve(...)` and awaits it
 * (`openclaw/dist/hook-runner-global-BhDCl4qm.mjs:783-797`), with no default
 * timeout for this hook name (`:451-459` lists none). What makes losing this
 * harmless is that the runner CATCHES: a throw goes to `handleHookError`
 * (`:700-707`), which for a fail-open hook — every hook but `before_agent_run`
 * (`:504`) — logs and returns. Above that the two emitters differ again: the
 * embedded runner fires and forgets with `.catch(...)`
 * (`builtin-openclaw-B-H-7lKk.mjs:3876-3884`) while the harness relay awaits
 * inside its own try/catch (`hook-helpers-CoFqzDGy.mjs:16-35`). Nothing here
 * refuses, retries, or touches the tool's result. By the time a body has
 * returned, refusing would change what already happened rather than what is
 * visible.
 *
 * TWO THINGS IT DELIBERATELY DOES NOT DO.
 *
 *   - It does NOT guess a call. `toolCallId` is optional on this event; with
 *     none there is no key, and a grant attributed to the wrong call would
 *     make this error line name a registrant that DID consume. So it says it
 *     could not attribute anything, drops nothing, and falls back to matching
 *     on nothing — not the tool name, not the parameters, not the one record
 *     that happens to be live.
 *   - It does NOT look at origin. This hook's context is built without a
 *     `requester` (`openclaw/dist/hook-helpers-CoFqzDGy.mjs`, and the embedded
 *     runner's own call site), unlike `before_tool_call`, which assembles one
 *     explicitly. It needs none: whether a grant was spent is a fact about the
 *     record, not about who asked.
 *
 * THE CONTRACT THIS PLACES ON A REGISTRANT, same as the MCP seam's: consume
 * WITHIN YOUR OWN PROMISE. This fires once the tool body has settled, so a
 * registrant that consumes afterwards finds its grant already dropped and is
 * told `ALREADY_CONSUMED` — fail closed, but surprising if nobody wrote it
 * down.
 */
export interface OwnerApprovalAfterToolEvent {
  readonly toolName?: string;
  readonly toolCallId?: string;
}
export function ownerApprovalAfterToolCall(
  event: OwnerApprovalAfterToolEvent | undefined,
  ctx: { readonly toolCallId?: string } | undefined,
  report: (message: string) => void,
): void {
  const toolName = event?.toolName;
  // Every tool on this host fires this hook. Only a registered subject can
  // ever have a grant, so only a registered subject may be spoken about: a
  // guard that narrated the rest would bury its own one report.
  if (!toolName || !subjects.has(toolName)) return;
  const callRef = callIdentity(ctx?.toolCallId ?? event?.toolCallId);
  if (callRef === null) return say(report, unattributableGrantReport(toolName));
  if (discardUnconsumedOwnerApproval(toolName, callRef)) {
    say(report, unconsumedGrantReport(toolName, callRef));
  }
}

/** A host logger that throws must not become a thrown hook: this guard's whole
 *  promise is that it changes nothing but visibility. The report is what is
 *  lost, never the drop — which has already happened by the time we speak. */
function say(report: (message: string) => void, message: string): void {
  try { report(message); } catch { /* the report is lost; nothing else is. */ }
}

/** The one sentence BOTH roots report this defect with. Restated per root, it
 *  would give a person grepping their logs two phrasings for one failure. */
export function unconsumedGrantReport(toolName: string, callRef: string): string {
  return `popclaw: owner approval for ${toolName} was granted and never consumed — `
    + 'its tool body does not call consumeOwnerApproval, so the owner\'s answer decided '
    + `nothing; the grant was dropped (tool_call_id ${callRef})`;
}
/** The honest answer when the host gave this call no identity. It names what
 *  could NOT be established rather than implying nothing was wrong. */
export function unattributableGrantReport(toolName: string): string {
  return `popclaw: ${toolName} finished with no tool call id, so an unconsumed owner `
    + 'approval could not be attributed to this call; nothing was dropped';
}

/**
 * The MCP backend: ASK FIRST, THEN DISPATCH.
 *
 * The earlier round reported this as unbuildable because "MCP elicitation is a
 * server→client round trip and `consumeOwnerApproval` is synchronous with
 * nowhere to await it". That conflated two different things. What has to be
 * ASYNCHRONOUS IS THE ASKING; the consuming stays synchronous in both
 * lifecycles. On the OpenClaw native host the host suspends the call and asks
 * between the hook and the body; on an MCP root nothing suspends the call for
 * us, so the root asks BEFORE it dispatches the body. Same event order, same
 * record, same synchronous `consumeOwnerApproval` inside the body — one
 * interface, not one signature over two lifecycles.
 *
 * Everything that decides whether to ask, what may be shown and what is bound
 * stays HERE. The caller injects only the act of asking, and can answer with
 * nothing but a decision. It cannot write a record, cannot choose the subject,
 * cannot reach the store, and cannot answer `allow-always` — the type does not
 * admit it, which is the one widening a second backend could otherwise smuggle
 * in past a host that never offers it.
 *
 * Returns when the answer is recorded. It NEVER throws and never reports the
 * answer: the body learns the outcome the same way it does on every other
 * host, by calling `consumeOwnerApproval` with the parameters it is about to
 * act on. An `ask` that throws, rejects or never resolves leaves the record
 * unanswered, which consumes as `timeout`. Fails closed in every direction.
 */
export async function askOwnerApprovalBeforeDispatch(
  toolName: string, params: unknown, callRef: string,
  ask: (prompt: OwnerApprovalPrompt) => Promise<OwnerApprovalAskResult>,
  /** Trusted backend presentation; tool parameters cannot select it. */
  profile: ApprovalDialogProfile = NATIVE_APPROVAL_PROFILE,
): Promise<void> {
  const prepared = await prepare(toolName, params, callRef, profile);
  if (!prepared) return;
  try {
    const answer = await ask(prepared.prompt);
    // A host that cannot render the dialog never showed it, so this is a
    // refusal by name, not a silent timeout the owner appears to have caused.
    //
    // AND IT NAMES THE REGISTRANT'S OWN DEFECT WHEN THERE WAS ONE. If the
    // registrant offered a folded rendering, the seam dropped it as
    // unpresentable, and the backend then could not render the primary either,
    // then "this host could not render the dialog" is true but useless: the
    // reason the fallback did not save it is a bug in the fallback, and
    // reporting the generic name is how it would stay invisible for as long as
    // the shorter layout kept failing. Fails closed either way — nothing is
    // shown and nothing is approved; only the name a person reads changes.
    if (isDialogFailure(answer)) prepared.record.failed = answer;
    else if (answer === 'unreadable') {
      prepared.record.refused = prepared.record.foldedDropped
        ? FOLDED_ALTERNATIVE_UNPRESENTABLE : APPROVAL_PROMPT_UNREADABLE_ON_HOST;
    }
    // Anything but `allow-once` is not consent. `consumeOwnerApproval` already
    // collapses an unrecognised decision to `timeout`; assigning it verbatim
    // keeps that one table the only place the mapping lives.
    else prepared.record.decision = answer;
  } catch { /* unanswered: the record stays `null`, which consumes as timeout. */ }
}

/** What the seam decided the owner may be shown, after every screen passed.
 *  `description` is the joined string a host that renders one block wants;
 *  `lines` is the same content as rows, for a host that lays out per row. Both
 *  are derived here so no backend re-splits or re-joins on its own. */
export interface OwnerApprovalPrompt {
  readonly title: string;
  readonly description: string;
  readonly lines: readonly string[];
  readonly timeoutMs: number;
  /** The registrant's shorter spelling of the same subject, if it offered one
   *  and it passed the same screening. A backend reaches for it only when its
   *  own host cannot render `lines`; it is not a summary and not a different
   *  question — see `ApprovalSubjectResult`.
   *
   *  A BACKEND MAY SHOW THESE ROWS INSTEAD OF `lines` AND RECORD THE ANSWER
   *  AGAINST THE SAME SUBJECT, so whether they describe the same action on the
   *  same snapshot is load-bearing — and unverifiable here. The binding is the
   *  canonical string the seam already holds; this text is the registrant's
   *  promise about what that string means, and only review checks it.
   *
   *  NO BACKEND READS IT TODAY. The MCP backend was its only consumer, and it
   *  now shows every host the primary rows in the dialog's message. The field
   *  stays because registrants compile against it; it is still screened, and
   *  a failing one still sets `foldedDropped`. Removing it is a follow-up. */
  readonly folded?: { readonly title: string; readonly lines: readonly string[] };
  /** The registrant's own label for the confirmation, screened. Absent means
   *  the backend's generic, localized one. */
  readonly confirmLabel?: string;
  /** The registrant's own line under the confirmation, screened. Absent means
   *  the backend's generic, localized one. */
  readonly confirmDescription?: string;
  /** The registrant's first-screen spelling of the same rows, screened, for
   *  the MCP dialog only. Absent means the primary `title` and rows. */
  readonly firstScreen?: { readonly title: string; readonly description: string; readonly lines: readonly string[] };
}
/** What a backend may answer. `allow-always` is deliberately absent: the
 *  native path never offers it and no other backend may introduce it. */
export type OwnerApprovalAskResult =
  | 'allow-once' | 'deny' | 'timeout'
  /** The dialog ended without an answer, NOT because our window closed. Named,
   *  so the owner is not told "the window closed" about a cancel or a crash. */
  | OwnerApprovalDialogFailure
  /** The backend could build no dialog THIS HOST would render whole. Not a
   *  denial — nobody denied anything — and not a timeout either, so it becomes
   *  a named refusal rather than being folded into one of those. */
  | 'unreadable';
/** What `unreadable` becomes on the record. */
export const APPROVAL_PROMPT_UNREADABLE_ON_HOST = 'APPROVAL_PROMPT_UNREADABLE_ON_HOST';
/**
 * What `unreadable` becomes instead when the registrant HAD offered a shorter
 * rendering and the seam had already dropped it.
 *
 * The drop itself is correct and stays correct — a malformed alternative must
 * not be shown and must not take the primary down with it — but on its own it
 * was SILENT, and silence is what this whole lane exists to stop. It becomes
 * audible at the only moment it can have cost anything: the host asked for the
 * fallback, there was none, and the call was refused. A tool body that reports
 * its reasons then prints this name, which says "the shorter layout your
 * registrant offered was not showable" rather than "this host is small".
 *
 * IT CARRIES NO CONTENT. Only the fact that a rendering was dropped travels;
 * neither layout's rows, the draft, nor any parameter value goes anywhere near
 * it, here or in anything that prints it.
 */
export const FOLDED_ALTERNATIVE_UNPRESENTABLE = 'FOLDED_ALTERNATIVE_UNPRESENTABLE';

interface PreparedPrompt { readonly record: ApprovalRecord; readonly prompt: OwnerApprovalPrompt }
/**
 * Everything both backends must do identically, in one place: look the subject
 * up, canonicalize, describe, screen, and write the record. Returns the prompt
 * only when there is genuinely something to show; every refusal is recorded
 * and answered with null, so the tool body reads a named reason either way.
 *
 * The ORIGIN GUARD is not here on purpose — what counts as the owner's own
 * surface is a property of the host, and each backend answers it before
 * calling this.
 */
async function prepare(toolName: string, params: unknown, callRef: string,
  backendProfile: ApprovalDialogProfile): Promise<PreparedPrompt | null> {
  const descriptor = toolName ? subjects.get(toolName) : undefined;
  if (!descriptor || !surfacePresent) return null;
  // The subject's own budget, when it brought one, wins: see `displayBudget`.
  const profile = descriptor.displayBudget
    ? { ...backendProfile, budget: descriptor.displayBudget } : backendProfile;
  const { budget } = profile;
  const call = callIdentity(callRef);
  if (call === null) return null;
  const subject = canonicalizeSafely(descriptor, params);
  if (subject === null) return null;
  let described: ApprovalSubjectResult;
  try { described = await descriptor.describe(params, profile); }
  catch { described = { kind: 'refuse', reason: refusalOf() }; }
  // Over-budget or unpresentable is a refusal like any other, and it is the
  // descriptor's own `refuse` reason the tool body will read back.
  const refused = described.kind === 'refuse' ? described.reason
    : presentable(described, budget) ?? labelRefusal(described.confirmLabel) ?? beforeAskRefusal(descriptor, params);
  // The alternative layout goes through the SAME screen, and a failing one is
  // dropped rather than refusing the prompt: a defect in the shorter spelling
  // must not take away a dialog the primary layout could have rendered. The
  // drop is remembered on the record, because a folded backend that then finds
  // nothing to fall back to is owed the real name for that
  // (`FOLDED_ALTERNATIVE_UNPRESENTABLE`) instead of a generic one.
  const alternative = described.kind === 'ask' && described.folded
    ? { offered: described.folded, unpresentable: presentable(described.folded, budget) }
    : null;
  const now = clock();
  sweep(now);
  const record: ApprovalRecord = {
    toolName, callRef: call, subject, at: now, refused, decision: null, failed: null,
    foldedDropped: alternative !== null && alternative.unpresentable !== null,
  };
  records.set(recordKey(toolName, call), record);
  if (refused !== null || described.kind !== 'ask') return null;
  const folded = alternative && alternative.unpresentable === null
    ? { title: alternative.offered.title, lines: alternative.offered.description }
    : null;
  return { record, prompt: {
    title: described.title,
    // The ONLY place rows become one string, and only after every row has been
    // screened. Nothing outside this module re-joins or re-splits it.
    description: joinDescription(described.description),
    lines: described.description,
    timeoutMs: OWNER_APPROVAL_WINDOW_MS,
    ...(folded ? { folded } : {}),
    ...(described.confirmLabel !== undefined ? { confirmLabel: described.confirmLabel } : {}),
    // DROPPED, NEVER REFUSED. This line is a pointer, not the subject: an
    // unshowable one is left out and the backend shows its generic line, so a
    // defect here can never take away the owner's chance to approve.
    ...(described.kind === 'ask' && typeof described.confirmDescription === 'string'
      && described.confirmDescription.trim() !== '' && !INVISIBLE.test(described.confirmDescription)
      ? { confirmDescription: described.confirmDescription } : {}),
    // DROPPED, NEVER REFUSED, like the line above: the primary is always there.
    ...(described.kind === 'ask' && described.firstScreen && presentable(described.firstScreen, budget) === null
      ? { firstScreen: {
          title: described.firstScreen.title,
          description: joinDescription(described.firstScreen.description),
          lines: described.firstScreen.description,
        } }
      : {}),
  } };
}

/**
 * What the tool body asks, with the parameters it is about to act on.
 *
 * Single use: an `approved` answer is consumed here and can never authorize a
 * second call, not even one carrying the identical parameters.
 */
export function consumeOwnerApproval(toolName: string, params: unknown, callRef: string): OwnerApprovalOutcome {
  const descriptor = subjects.get(toolName);
  if (!descriptor) return { decision: 'unavailable', reason: 'SUBJECT_NOT_REGISTERED' };
  const call = callIdentity(callRef);
  if (call === null) return { decision: 'unavailable', reason: 'CALL_IDENTITY_ABSENT' };
  const subject = canonicalizeSafely(descriptor, params);
  if (subject === null) return { decision: 'unavailable', reason: 'SUBJECT_REFUSED', detail: 'CANONICALIZE_FAILED' };
  const key = recordKey(toolName, call);
  const record = records.get(key);
  if (!record) {
    // Asked and spent, checked before anything else a missing record could
    // mean — but AFTER a live record, so a host that re-asks under the same
    // call identity is answered rather than being told it is a replay.
    if (consumed.has(key)) return { decision: 'unavailable', reason: 'ALREADY_CONSUMED' };
    // THE NAMED REASON, IF THE GUARD LEFT ONE. This is the only branch here
    // that is a recorded fact about THIS call rather than an inference from a
    // missing record, so it answers first — and it is what stops the named
    // refusals arriving as one sentence. The entry is left in
    // place: a body that asks twice deserves the same answer twice, and the
    // sweep bounds it.
    const noted = originRefusals.get(key);
    if (noted) return { decision: 'unavailable', reason: noted.reason };
    // An answer that exists for these exact bytes but belongs to ANOTHER call
    // is the dangerous case, and it gets its own name: the owner approved
    // something, and this is not the thing they were looking at.
    for (const other of records.values()) {
      if (other.toolName === toolName && other.subject === subject && other.refused === null) {
        return { decision: 'unavailable', reason: 'CALL_MISMATCH' };
      }
    }
    return { decision: 'unavailable',
      reason: surfacePresent ? 'ORIGIN_NOT_OWNER_DIRECT' : 'APPROVAL_SURFACE_ABSENT' };
  }
  // The owner answered about THIS call — but about other bytes. The record
  // stays put: the answer belongs to what it was given for and nothing else.
  if (record.subject !== subject) return { decision: 'unavailable', reason: 'SUBJECT_CHANGED' };
  records.delete(key);
  // A refused subject was never shown, so there is no answer to consume and
  // nothing to mark as spent: saying so again is the correct outcome.
  if (record.refused !== null) return { decision: 'unavailable', reason: 'SUBJECT_REFUSED', detail: record.refused };
  consumed.add(key);
  // CONSENT IS EXACTLY `allow-once`, CHECKED AT RUNTIME.
  //
  // `allow-always` is absent from the offered set and absent from the backend
  // answer type — and a type is a compile-time argument, which is no argument
  // at all about what arrives here. `onResolution` takes a bare string from
  // the host, an embedded broker answers through the same callback with no
  // identity chain behind it, and a future backend is one careless line from
  // passing its own answer through. This used to read it as consent, so a
  // standing "always allow this" decided by something other than the person in
  // front of the dialog would have authorized the call — the one widening the
  // whole seam refuses to offer.
  // An MCP dialog that ended without an answer, for a named reason other than
  // our window closing. Spent like any other ending, and never consent.
  if (record.failed !== null) return { decision: 'unavailable', reason: record.failed };
  if (record.decision === 'allow-once') return { decision: 'approved' };
  // Answered, but not with consent. `allow-always` lands here deliberately: an
  // answer was given and it was not the one that authorizes, which is a deny.
  if (record.decision === 'deny' || record.decision === 'allow-always') return { decision: 'denied' };
  // Timed out, cancelled, never answered, or answered with something nobody
  // offered and nobody here recognises. None of those is consent either.
  return { decision: 'timeout' };
}

/** Whether THE OWNER WAS ACTUALLY ASKED about this call: an answer, an
 *  unanswered prompt, or an answer already spent. Reads only. It exists so a
 *  caller can tell "the owner was asked" from "the owner was not asked" BEFORE
 *  consuming, because those two owe opposite behaviour: the first must be
 *  obeyed, the second must fall through to whatever authorization the tool had
 *  before this seam existed.
 *
 *  A REFUSED SUBJECT ANSWERS FALSE, and that is a fix rather than an accident.
 *  A record is still written for a refusal so the tool body can learn WHICH
 *  refusal it was instead of inferring it from silence — but a refusal means no
 *  prompt was ever built and no human ever saw anything, so it is not "the
 *  owner was asked". Answering true routed those calls into the owner lane and
 *  failed them there, taking away a configured policy that would have served
 *  them a moment earlier: an availability regression caused entirely by this
 *  seam existing. A refusal must not consume a path it never offered to
 *  replace. Nothing widens: the policy lane still demands a real policy, and
 *  with none it refuses by its own name. */
export function ownerApprovalRecorded(toolName: string, callRef: string): boolean {
  const call = callIdentity(callRef);
  if (call === null) return false;
  const key = recordKey(toolName, call);
  const record = records.get(key);
  if (record) return record.refused === null;
  // A refused record is never added to `consumed` (it is deleted un-spent), so
  // this set only ever holds calls the owner really was asked about.
  return consumed.has(key);
}

/**
 * THE NAME THE ORIGIN GUARD LEFT FOR THIS CALL, WITHOUT CONSUMING ANYTHING.
 *
 * `consumeOwnerApproval` already reports it, but only to a caller that reaches
 * `consumeOwnerApproval` — and on the OpenClaw native host a REFUSED call never
 * does: `ownerApprovalRecorded` answers false for it (deliberately, so the
 * configured policy lane still serves it), so the native root routes it away
 * from the owner lane and nothing on the remaining path ever asks this module
 * anything. The whole of `OwnerApprovalOriginRefusal` — every entry of
 * `OWNER_APPROVAL_ROUTE_REFUSALS`, plus `OWNER_ALLOWLIST_UNCONFIGURED` and
 * `ORIGIN_NOT_OWNER_DIRECT` — was therefore computed here and reaching nobody.
 * The count stays in the array and is deliberately not repeated in prose.
 *
 * NOT "observable on the MCP root", as this comment used to say — none of them
 * ever was. `noteOriginRefusal` has one caller, `ownerApprovalBeforeToolCall`
 * (`:628-631`), so `originRefusals` has one writer and it is the native
 * `before_tool_call` hook; the MCP root asks through
 * `askOwnerApprovalBeforeDispatch` (`:784`), which calls `prepare` directly and
 * never runs the origin guard. That is by design rather than a second place
 * this note failed to reach: the MCP root has no channel origin to screen. The
 * premise that rests on, and the one change that would end it, are written out
 * at `nativeWorldInvoke` in `openclaw-owner-approval.ts`.
 *
 * This is the read a fall-through lane can make. It consumes nothing, grants
 * nothing, decides nothing, and CANNOT admit: the only thing a caller can do
 * with the answer is say it out loud.
 */
export function ownerApprovalOriginRefusalNote(
  toolName: string, callRef: unknown,
): OwnerApprovalOriginRefusal | null {
  const call = callIdentity(callRef);
  if (call === null) return null;
  return originRefusals.get(recordKey(toolName, call))?.reason ?? null;
}

/**
 * SAY A REFUSED ORIGIN OUT LOUD, ONCE, WHERE AN OPERATOR CAN GREP IT.
 *
 * The name reaches the AGENT — `nativeWorldInvoke` carries it out with
 * whatever the policy lane said — and until this existed it reached nobody
 * else. Nothing anywhere wrote it to a log: this module has no logger by
 * design, the route module has none either, and the hook's registration logs
 * once at boot and never per call. On a real instance a draft was refused in
 * the owner's own chat and the operator had nothing to grep for, so the
 * diagnosis fell back on the agent's paraphrase of a sentence that had already
 * been flattened once on the way to it.
 *
 * WHAT THE LINE MAY CARRY, AND NOTHING ELSE: the tool, the host's own call id,
 * and the NAMED reason. Not the parameters, not the house, not the body, not
 * the owner's address. A tool result is read by one person and gone; a log
 * line is written to a file that outlives the turn and is copied into bug
 * reports, so the seam's whole premise — the body stays in front of the person
 * who is being asked — has to hold here too.
 *
 * SAME SHAPE AS `ownerApprovalAfterToolCall`, for the same reason: the caller
 * injects a STRING SINK, never a logger, so the module that decides stays
 * decidable without one. `say` keeps a throwing sink from becoming a thrown
 * hook — the report is what is lost, never the refusal, which has already been
 * recorded by the time this runs.
 *
 * A call the host gave no id has no note to read (`noteOriginRefusal` will not
 * invent a key) and therefore stays silent here too, exactly as it is silent
 * on every other surface.
 */
export function reportOwnerApprovalOriginRefusal(
  event: OwnerApprovalToolEvent | undefined,
  ctx: OwnerApprovalToolContext | undefined,
  report: (message: string) => void,
): void {
  const toolName = event?.toolName;
  if (!toolName) return;
  const callRef = callIdentity(ctx?.toolCallId ?? event?.toolCallId);
  if (callRef === null) return;
  const reason = ownerApprovalOriginRefusalNote(toolName, callRef);
  if (reason === null) return;
  say(report, originRefusedReport(toolName, callRef, reason));
}

/** The one sentence a refused origin is reported with. Built here rather than
 *  at the call site so the three facts are the only three facts: a caller that
 *  assembled its own line could reach for the event it is holding. */
export function originRefusedReport(
  toolName: string, callRef: string, reason: OwnerApprovalOriginRefusal,
): string {
  return `popclaw: owner approval refused the origin of ${toolName} — ${reason} `
    + `(tool_call_id ${callRef})`;
}

/**
 * Drop a grant the call it was given for never spent, and say whether there
 * was one.
 *
 * WHY THIS EXISTS. A registrant's tool body is what turns an answer into a
 * decision, by calling `consumeOwnerApproval`. A body that never calls it
 * still caused the owner to be asked and still had an answer recorded — and
 * then ran regardless. That is the failure that shipped once already
 * (`popclaw_world_invoke` under MCP: asked by the seam, decided by something
 * else), and it was completely silent. The root's dispatch seam calls this
 * once the body has returned so the defect can be REPORTED rather than
 * inferred, and so a live grant cannot outlive the call that earned it.
 *
 * It never refuses anything: by the time a body has returned, refusing would
 * change what already happened. True here means "a defect at the call site",
 * which is the caller's to log — this module has no logger.
 *
 * Only a GRANT is dropped. A denial or a refusal authorizes nothing, so
 * leaving it to age out changes nothing.
 */
export function discardUnconsumedOwnerApproval(toolName: string, callRef: string): boolean {
  const call = callIdentity(callRef);
  if (call === null) return false;
  const key = recordKey(toolName, call);
  const record = records.get(key);
  if (!record || record.refused !== null || record.decision !== 'allow-once') return false;
  records.delete(key);
  // Marked spent, not merely forgotten: the same transition a real consume
  // makes, so anything reading later is told ALREADY_CONSUMED instead of
  // "nobody was ever asked about this call" — which is the answer that sends
  // a caller down a fall-through lane.
  consumed.add(key);
  return true;
}

/** Whether an unspent approval for this call is waiting. Reads only — it
 *  consumes nothing and grants nothing. */
export function ownerApprovalGranted(toolName: string, callRef: string): boolean {
  const call = callIdentity(callRef);
  if (call === null) return false;
  const record = records.get(recordKey(toolName, call));
  if (!record || record.refused !== null) return false;
  // The same one-value table `consumeOwnerApproval` uses. A reader that called
  // an `allow-always` record "granted" would disagree with the consumer that
  // denies it, and a lane chosen on a disagreement is the worst kind.
  return record.decision === 'allow-once';
}
