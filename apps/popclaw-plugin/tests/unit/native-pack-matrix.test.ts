import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const PLUGIN = join(ROOT, 'apps/popclaw-plugin');
const PREFIX = 'package/dist/native-deps/better-sqlite3/build/Release';
const TARGETS = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-x64'];
const ABIS: Record<number, number> = { 24: 137, 26: 147 };
let scratch: string;

// Synthetic binary headers and ABI export markers exercise the archive guard;
// these fixtures are not loadable addons or release packages.
const binary = (target: string, abi: number): Buffer => {
  const bytes = Buffer.alloc(600_000);
  if (target.startsWith('darwin-')) {
    bytes.writeUInt32LE(0xfeedfacf, 0);
    bytes.writeUInt32LE(target.endsWith('arm64') ? 0x100000c : 0x1000007, 4);
  } else if (target.startsWith('linux-')) {
    bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1]);
    bytes.writeUInt16LE(target.endsWith('arm64') ? 183 : 62, 18);
  } else {
    bytes.write('MZ');
    bytes.writeUInt32LE(128, 0x3c);
    bytes.write('PE\0\0', 128);
    bytes.writeUInt16LE(0x8664, 132);
  }
  bytes.write(`node_register_module_v${abi}\0`, 200);
  return bytes;
};

const fixture = (change?: (files: Map<string, Buffer>) => void): string => {
  const files = new Map<string, Buffer>();
  for (const target of TARGETS) {
    for (const major of [24, 26]) {
      files.set(`better_sqlite3-${target}-node${major}.node`, binary(target, ABIS[major]!));
    }
  }
  files.set('better_sqlite3.node', binary('darwin-arm64', 137));
  change?.(files);
  const dir = mkdtempSync(join(scratch, 'fixture-'));
  mkdirSync(join(dir, PREFIX), { recursive: true });
  for (const [name, bytes] of files) writeFileSync(join(dir, PREFIX, name), bytes);
  const tgz = `${dir}.tgz`;
  execFileSync('tar', ['-czf', tgz, '-C', dir, 'package']);
  return tgz;
};

const guard = (tgz: string) => {
  const source = readFileSync(join(ROOT, 'Justfile'), 'utf8');
  // Run the recipe's actual post-pack guard, without running pnpm pack.
  const start = source.indexOf('    mv "$src" "$dst"') + '    mv "$src" "$dst"'.length;
  const end = source.indexOf('    echo "boot log will show:');
  return spawnSync('bash', ['-euc', source.slice(start, end)], {
    cwd: PLUGIN,
    encoding: 'utf8',
    env: { ...process.env, dst: tgz },
  });
};

beforeAll(() => { scratch = mkdtempSync(join(tmpdir(), 'popclaw-native-matrix-')); });
afterAll(() => { rmSync(scratch, { recursive: true, force: true }); });

describe('pack-plugin verifies named platform, architecture and ABI cells in the archive', () => {
  it('accepts the complete declared matrix and packer fallback', () => {
    expect(guard(fixture()).status).toBe(0);
  });

  it('rejects a missing Darwin cell even when another addon keeps the count at eleven', () => {
    const result = guard(fixture(files => {
      files.delete('better_sqlite3-darwin-x64-node26.node');
      files.set('unrelated.node', binary('linux-x64', 147));
    }));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('better_sqlite3-darwin-x64-node26.node');
  });

  it('rejects a Linux binary renamed as Darwin', () => {
    const result = guard(fixture(files => {
      files.set('better_sqlite3-darwin-arm64-node24.node', binary('linux-arm64', 137));
    }));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('darwin-arm64');
  });

  it('rejects the wrong architecture under a correct cell name', () => {
    const result = guard(fixture(files => {
      files.set('better_sqlite3-linux-arm64-node26.node', binary('linux-x64', 147));
    }));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('linux-arm64');
  });

  it('rejects an ABI 137 binary renamed as Node 26', () => {
    const result = guard(fixture(files => {
      files.set('better_sqlite3-win32-x64-node26.node', binary('win32-x64', 137));
    }));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('147');
  });

  it('rejects a truncated cell and an unrelated fallback', () => {
    const truncated = guard(fixture(files => {
      files.set('better_sqlite3-linux-x64-node24.node', Buffer.alloc(20));
    }));
    expect(truncated.status).not.toBe(0);
    const fallback = guard(fixture(files => {
      files.set('better_sqlite3.node', binary('linux-x64', 137));
    }));
    expect(fallback.status).not.toBe(0);
  });
});
