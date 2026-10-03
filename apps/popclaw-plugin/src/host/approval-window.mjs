/**
 * The owner-approval window, in ONE place that both the plugin (TypeScript)
 * and the setup connector (`src/setup/connector.mjs`, plain ESM that must run
 * without a TypeScript loader) can import. Plain `.mjs` for exactly that
 * reason: it is the only form both sides read natively.
 *
 * Every number that depends on the window is DERIVED here, never re-typed at
 * its use site — a window and a host timeout held in two places is how a host
 * came to cut calls off before the window closed.
 */

/** How long any owner-approval dialog stays answerable by default. The owner's
 *  floor (2026-09-26): at least six minutes. */
export const OWNER_APPROVAL_WINDOW_SECONDS = 360;

/** The longest window the plugin will ever use: the upper bound of
 *  `POPCLAW_OWNER_APPROVAL_TIMEOUT_SECONDS`. Equal to OpenClaw's own plugin
 *  approval ceiling (`MAX_PLUGIN_APPROVAL_TIMEOUT_MS` = 600 000). */
export const OWNER_APPROVAL_WINDOW_MAX_SECONDS = 600;

/** Headroom between our window closing and the host giving up, so our named
 *  timeout result reaches the agent before the host aborts the call. */
export const HOST_TOOL_TIMEOUT_MARGIN_SECONDS = 60;

/**
 * What setup writes as Codex's `[mcp_servers.popclaw] tool_timeout_sec`.
 *
 * INSTALL HEADROOM, NOT A GUARANTEE. The Codex CLI source was observed (by
 * review, from 0.121, at 0.156.1) to pause the tool timeout while an
 * elicitation is open; that is an observation, not a contract, and it does
 * not cover Codex Desktop. In older versions the timeout (60 s in OpenAI's
 * documentation, 300 s in the source at some versions) can end the call
 * while the dialog is still open, and what a later approval does there is not
 * verified. Outlasting our longest window keeps Codex's timeout from ending
 * the call first. It proves nothing about cancellation reaching us or about
 * duplicate sends. Written explicitly so nothing depends on the default.
 * Derived from the LONGEST window, not the default: a user who
 * raises the window to its maximum must not meet the same cut-off again.
 * It applies to every popclaw tool on Codex, not only approvals.
 */
export const CODEX_TOOL_TIMEOUT_SECONDS = OWNER_APPROVAL_WINDOW_MAX_SECONDS + HOST_TOOL_TIMEOUT_MARGIN_SECONDS;
