import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/plugin-entry';
import type { HostDb } from './host-db.js';
import type { NativeInputObservation, NativeReadContext } from './native-read-context.js';
import type { HouseGuideContext } from '../world/house-guide-context.js';
import { houseGuideContextKey } from '../world/house-guide-context.js';
import { peekPerProcess } from '../runtime/once.js';
import { isClosedRuntime, peekCurrentRuntime, runtimeMemoCurrent } from '../runtime/stale-runtime-memo.js';

type AckRuntime = { host: { db: HostDb }; houseRuntime: { markHouseGuideDelivered(context: HouseGuideContext): boolean } };
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
