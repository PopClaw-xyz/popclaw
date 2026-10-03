/**
 * The incoming-DM handler used to exist three times — once per composition root
 * (`index.ts`, `main.ts`, `mcp.ts`) — and both drifts that caused were real:
 *
 *  - mcp.ts dropped `envelopeBytes` → MCP citizens' inboxes hold DMs with no
 *    signed envelope at all, and v0.2 client-side verification can never run
 *    over that stretch of history (P0-A).
 *  - main.ts never wrote the `dm_received` social-log entry → DMs received by
 *    the dev daemon are missing from the dreaming corpus.
 *
 * There is now ONE copy — `runtime/inbox-consumer.ts` — and its behaviour is
 * covered by dm-encryption-wiring.test.ts, which drives it end to end through a
 * real signer and a real InboxStore, and (through each tool-registering root's
 * real assembly) by assemble-runtime-{mcp,gateway}.test.ts.
 *
 * What THIS file still has to guard is that the three roots keep consuming that
 * one copy instead of quietly growing a fourth. A root that re-typed the loop
 * inline would pass every behavioural test in the suite and reintroduce exactly
 * the drift above, so the check is necessarily on the roots' source text: each
 * root's `makeInboxOnMessage({...})` block must be a thin shell that HANDS
 * OFF to the shared builder, and must not carry any step of the loop itself.
 */
import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../../../src');
const ROOTS = ['index.ts', 'main.ts', 'mcp.ts'] as const;
/**
 * Where each root's inbox wiring lives. Neither tool-registering root types it
 * any more (MCP since C2, the gateway since C3): both call the shared runtime
 * assembly, whose `dm.ts` builder holds the one `makeInboxOnMessage` call and
 * whose `feeds.ts` hands every house's DMs to it.
 */
const WIRING: Record<(typeof ROOTS)[number], { consumer: string; resources: string; importPath: string }> = {
  'index.ts': { consumer: 'runtime/assembly/dm.ts', resources: 'runtime/assembly/feeds.ts', importPath: '../inbox-consumer.js' },
  'main.ts': { consumer: 'main.ts', resources: 'main.ts', importPath: './runtime/inbox-consumer.js' },
  'mcp.ts': { consumer: 'runtime/assembly/dm.ts', resources: 'runtime/assembly/feeds.ts', importPath: '../inbox-consumer.js' },
};
/** Every file of the shared assembly, whatever builders it grows. */
const ASSEMBLY_FILES = readdirSync(join(SRC, 'runtime/assembly'), { recursive: true, encoding: 'utf-8' })
  .filter((f) => f.endsWith('.ts')).map((f) => `runtime/assembly/${f}`).sort();

function read(rel: string): string {
  return readFileSync(join(SRC, rel), 'utf-8');
}

/**
 * The `openHouseInboxStreams({...})` call in one composition root.
 *
 * The closing `});` is found at the SAME indent as the opening line — index.ts
 * wires this eight spaces deep inside bootRuntime while mcp.ts/main.ts are at
 * two, and a hard-coded indent silently returns -1 there, which slices the rest
 * of the file into the assertions instead of the block.
 */
function consumerCalls(file: string): { calls: ts.CallExpression[]; source: ts.SourceFile } {
  const source = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true);
  const calls: ts.CallExpression[] = [];
  function walk(node: ts.Node): void {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'makeInboxOnMessage') calls.push(node);
    ts.forEachChild(node, walk);
  }
  walk(source);
  return { calls, source };
}

function inboxWiring(root: (typeof ROOTS)[number]): string {
  const file = WIRING[root].consumer;
  const { calls, source } = consumerCalls(file);
  expect(calls, `${root} must use one shared inbox consumer (scanned ${file})`).toHaveLength(1);
  return calls[0]!.getText(source);
}

describe('the three composition roots share ONE incoming-DM handler', () => {
  // Guards the delimiter itself: a block that swallowed the rest of the file
  // would still satisfy every assertion below, for the wrong reason. The
  // fattest shell (index.ts, which hangs the relative-value gate + L1 push off
  // onPlainDm) is well under this against a ~100k file, so the bound has plenty
  // of headroom and still catches a runaway slice by an order of magnitude.
  it.each(ROOTS)('%s: the extracted block is the wiring, not half the file', (root) => {
    expect(inboxWiring(root).length).toBeLessThan(8_000);
  });

  it.each(ROOTS)('%s hands the message off to the shared consumer', (root) => {
    const { consumer, resources, importPath } = WIRING[root];
    const wiring = inboxWiring(root);
    expect(wiring).toContain('makeInboxOnMessage({');
    // For the two tool-registering roots, that feeds.ts hands every house's DMs
    // (envelope bytes included) to this consumer is pinned on behaviour since
    // C4: assemble-runtime-{mcp,gateway}.test.ts "a DM through the root's inbox
    // hook is stored with its signed envelope and logged once as dm_received".
    if (root === 'main.ts') expect(read(resources)).toContain('=> onInbox(dm, house.slug, bytes, nickname, authenticatedPlain)');
    expect(read(root)).not.toContain('openHouseInboxStreams(');
    expect(read(resources)).not.toContain('openHouseInboxStreams(');
    // …imported from the one module, not re-declared locally.
    expect(read(consumer)).toContain(`import { makeInboxOnMessage } from '${importPath}';`);
  });

  // The MCP side moved; these pin that the scans above look where the code
  // now is, and that the MCP root actually reaches it.
  it.each(['mcp.ts', 'index.ts'])('%s itself carries no inbox wiring any more — a scan over it finds nothing', (root) => {
    expect(consumerCalls(root).calls).toHaveLength(0);
    expect(read(root)).not.toContain('configureResources(');
  });

  it('the shared assembly holds exactly ONE makeInboxOnMessage call, and both tool-registering roots build through it', () => {
    expect(ASSEMBLY_FILES).toEqual(expect.arrayContaining(['runtime/assembly/dm.ts', 'runtime/assembly/feeds.ts', 'runtime/assembly/index.ts']));
    expect(ASSEMBLY_FILES.length).toBeGreaterThan(5);
    for (const file of ASSEMBLY_FILES) expect(read(file), file).not.toContain('openHouseInboxStreams(');
    const total = ASSEMBLY_FILES.reduce((n, f) => n + consumerCalls(f).calls.length, 0);
    expect(total).toBe(1);
    // Both roots reaching that one call is shown on behaviour (the C4 DM probe
    // above, through each root's real configureResources); that they build
    // through the assembly at all is runtime-contract.test.ts's build-path pin.
    expect(consumerCalls('host/openclaw-runtime-ports.ts').calls).toHaveLength(0);
    expect(consumerCalls('host/mcp-runtime-ports.ts').calls).toHaveLength(0);
  });

  it.each(ROOTS)('%s does not re-implement any step of the loop', (root) => {
    const wiring = inboxWiring(root);
    // Each of these is a step a root once owned a private copy of. Seeing one
    // back inside a root's wiring block means the shared consumer was forked.
    for (const step of [
      'readDmBody(',
      'receiveDmMedia(',
      'inboxStore.record(',
      'store.record(',
      'wasNew',
      "kind: 'dm_received'",
    ]) {
      expect(wiring, `${root} must delegate "${step}" to runtime/inbox-consumer.ts`).not.toContain(
        step,
      );
    }
  });
});

/*
 * The shared consumer's own invariants are pinned on behaviour, not on its
 * source text (C4 removed the text pins that stood here):
 *  - envelope bytes persisted (P0-A) and one `dm_received` per DM, behind the
 *    exactly-once gate: assemble-runtime-{mcp,gateway}.test.ts "a DM through
 *    the root's inbox hook is stored with its signed envelope and logged once
 *    as dm_received, a replay neither", and dm-encryption-wiring.test.ts
 *    "回补重放同一封 → 库里一条，日志也只有一条";
 *  - no red-packet handling on the DM path: dm-encryption-wiring.test.ts
 *    "票据 JSON 加密发出、解密收到，按普通私信投递且可去重（不解析、不执行支付指令）".
 */
