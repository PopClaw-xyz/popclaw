/**
 * The runtime-bag contract between the two TOOL-REGISTERING composition roots
 * (`index.ts`, the OpenClaw gateway, and `mcp.ts`, the stdio MCP bridge) and
 * the tool modules under `src/tools/`. `main.ts` is the dev CLI/daemon and registers no
 * tools, so it builds no bag.
 *
 * This guards an entire class of silent failures. register-tools always reads runtime through
 * optional chains (`rt?.knownFollowers?.allFollowerIds?.()`), so a missing root-supplied slot
 * produces no error or exception; the feature silently disappears. This happened when the MCP
 * bridge never supplied knownFollowers and person resolution silently omitted all followers
 * (the gateway had already hit the same failure on a real machine on 2026-07-30).
 *
 * Two gates cover separate halves:
 *  ① Missing supply: runtime/plugin-runtime.ts types the bag and all three roots annotate it.
 *     Missing slots fail compilation; tsc owns this gate, so no test is needed.
 *  ② Excess reads (this file): register-tools casts runtime to local structural types, bypassing
 *     gate ①. Reading a name absent from the contract produces no tsc error. Scan source for
 *     set containment: every name read must be declared in the contract.
 *
 * Outside the scan on purpose: `src/commands/status-deps.ts` reads the runtime
 * through `Pick<PluginRuntime, ...>`, not a local cast, so gate ① (tsc) already
 * fails on any slot it names that the contract does not declare.
 */
import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../../src');

/**
 * The MCP root's build path since C2 of the shared-assembly refactor:
 * `mcp.ts` → `host/mcp-runtime-ports.ts` (`buildMcpRuntime`, `mcpRuntimePorts`)
 * → `runtime/assembly/**` (`assembleRuntime` and its private builders). The
 * wiring the checks below pin used to be typed in `mcp.ts`; it is read where
 * it lives now, and the first check proves `mcp.ts` really goes that way.
 */
const ASSEMBLY_DIR = join(SRC, 'runtime/assembly');
const ASSEMBLY_FILES = readdirSync(ASSEMBLY_DIR, { recursive: true, encoding: 'utf-8' })
  .filter((f) => f.endsWith('.ts')).map((f) => `runtime/assembly/${f}`).sort();
const RUNTIME_PORT_FILES = readdirSync(join(SRC, 'host')).filter((f) => f.endsWith('-runtime-ports.ts')).map((f) => `host/${f}`);
const readSrc = (file: string) => readFileSync(join(SRC, file), 'utf-8');

/** `file`'s source with every comment removed (TypeScript's own scanner), so a
 *  presence check can only be satisfied by code. */
function code(file: string): string {
  return stripComments(readSrc(file));
}

function stripComments(text: string): string {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, text);
  let out = '';
  // Open braces per enclosing template substitution: a `}` that closes a
  // `${…}` is rescanned as the rest of the template, so text such as
  // `http://${x}` is never read as a comment.
  const templates: number[] = [];
  for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) {
    if (kind === ts.SyntaxKind.TemplateHead) templates.push(0);
    else if (kind === ts.SyntaxKind.OpenBraceToken && templates.length) templates[templates.length - 1]!++;
    else if (kind === ts.SyntaxKind.CloseBraceToken && templates.length) {
      if (templates[templates.length - 1] === 0) {
        if (scanner.reScanTemplateToken(false) === ts.SyntaxKind.TemplateTail) templates.pop();
      } else templates[templates.length - 1]!--;
    }
    if (kind === ts.SyntaxKind.SingleLineCommentTrivia || kind === ts.SyntaxKind.MultiLineCommentTrivia) continue;
    out += scanner.getTokenText();
  }
  return out;
}

/** Every file on the MCP root's build path, in the order the build reaches them. */
const MCP_PATH_FILES = ['mcp.ts', 'host/mcp-runtime-ports.ts', ...ASSEMBLY_FILES];
/** The gateway root's build path since C3: `index.ts` → `host/openclaw-runtime-ports.ts` → `runtime/assembly/**`. */
const GATEWAY_PATH_FILES = ['index.ts', 'host/openclaw-runtime-ports.ts', ...ASSEMBLY_FILES];
/** The one runtime-ports file that may import the host SDK: the assembly never may. */
const SDK_PORT_FILES = new Set(['host/openclaw-runtime-ports.ts']);

/** The MCP root really builds through `buildMcpRuntime` → `assembleRuntime`. */
function assertMcpBuildPath(): void {
  expect(code('mcp.ts')).toMatch(/return buildMcpRuntime\(\{/);
  expect(code('host/mcp-runtime-ports.ts')).toMatch(/return assembleRuntime\(host, mcpRuntimePorts\(/);
  expect(ASSEMBLY_FILES.length).toBeGreaterThan(5);
}

/** The gateway root really builds through `gatewayRuntimePorts` → `assembleRuntime`. */
function assertGatewayBuildPath(): void {
  expect(code('index.ts')).toMatch(/return assembleRuntime\(host, gatewayRuntimePorts\(\{/);
  expect(code('host/openclaw-runtime-ports.ts')).toMatch(/export function gatewayRuntimePorts\(/);
  expect(ASSEMBLY_FILES.length).toBeGreaterThan(5);
}

/** How many times `pattern` occurs in the code of each file on a root's path (files with none omitted). */
function occurrences(pattern: RegExp, files: readonly string[] = MCP_PATH_FILES): Record<string, number> {
  const found: Record<string, number> = {};
  for (const file of files) {
    const n = code(file).match(new RegExp(pattern.source, 'g'))?.length ?? 0;
    if (n > 0) found[file] = n;
  }
  return found;
}

/** Contract field names: top-level, two-space-indented name: / readonly name:. */
function declaredContractKeys(): Set<string> {
  const src = readFileSync(join(SRC, 'runtime/plugin-runtime.ts'), 'utf-8');
  const body = src.slice(src.indexOf('export interface PluginRuntime {'));
  return new Set(
    [...body.matchAll(/^ {2}(?:readonly )?([a-zA-Z_][\w]*)\??:/gm)].map((m) => m[1]!),
  );
}

/** The subset of those that are REQUIRED — declared without a `?`. */
function requiredContractKeys(): Set<string> {
  const src = readFileSync(join(SRC, 'runtime/plugin-runtime.ts'), 'utf-8');
  const body = src.slice(src.indexOf('export interface PluginRuntime {'));
  return new Set(
    [...body.matchAll(/^ {2}(?:readonly )?([a-zA-Z_][\w]*):/gm)].map((m) => m[1]!),
  );
}

/**
 * Field names: recognize only reads through a stored variable (rt.x after const rt = await runtime()),
 * the dominant register-tools pattern. Rare inline reads such as (await deps.runtime())?.nameOf
 * are outside the scan, so this covers the main pattern, not every possible read.
 */
function keysReadByTools(): Set<string> {
  // After the 2026-08-25 split, tools live in domain modules under src/tools/*.ts instead of one register-tools.ts file.
  // Scan the whole directory to preserve this gate's coverage.
  const dir = join(SRC, 'tools');
  // Recursive, so a later per-domain subdirectory cannot drop out of the scan.
  const files = readdirSync(dir, { recursive: true, encoding: 'utf-8' }).filter((f) => f.endsWith('.ts'));
  // An empty glob after renaming or moving files would let containment pass vacuously,
  // leaving a green gate that checked nothing. First assert that the scan found something.
  expect(files.length).toBeGreaterThan(5);
  const src = files.map((f) => readFileSync(join(dir, f), 'utf-8')).join('\n');
  const keys = new Set([...src.matchAll(/\brt\??\.([a-zA-Z_][\w]*)/g)].map((m) => m[1]!));
  expect(keys.size).toBeGreaterThan(0);
  return keys;
}

describe('PluginRuntime contract', () => {
  // `houseSilenceOf` (ingress/house-silence.ts) reads this slot through a cast
  // from OUTSIDE src/tools/, so the scan below cannot see it. Renaming it on
  // the contract side would turn the #588 outage line off in silence.
  // tests/unit/ingress/house-silence.test.ts pins the other half — that a real
  // WorldFeedCatalog still satisfies the shape read through that cast.
  it('declares worldFeedCache, the slot the #588 outage line reads through a cast', () => {
    expect(declaredContractKeys().has('worldFeedCache')).toBe(true);
  });

  it('declares every key register-tools reads (a read of an undeclared key is a silent no-op)', () => {
    const declared = declaredContractKeys();
    const read = keysReadByTools();
    const undeclared = [...read].filter((k) => !declared.has(k)).sort();
    expect(undeclared).toEqual([]);
  });

  // The four keys the MCP root was missing until 2026-08-24 (nameOf, houses,
  // houseStarted, knownFollowers) are pinned on the REAL bags since C4:
  // runtime/assembly/assemble-runtime-{mcp,gateway}.test.ts compare each
  // root's bag with its exact key set.

  /**
   * The follow doorbell's rows, and the one slot where optional was itself the
   * defect. Every resident root pulls the batch now
   * (runtime/resident-services.ts), and the pull enqueues an L2 telling the
   * owner "N pending — say 'follow list'". `stub-tools.ts` and
   * `world-tools.ts` both reach this slot through a local `pendingFollows?:`
   * cast, so a root that omitted it answered that invitation with an empty
   * list and a follow that never graduated.
   *
   * Required is what makes tsc gate ① catch that: a root that pulls the batch
   * and cannot show it no longer compiles. Optional again would compile, run,
   * and be silent — which is the whole failure mode this file exists for.
   */
  it('requires pendingFollows — the slot whose optionality WAS the dead end', () => {
    expect(declaredContractKeys()).toContain('pendingFollows');
    expect(requiredContractKeys()).toContain('pendingFollows');
  });

  it('is types-only — no runtime code, no node imports (eslint bans those outside the roots)', () => {
    const src = readFileSync(join(SRC, 'runtime/plugin-runtime.ts'), 'utf-8');
    expect(src).not.toMatch(/^import (?!type )/m);
    expect(src).not.toMatch(/from '(node:|fs|path|os)/);
  });
});

describe('MCP composition root', () => {
  // Each wiring check below reads the ONE file that must hold it, without
  // comments; the build-path check proves mcp.ts really reaches those files.
  it('builds through the shared assembly, and the moved wiring is really gone from mcp.ts', () => {
    assertMcpBuildPath();
    const root = code('mcp.ts');
    for (const moved of ['makeNameChain(', 'new KnownFollowersStore(host.db)', 'followPerson: errandFollowFrom(', 'canvas: {']) {
      expect(root, moved).not.toContain(moved);
    }
  });

  // The bag is type-checked (McpPluginRuntime), so "missing" is a compile error.
  // The OPTIONAL surfaces are not: `getWorldDeps`' `mountedGuides` and all five
  // `?:` slots on OnboardingOrchestratorDeps drop silently, each disabling one
  // feature for MCP citizens only. Three of the five (nameOf / houses /
  // houseStarted) are pinned by the construction test below; the two that carry
  // their own wiring are pinned here.
  it('feeds the world tools the mounted houses guides', () => {
    // Without it the world tools only ever describe the PRIMARY house — every
    // other mounted house reads as if it were never mounted (ADR-0041).
    expect(code('mcp.ts')).toMatch(/mountedGuides:\s*\(\)\s*=>\s*mountedHouseGuides\(/);
  });

  it('wires the image fetcher both roots share', () => {
    // `fetchImage` is an OPTIONAL tool dep, so a root that forgets it compiles and
    // runs — read-tools then assembles no `avatars` deps, publish-newspaper skips
    // the inlining, and only the MCP-published paper still asks a third party for
    // its faces. Same module in both roots, never a second implementation.
    expect(code('mcp.ts')).toMatch(/fetchImage:\s*fetchImageOverHttp/);
    expect(code('mcp.ts')).toContain("from './visual/fetch-image.js'");
    expect(readFileSync(join(SRC, 'index.ts'), 'utf-8')).toMatch(/fetchImage:\s*fetchImageOverHttp/);
  });

  it('gives onboarding the canvas + the follow chain', () => {
    // No canvas → the onboarding cards lose their link line (spec §3).
    expect(code('runtime/assembly/onboarding.ts')).toMatch(/new OnboardingOrchestrator\(\{[\s\S]*canvas:\s*\{/);
    // No followPerson → the errand act degrades to "noted, go find them yourself".
    // Both tool-registering roots go through the SAME assembly (errandFollowFrom
    // in commands/follow.ts) — a root building its own would be the drift this
    // whole file exists to catch.
    expect(code('runtime/assembly/onboarding.ts')).toMatch(/followPerson:\s*errandFollowFrom\(/);
    expect(code('runtime/assembly/index.ts')).toMatch(/= buildOnboarding\(\{/);
    // The gateway root builds through that same assembly since C3, and types none of it.
    assertGatewayBuildPath();
    for (const moved of ['errandFollowFrom(', 'new OnboardingOrchestrator(', 'makeNameChain(', 'new KnownFollowersStore(']) {
      expect(code('index.ts'), moved).not.toContain(moved);
      expect(code('host/openclaw-runtime-ports.ts'), moved).not.toContain(moved);
    }
  });

  // Same source as index.ts's — a second, MCP-only way to compute "who is this"
  // or "which houses are mounted" is exactly how the two roots drift apart.
  it('builds nameOf / houses / houseStarted from the same modules index.ts uses', () => {
    expect(code('runtime/assembly/relations.ts')).toContain('return makeNameChain(');
    expect(code('runtime/assembly/core.ts')).toContain('const knownFollowers = new KnownFollowersStore(host.db)');
    expect(code('runtime/assembly/onboarding.ts')).toContain('mountedHouseGuides(paths, boot.loreHouseUrls)');
    expect(code('runtime/assembly/onboarding.ts')).toContain('inboxStore.hasIncomingFrom(');
    // …and the assembly calls those builders and puts their results in the bag.
    const index = code('runtime/assembly/index.ts');
    expect(index).toMatch(/const nameOf = buildNameChain\(/);
    expect(index).toMatch(/= buildSharedStores\(/);
    expect(index).toMatch(/= mountedHousesOf\(/);
    for (const key of ['nameOf,', 'knownFollowers,', 'houses: mountedHouses,', 'houseStarted,']) expect(index).toContain(key);
  });
});

/**
 * `boot.nickname` is a live getter (a rename must reach the next signed
 * envelope). An object spread of `boot`, or a value captured from it at
 * wiring time, freezes the startup name again — silently: everything still
 * compiles and signs, just as `ranger-xxxxxx`.
 *
 * Both tool-registering roots are booted since C2/C3, so their wiring is
 * pinned by behaviour: assemble-runtime-{mcp,gateway}.test.ts rename after the
 * boot and read the name back from the boot, the invite builder, the mark
 * signer, the onboarding canvas and the profile URL. What stays here is what
 * no boot can show: the dev daemon's wrap, and a ratchet on value captures.
 */
describe('the owner name stays live in the roots', () => {
  const roots = {
    'main.ts': readFileSync(join(SRC, 'main.ts'), 'utf-8'),
  };

  it.each(Object.keys(roots))('%s wraps the boot with extendBoot, never an object spread', (file) => {
    const src = roots[file as keyof typeof roots];
    expect(src).toMatch(/extendBoot\((rawBoot|boot),/);
    expect(src).not.toMatch(/\.\.\.\s*(rawBoot|boot)\b/);
  });

  // A NEW consumer that captured the name would not be among the surfaces the
  // behaviour probes read, so value captures stay a ratchet: the only one is
  // the Ranger's, whose field is never read.
  it('the only value capture of the owner name on either build path is the Ranger\'s, and nothing spreads the boot', () => {
    const files = [...new Set([...MCP_PATH_FILES, ...GATEWAY_PATH_FILES])];
    expect(occurrences(/nickname: boot\.nickname\b/, files)).toEqual({ 'runtime/assembly/feeds.ts': 1 });
    // …and no file on either path (the roots included) spreads the boot.
    expect(occurrences(/\.\.\.\s*(rawBoot|boot)\b/, files)).toEqual({});
  });
});

/**
 * The shared runtime assembly is business code every tool-registering root
 * runs inside its lazy build (ADR-0035). Host facts reach it through ports
 * only: it must not read the environment, touch Node or the host SDK, know a
 * root, or do anything when merely imported.
 */
describe('the shared runtime assembly stays host-free and inert', () => {
  it('the scan covers the assembly and every root runtime-ports file', () => {
    expect(ASSEMBLY_FILES).toContain('runtime/assembly/index.ts');
    expect(RUNTIME_PORT_FILES).toContain('host/mcp-runtime-ports.ts');
    expect(RUNTIME_PORT_FILES).toContain('host/openclaw-runtime-ports.ts');
    // Control for the SDK allowance below: the gateway ports really import the
    // SDK (so the allowance is not vacuous), and it is the only exempt file.
    expect(readSrc('host/openclaw-runtime-ports.ts')).toMatch(/from 'openclaw\//);
    expect([...SDK_PORT_FILES].every((f) => RUNTIME_PORT_FILES.includes(f))).toBe(true);
  });

  it.each(ASSEMBLY_FILES)('%s: no env read, no node import, no host SDK, no root, no host-name literal', (file) => {
    const src = readSrc(file);
    expect(src).not.toMatch(/process\.env/);
    expect(src).not.toMatch(/from '(node:|fs|path|os|child_process)/);
    expect(src).not.toMatch(/from 'openclaw/);
    // Reverse dependencies: a root, or one host's adapters or ports.
    expect(src).not.toMatch(/from '(\.\.\/)+(index|mcp|main)\.js'/);
    expect(src).not.toMatch(/from '(\.\.\/)+host\/(mcp-|openclaw-)/);
    // A host's name in any quoting, in code (comments may name hosts).
    expect(code(file)).not.toMatch(/(['"`])(gateway|mcp)\1/i);
  });

  it('the comment stripper drops comments and nothing else (control)', () => {
    const sample = "const a = `http://${host}/x//y`; // gone\n/* gone too */ const b = 'c://d'; const e = `${f ? `g${h}` : '//'}`;";
    expect(stripComments(sample)).toBe("const a = `http://${host}/x//y`; \n const b = 'c://d'; const e = `${f ? `g${h}` : '//'}`;");
  });

  it('the host-name ban catches every quoting (control)', () => {
    for (const literal of ["'mcp'", '"gateway"', '`mcp`', "'Gateway'"]) {
      expect(literal).toMatch(/(['"`])(gateway|mcp)\1/i);
    }
  });

  it.each([...ASSEMBLY_FILES, ...RUNTIME_PORT_FILES])('%s: no import-time statement, and never an object spread of the boot', (file) => {
    const source = ts.createSourceFile(file, readSrc(file), ts.ScriptTarget.Latest, true);
    const effectful = source.statements.filter((st) => !(ts.isImportDeclaration(st) || ts.isExportDeclaration(st)
      || ts.isFunctionDeclaration(st) || ts.isInterfaceDeclaration(st) || ts.isTypeAliasDeclaration(st)
      // A top-level const is allowed only when it evaluates nothing: a function or a frozen literal of literals.
      || (ts.isVariableStatement(st) && st.declarationList.declarations.every((d) => d.initializer
        && (ts.isArrowFunction(d.initializer) || isInertLiteral(d.initializer))))));
    expect(effectful.map((st) => st.getText(source).slice(0, 80))).toEqual([]);
    expect(readSrc(file)).not.toMatch(/\.\.\.\s*(rawBoot|boot)\b/);
    // The gateway's ports may import the OpenClaw SDK; the assembly and every other ports file may not.
    if (!SDK_PORT_FILES.has(file)) expect(readSrc(file)).not.toMatch(/from 'openclaw/);
    expect(readSrc(file)).not.toMatch(/from '(node:|fs|path|os|child_process)/);
  });
});

function isInertLiteral(node: ts.Expression): boolean {
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
    && node.expression.getText() === 'Object.freeze' && node.arguments.length === 1) return isInertLiteral(node.arguments[0]!);
  if (ts.isObjectLiteralExpression(node)) {
    return node.properties.every((p) => ts.isPropertyAssignment(p) && isInertLiteral(p.initializer));
  }
  return ts.isStringLiteral(node) || ts.isNumericLiteral(node) || node.kind === ts.SyntaxKind.TrueKeyword
    || node.kind === ts.SyntaxKind.FalseKeyword || (ts.isIdentifier(node) && node.text === 'undefined');
}
