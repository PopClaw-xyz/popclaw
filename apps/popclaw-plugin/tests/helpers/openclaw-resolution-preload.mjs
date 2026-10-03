/**
 * `node --import <this>` before a bundle, so a test can ASK THE LOADER what the
 * process tried to resolve instead of inferring it from behaviour.
 *
 * Used by `tests/unit/mcp-bundle-host-free.test.ts` to establish the negative
 * half of the claim: not only does the MCP root survive without `openclaw`
 * installed, it never reaches for it at all on the way to `tools/list`. Without
 * this, "the load is not triggered" would be an argument from reading the call
 * graph — and this lane's whole history is defects that survived exactly that
 * kind of argument.
 *
 * The log path arrives by environment rather than as a hook option so the
 * preload stays a one-liner; the hooks thread reads it the same way.
 */
import { register } from 'node:module';

register('./openclaw-resolution-hooks.mjs', import.meta.url);
