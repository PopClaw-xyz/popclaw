import { WorldExecutionConfig } from '../config/schema.js';
/** Configuration identifies a House for routing only; this creates no permit. */
export function configuredRoutingHouseOrigins(value: unknown): string[] {
  try {
    const config = value as {plugins?: {enabled?: boolean; entries?: {popclaw?: {enabled?: boolean; config?: {worldExecution?: unknown}}}}};
    const entry = config?.plugins?.entries?.popclaw;
    if (config?.plugins?.enabled === false || entry?.enabled === false) return [];
    const parsed = WorldExecutionConfig.safeParse(entry?.config?.worldExecution);
    return parsed.success ? [...new Set(parsed.data.policies.map(policy => policy.house))] : [];
  } catch { return []; }
}
