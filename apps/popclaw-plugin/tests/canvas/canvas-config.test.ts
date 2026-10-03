import { describe, it, expect, afterEach } from 'vitest';
import { canvasSigningBytes } from '../../src/canvas/canvas-signing.js';
import {
  readCanvasBaseUrlEnv,
  FALLBACK_CANVAS_BASE_URL,
  resolveCanvasBaseUrl,
} from '../../src/canvas/canvas-fallback.js';

describe('canvas signing bytes', () => {
  it('leads with its own domain tag, then title\\0html (must match @popclaw/canvas)', () => {
    // The tag is why this is not `[97, 0, 98]` any more. Without it the first
    // field was the title, and `canvasSigningBytes('intents-pull', …)`
    // produced the same bytes as a follow-intent pull signature — one
    // signature satisfying both checks, so a credential minted to READ an
    // owner's intents also authorised PUBLISHING as them.
    const tag = [...new TextEncoder().encode('canvas-upload')];
    expect([...canvasSigningBytes('a', 'b')]).toEqual([...tag, 0, 97, 0, 98]);
  });
});

describe('canvas base url', () => {
  afterEach(() => {
    delete process.env.POPCLAW_CANVAS_BASE_URL;
  });
  it('reads the env var when set', () => {
    process.env.POPCLAW_CANVAS_BASE_URL = 'http://host:9';
    expect(readCanvasBaseUrlEnv()).toBe('http://host:9');
  });

  /**
   * Tri-state on purpose: "never mentioned" and "mentioned, deliberately
   * empty" are different answers, and only the second one means "no
   * publisher". Collapsing them to one `null` is what made an explicit
   * `POPCLAW_CANVAS_BASE_URL=` fall through to the public default.
   */
  it('returns undefined when the var is absent', () => {
    expect(readCanvasBaseUrlEnv()).toBeUndefined();
  });

  it('returns the empty string when the var is set but empty or blank — that is an owner saying "off"', () => {
    process.env.POPCLAW_CANVAS_BASE_URL = '';
    expect(readCanvasBaseUrlEnv()).toBe('');
    process.env.POPCLAW_CANVAS_BASE_URL = '  ';
    expect(readCanvasBaseUrlEnv()).toBe('');
  });

  it('defaults to the public canvas host — zero-config owners must get a link that opens on a phone', () => {
    expect(FALLBACK_CANVAS_BASE_URL).toBe('https://canvas.popclaw.me');
  });

  it('keeps the default on https — a capability token must never ride plaintext', () => {
    expect(FALLBACK_CANVAS_BASE_URL.startsWith('https://')).toBe(true);
  });
});

describe('resolveCanvasBaseUrl (config → env → fallback, with an explicit off)', () => {
  afterEach(() => {
    delete process.env.POPCLAW_CANVAS_BASE_URL;
  });

  it('prefers the plugin-config value — the authoritative home, decoupled from host env', () => {
    process.env.POPCLAW_CANVAS_BASE_URL = 'http://env:9';
    expect(resolveCanvasBaseUrl('http://192.0.2.6:8788')).toBe('http://192.0.2.6:8788');
  });

  it('falls back to the env var when config is absent (back-compat)', () => {
    process.env.POPCLAW_CANVAS_BASE_URL = 'http://env:9';
    expect(resolveCanvasBaseUrl(undefined)).toBe('http://env:9');
  });

  it('falls back to the public default when neither config nor env is set', () => {
    expect(resolveCanvasBaseUrl(undefined)).toBe(FALLBACK_CANVAS_BASE_URL);
  });

  it('normalizes by stripping a trailing slash', () => {
    expect(resolveCanvasBaseUrl('http://192.0.2.6:8788/')).toBe('http://192.0.2.6:8788');
  });

  // -- the explicit off ----------------------------------------------------

  it('an empty config value means NO PUBLISHER, and outranks the env var', () => {
    process.env.POPCLAW_CANVAS_BASE_URL = 'http://env:9';
    expect(resolveCanvasBaseUrl('')).toBeNull();
  });

  it('a blank config value is still the owner having answered — off, not absent', () => {
    expect(resolveCanvasBaseUrl('   ')).toBeNull();
  });

  it('an empty env var means NO PUBLISHER (it no longer falls through to the default)', () => {
    process.env.POPCLAW_CANVAS_BASE_URL = '';
    expect(resolveCanvasBaseUrl(undefined)).toBeNull();
  });

  it('a config URL still wins over an empty env var', () => {
    process.env.POPCLAW_CANVAS_BASE_URL = '';
    expect(resolveCanvasBaseUrl('http://192.0.2.6:8788')).toBe('http://192.0.2.6:8788');
  });

  it('a null config value is "not configured", not "off" — it falls through like undefined', () => {
    expect(resolveCanvasBaseUrl(null)).toBe(FALLBACK_CANVAS_BASE_URL);
  });
});
