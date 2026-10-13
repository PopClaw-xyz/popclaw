// Copied into the vendored better-sqlite3 lib directory by the reviewed runtime derivation.
'use strict';
const { existsSync } = require('node:fs');
const { join } = require('node:path');

module.exports = function loadPopclawNativeBinding() {
  const major = process.versions.node.split('.')[0];
  const release = join(__dirname, '..', 'build', 'Release');
  for (const name of [
    `better_sqlite3-${process.platform}-${process.arch}-node${major}.node`,
    `better_sqlite3-node${major}.node`,
  ]) {
    const candidate = join(release, name);
    if (existsSync(candidate)) return require(candidate);
  }
  // node-gyp still produces the upstream default filename. Preserve all of
  // bindings' standard paths for source rebuilds and development installs.
  try {
    return require('bindings')('better_sqlite3.node');
  } catch (cause) {
    if (!(cause instanceof Error)
      || !cause.message.startsWith('Could not locate the bindings file.')
      || !Array.isArray(cause.tries) || cause.tries.length === 0
      || !cause.tries.every(candidate => typeof candidate === 'string' && !existsSync(candidate))) {
      throw cause;
    }
    // Only this package's confirmed missing-binding case permits LocalHostDb
    // to run its existing source rebuild. Load/permission/SQLite errors retain
    // their original type and code.
    const error = new Error(`No PopClaw native binding for ${process.platform}/${process.arch} Node ${major}`, { cause });
    error.code = 'POPCLAW_NATIVE_BINDING_MISSING';
    throw error;
  }
};
