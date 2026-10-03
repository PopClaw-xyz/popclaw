/** The general-purpose canvas: HTML the agent rendered, in exchange for a shareable link. */

import { CanvasSchema } from './tool-schemas.js';
import { ownerLang, failureText } from '../lexicon/owner-language.js';
import { renderCopy } from '../lexicon/index.js';
import { MAX_HTML_BYTES as MAX_CANVAS_HTML_BYTES } from '../commands/popclaw-canvas.js';
import { type PublishDeps } from '../newspaper/publish-newspaper.js';
import { type ToolsCtx } from './tools-context.js';

/** popclaw_canvas. */
export function registerCanvasTool(ctx: ToolsCtx): void {
  const { api, runtime } = ctx;
  // General-purpose canvas: the agent renders a page of HTML this turn and hands it over
  // directly in exchange for a shareable link.
  // The newspaper path (gather → render → publish) is a dedicated channel **with
  // material-faithfulness verification**; this one is the bare general-purpose hook — the
  // owner saying "draw me a chart / make a table / make a page" all go through this.
  // The slash command `/popclaw canvas <file>` still exists, for "I already have an HTML
  // file in hand"; the agent shouldn't have to write a file to disk first just to publish a
  // page of HTML.
  api.registerTool({
    name: 'popclaw_canvas',
    description:
      'Call this when you have rendered a page of HTML you want to show the owner / give them a shareable link ' +
      '("draw me a chart", "make a table", "make a page", "visualise this"). ' +
      'Returns a short-lived canvas link — read it out to the owner as it is. ' +
      '**Inline everything** (CSS into <style>, data into the HTML) — the page runs in a sandboxed iframe, ' +
      'external scripts/fonts/images are not guaranteed to load; a link is valid for the day by default (24 hours), ' +
      'once it expires just re-render and send a new one. ' +
      'For a page the owner will keep and read at leisure (such as the getting-started guide at the end of settling in) you may raise ttl_hours to 72. ' +
      'The daily paper has its own channel (popclaw_newspaper → popclaw_publish_newspaper), do not send a paper through this one. ' +
      'If the tool fails, tell the owner it failed — never make up a result.',
    parameters: CanvasSchema,
    execute: async (_callId: string, params: unknown) => {
      try {
        const p = params as { html?: unknown; title?: unknown; ttl_hours?: unknown };
        const html = typeof p.html === 'string' ? p.html : '';
        // Both an empty page and over-size content are caught locally: saves a round trip that was doomed to fail, and saves the owner an unreadable 5xx.
        if (!html.trim()) return { type: 'text' as const, text: renderCopy(ownerLang(), 'canvas.emptyHtml') };
        if (Buffer.byteLength(html, 'utf8') > MAX_CANVAS_HTML_BYTES) {
          return { type: 'text' as const, text: renderCopy(ownerLang(), 'canvas.tooLarge') };
        }
        const title = (typeof p.title === 'string' && p.title.trim() ? p.title : 'Untitled').slice(0, 200);
        const rt = (await runtime()) as {
          boot: { signer: PublishDeps['signer']; nickname: string; canvasBaseUrl?: string | null };
          uploadCanvas: PublishDeps['upload'];
        };
        // The tool stays REGISTERED with no publisher (a tool missing from the
        // table is invisible to the agent, and the three tool tables must agree)
        // — it just answers honestly instead of reaching for a service that is
        // not there.
        if (!rt.boot.canvasBaseUrl) {
          return { type: 'text' as const, text: renderCopy(ownerLang(), 'newspaper.publisher.unavailable') };
        }
        // ttl is a delivery knob (not part of the content signature); an out-of-range value is simply ignored, falling back to the server default of 24h.
        const rawTtl = typeof p.ttl_hours === 'number' ? Math.floor(p.ttl_hours) : undefined;
        const ttlHours = rawTtl !== undefined && rawTtl >= 1 && rawTtl <= 72 ? rawTtl : undefined;
        const { url } = await rt.uploadCanvas({
          baseUrl: rt.boot.canvasBaseUrl,
          signer: rt.boot.signer,
          nickname: rt.boot.nickname,
          title,
          html,
          ...(ttlHours !== undefined ? { ttlHours } : {}),
        });
        return {
          type: 'text' as const,
          text: renderCopy(ownerLang(), 'canvas.created', { hours: String(ttlHours ?? 24), url }),
        };
      } catch (err) {
        // If the canvas service is down, that shouldn't blow up the agent's turn too — it's still holding the freshly rendered HTML.
        return { type: 'text' as const, text: failureText('popclaw_canvas', err) };
      }
    },
  });
}
