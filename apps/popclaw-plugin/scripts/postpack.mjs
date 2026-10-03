/**
 * Post-pack hook: restore the dev-mode package.json after prepack's
 * strip operation. See prepack.mjs for rationale.
 */
import { copyFileSync, unlinkSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkgPath = resolve(root, 'package.json');
const backupPath = resolve(root, 'package.json.backup');

if (existsSync(backupPath)) {
  copyFileSync(backupPath, pkgPath);
  unlinkSync(backupPath);
  console.log('postpack: restored package.json from backup');
} else {
  console.warn('postpack: no backup found — was prepack run?');
}
