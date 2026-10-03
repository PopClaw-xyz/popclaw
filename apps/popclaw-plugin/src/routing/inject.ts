import { nativeWorldRoute } from './native-world-routing.js';
/**
 * The tool-routing injection surface (ADR-0043 slice 2) — wires the lexicon
 * table into `before_prompt_build`.
 *
 * Pure function, zero I/O: the hook handler's only job is to call it and log
 * an info evidence line — the injected text itself can be tested without the
 * host SDK (the host's hook can't run in tests, so whatever's testable has
 * to live at this layer).
 */

import { bestPhrase, matchLexicon, renderL1, renderL2Hit, type LexiconEntry } from './lexicon.js';

export type Injection = {
  /** The L1 standing demo block. Appended into the system prompt, cacheable by the provider (surfaces §4). */
  appendSystemContext?: string;
  /** The L2 hit line. Costs tokens every turn, so it only appears on a hit. */
  prependContext?: string;
  /**
   * Hit details (tool name + the matched table phrase + the originating
   * house) — only used for the hook's info evidence line / trace (§6),
   * **never passed back to the host**. (The host's mergeBeforePromptBuild
   * only recognizes those five fields, so extra ones would be dropped
   * anyway; the handler still strips it explicitly.) `trigger` is a constant
   * from our own table, not the owner's verbatim words (trace.ts's privacy rule).
   */
  hits?: { tool: string; trigger: string; from?: string }[];
};

/** L1 is pure static text; assembling it once per process is enough. Lazy: register() never touches it (ADR-0035). */
let l1Cache: string | undefined;

/**
 * The owner's raw words this turn → what to inject.
 *
 * `extra` is house-side entries (slice 4 reads them from on-disk guide
 * frontmatter); the caller supplies them.
 * `POPCLAW_TOOL_ROUTING=off` is the kill switch — returns undefined (the
 * host treats undefined as "no such hook"). Reading the env var fresh every
 * turn is deliberate: flip the variable and restart the gateway and it takes
 * effect immediately, no plugin reinstall needed.
 */
export function buildInjection(
  prompt: string,
  opts: { extra?: LexiconEntry[]; knownHouseOrigins?: readonly string[] } = {},
): Injection | undefined {
  if (process.env.POPCLAW_TOOL_ROUTING === 'off') return undefined;
  l1Cache ??= renderL1();
  const hits = matchLexicon(prompt, opts.extra);
  const native = nativeWorldRoute(prompt, opts.knownHouseOrigins ?? []);
  if (native) return {appendSystemContext: l1Cache,
    prependContext: [native, ...hits.slice(0, 1).map(renderL2Hit)].join('\n'),
    hits: [{tool: 'popclaw_house_login', trigger: 'house-entry'},
      ...hits.slice(0, 1).map(h => ({tool: h.tool, trigger: bestPhrase(h, prompt), ...(h.from ? {from: h.from} : {})}))]};
  if (hits.length === 0) return { appendSystemContext: l1Cache };
  return {
    appendSystemContext: l1Cache,
    prependContext: hits.map(renderL2Hit).join('\n'),
    hits: hits.map((h) => ({ tool: h.tool, trigger: bestPhrase(h, prompt), ...(h.from ? { from: h.from } : {}) })),
  };
}

/**
 * The "the owner just handed you a file" line — put the absolute path
 * straight in front of the model.
 *
 * Why this can't rely on the tool alone (real-machine incident, 2026-07-31,
 * the fourth time falling into the same hole): host-c's install was
 * **correct**, `popclaw_recent_attachments` **was registered** (45→46), the
 * voice note at 14:45 **was sitting right there on disk**, and the agent
 * (kimi-k2.7) **never called that tool even once** — it went straight from
 * "this arrived via Feishu" to inferring "I can't reach the local path",
 * and that premise itself was wrong. On host-a running Claude, it would
 * remember to check; a weak model among 46 tools won't.
 *
 * Past fixes escalated one level at a time: give it an opening (#231) → tell
 * it in the description to go fetch it (#337) → give it a dedicated tool
 * (#353). The first two levels worked because the problem back then was "no
 * opening / didn't know one existed"; this time the opening exists, the
 * description is written, and **it just never opened the toolbox at all**.
 * So the next level isn't another line of description — it's **stop counting
 * on it to remember** — put the answer directly into its context this turn,
 * so all it has to do is drop the string into `attachment_path`.
 *
 * Two self-imposed limits, so this doesn't turn into noise every turn:
 *  - **Only report very recent ones** (`newerThanMs`) — "the one from just
 *    now" is meaningful, but yesterday's file shouldn't get mentioned every day;
 *  - **Only report the first few**, and only give path/size/how-long-ago —
 *    never guess which one the owner wants to send.
 */
export function recentAttachmentNotice(
  files: readonly { path: string; size: number; mtimeMs: number }[],
  now: number,
): string | undefined {
  if (files.length === 0) return undefined;
  const lines = files.map((f) => {
    const mins = Math.max(0, Math.round((now - f.mtimeMs) / 60_000));
    return `  ${f.path}  (${(f.size / 1024).toFixed(1)} KB, ${mins}m ago)`;
  });
  return (
    'The owner just handed you these files (newest first). If they say "that voice note" / ' +
    '"this file" / "the one from just now", it is one of these — pass the absolute path straight to ' +
    'popclaw_draft_message attachment_path. Do NOT claim you cannot access it, and do not ' +
    'ask the owner to save it somewhere first.\n' + lines.join('\n')
  );
}
