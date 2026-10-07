import {expect, it} from 'vitest';
import {withTail} from '../../../src/tools/tool-tail.js';
import type {RegisterToolsDeps} from '../../../src/tools/tools-context.js';

it('retains one JSON document when pending House guides are appended to a DM envelope', async () => {
  const original = {owner_text: 'First\n\nSecond', draft_id: 'message-42', recipient_popclaw_id: 'internal'};
  let registered: {execute(): Promise<{text: string}>};
  const guides = [{house: 'https://house.invalid', guide: 'untrusted context'}];
  const runtime = async () => ({houseRuntime: {pendingHouseGuides: async () => guides, publicReadGate: () => ({isActive: () => false})}});
  const api = withTail({registerTool: tool => {registered = tool as typeof registered;}}, runtime as unknown as RegisterToolsDeps['runtime']);
  api.registerTool({name: 'popclaw_draft_message', execute: async () => ({text: JSON.stringify(original)})});
  const result = JSON.parse((await registered!.execute()).text);
  expect(result).toMatchObject(original);
  expect(result.house_guide_contexts).toEqual(guides);
  expect(result.optional_world_offer).toBeTruthy();
  expect(result.owner_text).toBe(original.owner_text);
});
