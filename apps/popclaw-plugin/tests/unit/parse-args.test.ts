import { describe, it, expect } from 'vitest';
import { parseArgs } from '../../src/index.js';

describe('parseArgs', () => {
  it('parses only positional args (no flags)', () => {
    expect(parseArgs('hello world')).toEqual({
      positional: ['hello', 'world'],
      flags: {},
    });
  });

  it('parses --key=value (legacy syntax)', () => {
    expect(parseArgs('--reply=abc123 hi')).toEqual({
      positional: ['hi'],
      flags: { reply: 'abc123' },
    });
  });

  it('parses --key value (new space-separated syntax)', () => {
    expect(parseArgs('--reply abc123 hi')).toEqual({
      positional: ['hi'],
      flags: { reply: 'abc123' },
    });
  });

  it('treats --key at end of input as boolean (true)', () => {
    expect(parseArgs('--include-threads')).toEqual({
      positional: [],
      flags: { 'include-threads': 'true' },
    });
  });

  it('treats --key followed by --other as boolean (true)', () => {
    expect(parseArgs('--include-threads --author alice')).toEqual({
      positional: [],
      flags: { 'include-threads': 'true', author: 'alice' },
    });
  });

  it('only consumes ONE token after --key (rest goes to positional)', () => {
    expect(parseArgs('--reply abc hi world')).toEqual({
      positional: ['hi', 'world'],
      flags: { reply: 'abc' },
    });
  });

  it('--key without value before --other; --other still consumes its value', () => {
    expect(parseArgs('--reply --quote abc hi')).toEqual({
      positional: ['hi'],
      flags: { reply: 'true', quote: 'abc' },
    });
  });

  it('handles equal-sign in value (--key=foo=bar → flags.key=foo=bar)', () => {
    expect(parseArgs('--key=foo=bar')).toEqual({
      positional: [],
      flags: { key: 'foo=bar' },
    });
  });

  it('repeated flag: later value overrides earlier', () => {
    expect(parseArgs('--key a --key b')).toEqual({
      positional: [],
      flags: { key: 'b' },
    });
  });

  it('greedy consumption: --bool-flag <positional> attaches positional to flag (GNU-style)', () => {
    // This is the well-known "greedy consumption" tradeoff of schema-less arg
    // parsers. Same as `git log --author foo` greedily consuming `foo`.
    // Callers that want a positional after a boolean flag must either:
    //   (a) place positionals BEFORE the boolean flag (recommended)
    //   (b) use --flag=true explicitly to disambiguate
    expect(parseArgs('--include-threads 30')).toEqual({
      positional: [],
      flags: { 'include-threads': '30' },
    });
    // Workaround (a):
    expect(parseArgs('30 --include-threads')).toEqual({
      positional: ['30'],
      flags: { 'include-threads': 'true' },
    });
  });
});
