/**
 * Give a hand-written SocialGraph fake the outcome-returning methods.
 *
 * The follow and unfollow commands no longer collapse a relation write to "which
 * house did it land on". They read the outcome, because three different things
 * used to look alike from the outside: refused before signing, signed and queued
 * for re-send, and accepted by a house. A test whose subject is something else —
 * the social log's collection point, a bond projection, the MCP tool surface —
 * still only wants the happy path, and this supplies it without every such fake
 * having to spell an outcome literal.
 *
 * It reports `accepted`, so these fakes keep the behaviour their assertions were
 * written against. A test that cares about queued or refused should not use this;
 * it should build the outcome it means.
 */
import type { RelationOutcome } from '../../src/social-graph/relation-producer.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
type LegacyShaped = {
  // Permissive on purpose: these are hand-written fakes with every return
  // shape a test has ever needed, and tightening this here would only make
  // each of them carry a cast.
  declareFollow?: (...args: any[]) => any;
  revokeFollow?: (...args: any[]) => any;
  following?: (...args: any[]) => any;
  [k: string]: unknown;
};

const accepted = (
  action: 'declare' | 'revoke',
  followee: string,
  houseSlug: string | undefined,
): RelationOutcome => ({
  mode: 'ordered',
  transport: 'accepted',
  domain: 'unknown',
  action,
  followee,
  ...(houseSlug ? { houseSlug } : {}),
  houseKey: '9xQeWy8P3vNhKd2RmTzA6BcFgJ4LnSuVoXpYrEt5Hw1Z',
  eventId: `fake-${action}-${followee}`,
  seq: 1n,
  anotherEndHasSigned: false,
});

export function withOutcomes<T extends LegacyShaped>(sg: T): T {
  return {
    ...sg,
    activeFollowHouses: async (followee: string) => ({
      houses: (sg.following?.() ?? []).some((edge: { popclawId: string }) => edge.popclawId === followee)
        ? ['synthetic-house'] : [],
    }),
    declareFollowWithOutcome: async (followee: string, opts?: { tasteSubscribed?: boolean; house?: string }) =>
      // Forward the arguments the caller actually passed. Adding a trailing
      // `undefined` would change what every `toHaveBeenCalledWith` here sees.
      accepted('declare', followee,
        (opts === undefined ? await sg.declareFollow?.(followee) : await sg.declareFollow?.(followee, opts)) ?? undefined),
    revokeFollowWithOutcome: async (followee: string, opts?: { house?: string }) =>
      accepted('revoke', followee,
        (opts === undefined ? await sg.revokeFollow?.(followee) : await sg.revokeFollow?.(followee, opts)) ?? undefined),
  } as unknown as T;
}
