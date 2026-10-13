// Copied into the vendored better-sqlite3 lib directory by the reviewed runtime derivation.
'use strict';
const { statSync } = require('node:fs');
const { join } = require('node:path');

// existsSync hides EACCES and other filesystem failures. Only an absent path
// permits fallback or compilation; preserve every other error for the caller.
function bindingExists(candidate) {
  try { statSync(candidate); return true; }
  catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return false;
    throw error;
  }
}

module.exports = function loadPopclawNativeBinding() {
  const major = process.versions.node.split('.')[0];
  const release = join(__dirname, '..', 'build', 'Release');
  for (const name of [
    `better_sqlite3-${process.platform}-${process.arch}-node${major}.node`,
    `better_sqlite3-node${major}.node`,
  ]) {
    const candidate = join(release, name);
    if (bindingExists(candidate)) return require(candidate);
  }
  // node-gyp still produces the upstream default filename. Preserve all of
  // bindings' standard paths for source rebuilds and development installs.
  try {
    return require('bindings')('better_sqlite3.node');
  } catch (cause) {
    if (!(cause instanceof Error)
      || !cause.message.startsWith('Could not locate the bindings file.')
      || !Array.isArray(cause.tries) || cause.tries.length === 0
      || !cause.tries.every(candidate => typeof candidate === 'string' && !bindingExists(candidate))) {
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
