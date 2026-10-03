/**
 * READ-CLASS tools: status / feed / search / attachments / inbox / pings /
 * recommend / the daily paper / canvas / dreaming / the taste write-back.
 * Nothing here needs the draft+confirm gate.
 *
 * Split out of register-tools.ts (2026-08-25), then into one module per domain; the
 * call order below is the order the tools were registered before either split.
 */

import type { ToolsCtx } from './tools-context.js';
import { registerNamecardTool, registerStatusTool } from './identity-tools.js';
import { registerFeedTools, registerRecommendTool } from './feed-tools.js';
import { registerInboxTools } from './inbox-tools.js';
import { registerNewspaperTools } from './newspaper-tools.js';
import { registerCanvasTool } from './canvas-tools.js';
import { createDreamCron, registerDreamTasteTools } from './dream-taste-tools.js';

/**
 * READ-CLASS registrations, in their original order. The domains interleave
 * (recommend sits after the inbox tools), so each module exports its tools'
 * registration separately and this list keeps the sequence — pinned by
 * tests/unit/tools/register-tools.test.ts.
 */
export function registerReadTools(ctx: ToolsCtx): void {
  const dreamCron = createDreamCron();
  registerNamecardTool(ctx);
  registerStatusTool(ctx, dreamCron);
  registerFeedTools(ctx);
  registerInboxTools(ctx);
  registerRecommendTool(ctx);
  registerNewspaperTools(ctx);
  registerCanvasTool(ctx);
  registerDreamTasteTools(ctx, dreamCron);
}
