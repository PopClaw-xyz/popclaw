import { readFileSync } from 'node:fs';
import type { Signer } from '../identity/signer.js';
import { uploadCanvas } from '../egress/canvas-egress.js';
import { renderCopy } from '../lexicon/index.js';
import { ownerLang } from '../lexicon/owner-language.js';

/** Hard cap of the server-side store; shared by the slash command and the `popclaw_canvas` tool from one definition. */
export const MAX_HTML_BYTES = 2 * 1024 * 1024;

export interface PopclawCanvasArgs {
  positional: string[];
  flags: Record<string, string>;
}
export interface PopclawCanvasDeps {
  signer: Signer;
  nickname: string;
  /** `null` = the owner has no publisher; the command says so instead of uploading. */
  canvasBaseUrl?: string | null;
}

type Uploader = typeof uploadCanvas;

export async function runPopclawCanvasCommand(
  args: PopclawCanvasArgs,
  deps: PopclawCanvasDeps,
  upload: Uploader = uploadCanvas, // injectable for tests
): Promise<{ text: string }> {
  const lang = ownerLang();
  // Answered before the file is even read: with no publisher there is nothing this
  // command could hand back, and "your file is fine, there is nowhere to put it" is
  // the useful half of that sentence.
  if (!deps.canvasBaseUrl) return { text: renderCopy(lang, 'newspaper.publisher.unavailable') };
  const file = args.positional[0];
  if (!file) return { text: renderCopy(lang, 'canvas.cmd.usage') };

  let buf: Buffer;
  try {
    buf = readFileSync(file);
  } catch {
    return { text: renderCopy(lang, 'canvas.cmd.unreadable', { file }) };
  }
  if (buf.byteLength > MAX_HTML_BYTES) return { text: renderCopy(lang, 'canvas.cmd.tooLarge') };
  const html = buf.toString('utf8');
  if (!html.trim()) return { text: renderCopy(lang, 'canvas.cmd.emptyFile') };

  const title = (args.flags['title'] ?? 'Untitled').slice(0, 200);
  const { url } = await upload({
    baseUrl: deps.canvasBaseUrl,
    signer: deps.signer,
    nickname: deps.nickname,
    title,
    html,
  });
  return { text: renderCopy(lang, 'canvas.cmd.created', { url }) };
}
