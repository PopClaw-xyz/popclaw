/** Real host → real snapshot recovery, with the final page held across a state change. */
import { afterEach, describe, expect, it } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InMemoryHostDb } from '../../../src/host/in-memory-host-db.js';
import { runMigrations } from '../../../src/host/migrations.js';
import { openRelationAwareInbox } from '../../../src/social-graph/relation-host.js';
import { establishHouseTrust } from '../../../src/world/house-trust.js';
import { mintHouse } from '../../helpers/signed-manifest.js';
import { grantingReadAuthorityFor } from '../../helpers/read-authority.js';

const MIGRATIONS = resolve(dirname(fileURLToPath(import.meta.url)), '../../../migrations');
const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); });
const settle = async () => { for (let i = 0; i < 4; i++) await new Promise<void>((done) => setImmediate(done)); };

describe('relation host snapshot authority capture', () => {
  it.each(['unchanged', 'generation', 'pin-key', 'pin-incarnation', 'pin-block', 'newer-gap', 'stop'] as const)(
    'completes only with the captured authority after %s', async (change) => {
      const db = new InMemoryHostDb(); runMigrations(db, MIGRATIONS);
      const house = mintHouse({ origin: 'https://capture.test', manifest: { relations: { ordered: 1 } } });
      const trace: string[] = [];
      let release!: (response: Response) => void;
      const pending = new Promise<Response>((done) => { release = done; });
      const host = await openRelationAwareInbox({
        db, recipientPopclawId: 'owner', signer: {} as never, now: () => 100,
        readAuthorityFor: grantingReadAuthorityFor, onMessage: () => {},
        fetch: (async (input) => {
          if (String(input).includes('/v1/relation-snapshot')) {
            trace.push('snapshot:requested'); return pending;
          }
          return house.fetch(input);
        }) as typeof globalThis.fetch,
        log: { info: (line) => trace.push(line), warn: (line) => trace.push(line) },
        autostart: false, drainIntervalMs: 600_000,
      }, []);
      cleanup.push(() => { host.stop(); db.close(); });
      const trusted = await establishHouseTrust(db, house.origin, { fetch: house.fetch as typeof globalThis.fetch });
      expect(trusted.ok).toBe(true);
      host.wiring.login({ houseKey: house.houseKey, incarnation: house.incarnation, houseSlug: 'capture' });
      expect(await host.attach(house.origin, 'capture')).toEqual({ ok: true });
      const original = host.handleFor('capture')!;
      const reset = { reason: 'retention', logGeneration: '2', floor: '7', reconcile: 'snapshot' };
      host.reception.onCursorReset('capture', reset, 1);
      host.start(); await settle();
      expect(trace).toContain('snapshot:requested');
      if (change === 'generation') {
        host.wiring.login({ houseKey: house.houseKey, incarnation: house.incarnation, houseSlug: 'capture' });
        await host.attach(house.origin, 'capture');
        expect(host.handleFor('capture')).not.toBe(original);
      }
      if (change === 'pin-key') db.execute("UPDATE house_binding_pin SET house_key = 'replacement'");
      if (change === 'pin-incarnation') db.execute("UPDATE house_binding_pin SET incarnation = 'replacement'");
      if (change === 'pin-block') db.execute("UPDATE house_binding_pin SET blocked_reason = 'changed'");
      if (change === 'newer-gap') host.reception.onCursorReset('capture', { ...reset, logGeneration: '3' }, 1);
      if (change === 'stop') host.stop();
      release(new Response(JSON.stringify({
        checkpoint_id: 'checkpoint', log_generation: '2', floor: '7', watermark: '20',
        entries: [], complete: true,
      }), { status: 200 }));
      await settle();
      const gaps = db.queryAll('SELECT * FROM relation_stream_gaps');
      expect(gaps).toHaveLength(change === 'unchanged' ? 0 : 1);
      expect(host.reception.resumePosition('capture')).toBe(change === 'unchanged' ? '2.20' : undefined);
      expect({
        trace, gaps, resume: host.reception.resumePosition('capture') ?? null,
        capturedGeneration: original.source.ownerGeneration,
        currentGeneration: host.handleFor('capture')!.source.ownerGeneration,
      }).toMatchSnapshot();
    },
  );
});
