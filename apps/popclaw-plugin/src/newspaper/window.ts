/** One initial collection freezes its material cutoff; continuations use its ledger. */
import { ownerTz, startOfLocalDay } from '../time/time-context.js';

export interface NewspaperWindowSelection { hours?: number; today?: boolean }
export interface ResolvedNewspaperWindow {
  /** Inclusive epoch-second lower bound. There is deliberately no upper bound. */
  readonly since: number;
  readonly windowLabel: string;
  readonly hours?: number;
  readonly today: boolean;
}
export interface NewspaperCollectionOptions extends NewspaperWindowSelection { window?: ResolvedNewspaperWindow }

export function validateNewspaperWindow(selection: NewspaperWindowSelection): void {
  if (selection.today !== undefined && typeof selection.today !== 'boolean') throw new Error('NEWSPAPER_WINDOW_INVALID');
  if (selection.hours !== undefined && (!Number.isInteger(selection.hours) || selection.hours < 1 || selection.hours > 168))
    throw new Error('NEWSPAPER_WINDOW_INVALID');
  if (selection.today === true && selection.hours !== undefined) throw new Error('NEWSPAPER_WINDOW_CONFLICT');
}
export function resolveNewspaperWindow(selection: NewspaperWindowSelection, nowSeconds: number, timeZone = ownerTz()): ResolvedNewspaperWindow {
  validateNewspaperWindow(selection);
  if (!Number.isFinite(nowSeconds)) throw new Error('NEWSPAPER_WINDOW_INVALID');
  if (selection.today === true) return Object.freeze({ since: Math.max(0, startOfLocalDay(nowSeconds, timeZone)), windowLabel: 'today', today: true });
  const hours = selection.hours ?? 72;
  return Object.freeze({ since: Math.max(0, nowSeconds - hours * 3600), windowLabel: `in the last ${hours} hours`, hours, today: false });
}
