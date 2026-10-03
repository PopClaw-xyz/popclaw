import { describe, expect, it, beforeAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { cidFromCanonical } from '@popclaw/algorithms';
import { ensureBundle } from '../helpers/ensure-bundle.js';

/**
 * Real-host regression test for hook registration (#306 + #374).
 *
 * **#374 (2026-07-31)** — the routing hook was registered through
 * `api.registerHook`, and therefore **never fired once**. The host writes that
 * one into the internal-hook table (`registry.hooks`), while the sole emitter
 * of `before_prompt_build` (`hookRunner.runBeforePromptBuild`) gates on
 * `hasHooks()` reading `registry.typedHooks` — a table only `registerTypedHook`
 * writes, exposed to plugins as **`api.on`**. Nothing threw, nothing warned,
 * and `openclaw hooks info` still reported ✓ Ready. So this test now pins the
 * namespace: `before_prompt_build` and `before_dispatch` must both go through
 * `api.on`.
 *
 * **#306 (2026-07-30)** — kept below as a trap: pack `5a00a78` shipped
 * `api.registerHook('before_prompt_build', handler)`
 * with no third `opts` argument. Back then every unit test in this repo ran
 * against a hand-written TS shim (`src/types/openclaw.d.ts`, deleted 2026-08-11
 * for the real 2026.7.1 types), which happily typed that call — the shim never
 * modeled `opts` at all. The REAL host
 * (`/opt/homebrew/lib/node_modules/openclaw/dist/registry-*.js`,
 * `registerHook(record, events, handler, opts, ...)`) does:
 *
 *   const hookName = requireRegistrationValue(
 *     entry?.hook.name ?? opts?.name?.trim(),
 *     "hook registration missing name",
 *   );
 *
 * — no `opts.name` → throws, synchronously, inside `register()`. That took
 * down all three real machines (macOS x2, Linux x1) on install; gateway
 * stderr is `/dev/null` on those boxes so nothing showed up in gateway.log,
 * only in the install CLI's own stderr (see #275 for the same blackhole).
 *
 * This test is the only one in the suite that loads the ACTUAL bundled
 * artifact (`dist/bundled/index.js`, the exact file the host `import()`s)
 * and drives `register()` against a stub that enforces the real contract
 * above — so a future opts-less `registerHook` call fails here, in CI,
 * instead of on a real machine after a rollback.
 */

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const BUNDLE_PATH = join(PKG_ROOT, 'dist/bundled/index.js');
type TypedHandler = (event: unknown, ctx: unknown) => unknown;
type Service = { id: string; start(): Promise<void>; stop?(): Promise<void> };

/* --------------------------------------------------------------------------
 * A DECLARED SOURCE FOR THE REAL ARTIFACT.
 *
 * The bundle's own declaration source reads the runtime the gateway STARTED
 * (`src/index.ts`, `liveRuntime`), and never boots one — so a process that has
 * only registered can say nothing about any house and draws no dialog. That
 * is correct behaviour, but "no dialog" is also what a broken build produces,
 * so asserting only the refusal would pass on a bundle that does nothing at
 * all.
 *
 * The memo the root reads its runtime from lives on `globalThis`
 * (`src/runtime/once.ts`), which the bundled copy shares with this test. So
 * the test parks a runtime there whose only real content is ONE house's
 * verified capability view, starts the service that adopts it, and reads a
 * real prompt back out of the real artifact. Everything between the view and
 * the dialog — the declared-key filter, the frame, the row prefix, the
 * budget — is the bundle's own code.
 * ----------------------------------------------------------------------- */
const RUNTIME_MEMO = '__popclaw_singleton__runtime';
const HOUSE = 'https://house.example';
/** bs58 for 32 zero bytes: a well-formed world key, which the evidence
 *  selector insists on before it will answer anything. */
const ACTOR = '1'.repeat(32);
const GUIDE_BYTES = new TextEncoder().encode('Use reading.annotate to save an annotation.');
const MANIFEST_BYTES = new TextEncoder().encode(JSON.stringify({
  world_interaction: {
    version: 1,
    actions: { status_endpoint: '/v1/world-actions/status', result_authority_pubkey: ACTOR,
      kinds: ['reading.annotate'], attachments: [] },
    guide: { path: '/v1/guide.md', sha256: cidFromCanonical(GUIDE_BYTES), revision: 'guide_1' },
  },
  // THE HOUSE NAMES ITS PARAMETER. The dialog draws a row for a key the house
  // declared, or it draws nothing.
  intent_kinds: [{ kind: 'reading.annotate', schema_version: 1, transport: 'typed', signer: 'user',
    description: 'Save annotation', params_schema: { type: 'object', properties: { text: { type: 'string' } } },
    result_schema: { type: 'object' }, result_attachments: { allowed: [], required_on_success: [] },
    consistency: 'none' }],
}));
const REVISION = cidFromCanonical(MANIFEST_BYTES);
function verifiedHouseView(): unknown {
  const valid = { validation: 'valid', detail: '', support: 'unsupported', ready: false } as const;
  return {
    verified: { house: { origin: HOUSE, houseKey: ACTOR, incarnation: 'house_1' },
      capabilityRevision: REVISION, manifestBytes: MANIFEST_BYTES, proofBytes: new Uint8Array([1, 2, 3]),
      guideBytes: GUIDE_BYTES, pinProvenance: 'configured_pin' },
    actions: { ...valid, kinds: { 'reading.annotate': valid } }, guide: valid, publicStream: valid,
    privateMessages: { ...valid, kinds: {} }, executionClosure: valid,
  };
}

beforeAll(async () => {
  // Lazy build, shared with every other test file that needs the bundle (the
  // lock in the helper is why they can run in parallel): reuse the artifact if
  // a previous `pnpm run build:bundle` already produced one. CI checkouts
  // always start clean, so this always builds there — that's the point, it's
  // the only way to test the file the host actually loads.
  await ensureBundle(PKG_ROOT, BUNDLE_PATH);
}, 300_000);

describe('register() against the real host hook contract (#306 + #374)', () => {
  it(
    'loads dist/bundled/index.js and wires both hooks through api.on, without throwing',
    async () => {
      const mod = (await import(pathToFileURL(BUNDLE_PATH).href)) as {
        default: { register: (api: unknown) => void };
      };
      const entry = mod.default;
      expect(typeof entry.register).toBe('function');

      const hookCalls: Array<{ events: unknown; opts: { name?: string; description?: string } | undefined }> = [];
      const typedHooks: string[] = [];
      const typedHandlers = new Map<string, TypedHandler>();
      const registeredHookNames = new Set<string>();
      // registerHook stub mirrors the REAL host (verified against
      // /opt/homebrew/lib/node_modules/openclaw/dist/registry-D1_pYg_a.js:2681-2694,
      // openclaw 2026.7.1):
      //   - opts?.name?.trim() missing/empty -> throw (the #306 crash)
      //   - duplicate name -> NOT fatal, host just pushes a diagnostic and
      //     returns (registerHook internal, `existingHook` branch) — recorded
      //     here instead of thrown so a future re-register (install probe /
      //     gateway / side-agent) can't be mistaken for a regression.
      const registerHook = (
        events: unknown,
        _handler: unknown,
        opts?: { name?: string; description?: string },
      ) => {
        const name = opts?.name?.trim();
        if (!name) throw new Error('hook registration missing name');
        if (registeredHookNames.has(name)) {
          hookCalls.push({ events, opts: { ...opts, duplicate: true } as never });
          return;
        }
        registeredHookNames.add(name);
        hookCalls.push({ events, opts });
      };

      const stateDir = mkdtempSync(join(tmpdir(), 'popclaw-register-smoke-'));
      const api = {
        registrationMode: 'full',
        logger: {
          debug() {},
          info() {},
          warn() {},
          error() {},
        },
        pluginConfig: {},
        config: {},
        runtime: {
          state: { resolveStateDir: () => stateDir },
          system: {
            enqueueSystemEvent: () => true,
            runHeartbeatOnce: async () => undefined,
          },
        },
        registerCommand() {},
        registerService() {},
        registerInteractiveHandler() {},
        registerTool() {},
        registerHook,
        on: (hookName: string, handler: unknown) => {
          typedHooks.push(hookName);
          typedHandlers.set(hookName, handler as TypedHandler);
        },
      };

      expect(() => entry.register(api)).not.toThrow();

      // #374: the typed-hook table is the ONLY one the emitters read.
      expect(typedHooks).toContain('before_prompt_build');
      expect(typedHooks).toContain('before_dispatch');
      // The owner-approval seam rides the same table, for the same reason: a
      // `before_tool_call` handler in the internal table would never fire, and
      // a world action would silently never ask anyone.
      expect(typedHooks).toContain('before_tool_call');
      // Its other half: the report-only guard that names a grant no body
      // consumed. Same table, same reason — an `after_tool_call` handler in
      // the internal namespace would never fire, and the one report that must
      // never be silent would be silent again.
      expect(typedHooks).toContain('after_tool_call');
      // Graceful shutdown (7.1): `deactivate` is the deprecated alias, removed
      // 2026-08-16 — this must stay `gateway_stop`.
      expect(typedHooks).toContain('gateway_stop');
      // …and the dead namespace must stay empty, or `openclaw hooks info` goes
      // back to reporting a ✓ Ready hook that can never fire.
      expect(hookCalls).toEqual([]);
      // Trap kept live: any future registerHook call still has to carry a name.
      expect(() => registerHook('x', () => undefined, undefined)).toThrow(
        /hook registration missing name/,
      );
    },
    30_000,
  );

  it(
    'survives a host whose api.on rejects the registration, and says so at info',
    async () => {
      const mod = (await import(pathToFileURL(BUNDLE_PATH).href)) as {
        default: { register: (api: unknown) => void };
      };
      const info: string[] = [];
      const stateDir = mkdtempSync(join(tmpdir(), 'popclaw-register-onthrows-'));
      const api = {
        registrationMode: 'full',
        logger: { debug() {}, info: (m: string) => info.push(m), warn() {}, error() {} },
        pluginConfig: {},
        config: {},
        runtime: {
          state: { resolveStateDir: () => stateDir },
          system: { enqueueSystemEvent: () => true, runHeartbeatOnce: async () => undefined },
        },
        registerCommand() {},
        registerService() {},
        registerInteractiveHandler() {},
        registerTool() {},
        // We target 2026.7.1+ only, so `api.on` always exists — but register()
        // still may never throw (ADR-0035: it runs in EVERY loading process,
        // including `plugins install`). A host that refuses the registration is
        // the last reachable path to that rule.
        on: () => {
          throw new Error('hook registry unavailable');
        },
      };

      expect(() => mod.default.register(api)).not.toThrow();
      // Three-state boot line: a silent skip is what cost us three weeks.
      expect(info.some((m) => m.includes('routing unavailable'))).toBe(true);
      // Host warn/error go to /dev/null on real boxes — visibleLogger re-routes
      // them onto info, and that's the only trace of a failed wiring.
      expect(info.some((m) => m.includes('before_prompt_build registration failed'))).toBe(true);
      expect(info.some((m) => m.includes('before_dispatch hook registration failed'))).toBe(true);
      expect(info.some((m) => m.includes('gateway_stop hook registration failed'))).toBe(true);
    },
    30_000,
  );

  it(
    'fires the registered before_tool_call handler, and refuses a world action it cannot bound',
    async () => {
      const mod = (await import(pathToFileURL(BUNDLE_PATH).href)) as {
        default: { register: (api: unknown) => void };
      };
      const typedHandlers = new Map<string, TypedHandler>();
      const registeredTools: string[] = [];
      const services = new Map<string, Service>();
      const stateDir = mkdtempSync(join(tmpdir(), 'popclaw-register-approval-'));
      const api = {
        registrationMode: 'full',
        logger: { debug() {}, info() {}, warn() {}, error() {} },
        pluginConfig: {},
        config: {},
        runtime: {
          state: { resolveStateDir: () => stateDir },
          system: { enqueueSystemEvent: () => true, runHeartbeatOnce: async () => undefined },
        },
        registerCommand() {},
        registerService: (service: Service) => { services.set(service.id, service); },
        registerInteractiveHandler() {},
        // Both registration forms: a plain tool, and the FACTORY form the
        // world invoke tool uses (a function plus `{ name }`).
        registerTool: (tool: unknown, opts?: { name?: string }) => {
          const name = opts?.name ?? (typeof tool === 'object' && tool !== null
            ? (tool as { name?: string }).name : undefined);
          if (name) registeredTools.push(name);
        },
        registerHook: (_events: unknown, _handler: unknown, opts?: { name?: string }) => {
          if (!opts?.name?.trim()) throw new Error('hook registration missing name');
        },
        on: (hookName: string, handler: unknown) => { typedHandlers.set(hookName, handler as TypedHandler); },
      };
      expect(() => mod.default.register(api)).not.toThrow();

      // Registration alone proves nothing — #374 registered fine too. Drive the
      // handler the way the host drives it.
      const handler = typedHandlers.get('before_tool_call');
      expect(typeof handler).toBe('function');

      // N6, AT BUNDLE LEVEL. The owner-approval SUBJECT is declared by the
      // same call that registers the world tool
      // (`src/tools/world-interaction-tools.ts`), which is the one place both
      // composition roots reach. It used to be declared in `src/index.ts`
      // alone, so the MCP root's registry was empty and its whole backend
      // inert. Seeing this tool come out of the REAL bundled artifact is what
      // proves that registration path ran here.
      expect(registeredTools).toContain('popclaw_world_invoke');
      const params = {
        house: 'http://127.0.0.1:18989',
        kind: 'rangermap.check_in',
        params: { place: 'Real MCP root', latitude: '30.2700', longitude: '120.1500',
          status: 'Isolated diagnostic through the real MCP stdio root' },
        expected_capability_revision: 'b'.repeat(64),
      };
      // AND NO PROMPT COMES BACK — deliberately, and this is the change.
      //
      // The dialog draws a row for a parameter key the HOUSE declared, or it
      // draws nothing: an unknown schema is not an empty constraint (review's
      // PROBE-8c). A process that has only registered has started no runtime
      // and holds no verified view of `127.0.0.1:18989`, so it cannot say what
      // that house declared, and it refuses rather than rendering whatever the
      // call happened to carry. Such a call falls through to the configured
      // policy lane exactly as it did before this seam existed — and that lane
      // refuses the same undeclared key by the same name.
      //
      // The prompt-rendering proof therefore moved to
      // `tests/unit/tools/world-approval-subject-registration.test.ts`, which
      // drives this same real `registerPopclawTools` path with a declaration
      // source and reads the prompt back.
      expect(await handler!(
        { toolName: 'popclaw_world_invoke', params, toolCallId: 'smoke-1' },
        { toolCallId: 'smoke-1', requester: { channel: 'tui', senderId: 'me', senderIsOwner: true } },
      )).toBeUndefined();

      // A turn from a chat the prompt could fall back into is never asked at all.
      expect(await handler!(
        { toolName: 'popclaw_world_invoke', params, toolCallId: 'smoke-2' },
        { toolCallId: 'smoke-2', requester: { channel: 'telegram', senderId: 'me', senderIsOwner: true } },
      )).toBeUndefined();
      // And no other tool is touched.
      expect(await handler!(
        { toolName: 'popclaw_show_feed', params: {}, toolCallId: 'smoke-3' },
        { toolCallId: 'smoke-3', requester: { channel: 'tui', senderId: 'me', senderIsOwner: true } },
      )).toBeUndefined();

      // AND NOW THE POSITIVE HALF: the same real artifact, once it has a
      // runtime to read a declared schema from, draws the actual dialog.
      // Without this a bundle that had simply stopped working would satisfy
      // every assertion above.
      const globals = globalThis as unknown as Record<string, unknown>;
      globals[RUNTIME_MEMO] = Promise.resolve({
        boot: { popclawId: ACTOR },
        worldRuntime: { readCapabilities: (house: string) => (house === HOUSE ? verifiedHouseView() : null) },
        orchestrator: { start: async () => {}, stop: async () => {} },
        shutdown: async () => {},
      });
      try {
        // `liveRuntime` is set by THIS service starting, and by nothing else —
        // which is exactly the cold-start window the release notes record.
        const orchestrator = services.get('onboarding-orchestrator');
        expect(orchestrator, 'the root registers the service that sets liveRuntime').toBeTruthy();
        await orchestrator!.start();
        const declared = {
          house: HOUSE, kind: 'reading.annotate',
          params: { text: 'The annotation the owner reads before approving' },
          expected_capability_revision: REVISION,
        };
        const asked = await handler!(
          { toolName: 'popclaw_world_invoke', params: declared, toolCallId: 'smoke-5' },
          { toolCallId: 'smoke-5', requester: { channel: 'tui', senderId: 'me', senderIsOwner: true } },
        ) as { requireApproval?: { title: string; description: string; allowedDecisions: string[] } } | undefined;
        expect(asked?.requireApproval).toBeTruthy();
        const shown = asked!.requireApproval!;
        expect(shown.title).toBe('PopClaw world action: reading.annotate');
        expect(shown.description).toContain(`house: ${HOUSE}`);
        // The declared key, carrying the parameter-row prefix the bundle's own
        // code puts there — a frame row never has it.
        expect(shown.description).toContain('> text: The annotation the owner reads before approving');
        // `allow-always` is never on the table.
        expect(shown.allowedDecisions).toEqual(['allow-once', 'deny']);
        // A key the house did not declare is still refused, by the real
        // artifact, even now that it can read the schema.
        expect(await handler!(
          { toolName: 'popclaw_world_invoke',
            params: { ...declared, params: { ...declared.params, ' house': 'http://elsewhere.example' } },
            toolCallId: 'smoke-6' },
          { toolCallId: 'smoke-6', requester: { channel: 'tui', senderId: 'me', senderIsOwner: true } },
        )).toBeUndefined();
      } finally {
        await services.get('onboarding-orchestrator')?.stop?.();
        delete globals[RUNTIME_MEMO];
      }
    },
    60_000,
  );
});
