import { afterEach, expect, it, vi } from 'vitest';
import { Value } from 'typebox/value';
import { runFollowCommand } from '../../../src/commands/follow.js';
import { runPopclawUnfollowCommand } from '../../../src/commands/popclaw-unfollow.js';
import { PopclawFollowSchema, PopclawUnfollowSchema } from '../../../src/tools/tool-schemas.js';
import { withOutcomes } from '../../helpers/with-outcomes.js';
import { setOwnerLang } from '../../../src/lexicon/owner-language.js';

afterEach(() => setOwnerLang(undefined));
const result = { mode: 'ordered', transport: 'accepted', houseSlug: 'world' };
it('an explicit house reaches the declare producer without replacing the person', async () => {
  const declareFollowWithOutcome = vi.fn(async () => result);
  await runFollowCommand('person', { socialGraph: { declareFollowWithOutcome } as never,
    ownPopclawId: 'owner', house: 'https://house.popclaw.world' });
  expect(declareFollowWithOutcome).toHaveBeenCalledWith('person', { house: 'https://house.popclaw.world' });
});
it('an explicit revoke retains the remaining aggregate follow and names its partial result', async () => {
  setOwnerLang('en', 'config');
  let houses = ['me', 'world'];
  const revokeFollowWithOutcome = vi.fn(async () => { houses = houses.filter(house => house !== 'world'); return result; });
  const setFollowed = vi.fn();
  const reply = await runPopclawUnfollowCommand('person', {
    socialGraph: { revokeFollowWithOutcome, activeFollowHouses: async () => ({ houses }), following: () => [{ popclawId: 'person' }] } as never,
    ownPopclawId: 'owner', house: 'world', bondsStore: { setFollowed }, houseDisplayName: () => 'World',
  });
  expect(revokeFollowWithOutcome).toHaveBeenCalledWith('person', { house: 'world' });
  expect(setFollowed).toHaveBeenCalledWith('person', true);
  expect(reply.remainingFollowing).toBe(true);
  expect(reply.text).toContain('another house');
});
it('the last revoked house clears the aggregate bond', async () => {
  let followed = true;
  const setFollowed = vi.fn();
  const reply = await runPopclawUnfollowCommand('person', {
    socialGraph: { revokeFollowWithOutcome: async () => { followed = false; return result; },
      activeFollowHouses: async () => ({ houses: followed ? ['world'] : [] }),
      following: () => followed ? [{ popclawId: 'person' }] : [] } as never,
    ownPopclawId: 'owner', house: 'world', bondsStore: { setFollowed },
  });
  expect(setFollowed).toHaveBeenCalledWith('person', false);
  expect(reply.remainingFollowing).not.toBe(true);
});
it.each([PopclawFollowSchema, PopclawUnfollowSchema])('house is optional but must be a nonempty string', schema => {
  expect(Value.Check(schema, { name: 'person' })).toBe(true);
  expect(Value.Check(schema, { name: 'person', house: 'world' })).toBe(true);
  expect(Value.Check(schema, { name: 'person', house: '' })).toBe(false);
  expect(Value.Check(schema, { name: 'person', house: 1 })).toBe(false);
});

it('an empty local following projection does not prevent the producer from recovering an explicit edge', async () => {
  const revokeFollowWithOutcome = vi.fn(async () => result);
  const reply = await runPopclawUnfollowCommand('person', { socialGraph: {
    revokeFollowWithOutcome, activeFollowHouses: async () => ({ houses: [] }), following: () => [] } as never, ownPopclawId: 'owner', house: 'world' });
  expect(revokeFollowWithOutcome).toHaveBeenCalledWith('person', { house: 'world' });
  expect(reply.outcome.kind).toBe('accepted');
});
it("the producer's exact house not-following refusal retains the person in the copy", async () => {
  setOwnerLang('en', 'config');
  const revokeFollowWithOutcome = vi.fn(async () => ({ mode: 'none', reason: 'RELATION_NOT_FOLLOWING' }));
  const reply = await runPopclawUnfollowCommand('person', { socialGraph: { revokeFollowWithOutcome } as never,
    ownPopclawId: 'owner', house: 'world' });
  expect(reply.outcome).toEqual({ kind: 'refused', reason: 'notFollowing' });
  expect(reply.text).toContain('Not currently following person');
});

it('consumer-only active at another house preserves the bond even with no local follow ledger', async () => {
  const setFollowed = vi.fn();
  const activeFollowHouses = vi.fn(async () => ({ houses: ['world'] }));
  const reply = await runPopclawUnfollowCommand('person', { socialGraph: {
    revokeFollowWithOutcome: async () => result, following: () => [], activeFollowHouses } as never,
    ownPopclawId: 'owner', house: 'me', bondsStore: { setFollowed } });
  expect(activeFollowHouses).toHaveBeenCalledWith('person');
  expect(setFollowed).toHaveBeenCalledWith('person', true);
  expect(reply.remainingFollowing).toBe(true);
});
it('uncertain aggregate state never clears or rewrites the bond and is reported as unknown', async () => {
  setOwnerLang('en', 'config');
  const setFollowed = vi.fn();
  const activeFollowHouses = vi.fn(async () => ({ houses: [], uncertain: 'RELATION_ACTIVE_STATE_UNCERTAIN', uncertainHouses: ['world'] }));
  const reply = await runPopclawUnfollowCommand('person', { socialGraph: {
    revokeFollowWithOutcome: async () => result, following: () => [], activeFollowHouses } as never,
    ownPopclawId: 'owner', house: 'me', bondsStore: { setFollowed } });
  expect(setFollowed).not.toHaveBeenCalled();
  expect(reply.remainingFollowingUnknown).toBe(true);
  expect(reply.text).toContain('uncertain');
});
it.each(['none', 'queued'])('a %s result reads no aggregate state and writes no bond', async transport => {
  const activeFollowHouses = vi.fn(), setFollowed = vi.fn();
  const outcome = transport === 'none' ? { mode: 'none', reason: 'RELATION_NOT_FOLLOWING' }
    : { ...result, transport: 'queued' };
  await runPopclawUnfollowCommand('person', { socialGraph: {
    revokeFollowWithOutcome: async () => outcome, activeFollowHouses } as never,
    ownPopclawId: 'owner', house: 'me', bondsStore: { setFollowed } });
  expect(activeFollowHouses).not.toHaveBeenCalled();
  expect(setFollowed).not.toHaveBeenCalled();
});

it('a known remaining house keeps the bond true even if another house is uncertain', async () => {
  const setFollowed = vi.fn();
  const reply = await runPopclawUnfollowCommand('person', { socialGraph: {
    revokeFollowWithOutcome: async () => result,
    activeFollowHouses: async () => ({ houses: ['world'], uncertain: 'RELATION_ACTIVE_STATE_UNCERTAIN', uncertainHouses: ['game'] }) } as never,
    ownPopclawId: 'owner', house: 'me', bondsStore: { setFollowed } });
  expect(setFollowed).toHaveBeenCalledWith('person', true);
  expect(reply.remainingFollowing).toBe(true);
  expect(reply.remainingFollowingUnknown).toBeUndefined();
});

it.each(['follow', 'unfollow'])('the legacy test adapter preserves an explicit house on %s', async command => {
  const declareFollow = vi.fn(async () => 'world'), revokeFollow = vi.fn(async () => 'world');
  const socialGraph = withOutcomes({ declareFollow, revokeFollow, following: () => [] });
  const deps = { socialGraph: socialGraph as never, ownPopclawId: 'owner', house: 'world' };
  if (command === 'follow') await runFollowCommand('person', deps);
  else await runPopclawUnfollowCommand('person', deps);
  expect(command === 'follow' ? declareFollow : revokeFollow).toHaveBeenCalledWith('person', { house: 'world' });
});
