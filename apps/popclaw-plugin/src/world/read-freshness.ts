import type { HouseReadFailure } from '../runtime/house-lifecycle/read-failure.js';
import { renderCopy, type Lang } from '../lexicon/index.js';
export interface ReadFreshness {
  readonly status: 'fresh' | 'stale' | 'refresh_failed';
  readonly origin: string;
  readonly sourceBinding?: string;
  readonly fetchedAtMs: number | null;
  readonly checkedAtMs: number | null;
  readonly attemptedAtMs: number | null;
  readonly failure?: HouseReadFailure;
}
export function freshnessText(value: ReadFreshness | undefined, lang: Lang): string {
  if (!value) return '';
  const time = (ms: number | null) => ms === null ? renderCopy(lang,'world.read.unknown') : new Date(ms).toISOString();
  return renderCopy(lang,'world.read.freshness',{status:renderCopy(lang,`world.read.${value.status}`),origin:value.origin,
    fetched:time(value.fetchedAtMs),checked:time(value.checkedAtMs),attempted:time(value.attemptedAtMs)});
}
