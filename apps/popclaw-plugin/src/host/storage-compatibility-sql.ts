/** Compare schema SQL formatting without interpreting or rewriting its meaning.
 * Preserve lexical boundaries, quoted text, comments, numbers and operators.
 * In particular, never delete whitespace inside a CHECK/default/index literal. */
export function schemaSqlTokens(sql: string | null | undefined): readonly string[] | null | undefined {
  if (sql == null) return sql;
  const tokens: string[] = [];
  let offset = 0;
  while (offset < sql.length) {
    const start = offset, char = sql[offset]!;
    // SQLite's ASCII whitespace, not JavaScript's broader Unicode \s class.
    if (' \t\n\r\f'.includes(char)) { offset++; continue; }
    if (sql.startsWith('--', offset)) {
      const end = sql.indexOf('\n', offset + 2);
      offset = end < 0 ? sql.length : end;
    } else if (sql.startsWith('/*', offset)) {
      const end = sql.indexOf('*/', offset + 2);
      if (end < 0) throw new Error('STORAGE_SCHEMA_SQL_INVALID');
      offset = end + 2;
    } else if ("'\"`[".includes(char)) {
      const closing = char === '[' ? ']' : char;
      offset++;
      let closed = false;
      while (offset < sql.length) {
        if (sql[offset++] !== closing) continue;
        if (char !== '[' && sql[offset] === closing) { offset++; continue; }
        closed = true; break;
      }
      if (!closed) throw new Error('STORAGE_SCHEMA_SQL_INVALID');
    } else {
      const remainder = sql.slice(offset);
      // Keep numeric literals together: 1.2 / 1e-2 differ from 1 . 2 / 1e - 2.
      const number = /^(?:0[xX][0-9a-fA-F](?:_?[0-9a-fA-F])*|(?:\d(?:_?\d)*(?:\.(?:\d(?:_?\d)*)?)?|\.\d(?:_?\d)*)(?:[eE][+-]?\d(?:_?\d)*)?)/.exec(remainder);
      const blob = /^[xX]'[0-9a-fA-F]*'/.exec(remainder);
      const identifier = /^[A-Za-z_$\u0080-\uffff][A-Za-z0-9_$\u0080-\uffff]*/.exec(remainder);
      const operator = /^(?:->>|\|\||->|<=|>=|==|!=|<>|<<|>>)/.exec(remainder);
      offset += blob?.[0].length ?? number?.[0].length ?? identifier?.[0].length ?? operator?.[0].length ?? 1;
    }
    tokens.push(sql.slice(start, offset));
  }
  return tokens;
}
