import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * `popclaw-mcp` is an alias, and an alias that drifts is worse than no alias.
 *
 * The shell holds nothing but two bin files and a pinned dependency on this
 * package. Every promise it makes is therefore a promise about THIS
 * package.json: same version, same supported Node lines, and two specifiers
 * that only resolve because `exports` lists them. Nothing in a release build
 * compares the two manifests — `packages/popclaw-mcp` is deliberately outside
 * the pnpm workspace — so this test is the comparison.
 */
const pluginRoot = resolve(__dirname, '../..');
const shellRoot = resolve(pluginRoot, '../../packages/popclaw-mcp');

interface Manifest {
  name: string;
  version: string;
  type?: string;
  license?: string;
  engines?: Record<string, string>;
  exports?: Record<string, string>;
  bin?: Record<string, string>;
  files?: string[];
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  repository?: { type?: string; url?: string; directory?: string };
}

const read = (root: string): Manifest =>
  JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as Manifest;

const plugin = read(pluginRoot);
const shell = read(shellRoot);

describe('popclaw-mcp travels in lock step with popclaw', () => {
  it('publishes the same version and depends on exactly that version', () => {
    expect(shell.name).toBe('popclaw-mcp');
    expect(shell.version).toBe(plugin.version);
    // Exact, not a range: `^0.1.0` would let the alias drift onto a build it
    // was never tested against, and a `workspace:`/`file:` specifier does not
    // survive into a published tarball at all.
    expect(shell.dependencies).toEqual({ popclaw: plugin.version });
    expect(shell.peerDependencies).toBeUndefined();
    expect(shell.optionalDependencies).toBeUndefined();
  });

  it('promises the same Node lines and the same licence', () => {
    expect(shell.engines).toEqual(plugin.engines);
    expect(shell.license).toBe('Apache-2.0');
    expect(shell.type).toBe('module');
  });

  it('names the public repository, with its own directory', () => {
    expect(shell.repository?.url).toBe('git+https://github.com/PopClaw-xyz/popclaw.git');
    expect(shell.repository?.directory).toBe('packages/popclaw-mcp');
  });

  it('ships two bin files that are nothing but the import', () => {
    expect(shell.bin).toEqual({
      'popclaw-mcp': 'bin/popclaw-mcp.js',
      'popclaw-mcp-hook': 'bin/popclaw-mcp-hook.js',
    });
    const specifiers: Record<string, string> = {
      'popclaw-mcp': 'popclaw/mcp',
      'popclaw-mcp-hook': 'popclaw/mcp-hook',
    };
    for (const [command, relative] of Object.entries(shell.bin!)) {
      expect(shell.files, `${command} must be in files`).toContain(relative);
      const source = readFileSync(resolve(shellRoot, relative), 'utf8');
      // Logic in a bin file is logic that has to be kept in step by hand.
      expect(source).toBe(`#!/usr/bin/env node\nimport '${specifiers[command]}';\n`);
    }
    for (const required of ['README.md', 'LICENSE', 'NOTICE']) {
      expect(shell.files).toContain(required);
    }
    // No copied runtime: the alias must not grow a second bundle, a second
    // native matrix or a second set of migrations.
    for (const copied of ['dist', 'dist/bundled', 'dist/native-deps', 'migrations', 'wallet-migrations']) {
      expect(shell.files).not.toContain(copied);
    }
  });

  it('imports specifiers this package actually exports', () => {
    expect(plugin.exports).toEqual({
      '.': './dist/bundled/index.js',
      './mcp': './dist/bundled/mcp.js',
      './mcp-hook': './dist/bundled/mcp-hook.js',
    });
  });
});
