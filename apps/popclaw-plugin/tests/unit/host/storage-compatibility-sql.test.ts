import { describe, expect, it } from 'vitest';
import { schemaSqlTokens } from '../../../src/host/storage-compatibility-sql.js';

describe('schema SQL lexical whitespace comparison', () => {
  it('ignores only external SQLite whitespace around identical tokens', () => {
    expect(schemaSqlTokens('CREATE TABLE t (key TEXT PRIMARY KEY, value TEXT NOT NULL)'))
      .toEqual(schemaSqlTokens('CREATE\tTABLE\nt(key TEXT PRIMARY KEY ,value TEXT NOT NULL\r)'));
  });
  it.each([
    ["CHECK(value='a b')", "CHECK(value='ab')"],
    ["DEFAULT 'a  b'", "DEFAULT 'a b'"],
    ["CREATE INDEX x ON t(v || 'a b')", "CREATE INDEX x ON t(v || 'ab')"],
    ["CHECK(value='a'' b')", "CHECK(value='a''b')"],
    ['"a b"', '"ab"'], ['`a b`', '`ab`'], ['[a b]', '[ab]'],
    ['TEXT NOT NULL', 'TEXTNOTNULL'],
    ['v>=1', 'v > = 1'], ['v||w', 'v | | w'],
    ['v- -1', 'v--1'], ['1.2', '1 . 2'], ['1e-2', '1e - 2'],
    ['1_000', '1 _000'], ['0xA_B', '0xA _B'], ["X'AB'", "X 'AB'"],
    ['/* a b */', '/* ab */'], ['-- a b\n', '-- ab\n'],
    ['name\u00a0suffix', 'namesuffix'],
  ])('preserves meaningful lexical differences: %s / %s', (left, right) => {
    expect(schemaSqlTokens(left)).not.toEqual(schemaSqlTokens(right));
  });
  it('preserves null index SQL and fails closed on unterminated quoted/comment text', () => {
    expect(schemaSqlTokens(null)).toBeNull(); expect(schemaSqlTokens(undefined)).toBeUndefined();
    for (const sql of ["'a", '"a', '`a', '[a', '/* a']) expect(() => schemaSqlTokens(sql)).toThrow('STORAGE_SCHEMA_SQL_INVALID');
  });
});
