import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// The public protocol codec and algorithms resolve to the pinned protocol
// bundle at the repository root (see tsconfig.json paths); tests import the
// same specifiers as production code, so the resolver must agree with tsc
// and esbuild.
const PROTOCOL = '../../protocol/packages/contracts';
const ALIASES: Record<string, string> = {
  '@popclaw/contracts/descriptor': `${PROTOCOL}/ts/contracts/src/generated/descriptor.js`,
  '@popclaw/contracts/world-interaction/private-message.schema.json': `${PROTOCOL}/protocol/retained/private-message.schema.json`,
  '@popclaw/contracts/world-interaction/schema-profile.schema.json': `${PROTOCOL}/protocol/retained/schema-profile.schema.json`,
  '@popclaw/contracts/world-interaction/participation.schema.json': `${PROTOCOL}/protocol/retained/participation.schema.json`,
  '@popclaw/contracts/world-interaction/manifest.schema.json': 'src/protocol/retained/manifest.schema.json',
  '@popclaw/contracts/world-interaction/first-release-candidate/board.schema.json': `${PROTOCOL}/protocol/public-envelope-01/board.schema.json`,
  '@popclaw/contracts/world-interaction/first-release-candidate/action-kind.schema.json': `${PROTOCOL}/protocol/public-envelope-01/action-kind.schema.json`,
  '@popclaw/contracts/world-interaction/first-release-candidate/interpreted-event-kind.schema.json': `${PROTOCOL}/protocol/public-envelope-01/interpreted-event-kind.schema.json`,
  '@popclaw/contracts': `${PROTOCOL}/ts/contracts/src/index.ts`,
  '@popclaw/algorithms': `${PROTOCOL}/ts/algorithms/src/index.ts`,
};

export default defineConfig({
  resolve: {
    alias: Object.fromEntries(
      Object.entries(ALIASES).map(([k, v]) => [k, fileURLToPath(new URL(v, import.meta.url))]),
    ),
  },
  test: {
    include: ['tests/**/*.test.ts'],
    // tests/setup/** runs under `node --import tsx --test` (setup-core
    // DELIVERY): it uses node:test, not vitest.
    exclude: ['tests/setup/**', '**/node_modules/**'],
    environment: 'node',
    // A missing copy key prints its own name on the page and only whispers to a stderr
    // nobody reads. It is a failure here instead (tests/lexicon-key-guard.ts).
    setupFiles: ['tests/native-binding-guard.ts', 'tests/lexicon-key-guard.ts'],
    testTimeout: 10_000,
  },
});
