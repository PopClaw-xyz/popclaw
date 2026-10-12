/**
 * Bundle src/index.ts into a single ESM file with all workspace + npm deps
 * inlined. The OpenClaw plugin loader expects a self-contained JS file
 * because pnpm workspace `workspace:*` specifiers don't resolve via npm
 * install inside the plugin's install directory.
 *
 * External (not bundled):
 *   - `openclaw` (peer dep; provided by the host)
 *   - `node:*` (built-in)
 *   - `better-sqlite3` + transitive helpers (`bindings`, `file-uri-to-path`):
 *     native modules cannot be bundled — they need `.node` binding files
 *     resolved at runtime. Vendored to `dist/native-deps/` by
 *     `scripts/prepare-native-deps.mjs`; the banner below patches Node's
 *     module resolver to map these names to that vendored directory.
 *
 * Output: dist/bundled/index.js
 */
import { build } from 'esbuild';
import { execSync } from 'node:child_process';
import { chmodSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { buildIntegrityWorker } from './build-integrity-worker.mjs';
import { buildSchemaWorker } from './build-schema-worker.mjs';
import { collectBundleLicenses } from './bundle-licenses.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Build stamp embedded into the bundle and logged at boot (see src/index.ts
// __POPCLAW_BUILD__). Time is the owner's timezone UTC+8 (Beijing), marked +08.
// Format: "<version> <YYYY-MM-DD HH:MM>+08 <sha>[-dirty] (<branch>)".
function gitDescribe() {
  const run = (cmd) => execSync(cmd, { cwd: root }).toString().trim();
  try {
    const sha = run('git rev-parse --short HEAD');
    const branch = run('git rev-parse --abbrev-ref HEAD');
    const dirty = run('git status --porcelain') ? '-dirty' : '';
    return `${sha}${dirty} (${branch})`;
  } catch {
    return 'nogit';
  }
}
const version = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf-8')).version;
// UTC+8 (owner's tz; China has no DST so a fixed +8h offset is exact).
const builtAt = new Date(Date.now() + 8 * 3600 * 1000)
  .toISOString()
  .slice(0, 16)
  .replace('T', ' ');
const BUILD_STAMP = `${version} ${builtAt}+08 ${gitDescribe()}`;
const schemaWorker = await buildSchemaWorker();
const integrityWorker = await buildIntegrityWorker();

const shared = {
  bundle: true,
  metafile: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external: ['openclaw', 'openclaw/*', 'better-sqlite3', 'bindings', 'file-uri-to-path'],
  sourcemap: false,
  minify: false,
  // Third-party license comments (e.g. noble-curves/noble-hashes/scure-base's
  // `/*! ... MIT License ... */` headers) already survive under esbuild's
  // own default for bundle:true ('eof'). Set explicitly anyway so this
  // stays true even if `minify` or esbuild's default ever changes — losing
  // attribution notices we're obligated to ship (exit-review I-F) should
  // never be a side effect of an unrelated option flip.
  legalComments: 'eof',
  // The public protocol codec and algorithms resolve to the pinned protocol
  // bundle at the repository root — the same mapping as tsconfig.json paths
  // (kept in sync with
  // build-public-envelope.mjs, which verifies the pin before any build).
  alias: {
    '@popclaw/contracts/descriptor': resolve(root, '../../protocol/packages/contracts/ts/contracts/src/generated/descriptor.js'),
    '@popclaw/contracts/world-interaction/private-message.schema.json': resolve(root, '../../protocol/packages/contracts/protocol/retained/private-message.schema.json'),
    '@popclaw/contracts/world-interaction/schema-profile.schema.json': resolve(root, '../../protocol/packages/contracts/protocol/retained/schema-profile.schema.json'),
    '@popclaw/contracts/world-interaction/participation.schema.json': resolve(root, '../../protocol/packages/contracts/protocol/retained/participation.schema.json'),
    '@popclaw/contracts/world-interaction/manifest.schema.json': resolve(root, 'src/protocol/retained/manifest.schema.json'),
    '@popclaw/contracts/world-interaction/first-release-candidate/board.schema.json': resolve(root, '../../protocol/packages/contracts/protocol/public-envelope-02/board.schema.json'),
    '@popclaw/contracts/world-interaction/first-release-candidate/action-kind.schema.json': resolve(root, '../../protocol/packages/contracts/protocol/public-envelope-02/action-kind.schema.json'),
    '@popclaw/contracts/world-interaction/first-release-candidate/interpreted-event-kind.schema.json': resolve(root, '../../protocol/packages/contracts/protocol/public-envelope-02/interpreted-event-kind.schema.json'),
    '@popclaw/contracts': resolve(root, '../../protocol/packages/contracts/ts/contracts/src/index.ts'),
    '@popclaw/algorithms': resolve(root, '../../protocol/packages/contracts/ts/algorithms/src/index.ts'),
  },
  logLevel: 'info',
  define: {
    __POPCLAW_BUILD__: JSON.stringify(BUILD_STAMP),
    __POPCLAW_SCHEMA_WORKER_SOURCE__: JSON.stringify(schemaWorker.source),
    __POPCLAW_INTEGRITY_WORKER_SOURCE__: JSON.stringify(integrityWorker.source),
  },
};

// Same banner for both entries (native-deps resolver + createRequire); the MCP
// entry additionally gets a shebang because it is the `popclaw-mcp` bin.
const bannerLines = [
  // Node.js' ESM import of CommonJS packages needs `createRequire` injected
  // for a few deps (pino, protobufjs) that still ship CJS.
  //
  // Additionally: patch Module._resolveFilename so `require('better-sqlite3')`
  // (and its transitive `bindings` / `file-uri-to-path`) resolve to the
  // sibling `dist/native-deps/<name>/` directory. This lets us ship native
  // module sources + prebuilt `.node` binding outside `node_modules/` (which
  // `pnpm pack` strips unconditionally).
  `import { createRequire as __popclawCreateRequire } from 'node:module';`,
  `import { fileURLToPath as __popclawFileURLToPath } from 'node:url';`,
  `import { dirname as __popclawDirname, join as __popclawJoin } from 'node:path';`,
  `import * as __popclawNodeModule from 'node:module';`,
  `const require = __popclawCreateRequire(import.meta.url);`,
  `const __popclawBundleDir = __popclawDirname(__popclawFileURLToPath(import.meta.url));`,
  `const __popclawVendorDir = __popclawJoin(__popclawBundleDir, '..', 'native-deps');`,
  `const __popclawVendored = new Set(['better-sqlite3', 'bindings', 'file-uri-to-path']);`,
  `const __popclawOrigResolve = __popclawNodeModule.Module._resolveFilename;`,
  `__popclawNodeModule.Module._resolveFilename = function (request, parent, ...rest) {`,
  `  if (__popclawVendored.has(request)) {`,
  `    return __popclawOrigResolve.call(this, __popclawJoin(__popclawVendorDir, request), parent, ...rest);`,
  `  }`,
  `  return __popclawOrigResolve.call(this, request, parent, ...rest);`,
  `};`,
];

// Every distributed entry's result is kept: the license closure below is
// computed over all of their metafiles, not the plugin entry's alone.
const entryResults = [];
entryResults.push(await build({
  ...shared,
  entryPoints: [resolve(root, 'src/index.ts')],
  outfile: resolve(root, 'dist/bundled/index.js'),
  banner: { js: bannerLines.join('\n') },
}));

// The `popclaw-mcp` bin: same core, third composition root (stdio MCP server).
entryResults.push(await build({
  ...shared,
  entryPoints: [resolve(root, 'src/mcp.ts')],
  outfile: resolve(root, 'dist/bundled/mcp.js'),
  banner: { js: ['#!/usr/bin/env node', ...bannerLines].join('\n') },
}));
// npm sets the exec bit on `bin` targets at install time; do it here too so the
// bundle is runnable straight out of the build dir.
chmodSync(resolve(root, 'dist/bundled/mcp.js'), 0o755);

entryResults.push(await build({
  ...shared,
  entryPoints: [resolve(root, 'src/mcp-hook.ts')],
  outfile: resolve(root, 'dist/bundled/mcp-hook.js'),
  banner: { js: ['#!/usr/bin/env node', ...bannerLines].join('\n') },
}));
chmodSync(resolve(root, 'dist/bundled/mcp-hook.js'), 0o755);

// Standalone command entry; the plugin owns `popclaw`, while the MCP package
// retains its separate `popclaw-mcp` and `popclaw-mcp-hook` names.
entryResults.push(await build({
  ...shared,
  entryPoints: [resolve(root, 'src/main.ts')],
  outfile: resolve(root, 'dist/bundled/cli.js'),
  banner: { js: ['#!/usr/bin/env node', ...bannerLines].join('\n') },
}));
chmodSync(resolve(root, 'dist/bundled/cli.js'), 0o755);

// Explicit offline maintenance entry, distributed with the same native runtime.
entryResults.push(await build({
  ...shared,
  entryPoints: [resolve(root, 'scripts/prepare-native-world.ts')],
  outfile: resolve(root, 'dist/bundled/prepare-native-world.js'),
  banner: { js: ['#!/usr/bin/env node', ...bannerLines].join('\n') },
}));
chmodSync(resolve(root, 'dist/bundled/prepare-native-world.js'), 0o755);

// License closure of the ACTUAL bundle inputs of EVERY distributed file: each
// entry above plus the schema worker embedded into all of them. Every
// third-party package whose code was inlined anywhere gets its full LICENSE
// (and NOTICE, if any) shipped beside the bundle (esbuild's legalComments:eof
// preserves /*! */ headers, but that alone does not carry a package's full
// license text). A package without a license fails the build. Dev-only and
// workspace-internal inputs are not part of the closure. The vendored
// smol-toml license rides along byte-exact.
const licensed = collectBundleLicenses({
  metafiles: [schemaWorker.metafile, integrityWorker.metafile, ...entryResults.map((r) => r.metafile)],
  baseDir: root,
  licensesDir: resolve(root, 'dist/bundled/licenses'),
  vendored: [{ label: 'smol-toml@vendored', file: resolve(root, 'src/setup/vendor/smol-toml.LICENSE') }],
});
console.log(`bundle licenses: shipped ${licensed.length} npm package licenses + vendored smol-toml`);

console.log(
  `bundled → dist/bundled/index.js + dist/bundled/mcp.js + dist/bundled/mcp-hook.js + dist/bundled/cli.js + dist/bundled/prepare-native-world.js  [build ${BUILD_STAMP}]`,
);
