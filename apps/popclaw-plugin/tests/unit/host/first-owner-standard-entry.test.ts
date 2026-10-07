import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureBundle } from '../../helpers/ensure-bundle.js';

describe('standard native first-owner entry', () => {
  it.each(['telegram', 'feishu'])('%s retains SDK session binding and sends once under a current owner invocation', async channel => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
    await ensureBundle(root, resolve(root, 'dist/bundled/index.js'));
    const output = execFileSync(process.execPath, ['--import', 'tsx', 'tests/helpers/first-owner-standard-entry.ts', ...(channel === 'feishu' ? ['--feishu'] : [])],
      { cwd: root, encoding: 'utf8', timeout: 60_000 });
    const receipt = JSON.parse(output.trim().split('\n').at(-1)!);
    expect(receipt).toMatchObject({ standardEntry: true, initialApprovalConfigAbsent: true,
      channel, sdkSessionBindingVerified: true, sdkWrites: 0, userTriggeredOriginalDraft: true, automaticContinuation: false,
      oldDraftInjections: 0, originalHouseRecipientBodyPreserved: true, secondNativeApprovalAbsent: true,
      currentInvocationRequired: true, rejectedInvocationsPreserveDraft: true, singleUseVerified: true, sends: 1,
      durablePreparationThroughSdk: true, sdkWrapperVerified: true });
  }, 300_000);
});
