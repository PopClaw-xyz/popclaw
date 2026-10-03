/**
 * Builds an LLMClient for the popclaw recommend cycle.
 *
 * Lookup order:
 *   1. the llm config file (PopclawPaths.configFile('llm')) exists + valid → direct provider client.
 *   2. file missing → caller's fallback (OpenClaw plugin runtime adapter).
 *   3. file present but malformed → throw (do not silently fall back; the
 *      operator wrote a config file with intent and a typo would otherwise
 *      be invisible).
 *
 * See `docs/popclaw-direct-llm.md`.
 */

import { loadLLMConfig } from './llm-config.js';
import { OllamaCloudClient, type LLMClient } from './llm-client.js';

export interface LLMFactoryDeps {
  /** Path to the llm config file (PopclawPaths.configFile('llm')). */
  readonly llmConfigPath: string;
  /** Lazily-constructed OpenClaw plugin-runtime adapter; called only when no llm.json. */
  readonly fallback: () => LLMClient;
}

export function buildLLMClient(deps: LLMFactoryDeps): LLMClient {
  const cfg = loadLLMConfig(deps.llmConfigPath);
  if (!cfg) return deps.fallback();
  switch (cfg.provider) {
    case 'ollama-cloud':
      return new OllamaCloudClient({ apiKey: cfg.apiKey, model: cfg.model });
    default: {
      // Defensive: loadLLMConfig already validates provider, but TS narrows the
      // discriminator and a future provider added to the schema without a
      // matching case here would otherwise compile silently.
      const exhaustive: never = cfg.provider;
      throw new Error(`unhandled llm.json provider: ${String(exhaustive)}`);
    }
  }
}
