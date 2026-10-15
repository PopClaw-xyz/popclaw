import { expect, it } from 'vitest';
import { resolveNewspaperWindow } from '../../../src/newspaper/window.js';
const now = Date.parse('2026-10-15T01:00:00Z') / 1000;
it('resolves the default and explicit rolling windows in epoch seconds', () => {
  expect(resolveNewspaperWindow({}, now, 'UTC')).toEqual({since:now-72*3600,hours:72,today:false,windowLabel:'in the last 72 hours'});
  for (const hours of [1,24,168]) expect(resolveNewspaperWindow({hours},now,'UTC').since).toBe(now-hours*3600);
});
it('resolves today in the owner timezone and honours DST', () => {
  expect(resolveNewspaperWindow({today:true},now,'Asia/Shanghai').since).toBe(Date.parse('2026-10-14T16:00:00Z')/1000);
  expect(resolveNewspaperWindow({today:true},Date.parse('2026-03-08T20:00:00Z')/1000,'America/New_York').since).toBe(Date.parse('2026-03-08T05:00:00Z')/1000);
});
it('rejects conflicting or malformed supplied windows rather than silently regathering another window', () => {
  expect(() => resolveNewspaperWindow({today:true,hours:24},now)).toThrow('NEWSPAPER_WINDOW_CONFLICT');
  for (const hours of [0,169,1.5,NaN]) expect(() => resolveNewspaperWindow({hours},now)).toThrow('NEWSPAPER_WINDOW_INVALID');
  expect(() => resolveNewspaperWindow({today:'yes' as unknown as boolean},now)).toThrow('NEWSPAPER_WINDOW_INVALID');
});


it('clamps a rolling cutoff to the epoch when the lookback predates it', () => {
  expect(resolveNewspaperWindow({hours:24},200,'UTC')).toMatchObject({since:0,hours:24});
});


it('clamps an owner-local midnight before the epoch to zero', () => {
  expect(resolveNewspaperWindow({today:true},200,'Asia/Shanghai')).toMatchObject({since:0,today:true,windowLabel:'today'});
});
