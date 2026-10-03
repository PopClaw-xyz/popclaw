/**
 * The assembly, exercised as an assembly.
 *
 * Every piece below has had its own tests for a while and none of them was
 * reachable: nothing called the commit boundary, the participation helpers, the
 * consumer or the drain. These tests are about the joins between them — above
 * all the one that cannot be tested piece by piece, which is that a caller
 * never gets to say where a frame came from.
 *
 * In-memory, one process. No socket, no real house, no host root: `index.ts`,
 * `mcp.ts` and `main.ts` still do not attach this, and a green file here says
 * the assembly is correct, not that a running plugin uses it.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { popclaw } from '@popclaw/contracts';
import { canonicalizeEnvelope, cidFromCanonical } from '@popclaw/algorithms';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { InMemoryHostDb } from '../../../src/host/in-memory-host-db.js';
import { runMigrations } from '../../../src/host/migrations.js';
import {
  beginParticipation,
  endParticipation,
  housePositionAdvances,
} from '../../../src/ingress/inbound-commit.js';
import {
  createRelationWiring,
  type InboundRelationFrame,
  type RelationWiring,
} from '../../../src/social-graph/relation-wiring.js';

const MIGRATIONS = resolve(dirname(fileURLToPath(import.meta.url)), '../../../migrations');
const HOUSE = 'HouseA';
const OTHER = 'HouseB';
const NOW = () => 1_700_000_000;

// Relation events on the personal stream are the owner's own echoed
// follow/unfollow (R4 §8), so one keypair is both actor and recipient — the
// same shape production has.
const me = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(0x4d));
const ME = bs58.encode(me.publicKey);

function follow(followee: string, seq: number, houseKey = HOUSE, revoked = false): Uint8Array {
  const env: Record<string, unknown> = {
    actor: { popclawId: ME },
    timestamp: 1_700_000_000,
    [revoked ? 'followRevoked' : 'followDeclared']: {
      followeePopclawId: followee,
      order: { seq, houseKey },
    },
  };
  const canonical = canonicalizeEnvelope(env);
  return popclaw.event.EventEnvelope.encode({
    ...env,
    eventId: cidFromCanonical(canonical),
    signature: nacl.sign.detached(canonical, me.secretKey),
  }).finish();
}

/**
 * A relation original the public lane refuses, and the personal stream
 * accepts — the shape the cursor rules below are about.
 *
 * At this revision the public structure check refuses a relation original by
 * its follow type; the protocol re-seal that withdraws relation kinds from
 * the public tag list outright is a separate change, after which an ORDINARY
 * follow reaches the commit boundary by this same door. The boundary's
 * treatment of a refusal does not depend on which clause refused it, so this
 * fixture keeps its meaning either way.
 */
function publicLaneRefusedFollow(followee: string, seq: number, houseKey = HOUSE): Uint8Array {
  const env: Record<string, unknown> = {
    actor: { popclawId: ME },
    timestamp: 1_700_000_000,
    followDeclared: {
      followeePopclawId: followee,
      followType: 1,
      order: { seq, houseKey },
    },
  };
  const canonical = canonicalizeEnvelope(env);
  return popclaw.event.EventEnvelope.encode({
    ...env,
    eventId: cidFromCanonical(canonical),
    signature: nacl.sign.detached(canonical, me.secretKey),
  }).finish();
}

/**
 * Publicly legitimate in every way except the one that matters: the id is the
 * real digest of the canonical bytes, so the structure and CID checks both
 * pass and the signature check is what refuses it.
 */
function unsignedPost(text: string): Uint8Array {
  const env: Record<string, unknown> = {
    actor: { popclawId: ME },
    timestamp: 1_700_000_000,
    post: { blocks: [{ content: text }] },
  };
  const canonical = canonicalizeEnvelope(env);
  return popclaw.event.EventEnvelope.encode({
    ...env,
    eventId: cidFromCanonical(canonical),
    signature: new Uint8Array(64),
  }).finish();
}

/** An ordinary public post — what the world stream is actually for. */
function post(text: string): Uint8Array {
  const env: Record<string, unknown> = {
    actor: { popclawId: ME },
    timestamp: 1_700_000_000,
    post: { blocks: [{ content: text }] },
  };
  const canonical = canonicalizeEnvelope(env);
  return popclaw.event.EventEnvelope.encode({
    ...env,
    eventId: cidFromCanonical(canonical),
    signature: nacl.sign.detached(canonical, me.secretKey),
  }).finish();
}

/** A post the author scoped to a private audience. */
function privatePost(text: string): Uint8Array {
  const env: Record<string, unknown> = {
    actor: { popclawId: ME },
    timestamp: 1_700_000_000,
    // PRIVATE (1) is not a public audience, whatever stream it turns up on.
    target: { scope: 1, targetIds: ['someone'] },
    post: { blocks: [{ content: text }] },
  };
  const canonical = canonicalizeEnvelope(env);
  return popclaw.event.EventEnvelope.encode({
    ...env,
    eventId: cidFromCanonical(canonical),
    signature: nacl.sign.detached(canonical, me.secretKey),
  }).finish();
}

/** A payload that CONFERS house authority — a valid signature is not enough. */
function houseEvent(signer: nacl.SignKeyPair): Uint8Array {
  const env: Record<string, unknown> = {
    actor: { popclawId: bs58.encode(signer.publicKey) },
    timestamp: 1_700_000_000,
    houseEvent: { kind: 'me.postcard' },
  };
  const canonical = canonicalizeEnvelope(env);
  return popclaw.event.EventEnvelope.encode({
    ...env,
    eventId: cidFromCanonical(canonical),
    signature: nacl.sign.detached(canonical, signer.secretKey),
  }).finish();
}

/** A private message, signed by somebody else, as it would really arrive. */
function dm(): Uint8Array {
  const sender = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(0x53));
  const from = bs58.encode(sender.publicKey);
  const env: Record<string, unknown> = {
    actor: { popclawId: from },
    timestamp: 1_700_000_000,
    directMessage: { fromPopclawId: from, toPopclawId: ME, body: 'hello' },
  };
  const canonical = canonicalizeEnvelope(env);
  return popclaw.event.EventEnvelope.encode({
    ...env,
    eventId: cidFromCanonical(canonical),
    signature: nacl.sign.detached(canonical, sender.secretKey),
  }).finish();
}

function frameOf(bytes: Uint8Array, over: Partial<InboundRelationFrame> = {}): InboundRelationFrame {
  return {
    stream: 'personal',
    envelopeBytes: bytes,
    eventId: popclaw.event.EventEnvelope.decode(bytes).eventId ?? '',
    position: '7',
    ...over,
  };
}

describe('createRelationWiring', () => {
  let db: InMemoryHostDb;
  let wiring: RelationWiring;
  beforeEach(() => {
    db = new InMemoryHostDb();
    runMigrations(db, MIGRATIONS);
    wiring = createRelationWiring({ db, recipientPopclawId: ME, now: NOW });
  });

  /**
   * The property the whole trust chain rests on. A root is handed a session
   * handle; it cannot name a house key, an incarnation or a generation, so
   * there is no argument it could pass to commit a frame as somebody else.
   */
  it('gives a root no way to name its own source', () => {
    const h = wiring.login({ houseKey: HOUSE, incarnation: 'inc-1', houseSlug: 'home' });
    expect(h.source.ownerGeneration).toBe(1);
    expect(h.source.houseKey).toBe(HOUSE);
  });

  it('commits, queues and then judges a frame from a session', () => {
    const h = wiring.login({ houseKey: HOUSE, incarnation: 'inc-1', houseSlug: 'home' });

    expect(h.receive(frameOf(follow('Bob', 1)))).toEqual({
      firstTime: true,
      disposition: 'accepted',
    });
    expect(wiring.drain().map((o) => o.verdict)).toEqual(['applied']);
    expect(h.resumeFrom('personal')).toBe('7');
  });

  /**
   * The counter-example this handle exists for. A callback holding a
   * connection from before a logout keeps calling; if the source were looked up
   * by house key when its frame arrived, it would be handed whatever session is
   * current NOW and committed under a generation that has nothing to do with
   * it. The handle carries the generation it was born with, and the commit
   * boundary refuses it.
   */
  it('refuses an old handle after somebody else logged out and back in', () => {
    const old = wiring.login({ houseKey: HOUSE, incarnation: 'inc-1' });
    old.receive(frameOf(follow('Bob', 1), { position: '20' }));
    // The owner logs out and back in somewhere else entirely. This handle is
    // never told; it is a callback holding a connection, and it has no clock.
    endParticipation(db, HOUSE, NOW);
    const fresh = wiring.login({ houseKey: HOUSE, incarnation: 'inc-1' });
    expect(fresh.source.ownerGeneration).toBe(3);

    const r = old.receive(frameOf(follow('Carol', 2), { position: '7' }));

    expect(r.disposition).toBe('refused');
    expect(r.reason).toContain('owner generation 1');
    // And it did not drag the cursor back to where it was.
    expect(fresh.resumeFrom('personal')).toBe('20');
  });

  /**
   * Closing a connection has to stop the closure, not just forget it. Taking
   * the handle out of the set left `receive` perfectly usable — a detached
   * connection still committed frames and still moved the cursor.
   */
  it('stops a handle that has been detached', () => {
    const first = wiring.login({ houseKey: HOUSE, incarnation: 'inc-1' });
    const second = wiring.attach({ houseKey: HOUSE, incarnation: 'inc-1' })!;
    first.receive(frameOf(follow('Bob', 1), { position: '20' }));
    second.detach();

    const r = second.receive(frameOf(follow('Carol', 2), { position: '99' }));

    expect(r.disposition).toBe('refused');
    expect(r.reason).toContain('closed');
    expect(first.resumeFrom('personal')).toBe('20');
    expect(wiring.drain().map((o) => o.verdict)).toEqual(['applied']);
  });

  it('stops a handle that has left, too', () => {
    const h = wiring.login({ houseKey: HOUSE, incarnation: 'inc-1' });
    h.leave();
    expect(h.receive(frameOf(follow('Bob', 1))).reason).toContain('closed');
  });

  /**
   * A handle from a session that has already been replaced does not get to log
   * out the session that replaced it.
   */
  it('does not let a stale leave end somebody else session', () => {
    const old = wiring.login({ houseKey: HOUSE, incarnation: 'inc-1' });
    old.leave();
    const fresh = wiring.login({ houseKey: HOUSE, incarnation: 'inc-1' });

    old.leave();

    expect(fresh.receive(frameOf(follow('Bob', 1))).disposition).toBe('accepted');
    expect(wiring.liveSources()).toHaveLength(1);
  });

  /** Leaving is not forgetting. */
  it('keeps the cursor across a logout and login', () => {
    const first = wiring.login({ houseKey: HOUSE, incarnation: 'inc-1' });
    first.receive(frameOf(follow('Bob', 1), { position: '20' }));
    first.leave();
    expect(wiring.login({ houseKey: HOUSE, incarnation: 'inc-1' }).resumeFrom('personal')).toBe(
      '20',
    );
  });

  /**
   * A reconnect and a second process are not the owner logging in again. If
   * they were, one data root with two hosts could never keep a stream alive:
   * each would knock the other out on connect.
   */
  it('lets a second connection attach without knocking the first one out', () => {
    const first = wiring.login({ houseKey: HOUSE, incarnation: 'inc-1' });
    const second = wiring.attach({ houseKey: HOUSE, incarnation: 'inc-1' });

    expect(second?.source.ownerGeneration).toBe(first.source.ownerGeneration);
    expect(first.receive(frameOf(follow('Bob', 1))).disposition).toBe('accepted');
    expect(second?.receive(frameOf(follow('Carol', 2))).disposition).toBe('accepted');
  });

  it('has nothing to attach to before the owner logs in, or after they leave', () => {
    expect(wiring.attach({ houseKey: HOUSE, incarnation: 'inc-1' })).toBeUndefined();
    const h = wiring.login({ houseKey: HOUSE, incarnation: 'inc-1' });
    expect(wiring.attach({ houseKey: HOUSE, incarnation: 'inc-1' })).toBeDefined();
    h.leave();
    expect(wiring.attach({ houseKey: HOUSE, incarnation: 'inc-1' })).toBeUndefined();
  });

  it('detaching closes this connection and leaves the participation alone', () => {
    const first = wiring.login({ houseKey: HOUSE, incarnation: 'inc-1' });
    const second = wiring.attach({ houseKey: HOUSE, incarnation: 'inc-1' })!;
    second.detach();

    expect(wiring.liveSources()).toHaveLength(1);
    expect(first.receive(frameOf(follow('Bob', 1))).disposition).toBe('accepted');
  });

  /**
   * A session this process opened can be superseded by a login somewhere else —
   * another host on the same data root. The backlog it queued must stop taking
   * effect under a generation that is no longer the live one.
   */
  it('stops draining a session another login has superseded', () => {
    const h = wiring.login({ houseKey: HOUSE, incarnation: 'inc-1' });
    h.receive(frameOf(follow('Bob', 1)));
    expect(wiring.liveSources()).toHaveLength(1);

    expect(beginParticipation(db, HOUSE, NOW)).toBe(2);

    expect(wiring.liveSources()).toHaveLength(0);
    expect(wiring.drain()).toEqual([]);
  });

  it('keeps two houses independent', () => {
    const a = wiring.login({ houseKey: HOUSE, incarnation: 'inc-1' });
    const b = wiring.login({ houseKey: OTHER, incarnation: 'inc-9' });
    a.receive(frameOf(follow('Bob', 1), { position: '11' }));
    b.receive(frameOf(follow('Bob', 1, OTHER), { position: '4' }));

    expect(a.resumeFrom('personal')).toBe('11');
    expect(b.resumeFrom('personal')).toBe('4');

    a.leave();
    expect(wiring.liveSources().map((s) => s.houseKey)).toEqual([OTHER]);
  });

  /**
   * The personal inbox carries the owner's mail and verification enforces that.
   * Applying the same context to the world stream would refuse every ordinary
   * public post — which is the one thing that stream is for.
   */
  it('lets ordinary public content through on the world stream', () => {
    const h = wiring.login({ houseKey: HOUSE, incarnation: 'inc-1' });
    const withWorld = createRelationWiring({
      db,
      recipientPopclawId: ME,
      now: NOW,
      otherConsumers: [
        (_tx, f) =>
          f.stream === 'world'
            ? ({ status: 'accepted' } as const)
            : ({ status: 'not-applicable' } as const),
      ],
    });
    const w = withWorld.attach({ houseKey: HOUSE, incarnation: 'inc-1' })!;
    void h;

    expect(w.receive(frameOf(post('hello world'), { stream: 'world' })).disposition).toBe(
      'accepted',
    );
  });

  /**
   * And nothing is loosened to pay for it. A private message needs a recipient
   * to be verified against at all, so the world context — which supplies none
   * — refuses it before anything else looks at it. That is the existing
   * verifier doing its job, not a second guard bolted on here.
   */
  it('and still refuses a private message that arrives on it', () => {
    const h = wiring.login({ houseKey: HOUSE, incarnation: 'inc-1' });
    const r = h.receive(frameOf(dm(), { stream: 'world' }));
    expect(r.disposition).toBe('refused');
    expect(r.reason).toContain('NOT_PUBLIC');
  });

  /**
   * A world frame is not "no context" — it is the PUBLIC one. Dropping the
   * recipient without putting that in its place left the public surface
   * unchecked, and a properly signed post scoped to a private audience went
   * straight through to a world consumer.
   */
  it('refuses a properly signed post the author scoped privately', () => {
    const h = wiring.login({ houseKey: HOUSE, incarnation: 'inc-1' });
    const r = h.receive(frameOf(privatePost('not for everyone'), { stream: 'world' }));
    expect(r.disposition).toBe('refused');
    expect(r.reason).toContain('NOT_PUBLIC');
  });

  /**
   * A valid signature by an arbitrary actor is not authority. And authority is
   * per source: a house being official somewhere else says nothing about what
   * it may assert here.
   */
  it('refuses a house-authority payload when nothing has been declared official', () => {
    const h = wiring.login({ houseKey: HOUSE, incarnation: 'inc-1' });
    const r = h.receive(frameOf(houseEvent(me), { stream: 'world' }));
    expect(r.disposition).toBe('refused');
  });

  it('accepts one from the actor this source declares official, and only this source', () => {
    const official = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(0x0f));
    const officialId = bs58.encode(official.publicKey);
    const seen: string[] = [];
    const w = createRelationWiring({
      db,
      recipientPopclawId: ME,
      now: NOW,
      // Only HOUSE declares this actor official; OTHER declares nobody.
      officialActorsFor: (source) => (actorId) =>
        source.houseKey === HOUSE && actorId === officialId,
      otherConsumers: [
        (_tx, f) => {
          if (f.stream !== 'world') return { status: 'not-applicable' } as const;
          seen.push(f.eventId);
          return { status: 'accepted' } as const;
        },
      ],
    });
    const atHouse = w.login({ houseKey: HOUSE, incarnation: 'inc-1' });
    const atOther = w.login({ houseKey: OTHER, incarnation: 'inc-9' });

    expect(atHouse.receive(frameOf(houseEvent(official), { stream: 'world' })).disposition).toBe(
      'accepted',
    );
    expect(atOther.receive(frameOf(houseEvent(official), { stream: 'world' })).disposition).toBe(
      'refused',
    );
    expect(seen).toHaveLength(1);
  });

  it('keeps the personal inbox closed to content that is not the owner mail', () => {
    const h = wiring.login({ houseKey: HOUSE, incarnation: 'inc-1' });
    const r = h.receive(frameOf(post('hello world')));
    expect(r.disposition).toBe('refused');
    expect(r.reason).toContain('INBOX_PAYLOAD_MISMATCH');
  });

  /**
   * With only the relation consumer wired, everything else is somebody's mail
   * that nobody present can speak for.
   */
  it('reports a frame no wired consumer claims as not-applicable', () => {
    const h = wiring.login({ houseKey: HOUSE, incarnation: 'inc-1' });
    // A Post is publicly eligible and verifies; it simply has no wired
    // consumer. A relation original no longer reaches this state at all —
    // see the test below — so it is no longer the specimen for this one.
    expect(h.receive(frameOf(post('nobody claims this'), { stream: 'world' })).disposition).toBe(
      'not-applicable',
    );
  });

  /**
   * Since `.01.6` a relation original is not publicly eligible. Arriving on the
   * world stream it therefore fails verification rather than reaching the
   * consumers, and takes this boundary's existing refusal path: the bytes are
   * retained as quarantine evidence under the reason the predicate gave,
   * rather than silently dropped. The personal-stream path is unchanged.
   */
  it('refuses a relation original that arrives on the world stream', () => {
    const h = wiring.login({ houseKey: HOUSE, incarnation: 'inc-1' });
    const r = h.receive(frameOf(follow('Bob', 1), { stream: 'world' }));
    expect(r.disposition).toBe('refused');
    expect(r.reason).toContain('NOT_PUBLIC');
  });

  /**
   * The verification the commit boundary requires is the real one, not a stub
   * that echoes the claim — so bytes that do not verify never reach the table
   * keyed by the id they claimed.
   */
  it('quarantines bytes that do not verify instead of storing them', () => {
    const h = wiring.login({ houseKey: HOUSE, incarnation: 'inc-1' });
    const real = follow('Bob', 1);
    const realId = popclaw.event.EventEnvelope.decode(real).eventId ?? '';

    const r = h.receive({
      stream: 'personal',
      envelopeBytes: new Uint8Array([0xff, 0xff, 0xff]),
      eventId: realId,
      position: '3',
    });

    expect(r.disposition).toBe('refused');
    expect(db.queryAll('SELECT event_id FROM inbound_frames', [])).toHaveLength(0);
    expect(db.queryAll('SELECT quarantine_id FROM inbound_quarantine', [])).toHaveLength(1);

    expect(h.receive(frameOf(real)).disposition).toBe('accepted');
    const stored = db.queryOne<{ envelope: Uint8Array }>(
      'SELECT envelope FROM inbound_frames WHERE event_id = ?',
      [realId],
    );
    expect(stored?.envelope).toEqual(real);
  });

  it('refuses a frame whose bytes are not the event it announced', () => {
    const h = wiring.login({ houseKey: HOUSE, incarnation: 'inc-1' });
    const r = h.receive(frameOf(follow('Bob', 1), { eventId: 'a'.repeat(64) }));
    expect(r.disposition).toBe('refused');
    expect(r.reason).toContain('announced');
  });
});

/**
 * A relation original that arrives on a channel it must not be consumed on.
 *
 * What the refusal may and may not move. It may move the TRANSPORT's resume
 * position — the connection did deliver something, and asking for the same
 * inadmissible bytes for ever helps nobody — and it may do so only because
 * the frame is kept: raw bytes, the digest of what they actually are, the
 * reason, the source that handed them over, and the position they arrived at,
 * all written before the position moves and in the same transaction. What it
 * may never move is anything that means the event was verified, admitted or
 * finished with: no row keyed by the identity it claimed, no relation, no
 * delivery record, and no cursor at all when the evidence does not land.
 *
 * The refusal is cheap and comes BEFORE the signature is checked
 * (`verify-envelope.ts:23` runs the public structure check ahead of the CID
 * and signature at `:30`-`:32`), so nothing written here may read as proof
 * that the bytes were signed by whoever they name.
 */
describe('a refusal on a public channel, its evidence and the transport position', () => {
  let db: InMemoryHostDb;
  beforeEach(() => {
    db = new InMemoryHostDb();
    runMigrations(db, MIGRATIONS);
  });

  /**
   * The house's own cursor format, and the comparator the product roots hand
   * the commit boundary — not a test double. A position that is not
   * `<log_generation>.<seq>` is unreadable (RELATIONS.md §8: the personal
   * stream's frames carry `id: <log_generation>.<seq>`).
   */
  const worldWiring = (over: Partial<Parameters<typeof createRelationWiring>[0]> = {}) =>
    createRelationWiring({
      db,
      recipientPopclawId: ME,
      now: NOW,
      advances: housePositionAdvances,
      ...over,
    });

  const quarantined = () =>
    db.queryAll<{
      claimed_event_id: string;
      bytes_sha256: string;
      house_key: string;
      incarnation: string;
      owner_generation: number;
      stream: string;
      reason: string;
      position: string | null;
      envelope: Uint8Array;
    }>('SELECT * FROM inbound_quarantine ORDER BY quarantine_id', []);

  /**
   * Evidence retained WITH the position it arrived at — and only then does
   * the transport resume position move past it.
   */
  it('keeps the bytes, the reason, the source and the position, then advances', () => {
    const w = worldWiring();
    const h = w.login({ houseKey: HOUSE, incarnation: 'inc-1' });
    const bytes = publicLaneRefusedFollow('Bob', 1);

    const r = h.receive(frameOf(bytes, { stream: 'world', position: '5.12' }));

    expect(r).toEqual({ firstTime: false, disposition: 'refused', reason: 'NOT_PUBLIC' });
    const rows = quarantined();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      claimed_event_id: popclaw.event.EventEnvelope.decode(bytes).eventId ?? '',
      // What the bytes ARE, next to what they SAID they were.
      bytes_sha256: cidFromCanonical(bytes),
      house_key: HOUSE,
      incarnation: 'inc-1',
      owner_generation: 1,
      stream: 'world',
      reason: 'NOT_PUBLIC',
      position: '5.12',
    });
    expect(new Uint8Array(rows[0]!.envelope)).toEqual(new Uint8Array(bytes));
    expect(h.resumeFrom('world')).toBe('5.12');

    // Refused before the signature was ever checked: nothing here may read as
    // a verified event.
    expect(db.queryAll('SELECT event_id FROM inbound_frames', [])).toHaveLength(0);
    expect(db.queryAll('SELECT event_id FROM inbound_deliveries', [])).toHaveLength(0);
    expect(db.queryAll('SELECT * FROM relation_edges', [])).toHaveLength(0);
  });

  /**
   * The half that makes the advance permissible at all. If the evidence
   * cannot be written, the position must stay exactly where it was — the
   * control below is the position a successful refusal had already moved it
   * to, so "nothing moved" is measured against something that did move.
   */
  it('leaves the position where it was when the evidence write fails', () => {
    const w = worldWiring();
    const h = w.login({ houseKey: HOUSE, incarnation: 'inc-1' });
    h.receive(frameOf(publicLaneRefusedFollow('Bob', 1), { stream: 'world', position: '5.4' }));
    expect(h.resumeFrom('world')).toBe('5.4');

    db.execute(
      `CREATE TRIGGER no_evidence BEFORE INSERT ON inbound_quarantine
       BEGIN SELECT RAISE(ABORT, 'the evidence write failed'); END`,
    );

    expect(() =>
      h.receive(frameOf(publicLaneRefusedFollow('Carol', 2), { stream: 'world', position: '5.9' })),
    ).toThrow(/evidence write failed/u);
    expect(h.resumeFrom('world')).toBe('5.4');
    expect(quarantined()).toHaveLength(1);
  });

  /**
   * A callback still holding a connection from before the owner logged in
   * again has no standing to move a position the live session is reading —
   * whatever the frame turned out to contain.
   */
  it('does not advance for a session a later login has superseded', () => {
    const w = worldWiring();
    const old = w.login({ houseKey: HOUSE, incarnation: 'inc-1' });
    old.receive(frameOf(publicLaneRefusedFollow('Bob', 1), { stream: 'world', position: '5.4' }));
    endParticipation(db, HOUSE, NOW);
    const fresh = w.login({ houseKey: HOUSE, incarnation: 'inc-1' });
    expect(fresh.source.ownerGeneration).toBe(3);

    old.receive(frameOf(publicLaneRefusedFollow('Carol', 2), { stream: 'world', position: '5.99' }));

    expect(fresh.resumeFrom('world')).toBe('5.4');
    // The bytes are still kept. Evidence is not what the fence is about.
    expect(quarantined()).toHaveLength(2);
    expect(quarantined()[1]).toMatchObject({ position: '5.99', owner_generation: 1 });
  });

  /**
   * And at a house the owner has logged out of. The generation here is still
   * the current number — another process on this data root ended the
   * participation — so `active` is the only thing that can say nobody is
   * here.
   */
  it('does not advance at a house the owner has logged out of', () => {
    const w = worldWiring();
    const h = w.login({ houseKey: HOUSE, incarnation: 'inc-1' });
    h.receive(frameOf(publicLaneRefusedFollow('Bob', 1), { stream: 'world', position: '5.4' }));
    db.execute('UPDATE relation_participation SET active = 0 WHERE house_key = ?', [HOUSE]);

    h.receive(frameOf(publicLaneRefusedFollow('Carol', 2), { stream: 'world', position: '5.9' }));

    expect(h.resumeFrom('world')).toBe('5.4');
    expect(quarantined()).toHaveLength(2);
  });

  /**
   * The transport's own ordering still governs. A refusal is not a licence to
   * write whatever position arrived with it: an older one would skip frames
   * the live session has not seen, and one the house could never issue would
   * break the next reconnect's resume.
   */
  it('never adopts an older position, or one it cannot read', () => {
    const w = worldWiring();
    const h = w.login({ houseKey: HOUSE, incarnation: 'inc-1' });
    h.receive(frameOf(publicLaneRefusedFollow('Bob', 1), { stream: 'world', position: '5.20' }));

    h.receive(frameOf(publicLaneRefusedFollow('Carol', 2), { stream: 'world', position: '5.7' }));
    expect(h.resumeFrom('world')).toBe('5.20');

    // A bare number names no log generation, so it cannot be compared to one.
    h.receive(frameOf(publicLaneRefusedFollow('Dave', 3), { stream: 'world', position: '7' }));
    expect(h.resumeFrom('world')).toBe('5.20');

    // The control: a genuinely later position, on a rebuilt log, does move.
    h.receive(frameOf(publicLaneRefusedFollow('Erin', 4), { stream: 'world', position: '6.1' }));
    expect(h.resumeFrom('world')).toBe('6.1');
  });

  /**
   * The same rule with no row to compare against. The first position a house
   * ever writes used to bypass the comparison entirely, so an unreadable one
   * landed and every later reconnect resumed from debris.
   */
  it('refuses an unreadable position even when there is no cursor yet', () => {
    const w = worldWiring();
    const h = w.login({ houseKey: OTHER, incarnation: 'inc-9' });

    h.receive(frameOf(publicLaneRefusedFollow('Bob', 1, OTHER), { stream: 'world', position: '7' }));

    expect(h.resumeFrom('world')).toBeUndefined();
    expect(quarantined()).toHaveLength(1);
    expect(quarantined()[0]).toMatchObject({ position: '7' });
  });

  /**
   * The refusal must not occupy the identity of the event it refused. The
   * same legitimate original, arriving afterwards on the stream it belongs
   * to, is processed exactly as if the public copy had never come.
   */
  it('does not poison the dedup identity of the original it refused', () => {
    const w = worldWiring();
    const h = w.login({ houseKey: HOUSE, incarnation: 'inc-1' });
    const bytes = publicLaneRefusedFollow('Bob', 1);

    expect(h.receive(frameOf(bytes, { stream: 'world', position: '5.4' })).disposition).toBe(
      'refused',
    );
    expect(db.queryAll('SELECT event_id FROM inbound_frames', [])).toHaveLength(0);

    const later = h.receive(frameOf(bytes, { stream: 'personal', position: '5.5' }));

    expect(later).toEqual({ firstTime: true, disposition: 'accepted' });
    expect(w.drain().map((o) => o.verdict)).toEqual(['applied']);
    expect(h.resumeFrom('personal')).toBe('5.5');
  });

  /**
   * The cheap early refusal is allowed to skip the cryptography; it is not
   * allowed to relabel a failure that was actually found. A publicly
   * legitimate kind whose signature does not verify is reported as a
   * signature failure and quarantined as one — not as a channel refusal, and
   * not swallowed.
   */
  it('reports a signature failure on a publicly legitimate kind as one', () => {
    const w = worldWiring();
    const h = w.login({ houseKey: HOUSE, incarnation: 'inc-1' });

    const r = h.receive(frameOf(unsignedPost('hello world'), { stream: 'world', position: '5.4' }));

    expect(r.disposition).toBe('refused');
    expect(r.reason).toBe('SIGNATURE_INVALID');
    expect(quarantined()[0]).toMatchObject({ reason: 'SIGNATURE_INVALID', position: '5.4' });
  });

  /**
   * `publicLaneRefusedFollow` above reaches its refusal through the
   * `followType: 1` specimen because tags 20/21 were still public-eligible
   * when these evidence-and-position cases were written. Since `.01.6`
   * withdrew relation kinds from the public tag list outright, an ORDINARY
   * follow — the fixture a real client actually produces, not the specimen —
   * now reaches the very same door. That combination had not been exercised
   * against a re-sealed bundle; this proves it, with the full evidence chain
   * the specimen cases above establish, not just the verdict.
   */
  it('refuses an ORDINARY follow on the world lane with full evidence, then applies the same bytes on the personal lane', () => {
    const w = worldWiring();
    const h = w.login({ houseKey: HOUSE, incarnation: 'inc-1' });
    const bytes = follow('Bob', 1);

    const r = h.receive(frameOf(bytes, { stream: 'world', position: '9.3' }));

    expect(r).toEqual({ firstTime: false, disposition: 'refused', reason: 'NOT_PUBLIC' });
    const rows = quarantined();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      claimed_event_id: popclaw.event.EventEnvelope.decode(bytes).eventId ?? '',
      bytes_sha256: cidFromCanonical(bytes),
      house_key: HOUSE,
      incarnation: 'inc-1',
      owner_generation: 1,
      stream: 'world',
      reason: 'NOT_PUBLIC',
      position: '9.3',
    });
    expect(new Uint8Array(rows[0]!.envelope)).toEqual(new Uint8Array(bytes));
    expect(h.resumeFrom('world')).toBe('9.3');

    // Refused before anything here reads as a verified or admitted event.
    expect(db.queryAll('SELECT event_id FROM inbound_frames', [])).toHaveLength(0);
    expect(db.queryAll('SELECT event_id FROM inbound_deliveries', [])).toHaveLength(0);
    expect(db.queryAll('SELECT * FROM relation_edges', [])).toHaveLength(0);

    // The same bytes, arriving where a follow actually belongs, are accepted
    // and applied — the world-lane refusal did not poison this identity.
    const later = h.receive(frameOf(bytes, { stream: 'personal', position: '9.4' }));
    expect(later).toEqual({ firstTime: true, disposition: 'accepted' });
    expect(w.drain().map((o) => o.verdict)).toEqual(['applied']);
    expect(h.resumeFrom('personal')).toBe('9.4');
  });

  /** The same combination for an ordinary unfollow original. */
  it('refuses an ORDINARY unfollow on the world lane with full evidence, then applies the same bytes on the personal lane', () => {
    const w = worldWiring();
    const h = w.login({ houseKey: HOUSE, incarnation: 'inc-1' });
    const bytes = follow('Bob', 1, HOUSE, true);

    const r = h.receive(frameOf(bytes, { stream: 'world', position: '9.5' }));

    expect(r).toEqual({ firstTime: false, disposition: 'refused', reason: 'NOT_PUBLIC' });
    const rows = quarantined();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      claimed_event_id: popclaw.event.EventEnvelope.decode(bytes).eventId ?? '',
      bytes_sha256: cidFromCanonical(bytes),
      house_key: HOUSE,
      incarnation: 'inc-1',
      owner_generation: 1,
      stream: 'world',
      reason: 'NOT_PUBLIC',
      position: '9.5',
    });
    expect(h.resumeFrom('world')).toBe('9.5');
    expect(db.queryAll('SELECT event_id FROM inbound_frames', [])).toHaveLength(0);
    expect(db.queryAll('SELECT * FROM relation_edges', [])).toHaveLength(0);

    const later = h.receive(frameOf(bytes, { stream: 'personal', position: '9.6' }));
    expect(later).toEqual({ firstTime: true, disposition: 'accepted' });
    expect(w.drain().map((o) => o.verdict)).toEqual(['applied']);
    expect(h.resumeFrom('personal')).toBe('9.6');
  });
});
