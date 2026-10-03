/**
 * While the ordered producer is not installed, a relation WRITE is refused —
 * at the shared entry point, not at each surface.
 *
 * The bypass this closes was not the slash command. `SocialGraph.declareFollow`
 * signed a pre-ordering original and pushed it, and the slash command, the MCP
 * tool and the onboarding errand all reach that one method. Patching the
 * visible command would have left the other two emitting the old shape.
 *
 * The refusal happens BEFORE the local declaration is appended. Appending
 * first and failing afterwards is the one outcome worse than refusing: the
 * owner sees a failure and is left following somebody anyway, in a local
 * ledger that now disagrees with every House.
 *
 * Reading the graph is untouched. A build that cannot produce an ordered
 * original still knows who it follows.
 */
import { describe, expect, it, vi } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InMemoryHostDb } from '../../../src/host/in-memory-host-db.js';
import { runMigrations } from '../../../src/host/migrations.js';
import { SocialGraph, RelationWriteUnavailableError } from '../../../src/social-graph/social-graph.js';
import { runFollowCommand } from '../../../src/commands/follow.js';
import { runPopclawUnfollowCommand } from '../../../src/commands/popclaw-unfollow.js';
import { makeTestSigner } from '../../helpers/test-signer.js';
import { fakeRelationProducer } from '../../helpers/fake-relation-producer.js';

const MIGRATIONS = resolve(dirname(fileURLToPath(import.meta.url)), '../../../migrations');
const TARGET = '6EowM7D4wqWmMdMLmhmpoFZ1SeJrPdGK7VNLk2fKswvM';

async function graph(opts: { withProducer?: boolean } = {}) {
  const db = new InMemoryHostDb();
  runMigrations(db, MIGRATIONS);
  const egressPush = vi.fn(async () => {});
  // The producer owns signing, journalling and the push now, so a test that
  // wants to know whether the write happened asks IT, not the graph's egress
  // seam — which a relation no longer travels through.
  const fake = fakeRelationProducer({ db, egressPush });
  const sg = new SocialGraph({
    db,
    signer: makeTestSigner('BlackFeather'),
    egressPush,
    ...(opts.withProducer ? { relationProducer: fake.producer } : {}),
  });
  await sg.start();
  return { db, sg, egressPush, fake, events: () => db.queryAll('SELECT * FROM follow_events') };
}

describe('a relation write with no ordered producer installed', () => {
  it('refuses, and writes nothing locally', async () => {
    const g = await graph();
    await expect(g.sg.declareFollow(TARGET)).rejects.toBeInstanceOf(RelationWriteUnavailableError);
    // Nothing signed, nothing sent, and — the part that matters — no local
    // follow left behind for the owner to discover later.
    expect(g.egressPush).not.toHaveBeenCalled();
    expect(g.events()).toHaveLength(0);
    expect(g.sg.following()).toEqual([]);
  });

  it('refuses an unfollow on the same terms', async () => {
    const g = await graph();
    await expect(g.sg.revokeFollow(TARGET)).rejects.toBeInstanceOf(RelationWriteUnavailableError);
    expect(g.egressPush).not.toHaveBeenCalled();
    expect(g.events()).toHaveLength(0);
  });

  it('leaves reading the graph alone', async () => {
    const g = await graph();
    // A build that cannot write still knows what it knows. If this ever
    // throws, the refusal has been put in the wrong place.
    expect(() => g.sg.following()).not.toThrow();
    expect(g.sg.following()).toEqual([]);
  });

  it('writes again once a producer is installed', async () => {
    // The control. Without it the three cases above would also pass if
    // declareFollow simply always threw.
    const g = await graph({ withProducer: true });
    await expect(g.sg.declareFollow(TARGET)).resolves.not.toThrow();
    // The producer was ASKED — that is the write path now. Asserting the
    // graph's own egress seam would assert a route a relation no longer takes.
    expect(g.fake.calls).toEqual([{ action: 'declare', followee: TARGET, tasteSubscribed: false }]);
    expect(g.events()).toHaveLength(1);
  });

  it('never signs the old shape, even with a producer installed', async () => {
    // The claim this file exists to keep honest. Before the bridge, "a
    // producer is installed" merely disabled the refusal and the old signing
    // path ran anyway — so any stub re-enabled the format this release does
    // not emit. The graph now has no signing path of its own at all.
    const g = await graph({ withProducer: true });
    await g.sg.declareFollow(TARGET);
    const rows = g.db.queryAll<{ event_id: string | null }>('SELECT event_id FROM follow_events');
    expect(rows).toHaveLength(1);
    // An ordered original is journalled with the id of the event that was
    // signed; the pre-ordering path had none to record.
    expect(rows[0]?.event_id).toBeTruthy();
  });
});

describe('what the owner is told', () => {
  const deps = (sg: SocialGraph) => ({
    socialGraph: sg,
    resolvePerson: async () => ({ popclawId: TARGET }),
  }) as never;

  it('the follow command says it did not happen, and does not claim success', async () => {
    const g = await graph();
    const reply = await runFollowCommand(TARGET, deps(g.sg));
    // The success prefix is what the MCP layer reads; it must not be there.
    expect(reply.text.startsWith('✓')).toBe(false);
    expect(reply.text).toContain('⚠️');
    // Localised copy, not a leaked lexicon key and not a raw Error string.
    expect(reply.text).not.toContain('relation.writeUnavailable');
    expect(reply.text).not.toContain('RELATION_WRITE_UNAVAILABLE');
    expect(reply.text.toLowerCase()).toContain('unavailable');
  });

  it('the unfollow command says the same, on a graph that IS following them', async () => {
    // Follow first with a producer installed, then take the producer away on
    // the same database — otherwise the command would stop at "not currently
    // following" and this would prove nothing about the refusal.
    const db = new InMemoryHostDb();
    runMigrations(db, MIGRATIONS);
    const egressPush = vi.fn(async () => {});
    const signer = makeTestSigner('BlackFeather');
    const able = new SocialGraph({ db, signer, egressPush, relationProducer: fakeRelationProducer({ db }).producer });
    await able.start();
    await able.declareFollow(TARGET);
    expect(able.following().some((f) => f.popclawId === TARGET)).toBe(true);

    const unable = new SocialGraph({ db, signer, egressPush });
    await unable.start();
    expect(unable.following().some((f) => f.popclawId === TARGET)).toBe(true); // reads fine
    egressPush.mockClear();

    const reply = await runPopclawUnfollowCommand(TARGET, deps(unable));
    expect(reply.text.startsWith('✓')).toBe(false);
    expect(reply.text).toContain('⚠️');
    expect(reply.text).not.toContain('relation.writeUnavailable');
    expect(egressPush).not.toHaveBeenCalled();
    // Still following: a refused unfollow must not half-apply either.
    expect(unable.following().some((f) => f.popclawId === TARGET)).toBe(true);
  });
});

/**
 * Whose limitation it is.
 *
 * The producer IS installed and it ran; the house it resolved to declares no
 * ordered relations. Telling the owner "following is unavailable in this
 * build" there is false — the same build follows fine at a house that does
 * declare the capability — and it sends them off to wait for a release that
 * already shipped. The refusal itself is unchanged: nothing signed, nothing
 * sent, nobody followed.
 */
describe('a relation write the HOUSE refused', () => {
  const refusing = (reason: string) =>
    ({
      socialGraph: {
        following: () => [{ popclawId: TARGET, since: 1 }],
        declareFollowWithOutcome: async () => ({
          mode: 'none', transport: 'intent_recorded', domain: 'unknown',
          action: 'declare', followee: TARGET, reason,
        }),
        revokeFollowWithOutcome: async () => ({
          mode: 'none', transport: 'intent_recorded', domain: 'unknown',
          action: 'revoke', followee: TARGET, reason,
        }),
      },
      resolvePerson: async () => ({ popclawId: TARGET }),
    }) as never;

  it('blames the house, not the build, when the house declares no relations', async () => {
    const reply = await runFollowCommand(TARGET, refusing('HOUSE_ORDERED_RELATIONS_UNSUPPORTED'));

    expect(reply.text).toContain('⚠️');
    expect(reply.text).toContain('This house does not offer the follow operation');
    expect(reply.text).toContain('nothing was signed or sent');
    // The false half. This build follows perfectly well on a capable house.
    expect(reply.text).not.toContain('in this build');
    expect(reply.text).not.toContain('not wired up yet');
  });

  it('does not claim mail from that house can never reach the owner', async () => {
    // The retracted inference: the notification gate is the LOCAL per-person
    // union across every house, so a house with no relation lane of its own
    // does not make its mail permanently silent.
    const reply = await runFollowCommand(TARGET, refusing('HOUSE_ORDERED_RELATIONS_UNSUPPORTED'));

    expect(reply.text).toContain('already follow on another house');
    expect(reply.text).not.toMatch(/never (notify|be notified|reach)/i);
  });

  it('says the same on an unfollow', async () => {
    const reply = await runPopclawUnfollowCommand(TARGET, refusing('HOUSE_ORDERED_RELATIONS_UNSUPPORTED'));

    expect(reply.text).toContain('This house does not offer the follow operation');
    expect(reply.text).not.toContain('in this build');
  });

  it('leaves every other refusal reason on the sentence it already had', async () => {
    // The control. A rule that swapped the sentence for EVERY refusal would
    // pass the three above and quietly relabel a house that was merely down.
    const reply = await runFollowCommand(TARGET, refusing('HOUSE_UNREACHABLE'));

    expect(reply.text).toContain('in this build');
    expect(reply.text).not.toContain('This house does not offer the follow operation');
  });
});
