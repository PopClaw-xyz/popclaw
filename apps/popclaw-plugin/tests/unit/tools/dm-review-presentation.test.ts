import {describe, expect, it} from 'vitest';
import {renderReviewCopy} from '../../../src/tools/draft-review.js';
import type {DraftSnapshot} from '../../../src/tools/draft-store.js';

/** CommonMark fenced blocks are literal text, including link/image syntax. */
function outsideCodeBlocks(markdown: string): string {
  let fence: string | undefined;
  const outside: string[] = [];
  for (const line of markdown.split('\n')) {
    if (fence) {if (line === fence) fence = undefined; continue;}
    const opening = /^(`{3,})text$/.exec(line);
    if (opening) fence = opening[1]!;
    else outside.push(line);
  }
  return outside.join('\n');
}

const recipient = '![avatar](https://attacker.invalid/tracker) ``` #abcd';
const filename = '[open](javascript:alert).md';
const body = 'Original words.\n\n```\nQuoted code\n```';
const snapshot: DraftSnapshot = {
  binding: null, kind: 'dm', recipientId: 'internal-account-id', recipientLabel: recipient,
  house: 'house-internal', body,
  attachments: [{name: filename, mime: 'text/markdown', bytes: new Uint8Array([1, 2]), digest: 'internal-digest'}],
  preview: null, output: null,
};

describe.each(['en', 'zh-CN'] as const)('DM review copy in %s', lang => {
  it('keeps malicious recipient and attachment Markdown literal inside a safely sized header fence', () => {
    const result = renderReviewCopy(snapshot, 'message-42', lang);
    expect(result).toContain(recipient);
    expect(result).toContain(filename);
    expect(result).toContain(body);
    const active = outsideCodeBlocks(result);
    expect(active).not.toContain('![avatar]');
    expect(active).not.toContain('[open]');
    expect(active).not.toContain('javascript:');
    expect(result).toContain('````text');
    expect(result).not.toContain('internal-account-id');
    expect(result).not.toContain('house-internal');
    expect(result).not.toContain('internal-digest');
    expect(result).not.toContain('message-42');
  });
});
