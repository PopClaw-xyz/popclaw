import { describe, expect, it } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InMemoryHostDb } from '../../../src/host/in-memory-host-db.js';
import { runMigrations } from '../../../src/host/migrations.js';
import { BondsStore } from '../../../src/bonds/bonds-store.js';
import { ProposalsStore } from '../../../src/bonds/proposals-store.js';
import { runPopclawReviewCommand } from '../../../src/commands/popclaw-review.js';
// D8: assert through the same renderer the command uses, never a literal.
import { tierLabel } from '../../../src/bonds/bond-tier.js';
import { renderCopy } from '../../../src/lexicon/index.js';
import { ownerLang } from '../../../src/lexicon/owner-language.js';

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../migrations');

function fresh() {
  const db = new InMemoryHostDb();
  runMigrations(db, MIGRATIONS_DIR);
  const bondsStore = new BondsStore(db, () => 1000);
  const proposalsStore = new ProposalsStore(db, () => 1000);
  return { bondsStore, proposalsStore };
}
const deps = (b: BondsStore, p: ProposalsStore) => ({ bondsStore: b, proposalsStore: p });

describe('runPopclawReviewCommand — render', () => {
  it('no args → renders card and marks shown dynamics reported', async () => {
    const { bondsStore, proposalsStore } = fresh();
    bondsStore.setTier('A', 'close', 'manual');
    bondsStore.addDynamic('A', { ts: 100, summary: '发了新文章', isMilestone: false });
    const out = await runPopclawReviewCommand({ positional: [] }, deps(bondsStore, proposalsStore));
    expect(out.text).toContain('发了新文章');
    // second call → already reported → gone
    const out2 = await runPopclawReviewCommand({ positional: [] }, deps(bondsStore, proposalsStore));
    expect(out2.text).toContain(renderCopy(ownerLang(), 'review.card.noUpdates'));
  });
});

describe('runPopclawReviewCommand — decide', () => {
  it('"1 1" accepts proposal #1 → applies tier change', async () => {
    const { bondsStore, proposalsStore } = fresh();
    bondsStore.setTier('A', 'friend', 'manual');
    proposalsStore.add({ popclawId: 'A', fromTier: 'friend', toTier: 'close', rationale: 'x' });
    const out = await runPopclawReviewCommand({ positional: ['1', '1'] }, deps(bondsStore, proposalsStore));
    expect(out.text).toContain(tierLabel('close', ownerLang()));
    expect(bondsStore.get('A')!.tier).toBe('close');
    expect(proposalsStore.listPending()).toHaveLength(0);
  });

  it('"1 2" rejects → tier unchanged, proposal resolved', async () => {
    const { bondsStore, proposalsStore } = fresh();
    bondsStore.setTier('A', 'friend', 'manual');
    proposalsStore.add({ popclawId: 'A', fromTier: 'friend', toTier: 'close', rationale: 'x' });
    const out = await runPopclawReviewCommand({ positional: ['1', '2'] }, deps(bondsStore, proposalsStore));
    expect(bondsStore.get('A')!.tier).toBe('friend');
    expect(proposalsStore.listPending()).toHaveLength(0);
    expect(out.text).toBe(renderCopy(ownerLang(), 'bond.proposal.rejected', { tier: tierLabel('friend', ownerLang()) }));
  });

  it('"1 3" defers → resolved, not pending', async () => {
    const { bondsStore, proposalsStore } = fresh();
    bondsStore.setTier('A', 'friend', 'manual');
    proposalsStore.add({ popclawId: 'A', fromTier: 'friend', toTier: 'close', rationale: 'x' });
    await runPopclawReviewCommand({ positional: ['1', '3'] }, deps(bondsStore, proposalsStore));
    expect(proposalsStore.listPending()).toHaveLength(0);
    expect(proposalsStore.lastFor('A', 'close')!.status).toBe('deferred');
  });

  it('bad index → friendly error, nothing changes', async () => {
    const { bondsStore, proposalsStore } = fresh();
    const out = await runPopclawReviewCommand({ positional: ['9', '1'] }, deps(bondsStore, proposalsStore));
    expect(out.text).toBe(renderCopy(ownerLang(), 'review.noSuchProposal', { n: '9', pending: '0' }));
  });
});
