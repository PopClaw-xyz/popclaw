/**
 * A first release does not emit the old shape.
 *
 * The producer used to have one remaining downgrade: a house whose identity is
 * proven but whose manifest declares no ordered relations, on an edge with no
 * ordered history, got the legacy shape. That was the right answer for a build
 * that had to interoperate with houses already in the field. This is the first
 * public release — there is no field — so the legacy shape is not compatibility
 * any more, it is a second wire format nobody asked for, and its cost is
 * permanent: an edge started legacy has no seq, so nothing can ever order it
 * without a fresh namespace.
 *
 * The refusal has to happen BEFORE signing. Signing is what makes the
 * consequences durable — a signed original is recorded, queued and pushed, and
 * a seq once spent is spent. "Sign it and then decide" is not a smaller version
 * of this bug; it is the bug.
 *
 * What is NOT changed: the ability to READ an original that was signed in the
 * old shape. Refusing to produce a format and refusing to understand it are
 * different decisions, and only the first one is made here.
 */
import { describe, expect, it, vi } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InMemoryHostDb } from '../../../src/host/in-memory-host-db.js';
import { runMigrations } from '../../../src/host/migrations.js';
import { createRelationProducer } from '../../../src/social-graph/relation-producer.js';
import type { RelationScope } from '../../../src/social-graph/relation-producer.js';

const MIGRATIONS = resolve(dirname(fileURLToPath(import.meta.url)), '../../../migrations');
const HOUSE_KEY = '9xQeWy8P3vNhKd2RmTzA6BcFgJ4LnSuVoXpYrEt5Hw1Z';
const FOLLOWEE = '7LhZ8x6c8Kmw5P9Wtnm4T6E7YcbTpZ7N7tfZcqLRv5cM';

function producerWith(scope: RelationScope) {
  const db = new InMemoryHostDb();
  runMigrations(db, MIGRATIONS);
  const sign = vi.fn();
  const push = vi.fn(async () => ({ ok: true, eventId: 'never' }) as never);
  const intents: unknown[] = [];
  const producer = createRelationProducer({
    db,
    // Any call at all is a failure: the point is that nothing is signed.
    signer: new Proxy({}, { get: () => (...args: unknown[]) => { sign(...args); throw new Error('SIGNER_TOUCHED'); } }) as never,
    resolveScope: () => scope,
    signingReadiness: () => ({ ready: true }) as never,
    push,
    recordPendingIntent: (intent) => { intents.push(intent); },
    now: () => 1_713_657_600,
  });
  return { db, producer, sign, push, intents };
}

const unsupported: RelationScope = { support: 'unsupported', houseKey: HOUSE_KEY, houseSlug: 'h1',
  detail: 'manifest declares no relations block' };

describe('a house that does not serve ordered relations', () => {
  it('refuses a new follow instead of emitting the legacy shape', async () => {
    const p = producerWith(unsupported);
    const outcome = await p.producer.declare(FOLLOWEE);

    expect(outcome.mode).toBe('none');
    expect(outcome.mode).not.toBe('legacy');
    if (outcome.mode === 'none') {
      expect(outcome.reason).toBe('HOUSE_ORDERED_RELATIONS_UNSUPPORTED');
      expect(outcome.detail).toContain('manifest declares no relations block');
    }
  });

  it('does not sign, does not queue, does not push', async () => {
    const p = producerWith(unsupported);
    await p.producer.declare(FOLLOWEE);

    // Signing is the irreversible step, so it is the one the assertion names.
    expect(p.sign).not.toHaveBeenCalled();
    expect(p.push).not.toHaveBeenCalled();
    // No original was recorded, and nothing was left in the outbox for a
    // retry to pick up and deliver later.
    expect(p.db.queryAll('SELECT * FROM relation_outbox')).toHaveLength(0);
    expect(p.db.queryAll('SELECT * FROM follow_events')).toHaveLength(0);
  });

  it('journals the refusal so a relation that did not happen can be seen', async () => {
    const p = producerWith(unsupported);
    await p.producer.declare(FOLLOWEE);
    // Silence would be the worst outcome: the owner asked to follow somebody
    // and nothing anywhere would say why it did not happen.
    expect(p.intents).toHaveLength(1);
    expect(p.intents[0]).toMatchObject({
      action: 'declare', followee: FOLLOWEE, reason: 'HOUSE_ORDERED_RELATIONS_UNSUPPORTED',
    });
  });

  it('refuses an unfollow on the same terms', async () => {
    const p = producerWith(unsupported);
    const outcome = await p.producer.revoke(FOLLOWEE);
    expect(outcome.mode).toBe('none');
    expect(p.sign).not.toHaveBeenCalled();
    expect(p.push).not.toHaveBeenCalled();
  });

  it('still refuses the other three answers on their own reasons', async () => {
    // A control: this change must not have collapsed the four distinct
    // answers into one. "I could not prove who this house is" and "this house
    // says it has no ordered relations" stay different facts.
    for (const [scope, reason] of [
      [{ support: 'unproven', houseSlug: 'h1' }, 'HOUSE_BINDING_UNPROVEN'],
      [{ support: 'unreachable', houseSlug: 'h1' }, 'HOUSE_UNREACHABLE'],
      [{ support: 'capability-unknown', houseKey: HOUSE_KEY, houseSlug: 'h1' }, 'HOUSE_CAPABILITY_UNKNOWN'],
    ] as const) {
      const p = producerWith(scope as RelationScope);
      const outcome = await p.producer.declare(FOLLOWEE);
      expect(outcome.mode).toBe('none');
      if (outcome.mode === 'none') expect(outcome.reason).toBe(reason);
      expect(p.sign).not.toHaveBeenCalled();
    }
  });
});
