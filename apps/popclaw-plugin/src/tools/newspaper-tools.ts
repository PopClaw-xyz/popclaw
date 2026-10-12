import type { HouseRuntime } from '../runtime/house-lifecycle/house-runtime.js';
import { publicMaterialSource, PublicMaterialRefusal } from '../newspaper/public-material-source.js';
import { renderCopy } from '../lexicon/index.js';
import { ownerLang } from '../lexicon/owner-language.js';
/** The daily paper's two tools: gather/pick (popclaw_newspaper) and publish. */

import { createLocalNewspaperIssueArchive } from '../host/local-newspaper-artifacts.js';
import { NewspaperToolSchema, PublishNewspaperSchema } from './tool-schemas.js';
import { failureText } from '../lexicon/owner-language.js';
import { NewspaperOutcomeStore, NewspaperStageStore, isDedicatedSession } from '../newspaper/dedicated-session.js';
import { publishNewspaper, type PublishDeps } from '../newspaper/publish-newspaper.js';
import type { FollowableAuthorRow } from '../newspaper/followable-authors.js';
import type { HostDb } from '../host/host-db.js';
import type { PopclawPaths } from '../host/popclaw-paths.js';
import { readNewspaperStyle } from '../newspaper/newspaper-files.js';
import { socialLogOf, type ToolsCtx } from './tools-context.js';
import { CRON_GRANT_ADVICE } from './cron-grant-advice.js';
import { runNewspaperCall } from './newspaper-call.js';

/** popclaw_newspaper + popclaw_publish_newspaper, both in factory form. */
export function registerNewspaperTools(ctx: ToolsCtx): void {
  const { api, runtime, deps } = ctx;
  // Newspaper renders in the AGENT's own turn (host's authed model; popclaw never
  // calls an LLM — spec 2026-06-18). popclaw_newspaper hands the agent the
  // materials + the iron rules + layout + a publish_token; the agent renders teaser + HTML,
  // then calls popclaw_publish_newspaper to F2-check + upload to canvas. This works
  // on subscription/OAuth hosts with zero extra LLM config.
  //
  // Registered in the FACTORY form (2026-09-03 cut 1): only the factory form
  // receives the host's tool context, whose `sessionKey` is what tells the
  // dedicated newspaper workshop session (the one the main session dispatches)
  // from the owner's chat session. In the workshop session the flow below is
  // exactly the two-call candidate/picks flow; in the owner's session, the
  // first call dispatches the whole job into a fresh workshop session and
  // returns the finished paper's receipt (see dedicated-session.ts).
  api.registerTool(
    (toolCtx: { sessionKey?: string }) => ({
    name: 'popclaw_newspaper',
    description:
      "Use this tool for the owner's daily paper or morning edition; never create one from memory or chat context. " +
      "This is a complete personalized paper with taste, bonds and inbox. Configured Canvas delivery is part of this request; draft-only or no-upload constraints are unsupported. " +
      "Normally call twice: (1) no arguments returns the day's candidates grouped by author, with taste and bond-book " +
      "context; read all candidates and choose. (2) pass picks with the printed candidate_basis copied verbatim, or a real " +
      "candidate_token; without either, selection is refused, never guessed. Write only from the returned full material. " +
      "Whenever a returned page or unfinished receipt includes page_cursor, call this tool with ONLY that cursor until the complete-document end marker. Never regather to continue. " +
      "In this same turn submit edits in as many batches as needed to popclaw_publish_newspaper: each item's headline and faithful summary, " +
      "masthead, drifts, front-page picks and teaser. PopClaw lays out the page: do not write HTML or URLs; " +
      "summarise/translate faithfully, never fabricate.\n" +
      "Workshop-host exception: the FIRST call dispatches the complete job and returns a finished-paper receipt, failure " +
      "note, or a note that it will be delivered to this channel when ready. Relay it verbatim and stop. No second call or " +
      "polling: another request creates another paper.\n" +
      "If the owner requests a schedule, use host cron with job name `popclaw-newspaper`, their time and IANA timezone, " +
      "and result delivery off. Each wake runs this same flow for the same lore-houses, with no extra parameters, and " +
      "delivers through the owner's normal channel. " +
      CRON_GRANT_ADVICE,
    parameters: NewspaperToolSchema,
    execute: async (_callId: string, params: unknown) =>
      runNewspaperCall({ api, runtime, deps, toolCtx }, params),
    }),
    { name: 'popclaw_newspaper' },
  );

  // Factory form for the same reason as popclaw_newspaper: the publish half is
  // where a workshop session hands its receipt to the waiting dispatcher. In
  // the owner's own session the outcome store is never touched — it is a
  // hand-off channel between the two sessions of ONE dispatch, not a ledger.
  api.registerTool(
    (toolCtx: { sessionKey?: string }) => ({
    name: 'popclaw_publish_newspaper',
    description:
      'Call as soon as ONE small batch of complete item copy (q, h and s) is ready; do not draft the entire issue before the first call or send the edit as chat text. ' +
      'Each accepted batch is saved. Only after all selected items are complete does this tool save the final paper, upload it to canvas, and return the owner message (teaser + link). ' +
      'Your edit must carry the `basis` value printed on the material page, verbatim — it tells this tool which page your item numbers refer to. ' +
      'publish_token is optional — pass the one popclaw_newspaper returned if you can copy it exactly; ' +
      'a hand-in that arrives with neither a real token nor the basis is refused, not guessed — copy the `basis` line printed on the material page into every edit. ' +
      "Each item carries `q` — a passage copied verbatim from that item's own body — and publish checks it against that item: copy whose `q` is not in its own body is refused, so a summary cannot land under another item's number. " +
      '**Hand in one small batch at a time**: the first edit includes masthead, teaser and items. If the receipt says items are still unwritten, ' +
      'read its page_cursor continuations with popclaw_newspaper when present, then call this again in the same turn with the same basis and only the items you still owe. ' +
      'Previously accepted structure is inherited and accepted items are never rewritten. Complete every selected item; an unfinished receipt is not a final paper. ' +
      "The canvas link **may only come from this tool's returned text, and is forwarded to the owner verbatim** — " +
      'never invent/recall/assemble a canvas link yourself, an invented link is guaranteed to 404.',
    parameters: PublishNewspaperSchema,
    execute: async (_callId: string, params: unknown) => {
      // In a workshop session, this write IS the run's outcome: the dispatcher on
      // the other side reads it the moment this session's run settles. A later
      // call still replaces an earlier FAILURE with the real result (an in-run
      // retry) — but never the other way round. The description above tells the
      // writer to call again while items are unwritten, so a second call after a
      // landed receipt is ordinary; it is refused, because the paper that landed
      // consumed the issue token, and that refusal used to overwrite the success.
      // The owner was then told the edition failed while its HTML and its short
      // link already existed, and asked for another one — one request, two papers.
      const recordOutcome = (outcome: { ok: true; receiptText: string } | { ok: false; reason: string }): void => {
        if (!isDedicatedSession(toolCtx.sessionKey)) return;
        const sessionKey = toolCtx.sessionKey!;
        if (!outcome.ok && NewspaperOutcomeStore.get(sessionKey)?.ok) {
          // Not silently dropped: the refusal is this call's own return value, so
          // the writer reads it in full; the log keeps it for the diagnosis.
          api.logger?.info(
            `popclaw: newspaper publish refused after this run already landed (${sessionKey}) — ` +
              `the landed receipt stands as the run's outcome. Refusal: ${outcome.reason}`,
          );
          return;
        }
        NewspaperOutcomeStore.set(sessionKey, outcome);
      };
      /** The first line of a receipt, capped — a failure reason, not a transcript. */
      const briefReason = (text: string): string => {
        const line = text.split('\n').find((l: string) => l.trim()) ?? '';
        return line.slice(0, 160);
      };
      try {
        // Stage: the writer reached the publish step. Recorded before anything can refuse
        // the hand-in, because "it called publish and was refused" and "it never called
        // publish at all" are different failures and the ledger could tell neither apart.
        NewspaperStageStore.note(toolCtx.sessionKey, 'publishCalled');
        const p = params as { publish_token?: string; edit: unknown };
        const rt = (await runtime()) as {
          houseRuntime?: HouseRuntime;
          boot: {
            signer: PublishDeps['signer'];
            nickname: string;
            canvasBaseUrl?: string | null;
            /** The owner's page knobs (`newspaper.fonts` / `newspaper.avatars`). Absent = the shipped defaults. */
            config?: { newspaper?: { fonts?: PublishDeps['fonts']; avatars?: PublishDeps['avatarMode'] } };
          };
          paths: PopclawPaths;
          uploadCanvas: PublishDeps['upload'];
          /** The social DB (the same handle the bond book lives on). Optional: test stubs carry an empty host. */
          host?: { db?: HostDb };
          /** The follow doorbell's pending store — gateway root only; the piggyback leg is simply off elsewhere. */
          pendingFollows?: { listPending(): Array<{ display_name: string }> };
        };
        const materialSource = publicMaterialSource(rt);
        const socialLog = await socialLogOf(runtime);
        const r = await publishNewspaper(
          {
            ...(materialSource ? { validateMaterials: (issue) => materialSource.validate(issue) } : {}),
            upload: rt.uploadCanvas,
            signer: rt.boot.signer,
            nickname: rt.boot.nickname,
            // No publisher = no upload; the paper is still written to disk and the
            // receipt says where. `publishNewspaper` owns that degradation.
            canvasBaseUrl: rt.boot.canvasBaseUrl ?? null,
            // What the saved page may reach for (owner ruling 2026-09-12: zero
            // dependency, not zero network). Read fresh every issue, same as `style`.
            fonts: rt.boot.config?.newspaper?.fonts ?? 'web',
            avatarMode: rt.boot.config?.newspaper?.avatars ?? 'inline',
            // The master copy. `last-newspaper.html` stays as the always-the-latest copy.
            archive: createLocalNewspaperIssueArchive({
              issuesDir: rt.paths.newspaperIssuesDir(),
              lastNewspaperHtml: rt.paths.lastNewspaperHtml(),
            }),
            // Slice H: the ledger is persisted to disk, so gathering materials and publishing still line up across sessions/subagents.
            manifestDir: rt.paths.newspaperManifestsDir(),
            sessionKey: toolCtx.sessionKey,
            // The owner's knobs, read fresh every issue so an edit takes effect on the
            // very next paper — and its complaints ride along onto the receipt.
            style: readNewspaperStyle(rt.paths.newspaperDir()),
            // Bake the faces into the page so opening the paper reaches no third party;
            // the cache means a repeat author costs nothing tomorrow. Injected, never
            // reached for, so a unit test that wires nothing cannot touch the network.
            ...(deps.fetchImage
              ? { avatars: { cacheDir: rt.paths.newspaperAvatarsDir(), fetchImage: deps.fetchImage } }
              : {}),
            // P7: editing and publishing is something Pop does, so it's recorded to the social log (P-004: append-only).
            ...(socialLog ? { socialLog } : {}),
            // Doorbell §5: the issue's followable-author set, written to the social DB
            // once the paper lands. INSERT OR REPLACE because republishing an issue
            // (a re-upload of the same day) refreshes its set rather than dying on the
            // (issue_date, popclaw_id) key. No handle = the feature is off, which must
            // never block publishing.
            ...(rt.host?.db
              ? {
                  recordFollowable: (rows: FollowableAuthorRow[]): void => {
                    const db = rt.host!.db!;
                    for (const r of rows)
                      db.execute(
                        'INSERT OR REPLACE INTO followable_authors (issue_date, popclaw_id, display_name, descriptor, expires_at) VALUES (?, ?, ?, ?, ?)',
                        [r.issue_date, r.popclaw_id, r.display_name, r.descriptor, r.expires_at],
                      );
                  },
                }
              : {}),
            // Doorbell §6.5 next-day piggyback: whatever the other legs never
            // got answered rides this delivery message. No store = no ride,
            // which must never block publishing.
            ...(rt.pendingFollows ? { pendingList: () => rt.pendingFollows!.listPending() } : {}),
            // Only reached if unshareColophon cannot find the claim it is meant to
            // walk back on an upload failure — visible, never fatal. This api.logger
            // has no `.warn` of its own (tools-context.ts), same convention as the
            // dream-recorder wiring above: route through `.info`.
            ...(api.logger ? { logger: { warn: (m: string) => api.logger!.info(`popclaw: ${m}`) } } : {}),
          },
          { publishToken: p.publish_token, edit: p.edit },
        );
        // `landed` separates "the owner is holding the paper (or its local
        // fallback)" from every other receipt: an unfinished batch, a refused
        // edit, a token mismatch. Only a landed receipt may be reported to the
        // waiting dispatcher as success — anything else must surface as the
        // honest failure it is (2026-09-03: a cron run "succeeded" with zero
        // output and nobody knew).
        if (r.sourceRefused) NewspaperStageStore.collection(toolCtx.sessionKey, 'source-refused');
        recordOutcome(r.landed && !r.sourceRefused ? { ok: true, receiptText: r.text } : { ok: false, reason: r.sourceRefused ? r.text : briefReason(r.text) });
        // `accepted` is publish's own word for "this hand-in's copy was kept" — the
        // published issue, or a batch saved with more still to write. A refusal is not it.
        if (r.accepted) NewspaperStageStore.note(toolCtx.sessionKey, 'publishAccepted');
        return { type: 'text' as const, text: r.text };
      } catch (err) {
        if (err instanceof PublicMaterialRefusal) NewspaperStageStore.collection(toolCtx.sessionKey, 'source-refused');
        recordOutcome({ ok: false, reason: String(err instanceof Error ? err.message : err) });
        return { type: 'text' as const, text: err instanceof PublicMaterialRefusal ? renderCopy(ownerLang(), 'newspaper.source.refused', { reason: err.code }) : failureText('popclaw_publish_newspaper', err) };
      }
    },
    }),
    { name: 'popclaw_publish_newspaper' },
  );
}
