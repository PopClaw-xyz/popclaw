// Copied into the vendored better-sqlite3 lib directory by the reviewed runtime derivation.
'use strict';
const { join } = require('node:path');
const { bindingExists, resolveNativeBinding } = require('./popclaw-native-path.cjs');

module.exports = function loadPopclawNativeBinding() {
  const major = process.versions.node.split('.')[0];
  const candidate = resolveNativeBinding(join(__dirname, '..'));
  if (candidate) return require(candidate);
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
