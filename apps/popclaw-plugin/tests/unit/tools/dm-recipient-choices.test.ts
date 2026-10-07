import {afterEach, describe, expect, it, vi} from 'vitest';
import {registerWriteTools} from '../../../src/tools/write-tools.js';
import {resolvePersonRef} from '../../../src/tools/person-sources.js';
import {setOwnerLang} from '../../../src/lexicon/owner-language.js';
import type {ToolsCtx} from '../../../src/tools/tools-context.js';
vi.mock('../../../src/tools/person-sources.js', () => ({resolvePersonRef: vi.fn(), ownerPopclawId: vi.fn()}));
afterEach(() => {vi.clearAllMocks(); setOwnerLang(undefined);});

const candidates = [
  {nickname: 'Lee', sigil: '7t4k2n9q', popclawId: 'internal-full-account-first', profiles: []},
  {nickname: 'Lee', sigil: '8t4k2n9q', popclawId: 'internal-full-account-second', profiles: []},
];
type Tool = {execute(id: string, params: unknown): Promise<{text: string}>};

async function draftChoices(guessed: boolean) {
  vi.mocked(resolvePersonRef).mockResolvedValueOnce({kind: 'ambiguous', candidates, ...(guessed ? {guessed: true} : {})});
  let draft: Tool;
  const api = {registerTool(definition: unknown, options?: unknown) {
    if ((options as {name?: string})?.name !== 'popclaw_draft_message') return;
    const context = {agentId: 'main', sessionKey: 'agent:main:main', sessionId: 'synthetic', senderIsOwner: true, assertInvocationCurrent() {}};
    const descriptor = definition as {contextVersion?: number; create?(ctx: unknown): unknown};
    draft = (typeof definition === 'function' ? definition(context) : descriptor.create ? descriptor.create(context) : definition) as Tool;
  }};
  const runtime = async () => ({});
  registerWriteTools({api, runtime, deps: {api, runtime}, total: 4} as unknown as ToolsCtx);
  return JSON.parse((await draft!.execute('synthetic', {recipient: 'Lee', body: 'Original words'})).text);
}

describe.each(['en', 'zh-CN'] as const)('DM recipient choices in %s', lang => {
  it.each([false, true])('offers short named choices without requesting account IDs (lookalikes=%s)', async guessed => {
    setOwnerLang(lang, 'config');
    const result = await draftChoices(guessed);
    expect(result.owner_text).toContain('Lee#7t4k2n9q');
    expect(result.owner_text).toContain('Lee#8t4k2n9q');
    expect(result.owner_text).not.toMatch(/popclaw_id|full.?ID|完整.*id/i);
    expect(result.owner_text).not.toContain(candidates[0]!.popclawId);
    expect(result.owner_text).not.toContain(candidates[1]!.popclawId);
    expect(result.candidates).toEqual(candidates);
    expect(result.draft_id).toBeUndefined();
    if (guessed) expect(result.owner_text).toMatch(/similar names|名号相近/);
  });
});
