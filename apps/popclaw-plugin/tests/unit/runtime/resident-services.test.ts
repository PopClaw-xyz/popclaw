/**
 * The divergence guard.
 *
 * Three times now a long-running leg has been assembled inline in the
 * gateway's `register()` and nowhere else, and three times the MCP host and
 * the dev daemon lost the capability with nothing on stderr to say so. This
 * test makes the roots' disagreement loud: `RESIDENT_SERVICES` says which root
 * must start what (and why, for any root that must not), and here each root's
 * REAL wiring is read back and compared with it.
 *
 * What "real wiring" means per root, and what it does not:
 *  - gateway: `plugin.register()` is actually called with a collector api, so
 *    the ids asserted are the ids OpenClaw would be handed. A new service that
 *    nobody added a row for fails here.
 *  - gateway / mcp starters: since C4 compared with the table on behaviour,
 *    not here. The production root paths are booted with every starter
 *    probed — `assembly/assemble-runtime-mcp.test.ts` "starts exactly the
 *    resident starters RESIDENT_SERVICES assigns the MCP root, each once" and
 *    `root-assembly-gateway.test.ts` "each gateway service with a starter in
 *    RESIDENT_SERVICES starts exactly that starter, as the table says".
 *  - daemon: `src/main.ts` is not assembled and cannot be booted here, so its
 *    wiring is read from the TypeScript AST: which starter EXPORTS the root
 *    imports and calls. That resolves through the import declaration, so
 *    renaming the export — the move a text grep would sail straight past — is
 *    caught; what it cannot see is whether the call is reachable at runtime.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import {
  ALL_STARTERS,
  RESIDENT_SERVICES,
  ROOT_SOURCES,
  servicesStartedBy,
  startersCalledBy,
  type RootId,
  type StarterRef,
} from '../../../src/runtime/resident-services.js';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../../../src');

const seam = vi.hoisted(() => ({ runtime: vi.fn() }));
vi.mock('../../../src/runtime/once.js', async (original) => {
  const actual = await original<typeof import('../../../src/runtime/once.js')>();
  return {
    ...actual,
    getOrCreatePerProcess: <T>(key: string, factory: () => T): T =>
      key === 'runtime' ? (seam.runtime() as T) : actual.getOrCreatePerProcess(key, factory),
  };
});
vi.mock('../../../src/lexicon/owner-language.js', async (original) => ({
  ...(await original<typeof import('../../../src/lexicon/owner-language.js')>()),
  ownerLang: () => 'en',
  observeOwnerText: vi.fn(),
}));
import plugin from '../../../src/index.js';

const stateDirs: string[] = [];
beforeEach(() => {
  seam.runtime.mockImplementation(() => {
    throw new Error('UNEXPECTED_BOOTSTRAP');
  });
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('UNEXPECTED_NETWORK'); }));
});
afterEach(() => {
  stateDirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

/** Register the plugin for real and collect the service ids it hands the host. */
function registeredServiceIds(): string[] {
  const state = mkdtempSync(join(tmpdir(), 'resident-services-'));
  stateDirs.push(state);
  const ids: string[] = [];
  const api = {
    registrationMode: 'full',
    config: {},
    pluginConfig: {},
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    runtime: {
      state: { resolveStateDir: () => state },
      system: { enqueueSystemEvent: vi.fn(), runHeartbeatOnce: vi.fn() },
    },
    registerTool: (tool: unknown, options?: { name?: string }) =>
      typeof tool === 'function'
        ? void (tool as (c: unknown) => unknown)({ agentId: 'main', getRuntimeConfig: () => ({}) })
        : void options,
    registerCommand: vi.fn(),
    registerService: (service: { id: string }) => void ids.push(service.id),
    registerInteractiveHandler: vi.fn(),
    on: vi.fn(),
  };
  plugin.register!(api as unknown as Parameters<NonNullable<typeof plugin.register>>[0]);
  return ids;
}

const key = (r: StarterRef): string => `${r.module}#${r.export}`;
const KNOWN = new Set(ALL_STARTERS.map(key));

/**
 * Which of the table's starter exports `file` imports AND calls.
 *
 * Resolved through the file's own import declarations: a local alias
 * (`import { startFollowDoorbell as ring }`) still reports the exported name,
 * and a renamed export stops matching — which is the whole point of not
 * grepping for identifiers. Specifiers are resolved relative to the file, so a
 * builder under `runtime/assembly/` reports the same module path a root does.
 */
function startersCalledIn(file: string): StarterRef[] {
  const source = ts.createSourceFile(
    file,
    readFileSync(join(SRC, file), 'utf-8'),
    ts.ScriptTarget.ESNext,
    true,
  );
  /** local binding name -> the module + export it came from */
  const bindings = new Map<string, StarterRef>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const named = statement.importClause?.namedBindings;
    if (!named || !ts.isNamedImports(named)) continue;
    // '../../newspaper/follow-doorbell-service.js' from runtime/assembly/loops.ts -> 'newspaper/follow-doorbell-service'
    const module = posix.join(posix.dirname(file), statement.moduleSpecifier.text).replace(/\.js$/, '');
    for (const element of named.elements) {
      if (element.isTypeOnly || statement.importClause?.isTypeOnly) continue;
      bindings.set(element.name.text, { module, export: (element.propertyName ?? element.name).text });
    }
  }
  const called: StarterRef[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const ref = bindings.get(node.expression.text);
      if (ref && KNOWN.has(key(ref)) && !called.some((c) => key(c) === key(ref))) called.push(ref);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);
  return called;
}

/** A ROOT_SOURCES list with every directory entry (`…/`) expanded to its `.ts` files. */
function expand(entries: readonly string[]): string[] {
  return entries.flatMap((entry) => entry.endsWith('/')
    ? readdirSync(join(SRC, entry), { recursive: true, encoding: 'utf-8' }).filter((f) => f.endsWith('.ts')).map((f) => posix.join(entry, f)).sort()
    : [entry]);
}

/** The union over every file a root's wiring lives in. */
function startersCalledAcross(entries: readonly string[]): StarterRef[] {
  const all = expand(entries).flatMap(startersCalledIn);
  return all.filter((ref, i) => all.findIndex((r) => key(r) === key(ref)) === i);
}

const sorted = (refs: readonly StarterRef[]): string[] => refs.map(key).sort();

describe('RESIDENT_SERVICES — the table itself', () => {
  it('names every root for every service, with a reason wherever a root must not start it', () => {
    for (const service of RESIDENT_SERVICES) {
      for (const root of ['gateway', 'mcp', 'daemon'] as RootId[]) {
        const verdict = service.roots[root];
        expect(verdict, `${service.id} says nothing about ${root}`).toBeDefined();
        if (verdict !== true) {
          // A bare "no" is how a gap becomes invisible again. The reason is
          // the whole difference between deliberate and forgotten.
          expect(typeof verdict, `${service.id}/${root}`).toBe('string');
          expect((verdict as string).length, `${service.id}/${root} has an empty reason`).toBeGreaterThan(20);
        }
      }
    }
  });

  it('gives every service more than one root has to start a shared starter to call', () => {
    for (const service of RESIDENT_SERVICES) {
      const elsewhere = service.roots.mcp === true || service.roots.daemon === true;
      // Without one there is nothing for those roots to call, and the
      // implementation could only be a second copy of the gateway's.
      expect(elsewhere && service.starter === null, `${service.id}`).toBe(false);
    }
  });

  it('has no duplicate ids', () => {
    expect(new Set(RESIDENT_SERVICES.map((s) => s.id)).size).toBe(RESIDENT_SERVICES.length);
  });
});

describe('the gateway root starts exactly the table"s gateway set', () => {
  it('registers every id the table claims, and no id the table has never heard of', () => {
    const ids = registeredServiceIds();
    expect([...ids].sort()).toEqual([...servicesStartedBy('gateway')].sort());
  });
});

describe('the daemon calls the starters the table says it must', () => {
  it.each(['daemon'] as RootId[])('%s', (root) => {
    expect(sorted(startersCalledAcross(ROOT_SOURCES[root]))).toEqual(sorted(startersCalledBy(root)));
  });
});
