import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/plugin-entry';
import type { HostDb } from './host-db.js';
import type { NativeInputObservation, NativeReadContext } from './native-read-context.js';
import type { HouseGuideContext } from '../world/house-guide-context.js';
import { renderCopy } from '../lexicon/index.js';
import { ownerLang } from '../lexicon/owner-language.js';
import { cachedHouseGuide, observedHouseGuideKeys, houseGuideContextKey } from '../world/house-guide-context.js';
import { peekPerProcess } from '../runtime/once.js';
import { isClosedRuntime, peekCurrentRuntime, runtimeMemoCurrent } from '../runtime/stale-runtime-memo.js';

type AckRuntime = { host: { db: HostDb }; houseRuntime: { publicReadGate(origin: string): {isActive(): boolean}; markHouseGuideDelivered(context: HouseGuideContext): boolean } };
type GuideRow = { origin: string; binding_digest: string; op_seq: number; guide_url: string; guide_digest: string; guide_body: string };

/** Input parsing happens before any await. The asynchronous receipt carries keys only. */
export async function acknowledgeNativeGuideInput(observation: NativeInputObservation): Promise<void> {
  if (!observation.keys.size || !observation.scope.isCurrent()) return;
  const memo = peekPerProcess<Promise<AckRuntime>>('runtime');
  const runtime = await peekCurrentRuntime<AckRuntime>('runtime');
  const current = () => observation.scope.isCurrent() && runtimeMemoCurrent('runtime', memo) && !isClosedRuntime(runtime);
  if (!runtime || !current()) return;
  // Do not read/fetch a guide or boot a runtime here. Match the stored current
  // body after the await; the existing receipt writer rechecks participation
  // and the pinned House binding inside its synchronous transaction.
  const rows = runtime.host.db.queryAll<GuideRow>(`SELECT origin,binding_digest,op_seq,guide_url,guide_digest,guide_body
    FROM house_guide_context WHERE guide_body IS NOT NULL AND guide_digest IS NOT NULL
    AND (delivered_digest IS NULL OR delivered_digest!=guide_digest)`);
  for (const row of rows) {
    if (!current()) return;
    const guide: HouseGuideContext = { status: 'available', origin: row.origin, bindingDigest: row.binding_digest,
      opSeq: row.op_seq, guideUrl: row.guide_url, guideDigest: row.guide_digest, guide: row.guide_body, delivered: false };
    if (observation.keys.has(houseGuideContextKey(guide))) runtime.houseRuntime.markHouseGuideDelivered(guide);
  }
}

export function registerNativeReadContextHooks(api: Pick<OpenClawPluginApi, 'on' | 'logger'>, context: NativeReadContext): void {
  try {
    api.on('before_prompt_build', async event => {
      try {
        // Parse only this invocation's input, before yielding. An unknown input
        // supplies no continuity evidence and therefore suppresses nothing.
        const input = event as unknown as {messages?:unknown;historyMessages?:unknown};
        const present = observedHouseGuideKeys(input.messages ?? input.historyMessages ?? []);
        const memo = peekPerProcess<Promise<AckRuntime>>('runtime');
        if (!memo) return;
        // A settled runtime wins the microtask race; an ongoing boot loses.
        // This hook never starts or waits for boot, network or guide refresh.
        const runtime = await Promise.race([memo,Promise.resolve(null)]).catch(() => null);
        if (!runtime || !runtimeMemoCurrent('runtime',memo) || isClosedRuntime(runtime)) return;
        const guides: HouseGuideContext[] = [];
        for (const {origin} of runtime.host.db.queryAll<{origin:string}>('SELECT origin FROM house_guide_context')) {
          const guide = cachedHouseGuide(runtime.host.db,origin,() => runtime.houseRuntime.publicReadGate(origin).isActive());
          if (guide.status === 'available' && !present.has(houseGuideContextKey(guide))) guides.push(guide);
        }
        if (!guides.length) return;
        return {prependContext:renderCopy(ownerLang(),'world.guide.currentContext')+'\n'+JSON.stringify({house_guide_contexts:guides})};
      } catch (error) {
        api.logger.error(`popclaw: cached guide prompt failed — ${String(error)}`);
        return;
      }
    });
    api.on('llm_input', (event, ctx) => {
      const observed = context.observe(event, ctx);
      if (observed) return acknowledgeNativeGuideInput(observed).catch(error => {
        api.logger.error(`popclaw: guide input receipt failed — ${String(error)}`);
      });
    });
    api.on('before_tool_call', (event, ctx) => { context.beforeToolCall(event, ctx); });
    api.on('after_tool_call', (event, ctx) => { context.afterToolCall(event, ctx); });
    api.on('agent_end', (event, ctx) => { context.endRun(event, ctx); });
    api.on('before_reset', (event, ctx) => { context.reset(event, ctx); });
    api.on('before_compaction', (event, ctx) => { context.reset(event, ctx); });
    api.on('after_compaction', (event, ctx) => { context.reset(event, ctx); });
    api.on('session_end', (event, ctx) => { context.reset(event, ctx); });
    api.on('gateway_stop', () => { context.closeAll(); });
  } catch (error) {
    api.logger.error(`popclaw: native read context hook registration failed — ${String(error)}`);
  }
}
