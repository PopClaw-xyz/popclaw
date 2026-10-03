import { describe, it, expect, afterEach } from 'vitest';
import {
  FALLBACK_WEB_BASE_URL,
  normalizeWebBaseUrl,
  readWebBaseUrlEnv,
  resolveWebBaseUrl,
  readableUrl,
} from '../../../../src/lshow/sources/web-fallback';

describe('readableUrl ASCII safety boundary', () => {
  it('keeps every control and link delimiter escaped, but decodes safe ASCII', () => {
    const delimiters = new Set(Array.from('"#%<>?[]\\^`{|}/'));
    for (let code = 0; code < 128; code++) {
      const character = String.fromCharCode(code);
      const encoded = `%${code.toString(16).padStart(2, '0').toUpperCase()}`;
      const unsafe = code <= 0x20 || code === 0x7f || delimiters.has(character);
      expect(readableUrl(encoded), `ASCII ${code}`).toBe(unsafe ? encodeURIComponent(character) : character);
    }
  });
});

describe('readWebBaseUrlEnv (POPCLAW_WEB_BASE_URL)', () => {
  const original = process.env.POPCLAW_WEB_BASE_URL;
  afterEach(() => {
    if (original === undefined) delete process.env.POPCLAW_WEB_BASE_URL;
    else process.env.POPCLAW_WEB_BASE_URL = original;
  });

  it('returns null when unset', () => {
    delete process.env.POPCLAW_WEB_BASE_URL;
    expect(readWebBaseUrlEnv()).toBeNull();
  });

  it('returns null for whitespace-only', () => {
    process.env.POPCLAW_WEB_BASE_URL = '   ';
    expect(readWebBaseUrlEnv()).toBeNull();
  });

  it('returns trimmed value when set', () => {
    process.env.POPCLAW_WEB_BASE_URL = '  https://popclaw.me ';
    expect(readWebBaseUrlEnv()).toBe('https://popclaw.me');
  });
});

describe('normalizeWebBaseUrl', () => {
  it('strips a single trailing slash', () => {
    expect(normalizeWebBaseUrl('http://localhost:3000/')).toBe('http://localhost:3000');
  });
  it('leaves a slashless url untouched', () => {
    expect(normalizeWebBaseUrl('https://popclaw.me')).toBe('https://popclaw.me');
  });
});

describe('FALLBACK_WEB_BASE_URL', () => {
  it('is the live popclaw.me web app', () => {
    expect(FALLBACK_WEB_BASE_URL).toBe('https://popclaw.me');
  });
});

describe('resolveWebBaseUrl (config → env → https://popclaw.me)', () => {
  const original = process.env.POPCLAW_WEB_BASE_URL;
  afterEach(() => {
    if (original === undefined) delete process.env.POPCLAW_WEB_BASE_URL;
    else process.env.POPCLAW_WEB_BASE_URL = original;
  });

  it('prefers the plugin-config value — authoritative home, not the client env', () => {
    process.env.POPCLAW_WEB_BASE_URL = 'http://env:9';
    expect(resolveWebBaseUrl('http://config:9')).toBe('http://config:9');
  });

  it('falls back to env when config is absent (back-compat)', () => {
    process.env.POPCLAW_WEB_BASE_URL = 'http://env:9';
    expect(resolveWebBaseUrl(undefined)).toBe('http://env:9');
  });

  it('falls back to https://popclaw.me when neither config nor env is set', () => {
    delete process.env.POPCLAW_WEB_BASE_URL;
    expect(resolveWebBaseUrl(undefined)).toBe('https://popclaw.me');
  });

  it('treats a blank config value as absent', () => {
    delete process.env.POPCLAW_WEB_BASE_URL;
    expect(resolveWebBaseUrl('   ')).toBe('https://popclaw.me');
  });

  it('normalizes by stripping a trailing slash', () => {
    delete process.env.POPCLAW_WEB_BASE_URL;
    process.env.POPCLAW_WEB_BASE_URL = 'https://popclaw.me/';
    expect(resolveWebBaseUrl(undefined)).toBe('https://popclaw.me');
  });
});
