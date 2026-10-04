// eslint-disable-next-line no-restricted-imports -- Native host boundary rejects Proxy-backed context before reading authorization fields.
import { types } from 'node:util';
import { cidFromCanonical } from '@popclaw/algorithms';
import { WorldExecutionConfig, type WorldExecutionPolicy } from '../config/schema.js';
import { captureWorldCommandInput } from '../commands/popclaw-world.js';
import type { WorldInvokeInput } from '../world/action-client.js';
import { canonicalActionJson } from '../world/action-receipt-journal.js';
import { worldPublicKey } from '../world/action-wire.js';
import { renderCopy } from '../lexicon/index.js';
import { ownerLang } from '../lexicon/owner-language.js';

export interface NativeWorldExecutionPermit {
  readonly invocationKey: string;
  readonly principal: Readonly<{ kind: 'openclaw_agent'; agentId: string; actorId: string }>;
  readonly policySource: Readonly<{ kind: 'openclaw_runtime_config'; path: string }>;
  readonly policyRevision: string;
  readonly policyScope: Readonly<WorldExecutionPolicy>;
  readonly input: Readonly<WorldInvokeInput>;
  readonly reservedAt: number;
  readonly expiresAt: number;
  assertCurrent(): void;
}
export interface OpenClawWorldExecutionOptions {
  actorId: string;
  /** Public SDK active runtime snapshot, never the factory's fallback config. */
  readActiveConfig(): unknown;
  now?(): number;
  /** One line per refusal, same lane `HouseRuntime.executionRefusal` writes to. */
  log?(message: string): void;
}
/**
 * Whether any native policy could authorize one action kind, WITHOUT claiming
 * that it authorizes this call: the agent making the call is not known here
 * (see `NATIVE_AUTHORIZATION_REASONS`), so `ready: true` means only that the
 * refusals named below do not apply. `withInvocation` remains the one place
 * permission is decided.
 */
export interface NativeActionReadiness {
  ready: boolean;
  reason: string | null;
}
/**
 * Three situations that used to share `NATIVE_POLICY_REQUIRED`, which left a
 * person who had just authorized an action in the host's own dialog with one
 * code that could mean any of them — and no line in `logs/` to start from.
 *
 *   - `NATIVE_POLICY_REQUIRED`  — nothing in the active configuration
 *     authorizes this actor for this house and kind. Keeps the original
 *     spelling on purpose: it is the case the code name already described,
 *     the one the native host actually hits (the measured firstuse2 instance
 *     has `plugins.entries.popclaw.config = {}`, so `policies` is `[]`), and
 *     the one every existing caller and stored string already means by it.
 *   - `NATIVE_POLICY_AMBIGUOUS` — two or more policies match the same agent,
 *     actor, house and kind. Something DID authorize this; the configuration
 *     just cannot say which scope applies, and the opposite advice is owed.
 *   - `NATIVE_PLUGIN_DISABLED`  — the plugin (or the whole plugin table) is
 *     switched off, so no policy is read at all.
 *
 * Nothing here widens what counts as a match: each name is the same refusal,
 * told apart.
 */
export const NATIVE_AUTHORIZATION_REASONS = Object.freeze({
  missing: 'NATIVE_POLICY_REQUIRED', ambiguous: 'NATIVE_POLICY_AMBIGUOUS', disabled: 'NATIVE_PLUGIN_DISABLED',
} as const);
const source = Object.freeze({ kind: 'openclaw_runtime_config' as const, path: 'plugins.entries.popclaw.config.worldExecution' });
function fail(code: string): never { throw new Error(code); }
function field(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor && !('value' in descriptor)) return fail('NATIVE_CONTEXT_INVALID');
  return descriptor?.value;
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function digest(value: unknown): string { return cidFromCanonical(new TextEncoder().encode(canonicalActionJson(value))); }
/** Codes this module defines and may repeat verbatim. Everything else — above
 *  all a schema parser's rendering of the owner's own configuration — collapses
 *  to one name, because this string is read by the agent as well as by `logs/`. */
const NAMED_CONFIG_REFUSALS: ReadonlySet<string> = new Set(['NATIVE_CONFIG_UNAVAILABLE', 'NATIVE_CONTEXT_INVALID']);
export const NATIVE_POLICY_MALFORMED = 'NATIVE_POLICY_MALFORMED';
function namedConfigRefusal(error: unknown): string {
  return error instanceof Error && NAMED_CONFIG_REFUSALS.has(error.message) ? error.message : NATIVE_POLICY_MALFORMED;
}
function config(value: unknown) {
  if (!value) return fail('NATIVE_CONFIG_UNAVAILABLE');
  const plugins = field(value, 'plugins'), entry = field(field(plugins, 'entries'), 'popclaw');
  const enabled = field(plugins, 'enabled') !== false && field(entry, 'enabled') !== false;
  const raw = field(field(entry, 'config'), 'worldExecution');
  // Copy JSON first so validation never retains references to mutable host configuration.
  const policies = raw === undefined ? [] : WorldExecutionConfig.parse(JSON.parse(canonicalActionJson(raw))).policies;
  return { enabled, policies };
}
/** The one definition of "this policy covers this action", shared by the
 *  readiness probe and the permit gate so neither can drift wider. */
function coveringPolicies(policies: readonly WorldExecutionPolicy[], actorId: string, house: string, kind: string): readonly WorldExecutionPolicy[] {
  return policies.filter(policy => policy.actorId === actorId && policy.house === house && policy.kinds.includes(kind));
}
/**
 * The readiness verdict that can be reached WITHOUT an agentId.
 *
 * A permit matches on `{agentId, actorId, house, kind}`, and `agentId` only
 * exists once `bindFactory` has a host context — which readiness does not
 * have. So this answers the one question that is decidable without it: could
 * ANY agent execute this? Zero scoped policies means no agent can, and that
 * is the case the native host actually hits. Otherwise at least one agent
 * must own exactly one scoped policy; if every agent that appears owns two or
 * more, the configuration cannot authorize anyone and says so. A `null`
 * verdict is "no refusal is provable here", never "this caller is allowed".
 *
 * Two residuals, both deliberate and both unchanged from before this probe
 * existed. A policy that has EXPIRED, and one that is NOT YET VALID
 * (`authorizedAt` in the future), each still report ready here and are refused
 * at invocation with `NATIVE_POLICY_EXPIRED`. Answering either would mean
 * reading the clock, and `clock()` in this module is a side-effectful
 * monotonic high-water gate a read-only probe must not touch — there is a
 * mutation pinned to exactly that. A third residual is recorded in the report:
 * a policy that exists for a DIFFERENT agent also reports ready, because the
 * probe has no agentId.
 */
function readinessCode(policies: readonly WorldExecutionPolicy[], actorId: string, house: string, kind: string): string | null {
  const matches = coveringPolicies(policies, actorId, house, kind);
  if (!matches.length) return NATIVE_AUTHORIZATION_REASONS.missing;
  const perAgent = new Map<string, number>();
  for (const match of matches) perAgent.set(match.agentId, (perAgent.get(match.agentId) ?? 0) + 1);
  return [...perAgent.values()].includes(1) ? null : NATIVE_AUTHORIZATION_REASONS.ambiguous;
}

/** Only the native root supplies host factory contexts; never expose this as a JSON operation.
 * Authorization changes require stopping the Gateway, joining all in-flight work,
 * editing config, then restarting. The public SDK has no applied-generation event:
 * value checks cannot detect an unobserved online revoke/restore cycle. Hot editing
 * worldExecution is unsupported; observed changes still permanently revoke a permit.
 */
export function createOpenClawWorldExecution(options: OpenClawWorldExecutionOptions) {
  try { worldPublicKey(options.actorId); } catch { return fail('NATIVE_ACTOR_INVALID'); }
  const boot = crypto.randomUUID(); let stopped = false, highWater = 0;
  /** The last code each lane wrote down, PER SUBJECT and per lane.
   *
   *  One shared slot was wrong twice. The readiness probe runs on every
   *  capability read and the permit gate runs per invocation, so the probe's
   *  line could take the slot from the refusal a person actually hit and the
   *  log then named the wrong one. And with two refusing kinds the two
   *  alternated, so the de-duplication stopped working entirely — a measured
   *  5 rounds across 2 kinds produced 10 lines, not 2. (The claim that this
   *  wrote "one line, not per-retry spam" was overstated when it was made.)
   *  Bounded, because a long-lived gateway sees an unbounded number of
   *  house/kind pairs and a diagnostic must never become a leak. */
  const spoken = { probe: new Map<string, string>(), gate: new Map<string, string>() };
  const SPOKEN_CAP = 64;
  const issued = new WeakSet<NativeWorldExecutionPermit>();
  function clock(): number {
    if (stopped) return fail('NATIVE_AUTHORITY_INACTIVE');
    const now = options.now?.() ?? Math.floor(Date.now() / 1000);
    if (!Number.isSafeInteger(now) || now < highWater) return fail('NATIVE_CLOCK_ROLLBACK');
    highWater = now; return now;
  }
  /**
   * The named refusal, written down once per lane per subject, and said in the
   * owner's words.
   *
   * Written down: a refused world action used to leave nothing at all behind
   * — a person who had authorized one in the host's own dialog got a bare code
   * back, and `logs/` held no `NATIVE_*` line to investigate from. Once
   * though, not once per retry: a rejected invocation is replayed out of
   * `invocations` for the same callId, and the readiness probe is asked again
   * on every capability read. The same code for the same house and kind on the
   * same lane is suppressed until that lane's answer for that subject changes,
   * or an invocation for it succeeds.
   */
  function refusal(code: string, subject: string, lane: 'probe' | 'gate'): string {
    const memo = spoken[lane];
    if (memo.get(subject) !== code) {
      if (memo.size >= SPOKEN_CAP) memo.delete(memo.keys().next().value!);
      memo.set(subject, code);
      options.log?.(`native world execution unavailable (${subject}): ${code}`);
    }
    return code === NATIVE_AUTHORIZATION_REASONS.missing
      ? `${code}: ${renderCopy(ownerLang(), 'world.action.notAuthorized')}` : code;
  }
  function refuse(code: string, subject: string): never { return fail(refusal(code, subject, 'gate')); }
  const subjectOf = (house: string, kind: string) => `${house} ${kind}`;
  return Object.freeze({
    stop() { stopped = true; },
    /**
     * Read-only: never issues, reserves, or moves the permit clock. Composed
     * into the capability view so a kind that nothing authorizes reports
     * not-ready BEFORE a person picks it, rather than after they confirmed it.
     */
    actionReadiness(input: { house: string; kind: string; recoveryDecisionId?: string }): NativeActionReadiness {
      const subject = subjectOf(input.house, input.kind);
      try {
        const applied = config(options.readActiveConfig());
        const code = applied.enabled
          ? input.recoveryDecisionId !== undefined && !coveringPolicies(applied.policies,options.actorId,input.house,input.kind).some(p => p.recoveryDecisionId === input.recoveryDecisionId)
            ? 'NATIVE_POLICY_RECONFIRMATION_REQUIRED' : readinessCode(applied.policies, options.actorId, input.house, input.kind)
          : NATIVE_AUTHORIZATION_REASONS.disabled;
        // A probe that finds nothing to refuse clears this subject's memo, so
        // the next genuine refusal for it gets its own line.
        if (code === null) { spoken.probe.delete(subject); return { ready: true, reason: null }; }
        return { ready: false, reason: refusal(code, subject, 'probe') };
      } catch (error) {
        // Configuration this root cannot read is not an authorization, and
        // this hot read path never throws.
        //
        // The message is NOT passed through. `WorldExecutionConfig.parse`
        // renders a multi-line dump of what it found, and this string reaches
        // both `logs/` and the agent-visible `detail` — so a malformed
        // `worldExecution` block was handing the model the contents of the
        // owner's configuration. Only names this module itself defines survive;
        // anything else becomes one code that says parsing failed and nothing
        // about what was in there.
        return { ready: false, reason: refusal(namedConfigRefusal(error), subject, 'probe') };
      }
    },
    assertPermit(permit: NativeWorldExecutionPermit) {
      if (!issued.has(permit)) return fail('NATIVE_AUTHORITY_REQUIRED');
      permit.assertCurrent();
    },
    /** Advance from the durable ledger before issuing a native reservation after restart. */
    observeReservedAt(at: number) {
      if (!Number.isSafeInteger(at) || at < 0) return fail('NATIVE_CLOCK_INVALID');
      highWater = Math.max(highWater, at); clock();
    },
    bindFactory(context: unknown) {
      clock();
      const agentId = field(context, 'agentId'), getter = field(context, 'getRuntimeConfig');
      if (typeof agentId !== 'string' || typeof getter !== 'function') return fail('NATIVE_CONTEXT_REQUIRED');
      const readScoped = getter as () => unknown;
      const factory = crypto.randomUUID();
      const invocations = new Map<string, { input: string; result: Promise<unknown> }>();
      function current(subject: string) {
        if (field(context, 'agentId') !== agentId || field(context, 'getRuntimeConfig') !== getter) return fail('NATIVE_CONTEXT_CHANGED');
        const applied = config(options.readActiveConfig()), scoped = config(readScoped());
        if (canonicalActionJson(applied) !== canonicalActionJson(scoped)) return fail('NATIVE_CONFIG_STALE');
        if (!applied.enabled) return refuse(NATIVE_AUTHORIZATION_REASONS.disabled, subject);
        return applied;
      }
      return Object.freeze({
        async withInvocation<T>(callId: string, value: unknown, signal: AbortSignal | undefined,
          callback: (permit: NativeWorldExecutionPermit) => Promise<T>): Promise<T> {
          clock();
          if (typeof callId !== 'string' || !callId.length || callId.length > 256
            || [...callId].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) return fail('NATIVE_INVOCATION_INVALID');
          const input = freeze(captureWorldCommandInput('invoke', value)), text = canonicalActionJson(input);
          const old = invocations.get(callId);
          if (old) {
            if (old.input !== text) return fail('NATIVE_INVOCATION_CONFLICT');
            return old.result as Promise<T>;
          }
          // Defer execution until the map entry exists, including synchronous reentrant callers.
          const result = Promise.resolve().then(async () => {
            let active = true;
            const subject = subjectOf(input.house, input.kind);
            try {
              const now = clock(), initial = current(subject);
              // Same predicate the readiness probe uses, narrowed by the one
              // field readiness never has: which agent is calling.
              const matches = coveringPolicies(initial.policies, options.actorId, input.house, input.kind)
                .filter(policy => policy.agentId === agentId);
              if (matches.length !== 1) return refuse(matches.length
                ? NATIVE_AUTHORIZATION_REASONS.ambiguous : NATIVE_AUTHORIZATION_REASONS.missing, subject);
              const policyScope = freeze(matches[0]!);
              const authorizedAt = Date.parse(policyScope.authorizedAt) / 1000, policyExpiry = Date.parse(policyScope.expiresAt) / 1000;
              if (now < authorizedAt || now >= policyExpiry) return fail('NATIVE_POLICY_EXPIRED');
              const revision = digest(initial), expiresAt = Math.min(now + 300, policyExpiry);
              const assertCurrent = () => {
                try {
                  if (!active || signal?.aborted || stopped) return fail('NATIVE_AUTHORITY_INACTIVE');
                  const at = clock();
                  if (at >= expiresAt || at < authorizedAt) return fail('NATIVE_POLICY_EXPIRED');
                  if (digest(current(subject)) !== revision) return fail('NATIVE_POLICY_CHANGED');
                } catch (error) { active = false; throw error; }
              };
              const permit = Object.freeze({ invocationKey: digest([boot, factory, callId]),
                principal: Object.freeze({ kind: 'openclaw_agent' as const, agentId, actorId: options.actorId }),
                policySource: source, policyRevision: revision, policyScope, input, reservedAt: now, expiresAt, assertCurrent });
              issued.add(permit);
              assertCurrent();
              // A permit was issued for THIS subject, so its last refusal is
              // history: the next one deserves its own line even if it reads
              // the same. Other subjects keep their own memo.
              spoken.gate.delete(subject);
              // An already returned receipt must survive revocation during HTTP I/O.
              return await callback(permit);
            } finally { active = false; }
          });
          invocations.set(callId, { input: text, result }); return result;
        },
      });
    },
  });
}
