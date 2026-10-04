import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['src/protocol/public-envelope-generated.js', 'src/setup/vendor/**', 'src/setup/connector.mjs'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts', 'tests/**/*.ts'],
    rules: {
      // #374 (2026-07-31): `api.registerHook` writes the internal-hook table
      // (`registry.hooks`), but every typed-hook emitter gates on
      // `registry.typedHooks` — the table only `api.on` writes. A hook on the
      // wrong table never fires, never throws, and `openclaw hooks info` still
      // reports "✓ Ready". ADR-0043's L1/L2 routing, the owner-language signal
      // and the attachment notice were all dead for three weeks that way.
      // A comment did not stop us the first time; this rule has to.
      'no-restricted-syntax': [
        'error',
        {
          selector: "MemberExpression[property.name='registerHook']",
          message:
            'Do not use api.registerHook (#374): it writes registry.hooks, which no typed-hook emitter reads — the handler never fires and nothing warns. Use api.on(<hook>, handler) instead.',
        },
      ],
    },
  },
  {
    files: ['src/**/*.ts'],
    // demo.ts is a runnable composition-root script (peer of main.ts), not a
    // business module — it may wire node:* APIs.
    ignores: [
      'src/host/local-host-adapter.ts',
      // src/setup/** is first-install host machinery (peers of the host
      // adapters: filesystem, identity-root and config-file ownership).
      'src/setup/**',
      // sentinels.ts and integrity-check.ts are host-layer machinery (peers
      // of local-host-adapter): filesystem sentinel READMEs and on-disk
      // integrity state are their whole job, not incidental IO.
      'src/host/sentinels.ts',
      'src/host/integrity-check.ts',
      // collect.ts is the doctor feature's designated IO boundary — the
      // deliberate pure/impure split puts every file/log read here so that
      // bundle.ts (the redaction logic, the real privacy boundary) stays a
      // pure, unit-testable module. See the header comments of both files.
      'src/diagnostics/collect.ts',
      'src/main.ts',
      'src/mcp.ts',
      'src/mcp-hook.ts',
      'src/runtime/stdout-to-stderr.ts',
      'src/wallet/demo*.ts',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['node:*', 'fs', 'fs/promises', 'path', 'os', 'child_process'],
              message:
                'Business modules must use HostAdapter; only host/local-host-adapter.ts and main.ts may import node:* APIs.',
            },
          ],
        },
      ],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    files: [
      'tests/**/*.ts',
      'src/host/local-host-adapter.ts',
      'src/host/sentinels.ts',
      'src/host/integrity-check.ts',
      'src/diagnostics/collect.ts',
      'src/main.ts',
      'src/index.ts',
      // src/mcp.ts is the third composition root (stdio MCP server); its
      // stdout guard needs node:stream before any other module loads.
      'src/mcp.ts',
      'src/runtime/stdout-to-stderr.ts',
      'src/wallet/demo*.ts',
    ],
    // src/index.ts is the plugin composition root (peer of main.ts) — it
    // wires node:* for path resolution + local file reads (wallet config,
    // migrations dir). Other rules (unused-vars etc.) keep applying.
    rules: {
      'no-restricted-imports': 'off',
    },
  },
  {
    // Accepted Phase 1 storage adapters: filesystem/SQLite ownership is their job.
    // Keep business restrictions and the historical grandfather list unchanged.
    files: ['src/host/local-participation.ts', 'src/host/execution-store.ts', 'src/host/execution-store-migration.ts',
      'src/host/execution-partition-factory.ts', 'src/host/draft-review-files.ts',
      'src/host/storage-maintenance.ts', 'src/host/storage-backup.ts'],
    rules: {
      'no-restricted-imports': ['error', {patterns: [{
        group: ['node:*', '!node:fs', '!node:path', '!node:crypto', 'fs', 'fs/promises', 'path', 'os', 'child_process'],
        message: 'Storage host adapters permit only node:fs, node:path and node:crypto.',
      }]}],
    },
  },
  {
    // Local newspaper artifacts own filesystem IO; keep every other Node API restricted.
    files: ['src/host/local-newspaper-artifacts.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [{
        group: ['node:*', '!node:fs', '!node:path', 'fs', 'fs/promises', 'path', 'os', 'child_process'],
        message: 'Local newspaper artifacts permit only node:fs and node:path.',
      }] }],
    },
  },
  {
    // Disposable schema workers are host infrastructure. Allow only their
    // required built-ins; all other Node imports keep the normal boundary.
    files: ['src/host/schema-validator.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [{
        group: ['node:*', '!node:module', '!node:worker_threads', 'fs', 'fs/promises', 'path', 'os', 'child_process'],
        message: 'The schema worker host boundary permits only node:module and node:worker_threads.',
      }] }],
    },
  },
  {
    files: ['src/host/schema-validator-worker.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [{
        group: ['node:*', '!node:worker_threads', 'fs', 'fs/promises', 'path', 'os', 'child_process'],
        message: 'The schema worker entry permits only node:worker_threads.',
      }] }],
    },
  },
  {
    // tests/ never got the `^_` ignore pattern the src/ block above has,
    // so intentionally-unused, underscore-prefixed stub params (mock
    // signatures that must match a real interface) were flagged anyway.
    files: ['tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      // mock-heavy test stubs; the rule stays on for src/ where it counts.
      // Tests-scoped opt-out 2026-08-25.
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  {
    // Invariant: business modules must use HostAdapter; only the
    // composition roots + host/local-host-adapter.ts may import node:*
    // APIs (see the no-restricted-imports block above).
    //
    // The files below violate that invariant today. Grandfathered
    // 2026-08-24 — this list only shrinks; new files must go through
    // HostAdapter; migration tracked as roadmap C6, see
    // .repomix/notes/11-second-opinion.md v2.
    files: [
      'src/cadence/cadence-loader.ts',
      'src/commands/popclaw-canvas.ts',
      'src/host/daily-backup.ts',
      'src/host/host-adapter.in-memory.ts',
      'src/host/local-host-db.ts',
      'src/host/migrations.ts',
      'src/host/popclaw-paths.ts',
      'src/messaging/dm-media.ts',
      'src/messaging/inbox-store.ts',
      'src/newspaper/avatar-inline.ts',
      'src/newspaper/issue-store.ts',
      'src/newspaper/newspaper-files.ts',
      'src/notifier/media-staging.ts',
      'src/quest/scrape-content-handler.ts',
      'src/quest/verify-invite-handler.ts',
      'src/recommend/llm-config.ts',
      'src/recommend/pick-recorder.ts',
      'src/recommend/score-cache.ts',
      'src/routing/house-lexicon.ts',
      'src/runtime/last-build.ts',
      'src/social-graph/event-store.ts',
      'src/taste/taste-loader.ts',
      'src/visual/style-notes.ts',
      'src/world/digest-client.ts',
      'src/world/house-handshake.ts',
    ],
    rules: {
      'no-restricted-imports': 'off',
    },
  },
  {
    // src/newspaper/newspaper-files.ts carries a pre-existing inline
    // suppression for its node:crypto import, predating the
    // grandfather block above. Exempting the whole file there makes that
    // one directive redundant, which would otherwise surface as a new
    // "unused eslint-disable directive" warning — silence just that,
    // scoped to this single file only (does not touch any other file's
    // unused-directive reporting, including other grandfathered files).
    files: ['src/newspaper/newspaper-files.ts'],
    linterOptions: {
      reportUnusedDisableDirectives: false,
    },
  },
);
