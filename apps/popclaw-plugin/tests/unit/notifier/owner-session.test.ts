import { describe, it, expect } from 'vitest';
import { OwnerSession } from '../../../src/notifier/owner-session.js';

describe('OwnerSession', () => {
  it('returns undefined before any capture', () => {
    expect(new OwnerSession().get()).toBeUndefined();
  });
  it('returns the last captured sessionKey', () => {
    const s = new OwnerSession();
    s.set('sess-a');
    s.set('sess-b');
    expect(s.get()?.sessionKey).toBe('sess-b');
  });
  it('ignores undefined captures (keeps the last known target)', () => {
    const s = new OwnerSession();
    s.set('sess-a');
    s.set(undefined);
    expect(s.get()?.sessionKey).toBe('sess-a');
  });
  it('captures the delivery context (channel/to/...) alongside the sessionKey', () => {
    const s = new OwnerSession();
    s.set('sess-a', { channel: 'whatsapp', to: '+123', accountId: 'acct', threadId: 7 });
    expect(s.get()).toEqual({
      sessionKey: 'sess-a',
      deliveryContext: { channel: 'whatsapp', to: '+123', accountId: 'acct', threadId: 7 },
    });
  });
  it('a later capture without a delivery context replaces the earlier one (last wins)', () => {
    const s = new OwnerSession();
    s.set('sess-a', { channel: 'whatsapp', to: '+123' });
    s.set('sess-b');
    expect(s.get()).toEqual({ sessionKey: 'sess-b', deliveryContext: undefined });
  });
});
