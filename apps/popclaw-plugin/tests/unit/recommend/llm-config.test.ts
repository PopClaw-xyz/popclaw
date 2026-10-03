import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadLLMConfig } from '../../../src/recommend/llm-config';

describe('loadLLMConfig', () => {
  let dataRoot: string;
  let llmPath: string;

  beforeEach(() => {
    dataRoot = mkdtempSync(join(tmpdir(), 'popclaw-llm-cfg-'));
    mkdirSync(join(dataRoot, 'config'), { recursive: true });
    llmPath = join(dataRoot, 'config', 'llm.json');
  });

  afterEach(() => {
    rmSync(dataRoot, { recursive: true, force: true });
  });

  function writeConfig(json: unknown): void {
    writeFileSync(llmPath, JSON.stringify(json), 'utf-8');
  }

  it('returns null when llm.json is missing (caller falls back)', () => {
    expect(loadLLMConfig(llmPath)).toBeNull();
  });

  it('parses a valid ollama-cloud config', () => {
    writeConfig({
      schemaVersion: 1,
      provider: 'ollama-cloud',
      model: 'glm-5.1:cloud',
      apiKey: 'sk-xxx',
    });
    const cfg = loadLLMConfig(llmPath);
    expect(cfg).toEqual({
      schemaVersion: 1,
      provider: 'ollama-cloud',
      model: 'glm-5.1:cloud',
      apiKey: 'sk-xxx',
    });
  });

  it('throws on malformed JSON', () => {
    writeFileSync(llmPath, '{not json', 'utf-8');
    expect(() => loadLLMConfig(llmPath)).toThrow(/llm\.json/);
  });

  it('throws on wrong schemaVersion', () => {
    writeConfig({
      schemaVersion: 2,
      provider: 'ollama-cloud',
      model: 'glm-5.1:cloud',
      apiKey: 'k',
    });
    expect(() => loadLLMConfig(llmPath)).toThrow(/schemaVersion/);
  });

  it('throws on unsupported provider', () => {
    writeConfig({
      schemaVersion: 1,
      provider: 'made-up',
      model: 'm',
      apiKey: 'k',
    });
    expect(() => loadLLMConfig(llmPath)).toThrow(/provider/);
  });

  it('throws when apiKey is empty (catch a common config mistake)', () => {
    writeConfig({
      schemaVersion: 1,
      provider: 'ollama-cloud',
      model: 'glm-5.1:cloud',
      apiKey: '',
    });
    expect(() => loadLLMConfig(llmPath)).toThrow(/apiKey/);
  });

  it('throws when model is empty', () => {
    writeConfig({
      schemaVersion: 1,
      provider: 'ollama-cloud',
      model: '',
      apiKey: 'k',
    });
    expect(() => loadLLMConfig(llmPath)).toThrow(/model/);
  });
});
