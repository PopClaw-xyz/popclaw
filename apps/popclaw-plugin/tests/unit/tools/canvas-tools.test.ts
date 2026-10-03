/**
 * Canvas-domain tool cases (src/tools/canvas-tools.ts): popclaw_canvas, as
 * registered through registerPopclawTools.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { registerPopclawTools } from '../../../src/tools/register-tools.js';
import { setOwnerLang } from '../../../src/lexicon/owner-language.js';
import { renderCopy } from '../../../src/lexicon/index.js';
import { buildFakeApi, findTool, makeSigner } from '../../helpers/register-tools-fixture.js';

// Same pin as register-tools.test.ts: the moved cases were written against
// the zh-CN lane, so this file must not depend on another file having set it.
beforeAll(() => setOwnerLang('zh-CN', 'config'));

/**
 * The publisher is an owner-level setting with an explicit "off"
 * (`canvas_base_url: ""`). Publisher-only tools stay REGISTERED either way —
 * a tool missing from the table is invisible to the agent, and the three tool
 * tables (registration, MCP adapter, the static `contracts.tools` list) have to
 * agree — so they answer with one honest line instead.
 */
describe('publisher switched off', () => {
  it('popclaw_canvas is still registered, and answers PUBLISHER_UNAVAILABLE without reaching for the uploader', async () => {
    const { api, tools } = buildFakeApi();
    const uploadCanvas = vi.fn();
    const runtime = vi.fn(async () => ({
      boot: { signer: makeSigner(), nickname: 'TestUser', canvasBaseUrl: null },
      uploadCanvas,
    })) as unknown as Parameters<typeof registerPopclawTools>[0]['runtime'];
    registerPopclawTools({ api, runtime });
    const t = findTool(tools, 'popclaw_canvas');
    const r = await t.execute('cid', { html: '<p>hi</p>', title: 'A page' });
    expect(r.text).toBe(renderCopy('zh-CN', 'newspaper.publisher.unavailable'));
    expect(uploadCanvas).not.toHaveBeenCalled();
  });
});
