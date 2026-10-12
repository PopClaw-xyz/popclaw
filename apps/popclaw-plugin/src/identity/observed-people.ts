/** Names explicitly shown by trusted reads, retained only for follow-up references. */
import { getOrCreatePerProcess, resetSingletonForTest } from '../runtime/once.js';

export interface ObservedPerson {
  readonly popclawId: string;
  readonly nickname: string;
}

const MAX_PEOPLE = 1000;
const people = (): Map<string, readonly string[]> =>
  getOrCreatePerProcess('observed-summary-people', () => new Map<string, readonly string[]>());

/** No profiles, certifications, social edges or event-stream entries are written here. */
export function rememberObservedPeople(rows: readonly ObservedPerson[]): void {
  const incoming = new Map<string, Set<string>>();
  for (const row of rows) {
    const names = incoming.get(row.popclawId) ?? new Set<string>();
    names.add(row.nickname);
    incoming.set(row.popclawId, names);
  }
  const map = people();
  for (const [id, names] of incoming) {
    map.delete(id);
    if (map.size >= MAX_PEOPLE) map.delete(map.keys().next().value!);
    map.set(id, [...names].slice(0, 8));
  }
}

export function observedPeople(): ObservedPerson[] {
  return [...people()].flatMap(([popclawId, names]) => names.map(nickname => ({ popclawId, nickname })));
}

export const _observedPeopleForTest = {
  clear: (): void => resetSingletonForTest('observed-summary-people'),
};
