import { describe, it, expect, vi } from 'vitest';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPopclawCanvasCommand } from '../../src/commands/popclaw-canvas.js';
import type { Signer } from '../../src/identity/signer.js';
// D8: assert through the same renderer the command uses, never a literal —
// this copy now follows the owner's language.
import { renderCopy } from '../../src/lexicon/index.js';
import { ownerLang } from '../../src/lexicon/owner-language.js';

const deps = { signer: {} as Signer, nickname: 'blackfeather_ai', canvasBaseUrl: 'http://x' };
const stubUpload = async () => ({ url: 'http://canvas.test/blackfeather_ai/abc?t=tok' });

function tmpHtml(content: string): string {
  const p = join(mkdtempSync(join(tmpdir(), 'cv-')), 'a.html');
  writeFileSync(p, content);
  return p;
}

describe('runPopclawCanvasCommand', () => {
  /**
   * The publisher is an owner-level setting and "off" is sayable
   * (`canvas_base_url: ""`). The command still exists — it answers instead of
   * uploading, and it answers before it even opens the file.
   */
  it('no publisher configured → PUBLISHER_UNAVAILABLE, and nothing is uploaded', async () => {
    const upload = vi.fn();
    const r = await runPopclawCanvasCommand(
      { positional: [tmpHtml('<p>hi</p>')], flags: {} },
      { ...deps, canvasBaseUrl: null },
      upload as never,
    );
    expect(r.text).toBe(renderCopy(ownerLang(), 'newspaper.publisher.unavailable'));
    expect(upload).not.toHaveBeenCalled();
  });

  it('shows usage when no file given', async () => {
    const r = await runPopclawCanvasCommand({ positional: [], flags: {} }, deps, stubUpload);
    expect(r.text).toBe(renderCopy(ownerLang(), 'canvas.cmd.usage'));
  });
  it('errors on an unreadable file', async () => {
    const r = await runPopclawCanvasCommand({ positional: ['/no/such.html'], flags: {} }, deps, stubUpload);
    expect(r.text).toBe(renderCopy(ownerLang(), 'canvas.cmd.unreadable', { file: '/no/such.html' }));
  });
  it('errors on an empty file', async () => {
    const r = await runPopclawCanvasCommand({ positional: [tmpHtml('   ')], flags: {} }, deps, stubUpload);
    expect(r.text).toBe(renderCopy(ownerLang(), 'canvas.cmd.emptyFile'));
  });
  it('uploads and returns the url', async () => {
    const r = await runPopclawCanvasCommand(
      { positional: [tmpHtml('<p>hi</p>')], flags: { title: '简报' } },
      deps,
      stubUpload,
    );
    expect(r.text).toContain('http://canvas.test/blackfeather_ai/abc?t=tok');
  });
  it('errors when file exceeds 2MB', async () => {
    const bigFile = tmpHtml('x'.repeat(2 * 1024 * 1024 + 1));
    const r = await runPopclawCanvasCommand({ positional: [bigFile], flags: {} }, deps, stubUpload);
    expect(r.text).toContain('2MB');
  });
});
