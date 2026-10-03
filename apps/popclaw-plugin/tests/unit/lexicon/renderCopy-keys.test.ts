import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { EN } from '../../../src/lexicon/en.js';

/**
 * renderCopy()/t() take an untyped `key: string` — TypeScript cannot catch a
 * call site pointing at a copy key that no longer exists. lexicon/index.ts's
 * fallback chain (lang → en → the bare key) means a key missing from BOTH
 * lanes doesn't throw, it silently renders the literal key string. If a test
 * asserts on that same key via the same helper, the test computes the exact
 * same wrong literal and passes — a delete-from-both-lanes mistake goes
 * undetected. This file is the guard: it scans every call site in `src/`
 * and asserts the key argument still resolves.
 */
const SRC_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../src');
const COPY_KEYS = new Set(Object.keys(EN.copy));

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...listTsFiles(p));
    else if (name.endsWith('.ts') && !name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

/** Split a call's argument list on top-level commas (ignoring ones nested in (), [], {}, or quotes). */
function splitTopLevelArgs(s: string): string[] {
  const args: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (quote) {
      cur += c;
      if (c === '\\') cur += s[++i] ?? '';
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      quote = c;
      cur += c;
      continue;
    }
    if ('([{'.includes(c)) depth++;
    if (')]}'.includes(c)) depth--;
    if (c === ',' && depth === 0) {
      args.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  if (cur.trim()) args.push(cur);
  return args;
}

/** Read output branches, excluding predicates such as key.startsWith('page.'). */
function literalsIn(segment: string): string[] {
  const ast = ts.createSourceFile('key.ts', `const key = (${segment});`, ts.ScriptTarget.Latest, true);
  const statement = ast.statements[0];
  if (!statement || !ts.isVariableStatement(statement)) return [];
  const out: string[] = [];
  const visit = (node: ts.Expression | undefined): void => {
    if (!node) return;
    if (ts.isParenthesizedExpression(node)) visit(node.expression);
    else if (ts.isConditionalExpression(node)) { visit(node.whenTrue); visit(node.whenFalse); }
    else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) {
      visit(node.left); visit(node.right);
    }
    else if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) out.push(node.text);
    else if (ts.isTemplateExpression(node)) out.push(`${node.head.text}\${dynamic}`);
  };
  visit(statement.declarationList.declarations[0]?.initializer);
  return out;
}

/** Find every `renderCopy(...)` / `t(...)` call span (text between the matching parens). */
function callSpans(src: string, open: RegExp): string[] {
  const spans: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = open.exec(src))) {
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    while (i < src.length && depth > 0) {
      if (src[i] === '(') depth++;
      else if (src[i] === ')') depth--;
      i++;
    }
    spans.push(src.slice(start, i - 1));
  }
  return spans;
}

interface Found {
  file: string;
  literal: string[];
  prefix: string[];
}

function scan(file: string): Found {
  const src = readFileSync(file, 'utf-8');
  const literal: string[] = [];
  const prefix: string[] = [];

  const push = (raw: string) => {
    // Every real copy key is a dotted `area.thing.variant` path (see the Copy
    // doc comment in lexicon/index.ts). A ternary's key argument — e.g.
    // `kind === 'bug' ? 'feedback.kindLabel.bug' : 'feedback.kindLabel.need'`
    // — also picks up the comparison's own literal ('bug'); requiring a dot
    // filters those out without needing real ternary-aware parsing.
    if (!raw.includes('.')) return;
    const interp = raw.indexOf('${');
    if (interp === -1) literal.push(raw);
    else prefix.push(raw.slice(0, interp));
  };

  for (const span of callSpans(src, /\brenderCopy\s*\(/g)) {
    const args = splitTopLevelArgs(span);
    if (args[1]) literalsIn(args[1]).forEach(push);
  }
  for (const span of callSpans(src, /(?<![.\w])t\(/g)) {
    const args = splitTopLevelArgs(span);
    if (args[0]) literalsIn(args[0]).forEach(push);
  }
  return { file, literal, prefix };
}

const files = listTsFiles(SRC_ROOT);
const results = files.map(scan).filter((r) => r.literal.length || r.prefix.length);

describe('renderCopy()/t() call sites resolve to real lexicon keys', () => {
  it('checks nullish fallback output keys, including a missing fallback', () => {
    const output = literalsIn("SEED_BY_KEY[bad[0].key] ?? 'missing.fallback.copy'");
    expect(output).toEqual(['missing.fallback.copy']);
    expect(output.filter(key => !COPY_KEYS.has(key))).toEqual(['missing.fallback.copy']);
    expect(literalsIn("SEED_BY_KEY[key] ?? 'doctor.seed.default'")).toEqual(['doctor.seed.default']);
    expect(COPY_KEYS.has('doctor.seed.default')).toBe(true);
  });
  for (const { file, literal, prefix } of results) {
    const rel = relative(SRC_ROOT, file);

    it.each([...new Set(literal)])(`${rel}: literal key "%s" exists in the copy table`, (key) => {
      expect(COPY_KEYS.has(key), `"${key}" is not a key in src/lexicon/en.ts's copy table`).toBe(true);
    });

    it.each([...new Set(prefix)])(`${rel}: dynamic key family "%s*" has at least one member`, (pfx) => {
      const hasMember = [...COPY_KEYS].some((k) => k.startsWith(pfx));
      expect(hasMember, `no copy key starts with "${pfx}" (the whole family was deleted?)`).toBe(true);
    });
  }

  it('sanity: this scan actually found call sites (guards against a broken scanner going quietly empty)', () => {
    const totalLiteral = results.reduce((n, r) => n + r.literal.length, 0);
    const totalPrefix = results.reduce((n, r) => n + r.prefix.length, 0);
    expect(totalLiteral).toBeGreaterThan(50);
    expect(totalPrefix).toBeGreaterThan(0);
  });
});

it('key extraction checks conditional outputs, not prefix predicates, without ignoring missing literal branches', () => {
  expect(literalsIn("key.startsWith('page.') ? `newspaper.${key}` : `newspaper.material.${key}`"))
    .toEqual(['newspaper.${dynamic}', 'newspaper.material.${dynamic}']);
  expect(literalsIn("kind === 'bug' ? 'feedback.kindLabel.bug' : 'missing.copy.key'"))
    .toEqual(['feedback.kindLabel.bug', 'missing.copy.key']);
  expect(literalsIn("'missing.copy.key'")).toEqual(['missing.copy.key']);
});
