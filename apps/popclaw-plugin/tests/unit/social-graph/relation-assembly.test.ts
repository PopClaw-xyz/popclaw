/**
 * The assembled producer is reached, and the refusal moves.
 *
 * Wiring something and proving it is wired are different claims, and the gap
 * between them is how this work has gone wrong before: a table written that
 * nothing reads, a callback attached that nothing can reach. So this does not
 * assert "a producer exists". It asserts that the REASON a follow fails has
 * changed, which only happens if the chain is actually connected.
 *
 * Before the roots assembled a producer, `SocialGraph` refused every write at
 * its own door: RELATION_WRITE_UNAVAILABLE, meaning "this build cannot write a
 * relation at all". With the producer in place the write travels — through the
 * scope resolver, to the trust check — and stops at the first real obstacle:
 * no pin for this house, HOUSE_BINDING_UNPROVEN.
 *
 * Both are refusals and a follow does not happen either way. The difference is
 * that the second one is a statement about a HOUSE rather than about this
 * build, and getting it requires every piece between the command and the trust
 * check to exist.
 */
import { describe, expect, it } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InMemoryHostDb } from '../../../src/host/in-memory-host-db.js';
import { runMigrations } from '../../../src/host/migrations.js';
import { SocialGraph, RelationWriteUnavailableError } from '../../../src/social-graph/social-graph.js';
import { RelationRefusedError } from '../../../src/social-graph/relation-producer.js';
import { makeRelationProducer } from '../../../src/social-graph/relation-assembly.js';
import { makeTestSigner } from '../../helpers/test-signer.js';

const MIGRATIONS = resolve(dirname(fileURLToPath(import.meta.url)), '../../../migrations');
const TARGET = '6EowM7D4wqWmMdMLmhmpoFZ1SeJrPdGK7VNLk2fKswvM';
const HOUSES = [{ slug: 'house-a', origin: 'https://house-a.invalid' }];

async function graph(opts: { withProducer: boolean }) {
  const db = new InMemoryHostDb();
  runMigrations(db, MIGRATIONS);
  const signer = makeTestSigner('BlackFeather');
  const pushed: string[] = [];
  const sg = new SocialGraph({
    db,
    signer,
    ...(opts.withProducer
      ? {
          relationProducer: makeRelationProducer({
            db,
            signer,
            houses: HOUSES,
            pushTo: async (slug) => {
              pushed.push(slug);
              return { status: 200, eventId: 'never' } as never;
            },
          }),
        }
      : {}),
  });
  await sg.start();
  return { db, sg, pushed };
}

describe('a follow through the assembled producer', () => {
  it('stops at the house, not at this build', async () => {
    const g = await graph({ withProducer: true });
    const err = await g.sg.declareFollow(TARGET).then(() => null, (e: unknown) => e);

    // Not the door: the write got past SocialGraph and into the producer.
    expect(err).not.toBeInstanceOf(RelationWriteUnavailableError);
    expect(err).toBeInstanceOf(RelationRefusedError);
    // And it reached the trust check — this house has no pin, which is a fact
    // about the house, and the next piece of work to close.
    expect((err as RelationRefusedError).outcome.reason).toBe('HOUSE_BINDING_UNPROVEN');
    // Nothing signed, nothing sent: the refusal is before the wire.
    expect(g.pushed).toEqual([]);
    expect(g.db.queryAll('SELECT * FROM follow_events')).toHaveLength(0);
  });

  it('records the refusal where the owner can find it', async () => {
    const g = await graph({ withProducer: true });
    await g.sg.declareFollow(TARGET).catch(() => undefined);
    const journal = g.db.queryAll<{ reason: string; followee_popclaw_id: string; action: string }>(
      'SELECT reason, followee_popclaw_id, action FROM relation_pending_intents',
    );
    expect(journal).toHaveLength(1);
    expect(journal[0]).toMatchObject({
      reason: 'HOUSE_BINDING_UNPROVEN', followee_popclaw_id: TARGET, action: 'declare',
    });
  });

  it('without a producer it still stops at the door — the control', async () => {
    // If this ever reported HOUSE_BINDING_UNPROVEN too, the case above would
    // be passing for a reason that has nothing to do with the wiring.
    const g = await graph({ withProducer: false });
    await expect(g.sg.declareFollow(TARGET)).rejects.toBeInstanceOf(RelationWriteUnavailableError);
  });
});
