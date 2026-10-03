/**
 * The owner-approval seam's MCP backend: ASK FIRST, THEN DISPATCH.
 *
 * Peer of `openclaw-owner-approval.ts`. Both turn one human answer into a
 * record the shared seam owns; they differ only in WHEN the asking happens,
 * because the two hosts give the same event order by different means.
 *
 *   OpenClaw native — the host suspends the tool call between the
 *     `before_tool_call` hook and the tool body, asks in that gap, and resumes.
 *   MCP — nothing suspends the call for us, so the ROOT asks before it
 *     dispatches the body, in a place where awaiting is perfectly ordinary.
 *
 * Either way the body then calls `consumeOwnerApproval` synchronously and
 * finds the answer waiting. An earlier round reported this backend as
 * unbuildable on the grounds that elicitation is asynchronous and
 * `consumeOwnerApproval` is synchronous; that conflated the asking with the
 * consuming. Only the asking has to be asynchronous.
 *
 * SCOPE. This serves tools that registered an approval subject.
 * `popclaw_world_invoke` keeps its existing, reviewed MCP elicitation route
 * (`mcp-owner-authorization.ts`) and is NOT rewritten onto this one — two
 * working paths is an accepted transient, and unifying them is a named
 * follow-up. Nothing here touches that path.
 *
 * WHAT KEEPS THAT TRUE, because it is not true by itself: this root wraps
 * EVERY tool, so the world tool stays outside only while it registers no
 * subject on this root. It registers one on the native host alone
 * (`src/tools/world-interaction-tools.ts`, which explains the condition).
 * Registering it here as well showed the owner two dialogs for one action,
 * and — because the world MCP body never calls `consumeOwnerApproval` — let
 * the answer to the first one be discarded, so a deny could be re-asked into
 * a push. When the two paths are finally unified, THAT is the change which
 * makes registering the subject here correct; nothing smaller is.
 *
 * AND THE CLASS IS GUARDED. Not registering fixes one case, not the trap.
 * After a body returns, a grant it never consumed is reported at error level
 * and dropped (`discardUnconsumedOwnerApproval`), so the next registrant that
 * forgets to consume fails loudly instead of quietly succeeding.
 *
 * WHAT THIS IS NOT. Host-attested consent, exactly as the world-invoke dialog
 * says of itself: a host configured to auto-answer elicitations has removed
 * the boundary, and nothing here can detect that. The seam's other properties
 * are untouched and still hold — one answer authorizes one call, it is spent
 * when used, and it is bound to the exact canonical bytes the owner was shown.
 *
 * NOT RUN AGAINST A LIVE MCP HOST. Every claim about how Claude Code and Codex
 * render a form is inherited from the measurements recorded in
 * `mcp-owner-authorization.ts`, not re-observed here.
 */
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { ElicitRequestFormParams } from '@modelcontextprotocol/sdk/types.js';
import {
  OWNER_APPROVAL_WINDOW_MS, OWNER_CONFIRMATION_ANSWER_INVALID, OWNER_CONFIRMATION_CANCELLED,
  OWNER_CONFIRMATION_FAILED, OWNER_CONFIRMATION_INACTIVE,
  askOwnerApprovalBeforeDispatch, discardUnconsumedOwnerApproval, setOwnerApprovalSurface,
  unconsumedGrantReport,
  type ApprovalDisplayBudget, type OwnerApprovalAskResult, type OwnerApprovalPrompt,
} from './owner-approval.js';
import { L_ENVELOPE_MAX_BYTES } from '../protocol/public-envelope.js';
import { renderCopy } from '../lexicon/index.js';
import { APPROVAL_LAYOUT, displayWidth, type ApprovalDialogProfile } from './approval-presentation.js';
import { OWNER_APPROVAL_WINDOW_MAX_SECONDS } from './approval-window.mjs';
import { ownerLang } from '../lexicon/owner-language.js';

type FormSchema = ElicitRequestFormParams['requestedSchema'];

/** Late-bound for the same reason `McpServerBox` is: the MCP `Server` is built
 *  after the tool surface is collected, so this can only hold a box. */
export interface McpApprovalServerBox {
  current?: Pick<Server, 'elicitInput' | 'getClientCapabilities' | 'getClientVersion'>;
}

export interface McpOwnerApprovalOptions {
  readonly server: McpApprovalServerBox;
  /** How long one dialog may stay open. Absent means the shared window
   *  (`OWNER_APPROVAL_WINDOW_MS`, via `prompt.timeoutMs`). The MCP root fills
   *  it from `ownerApprovalTimeoutFromEnv` — and hands the world dialog the
   *  same value, so the two cannot disagree. */
  readonly elicitTimeoutMs?: number;
  /** `error` carries one thing only: a registrant whose body took an answer
   *  and decided nothing with it. Optional so a caller without an error
   *  channel still HEARS it — such a logger gets it as a warning rather than
   *  losing it, because the one thing this report must never be is silent. */
  readonly logger?: {
    warn(context: unknown, message: string): void;
    error?(context: unknown, message: string): void;
  };
}

export interface McpOwnerApprovalBackend {
  /**
   * The call identity the TOOL BODY will be given for this MCP request.
   *
   * It must be the same string on both sides or the record can never be found,
   * and the derivation is not ours: `dispatchMcpCall` builds it from the
   * JSON-RPC request id. Duplicated here rather than imported because that
   * module belongs to another thread this round; a test pins the two against
   * each other so a change on either side goes red rather than silently
   * failing every approval.
   */
  callRef(extra: { readonly requestId?: string | number }): string;
  /**
   * Ask the owner, if this tool has a registered subject, and record the
   * answer. Returns when there is nothing left to wait for. NEVER throws, and
   * never reports the answer — the body reads it from `consumeOwnerApproval`.
   * A tool with no subject is not asked about and this is a no-op, so the root
   * may call it unconditionally.
   */
  beforeDispatch(toolName: string, params: unknown, callRef: string, signal?: AbortSignal): Promise<void>;
  /**
   * `beforeDispatch`, then the body — IN THAT ORDER, and the order lives here
   * rather than at the call site on purpose. The MCP root
   * (`src/mcp.ts`) cannot be imported by a test: it is a bin entry point that
   * runs `main()` on import and installs a process-wide stdout guard. An
   * ordering that only existed there would be unprovable, and "ask before
   * dispatch" is the whole contract of this backend.
   *
   * THE CONTRACT THIS PLACES ON A REGISTRANT: CONSUME WITHIN YOUR OWN PROMISE.
   * The unconsumed-grant check below runs from a `finally`, which fires when
   * the body's promise SETTLES — so a body that returns and consumes
   * afterwards finds its grant already dropped and is told `ALREADY_CONSUMED`.
   * That fails closed, which is the right direction, but it is surprising
   * enough to be worth stating rather than discovering. (The world tool
   * consumes synchronously at the top of its body, so it complies; this is
   * for the next registrant.)
   */
  aroundDispatch<T>(toolName: string, params: unknown, callRef: string,
    signal: AbortSignal | undefined, body: () => Promise<T>): Promise<T>;
  /** Whether this root can ask at all right now: a connected client that
   *  declares form elicitation. Read-only. */
  canAsk(): boolean;
  /**
   * Hand this the MCP `Server`'s `onerror`. It picks out exactly one thing: an
   * answer to an approval dialog that arrived AFTER this backend stopped
   * waiting for it, and reports that it happened — tool, call ref, reason,
   * never a byte of what was answered. Everything else is ignored, as it was
   * before this existed. Never throws; never grants anything.
   *
   * WHY THIS IS THE ONLY PLACE A LATE ANSWER CAN BE SEEN. When the SDK's
   * `timeout` fires it deletes the request's response handler and sends
   * `notifications/cancelled` (sdk 1.30.0 `dist/esm/shared/protocol.js:670-687`,
   * timer `:713-714`). A response that arrives afterwards finds no handler and
   * is handed to `onerror` as "Received a response for an unknown message ID"
   * (`:464-467` → `:270-272`). With no `onerror` set it vanished without a
   * trace — which is how an owner's approval at 146 s disappeared.
   */
  noteProtocolError(error: unknown): void;
  stop(): void;
}

/* --------------------------------------------------------------------------
 * How long the owner has to answer, and the one knob that changes it.
 * ----------------------------------------------------------------------- */
/** Whole seconds. Read once, when the MCP root starts, and given to BOTH
 *  MCP dialogs (this one and the world action's). */
export const OWNER_APPROVAL_TIMEOUT_ENV = 'POPCLAW_OWNER_APPROVAL_TIMEOUT_SECONDS';
/**
 * The window may be set anywhere in here and nowhere else.
 *
 * The FLOOR is the owner's: at least six minutes (the shared default), so the
 * knob can lengthen the window but never undercut that ruling. The CEILING is
 * the hosts': Claude Code aborts a stdio MCP tool call that sends nothing for
 * `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT` (default 1 800 000 ms), and a window at
 * or past that has the HOST kill the call instead of us answering it — a worse
 * failure with no named reason. 600 s leaves that a 3x margin, equals
 * OpenClaw's own approval ceiling, and stays under the seam's record TTL.
 */
export const OWNER_APPROVAL_TIMEOUT_BOUNDS = Object.freeze({
  minSeconds: OWNER_APPROVAL_WINDOW_MS / 1000, maxSeconds: OWNER_APPROVAL_WINDOW_MAX_SECONDS,
});
/** What a late answer is reported as. It names a log line, never a result. */
export const OWNER_APPROVAL_ANSWERED_AFTER_TIMEOUT = 'OWNER_APPROVAL_ANSWERED_AFTER_TIMEOUT';
/**
 * What the owner reads when the window closed first. It rides at the end of
 * the send-draft timeout sentence in every locale (`sendDraft.refused.timeout`)
 * in the same `(reason: …)` frame every other refusal uses.
 */
export const OWNER_APPROVAL_TIMED_OUT_BEFORE_ANSWER = 'OWNER_APPROVAL_TIMED_OUT_BEFORE_ANSWER';

/**
 * The dialog window from the environment, in milliseconds — or `undefined`,
 * meaning "the seam's own default". Never throws: a bad value must not keep
 * the MCP root from starting, and must not quietly become something nobody
 * asked for. Unset or blank is the default, silently. Anything that is not a
 * whole number of seconds is the default, SAID ALOUD. A whole number outside
 * the bounds is clamped to the nearer bound, also said aloud.
 */
export function ownerApprovalTimeoutFromEnv(
  env: Readonly<Record<string, string | undefined>>,
  logger?: { warn(context: unknown, message: string): void },
): number | undefined {
  const raw = env[OWNER_APPROVAL_TIMEOUT_ENV]?.trim();
  if (!raw) return undefined;
  const { minSeconds, maxSeconds } = OWNER_APPROVAL_TIMEOUT_BOUNDS;
  if (!/^\d{1,9}$/.test(raw)) {
    logger?.warn({ env: OWNER_APPROVAL_TIMEOUT_ENV, value: raw },
      `popclaw: ${OWNER_APPROVAL_TIMEOUT_ENV} is not a whole number of seconds — using the default`);
    return undefined;
  }
  const asked = Number(raw);
  const seconds = Math.min(maxSeconds, Math.max(minSeconds, asked));
  if (seconds !== asked) {
    logger?.warn({ env: OWNER_APPROVAL_TIMEOUT_ENV, value: asked, used: seconds },
      `popclaw: ${OWNER_APPROVAL_TIMEOUT_ENV} is outside ${minSeconds}–${maxSeconds} — using ${seconds}`);
  }
  return seconds * 1000;
}

/** The exact prefix the installed SDK gives an orphaned response
 *  (`protocol.js:466`). A test drives the real SDK into producing it, so a
 *  wording change there turns red here rather than going quiet. */
const ORPHANED_RESPONSE = 'Received a response for an unknown message ID: ';
/** How far behind our own window the SDK's timer sits. Ours always fires
 *  first; the SDK's exists only so a request can never wait forever. */
const WINDOW_BACKSTOP_MS = 60_000;
/** How many abandoned dialogs are remembered, and for how long. A dialog the
 *  host never closes is never answered either; this only bounds the memory. */
const ABANDONED_MAX = 16;
const ABANDONED_TTL_MS = 60 * 60 * 1000;

/** Whether an orphaned response is an answer to an elicitation — the shape
 *  every such answer has (`action`), read and nothing else. */
function orphanedElicitAnswer(error: unknown): boolean {
  const message = error instanceof Error ? error.message : null;
  if (message === null || !message.startsWith(ORPHANED_RESPONSE)) return false;
  try {
    const response = JSON.parse(message.slice(ORPHANED_RESPONSE.length)) as { result?: { action?: unknown } };
    return typeof response?.result?.action === 'string';
  } catch { return false; }
}

/* --------------------------------------------------------------------------
 * The dialog budget.
 *
 * NO LONGER A LAYOUT RULE FOR THIS DIALOG. It was, when every row rode a form
 * field of its own; since the explanation became the message (below) nothing
 * here lays out by it and nothing here refuses by it. It stays exported
 * as a compatibility export of the neutral layout metrics; a test keeps it
 * equal to the measured original recorded in `mcp-owner-authorization.ts` (whose
 * own world dialog no longer lays out by it either).
 * ----------------------------------------------------------------------- */
/** What one field description may occupy, in columns (80 − 8 − 1 − 7). */
const FIELD_DESCRIPTION_COLUMNS = APPROVAL_LAYOUT.rowColumns;
/** What a folding host's message renders without a keystroke (80 − 4 − 1 − 3). */
const SUMMARY_LINE_COLUMNS = APPROVAL_LAYOUT.firstLineColumns;
/** The confirm field's one-line description: Claude Code 2.1.283 cut it at
 *  columns 81–91 (probe v3.1), so a registrant's line must fit 80. */
export const CONFIRM_DESCRIPTION_COLUMNS = APPROVAL_LAYOUT.confirmDescriptionColumns;
/** Rows that fit one 24-row screen with no scrolling: (24 − 7) / 3. */
const MAX_DIALOG_FIELDS = APPROVAL_LAYOUT.pointerMaxRows;
export const MCP_APPROVAL_DIALOG_BUDGET = Object.freeze({
  fieldDescriptionColumns: FIELD_DESCRIPTION_COLUMNS,
  summaryLineColumns: SUMMARY_LINE_COLUMNS,
  maxFields: MAX_DIALOG_FIELDS,
});

/**
 * WHAT THIS BACKEND'S DIALOG MAY CARRY: THE WHOLE SUBJECT, OR A NAMED REFUSAL.
 *
 * The native 496-code-point budget is OpenClaw's `requireApproval` cap and
 * says nothing about an MCP elicitation. Held to it, a 975-character letter
 * reached every MCP host as its first line, `[…]` and its last sentence, and
 * a Codex desktop owner could not read what they were asked to approve
 * (2026-09-27). So this backend asks registrants for the whole text
 * or an already-bound review copy (`whole-or-bound-review`).
 *
 * ITS DISPLAY BUDGET is a resource budget for this approval preview:
 * 1 572 864 UTF-8 bytes of the RENDERED description rows, the same figure as
 * `L_ENVELOPE_MAX_BYTES` (public-envelope-01 LIMITS.md:17). It is not the
 * protocol's bound on a letter: rendering inflates the text (a `> ` prefix
 * and a row break per line, wrap breaks, `‹U+XXXX›` escapes), so a letter
 * whose envelope is legal can still render past it, and is then refused as
 * `APPROVAL_PREVIEW_OVER_DISPLAY_BUDGET` — the preview is over this budget,
 * nothing was sent, and nothing is shown abbreviated instead. Nor is it an
 * SDK or host readability limit: it is not a claim that any host renders
 * that much, and what each host actually shows of a long message is
 * measured separately. (For scale only: the SDK puts no length on `message`,
 * `ElicitRequestFormParamsSchema`, sdk 1.30.0 `types.js:1741`, and its stdio
 * read buffer is 10 MiB, `shared/stdio.js:2`.)
 *
 * COST, recorded: rendering and measuring run synchronously on the root's
 * event loop — about 0.45 s for a 1.45 MB CJK body and 1.7 s for 900 KB of
 * line breaks (2026-09-27 review). Acceptable for a dialog a person answers.
 *
 * Fixed here, by the backend. No tool parameter reaches it.
 */
export const MCP_APPROVAL_DISPLAY_BUDGET_BYTES = L_ENVELOPE_MAX_BYTES;
/**
 * The row limit, explicit and named for its own refusal
 * (`DRAFT_FULL_TEXT_TOO_MANY_ROWS`). Every row after the first costs at least
 * one byte of the joined message (its row break), so the byte budget already
 * caps the rows at this figure; stating it separately keeps a row-count
 * failure from being reported as a size one.
 */
export const MCP_APPROVAL_MAX_ROWS = MCP_APPROVAL_DISPLAY_BUDGET_BYTES;
export const MCP_APPROVAL_DISPLAY_BUDGET: ApprovalDisplayBudget = Object.freeze({
  descriptionMax: MCP_APPROVAL_DISPLAY_BUDGET_BYTES,
  unit: 'utf8Bytes',
  maxLines: MCP_APPROVAL_MAX_ROWS,
});

/** The backend declares content policy independently of its resource budget. */
export const MCP_APPROVAL_PROFILE: ApprovalDialogProfile = Object.freeze({
  budget: MCP_APPROVAL_DISPLAY_BUDGET,
  draftPresentation: 'whole-or-bound-review',
  layout: APPROVAL_LAYOUT,
});

/**
 * The dialog, for every MCP host: the explanation is the MESSAGE, and the form
 * holds exactly one input — the owner's confirmation.
 *
 * WHY THERE IS NO SECOND LAYOUT ANY MORE. A folding host (Claude Code) used to
 * be given one `type: 'string'` field per row, titled `(1)`…`(5)`, because it
 * folds `message` after its first line. Those are real text inputs, not
 * labels: an owner approving a long draft saw five empty boxes, typed into the
 * first, and found the form baffling — and nothing read what they typed. MCP
 * form schemas have string, number, enum and boolean and no read-only field,
 * so there is no honest way to show a fact as a field. The rule that the
 * dialog must render without expanding is revoked (09-22): a folded message
 * the owner expands is acceptable, a fake input is not. So every host now gets
 * what Codex already got, and nothing is refused or re-spelled for being tall.
 *
 * WHAT THE CHECKBOX IS, AND IS NOT. Consent is `accept` with `confirm === true`
 * (see `elicit`). The box carries `default: false`, never `true`: the server
 * never pre-ticks it, and an untouched box is a refusal on every host probed.
 * Without a default, Claude Code 2.1.283 blocked an untouched Accept ("This
 * field is required") and codex-cli 0.157.1 answered an untouched Enter with
 * `confirm: true`, because its cursor starts on `true`. With `default: false`
 * (probes of both, 2026-09-27) Claude Code renders the box unticked and an
 * untouched Accept returns `confirm: false`, Codex's cursor starts on `false`
 * and an untouched Enter returns `confirm: false`, and ticking once returns
 * `true`. Both of those are refusals below. No second confirmation is added.
 * A client that applies schema defaults (the TS SDK's
 * `elicitation.form.applyDefaults`) now turns an omitted `confirm` into
 * `false`, a refusal, where it used to reach us as an invalid answer. That
 * is the safe direction; it is recorded here so nobody reads it as a change
 * in what counts as consent.
 *
 * The message carries the registrant's rows unchanged. Under
 * `MCP_APPROVAL_PROFILE` those rows carry the whole subject or its already-
 * bound review copy. This renderer does not choose that policy or shorten
 * the rows.
 */
export function buildApprovalDialog(
  prompt: OwnerApprovalPrompt,
): { readonly message: string; readonly requestedSchema: FormSchema } {
  const lang = ownerLang();
  // The registrant's first-screen spelling when it offered one: this dialog's
  // message shows only its first line on Claude Code. The native backend
  // never reads it and keeps the primary title.
  const shown = prompt.firstScreen ?? prompt;
  return {
    message: `${shown.title}\n\n${shown.description}`,
    requestedSchema: Object.freeze({
      type: 'object',
      properties: {
        confirm: {
          type: 'boolean',
          // Unticked until the owner ticks it; see the note above. Never `true`.
          default: false,
          title: prompt.confirmLabel ?? renderCopy(lang, 'ownerApproval.confirm.title'),
          // The registrant's own line only if it fits the one line a folding
          // host shows without expanding; otherwise the generic one. Dropped,
          // never refused — and the same on every host.
          description: prompt.confirmDescription !== undefined
            && displayWidth(prompt.confirmDescription) <= MCP_APPROVAL_PROFILE.layout.confirmDescriptionColumns
            ? prompt.confirmDescription
            : renderCopy(lang, 'ownerApproval.confirm.description'),
        },
      },
      required: ['confirm'],
    }) as FormSchema,
  };
}

/** The id `dispatchMcpCall` will hand the tool body. Kept byte-identical to it
 *  on purpose — see `McpOwnerApprovalBackend.callRef`. */
export function mcpApprovalCallRef(extra: { readonly requestId?: string | number }): string {
  const id = String(extra.requestId ?? '');
  return `mcp_${/^[A-Za-z0-9_.:-]{1,120}$/.test(id) ? id : Date.now()}`;
}

export function createMcpOwnerApproval(options: McpOwnerApprovalOptions): McpOwnerApprovalBackend {
  let stopped = false;
  const timeoutMs = options.elicitTimeoutMs;
  /** Dialogs this backend stopped waiting for. The SDK does not tell us the
   *  message id it used, so a late answer is matched by elimination: exactly
   *  one abandoned dialog means we know whose it was; more than one, we say
   *  we do not. (The world dialog shares the server, so its late answers land
   *  here too; with none of ours outstanding they are reported unattributed.) */
  let abandoned: Array<{ readonly tool: string; readonly callRef: string; readonly at: number }> = [];

  /** Called through the logger object rather than off a detached reference:
   *  a host logger's methods may be bound to it. Falls back to `warn` so the
   *  one report that must never vanish cannot vanish. */
  function reportDefect(context: unknown, message: string): void {
    const logger = options.logger;
    if (!logger) return;
    // WRAPPED, BECAUSE THIS RUNS FROM A `finally`, AND A `finally` THAT THROWS
    // REPLACES WHAT THE BLOCK WAS GOING TO PRODUCE. An un-caught throw here
    // turned a successful call into the logger's rejection, and a failing one
    // into the logger's error instead of its own — the exact opposite of this
    // block's promise never to change the tool's result. The report is what is
    // lost, never the drop: that has already happened by the time we speak.
    try {
      if (logger.error) logger.error(context, message);
      else logger.warn(context, message);
    } catch { /* the report is lost; the call's result is not. */ }
  }

  function client(): NonNullable<McpApprovalServerBox['current']> | null {
    if (stopped) return null;
    const server = options.server.current;
    // The same test the world dialog makes: a client that does not declare
    // form elicitation cannot be asked, and saying so is better than sending a
    // request it will reject.
    if (!server || !server.getClientCapabilities()?.elicitation?.form) return null;
    return server;
  }

  async function elicit(prompt: OwnerApprovalPrompt, tool: string, callRef: string,
    signal?: AbortSignal): Promise<OwnerApprovalAskResult> {
    const server = client();
    // Between `canAsk()` and here the client can go away: this host can no
    // longer ask, which is exactly what `APPROVAL_SURFACE_ABSENT` means. Not a
    // window that closed, and not consent.
    if (!server) return 'APPROVAL_SURFACE_ABSENT';
    const dialog = buildApprovalDialog(prompt);
    const window = timeoutMs ?? prompt.timeoutMs;
    // OUR OWN TIMER DECIDES WHAT A TIMEOUT IS — not the error code. The SDK
    // reports its own timer AND an aborted signal (the host cancelled the tool
    // call, or we shut down) with the same RequestTimeout (`protocol.js:685`),
    // so the code cannot tell "the window closed on the owner" from "the call
    // went away". This timer aborts with the same McpError the SDK's own timer
    // would use, so the `notifications/cancelled` on the wire is unchanged.
    let windowClosed = false;
    const closer = new AbortController();
    const timer = setTimeout(() => {
      windowClosed = true;
      closer.abort(McpError.fromError(ErrorCode.RequestTimeout, 'Request timed out', { timeout: window }));
    }, window);
    let result;
    try {
      result = await server.elicitInput(
        { mode: 'form', message: dialog.message, requestedSchema: dialog.requestedSchema },
        // The SDK's own timer is only a backstop behind ours; if it ever fired
        // first, that is a failure, not the owner's window.
        { timeout: window + WINDOW_BACKSTOP_MS, signal: signal ? AbortSignal.any([signal, closer.signal]) : closer.signal },
      );
    } catch (error: unknown) {
      const code = (error as { code?: unknown } | null)?.code;
      if (windowClosed) {
        // THE WINDOW CLOSED. Whatever the owner does in a dialog the host
        // leaves open is now an orphan — remembered only so that, if it
        // arrives, someone can see it did. It is never turned into consent.
        const now = Date.now();
        abandoned = [...abandoned.filter(a => now - a.at < ABANDONED_TTL_MS), { tool, callRef, at: now }]
          .slice(-ABANDONED_MAX);
        return 'timeout';
      }
      // The HOST ended the call while the dialog was open. Not a timeout, and
      // not remembered as an abandoned dialog: an answer arriving for it was
      // not given after a window we closed, so it must not be attributed as one.
      if (signal?.aborted) return OWNER_CONFIRMATION_INACTIVE;
      // The owner answered, but the SDK refused the answer against the form
      // (`server/index.js` validates accepted content): the host's fault, and
      // the owner is told so rather than that time ran out.
      if (code === ErrorCode.InvalidParams) return OWNER_CONFIRMATION_ANSWER_INVALID;
      options.logger?.warn({ code }, `popclaw: owner approval dialog failed — ${String(error)}`);
      // Disconnect, transport failure, anything else. Never consent.
      return OWNER_CONFIRMATION_FAILED;
    } finally { clearTimeout(timer); }
    // `decline` is a person saying no. `cancel` is the dialog closed without
    // an answer — its own name, not a timeout. Anything else is malformed.
    if (result.action === 'decline') return 'deny';
    if (result.action === 'cancel') return OWNER_CONFIRMATION_CANCELLED;
    if (result.action !== 'accept') return OWNER_CONFIRMATION_FAILED;
    // Consent is `accept` AND `confirm === true`. An accepted form whose box
    // came back anything else is a refusal — including an untouched box, which
    // comes back `false` under `default: false` (Claude Code 2.1.283 /
    // codex-cli 0.157.1, 2026-09-27; see `buildApprovalDialog`).
    return result.content?.['confirm'] === true ? 'allow-once' : 'deny';
  }

  return {
    callRef: mcpApprovalCallRef,
    canAsk(): boolean { return client() !== null; },
    async beforeDispatch(toolName, params, callRef, signal): Promise<void> {
      // Set from the CONNECTED CLIENT every call rather than once at install:
      // whether this root can ask is a property of who connected, which is not
      // known when the wrapper is installed. Idempotent — one root serves one
      // client — and it keeps `APPROVAL_SURFACE_ABSENT` meaning exactly "this
      // host cannot ask" instead of "the wrapper is missing".
      setOwnerApprovalSurface(client() !== null);
      await askOwnerApprovalBeforeDispatch(toolName, params, callRef,
        prompt => elicit(prompt, toolName, callRef, signal), MCP_APPROVAL_PROFILE);
    },
    async aroundDispatch<T>(toolName: string, params: unknown, callRef: string,
      signal: AbortSignal | undefined, body: () => Promise<T>): Promise<T> {
      await this.beforeDispatch(toolName, params, callRef, signal);
      try {
        return await body();
      } finally {
        // THE SEAM'S OWN SILENT FAILURE, MADE LOUD.
        //
        // A registered subject whose body never calls `consumeOwnerApproval`
        // has the owner asked, takes the answer, and then decides nothing
        // with it — including a refusal, which is how a recorded deny once
        // fell on the floor. Nothing threw and nothing warned, because
        // "nobody consumed it" looks exactly like "everything went fine".
        //
        // Reported, never refused. The body has already run; refusing here
        // would change execution semantics rather than visibility, and the
        // point is that this can no longer be invisible. Dropping the record
        // is the other half: no grant may outlive the call it was given for.
        // `finally`, so a throwing body is reported too.
        if (discardUnconsumedOwnerApproval(toolName, callRef)) {
          // The sentence itself lives beside the drop, so the native root's
          // `after_tool_call` guard reports one defect in one wording.
          reportDefect({ tool: toolName, call_ref: callRef },
            unconsumedGrantReport(toolName, callRef));
        }
      }
    },
    noteProtocolError(error: unknown): void {
      try {
        if (!orphanedElicitAnswer(error)) return;
        const now = Date.now();
        abandoned = abandoned.filter(a => now - a.at < ABANDONED_TTL_MS);
        const only = abandoned.length === 1 ? abandoned[0]! : null;
        if (only) abandoned = [];
        const tools = new Set(abandoned.map(a => a.tool));
        // Tool, call ref, reason. Not the action, not the form, not the draft.
        options.logger?.warn({
          tool: only?.tool ?? (tools.size === 1 ? [...tools][0] : null),
          call_ref: only?.callRef ?? null,
          reason: OWNER_APPROVAL_ANSWERED_AFTER_TIMEOUT,
        }, 'popclaw: an approval dialog was answered after its window closed — ignored, nothing was sent');
      } catch { /* a report is lost; nothing else is affected. */ }
    },
    stop(): void { stopped = true; setOwnerApprovalSurface(false); },
  };
}
