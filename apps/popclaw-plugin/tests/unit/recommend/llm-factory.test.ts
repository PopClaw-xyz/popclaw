import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildLLMClient } from '../../../src/recommend/llm-factory';
import { OllamaCloudClient } from '../../../src/recommend/llm-client';
import type { LLMClient } from '../../../src/recommend/llm-client';

describe('buildLLMClient', () => {
  let dataRoot: string;
  let llmConfigPath: string;

  beforeEach(() => {
    dataRoot = mkdtempSync(join(tmpdir(), 'popclaw-llm-fact-'));
    mkdirSync(join(dataRoot, 'config'), { recursive: true });
    llmConfigPath = join(dataRoot, 'config', 'llm.json');
  });

  afterEach(() => {
    rmSync(dataRoot, { recursive: true, force: true });
  });

  function writeConfig(json: unknown): void {
    writeFileSync(llmConfigPath, JSON.stringify(json), 'utf-8');
  }

  it('returns OllamaCloudClient when llm.json declares ollama-cloud', () => {
    writeConfig({
      schemaVersion: 1,
      provider: 'ollama-cloud',
      model: 'glm-5.1:cloud',
      apiKey: 'sk-x',
    });
    const fallback = vi.fn();
    const client = buildLLMClient({ llmConfigPath, fallback });
    expect(client).toBeInstanceOf(OllamaCloudClient);
    expect(fallback).not.toHaveBeenCalled();
  });

  it('calls fallback when llm.json is missing', () => {
    const stub: LLMClient = { complete: vi.fn().mockResolvedValue('') };
    const fallback = vi.fn().mockReturnValue(stub);
    const client = buildLLMClient({ llmConfigPath, fallback });
    expect(fallback).toHaveBeenCalledTimes(1);
    expect(client).toBe(stub);
  });

  it('does not silently swallow malformed llm.json (propagates loader error)', () => {
    writeFileSync(llmConfigPath, '{not json', 'utf-8');
    const fallback = vi.fn();
    expect(() => buildLLMClient({ llmConfigPath, fallback })).toThrow(/llm\.json/);
    expect(fallback).not.toHaveBeenCalled();
  });
});
