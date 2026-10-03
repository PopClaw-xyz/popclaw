import { describe, it, expect } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InMemoryHostDb } from '../../../src/host/in-memory-host-db.js';
import { runMigrations } from '../../../src/host/migrations.js';
import { DutyLease } from '../../../src/runtime/duty-lease.js';

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../migrations');

/**
 * 值班牌的合同：一个 data root 下同时活着的多个 popclaw 进程里，恰好一个去干
 * 后台活。这里用共享一个库的多个 DutyLease 实例扮演多个进程。
 *
 * 刻意跑真迁移而不是手写 DDL —— 顺带证明 020-duty-lease.sql 本身能落地。
 */
function freshDb(): InMemoryHostDb {
  const db = new InMemoryHostDb();
  runMigrations(db, MIGRATIONS_DIR);
  return db;
}

const TTL = 30_000;

describe('DutyLease', () => {
  it('exactly one of three concurrent processes takes duty', () => {
    const db = freshDb();
    const clock = () => 1_000_000;
    const leases = ['a', 'b', 'c'].map((t) => new DutyLease(db, t, TTL, clock));

    const winners = leases.filter((l) => l.tryAcquire());

    expect(winners).toHaveLength(1);
  });

  it('the holder keeps renewing; others stay off duty', () => {
    const db = freshDb();
    let t = 1_000_000;
    const clock = () => t;
    const holder = new DutyLease(db, 'holder', TTL, clock);
    const other = new DutyLease(db, 'other', TTL, clock);

    expect(holder.tryAcquire()).toBe(true);
    for (let i = 0; i < 5; i++) {
      t += TTL / 3;
      expect(holder.tryAcquire()).toBe(true); // renewal
      expect(other.tryAcquire()).toBe(false); // still someone else's shift
    }
  });

  it('a crashed holder is taken over once the lease expires', () => {
    const db = freshDb();
    let t = 1_000_000;
    const clock = () => t;
    const crashed = new DutyLease(db, 'crashed', TTL, clock);
    const survivor = new DutyLease(db, 'survivor', TTL, clock);

    expect(crashed.tryAcquire()).toBe(true);
    // crashed stops renewing (no release — that is what a crash looks like)
    t += TTL / 2;
    expect(survivor.tryAcquire()).toBe(false); // not expired yet: no double duty
    t += TTL; // now past TTL
    expect(survivor.tryAcquire()).toBe(true);
  });

  it('release hands the badge over immediately, no TTL wait', () => {
    const db = freshDb();
    const clock = () => 1_000_000;
    const first = new DutyLease(db, 'first', TTL, clock);
    const second = new DutyLease(db, 'second', TTL, clock);

    expect(first.tryAcquire()).toBe(true);
    expect(second.tryAcquire()).toBe(false);
    first.release();
    expect(second.tryAcquire()).toBe(true); // same instant, no expiry needed
  });

  it('release by a non-holder cannot steal the badge', () => {
    const db = freshDb();
    const clock = () => 1_000_000;
    const holder = new DutyLease(db, 'holder', TTL, clock);
    const bystander = new DutyLease(db, 'bystander', TTL, clock);

    expect(holder.tryAcquire()).toBe(true);
    bystander.tryAcquire(); // fails, holds nothing
    bystander.release(); // must be a no-op, not a DELETE of someone else's row
    expect(holder.tryAcquire()).toBe(true); // holder still on duty
  });
});
