/**
 * Loads + validates the popclaw llm config file (PopclawPaths.configFile('llm')).
 * Returns null if the file is missing (caller falls back to OpenClaw runtime).
 * Throws with a specific message on any other failure mode.
 *
 * See `docs/popclaw-direct-llm.md` for schema.
 */

import { readFileSync, existsSync } from 'node:fs';

export type SupportedProvider = 'ollama-cloud';

const SUPPORTED_PROVIDERS = new Set<string>(['ollama-cloud']);

export interface LLMConfig {
  readonly schemaVersion: 1;
  readonly provider: SupportedProvider;
  readonly model: string;
  readonly apiKey: string;
}

export function loadLLMConfig(llmConfigPath: string): LLMConfig | null {
  if (!existsSync(llmConfigPath)) return null;

  const raw = readFileSync(llmConfigPath, 'utf-8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(
      `popclaw llm.json: malformed JSON — ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('popclaw llm.json: top-level value must be an object');
  }
  const obj = parsed as Record<string, unknown>;

  if (obj.schemaVersion !== 1) {
    throw new Error(
      `popclaw llm.json: schemaVersion must be 1, got ${JSON.stringify(obj.schemaVersion)}`,
    );
  }
  if (typeof obj.provider !== 'string' || !SUPPORTED_PROVIDERS.has(obj.provider)) {
    throw new Error(
      `popclaw llm.json: provider must be one of [${[...SUPPORTED_PROVIDERS].join(', ')}], got ${JSON.stringify(obj.provider)}`,
    );
  }
  if (typeof obj.model !== 'string' || obj.model.trim() === '') {
    throw new Error('popclaw llm.json: model must be a non-empty string');
  }
  if (typeof obj.apiKey !== 'string' || obj.apiKey.trim() === '') {
    throw new Error('popclaw llm.json: apiKey must be a non-empty string');
  }

  return {
    schemaVersion: 1,
    provider: obj.provider as SupportedProvider,
    model: obj.model,
    apiKey: obj.apiKey,
  };
}
