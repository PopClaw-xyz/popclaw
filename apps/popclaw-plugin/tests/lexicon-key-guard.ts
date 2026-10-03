/**
 * A copy key that does not exist is a page that prints its own key name.
 *
 * `renderCopy` falls back to the bare key plus a `console.warn` (lexicon/index.ts) —
 * deliberately, so a missing key on the L1 push path shows up as a visible `notify.foo.bar`
 * rather than a swallowed notification. On the newspaper path that same fallback is silent
 * in practice: the host sends plugin warnings to /dev/null, so the writer gets a line of
 * gibberish and nobody hears about it.
 *
 * It happened on 2026-08-30. PR #517 added the "we cannot promise this page is whole"
 * sentence and wired the material page to `newspaper.material.integrity.*`, while the copy
 * was written under `newspaper.candidates.integrity.*`. The whole fix was a no-op on that
 * page, 355 tests stayed green, and the warning scrolled past in stderr for days.
 *
 * So the warning is now a failure. This catches the entire class — a renamed key, a new key
 * whose copy was never written, a prefix that does not match the helper it is called
 * through — once, instead of one regression test per key.
 */
import { afterEach, beforeEach, vi } from 'vitest';

let seen: string[] = [];
let original: typeof console.warn;

beforeEach(() => {
  seen = [];
  original = console.warn;
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    const line = args.map(String).join(' ');
    if (line.includes('lexicon copy key missing')) seen.push(line);
    else original(...(args as Parameters<typeof console.warn>));
  });
});

afterEach(() => {
  vi.mocked(console.warn).mockRestore?.();
  if (seen.length) {
    const lines = [...new Set(seen)];
    throw new Error(
      `${lines.length} lexicon copy key(s) missing — the page would print the key name itself:\n` +
        lines.map((l) => `  ${l}`).join('\n'),
    );
  }
});
