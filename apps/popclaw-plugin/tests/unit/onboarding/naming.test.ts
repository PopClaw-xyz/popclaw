import { describe, it, expect, vi } from 'vitest';
import { suggestNames, buildNamingPrompt } from '../../../src/onboarding/naming.js';
import type { LLMClientLike, NamingMaterials } from '../../../src/onboarding/naming.js';
import { setOwnerLang } from '../../../src/lexicon/owner-language.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFakeLLM(response: string): LLMClientLike {
  return { complete: vi.fn().mockResolvedValue(response) };
}

function makeMaterials(overrides: Partial<NamingMaterials> = {}): NamingMaterials {
  return { verifiedHandles: [], ...overrides };
}

// ---------------------------------------------------------------------------
// suggestNames
// ---------------------------------------------------------------------------

describe('suggestNames — happy path', () => {
  it('parses clean JSON and returns ≤3 candidates', async () => {
    const llm = makeFakeLLM('{"names":["江湖浪人","山海客","风尘侠"]}');
    const result = await suggestNames(llm, makeMaterials());
    expect(result.length).toBeGreaterThan(0);
    expect(result).toHaveLength(3);
    expect(result).toContain('江湖浪人');
  });

  it('returns at most 3 candidates even when LLM provides more', async () => {
    const llm = makeFakeLLM('{"names":["a","b","c","d","e"]}');
    const result = await suggestNames(llm, makeMaterials());
    expect(result.length).toBeGreaterThan(0);
    expect(result.length).toBeLessThanOrEqual(3);
  });

  // M3: schema has no .max(5) — 6 candidates from LLM should slice to 3, not reject whole array
  it('accepts 6 names from LLM and returns first 3 non-placeholder, fallback:false', async () => {
    const llm = makeFakeLLM('{"names":["风云客","山海侠","夜行者","江湖浪","星辰客","烟雨侠"]}');
    const result = await suggestNames(llm, makeMaterials());
    expect(result.length).toBeGreaterThan(0);
    expect(result).toHaveLength(3);
    expect(result[0]).toBe('风云客');
    expect(result[1]).toBe('山海侠');
    expect(result[2]).toBe('夜行者');
  });

  it('strips markdown ```json fence and parses successfully', async () => {
    const llm = makeFakeLLM('```json\n{"names":["侠客行","风云客","山中人"]}\n```');
    const result = await suggestNames(llm, makeMaterials());
    expect(result.length).toBeGreaterThan(0);
    expect(result).toHaveLength(3);
  });

  it('strips markdown ``` fence (no language tag) and parses successfully', async () => {
    const llm = makeFakeLLM('```\n{"names":["独行侠"]}\n```');
    const result = await suggestNames(llm, makeMaterials());
    expect(result.length).toBeGreaterThan(0);
    expect(result).toContain('独行侠');
  });

  it('handles leading/trailing prose around the JSON object', async () => {
    const llm = makeFakeLLM('好的，这是三个名号建议：\n{"names":["风云客","山海旅人","夜行者"]}\n希望您喜欢！');
    const result = await suggestNames(llm, makeMaterials());
    expect(result.length).toBeGreaterThan(0);
    expect(result.length).toBeGreaterThan(0);
  });
});

describe('suggestNames — error / fallback paths', () => {
  it('returns fallback:true and empty candidates when LLM throws', async () => {
    const llm: LLMClientLike = { complete: vi.fn().mockRejectedValue(new Error('network error')) };
    const result = await suggestNames(llm, makeMaterials());
    expect(result).toHaveLength(0);
  });

  it('returns fallback:true and empty candidates when llm is null', async () => {
    const result = await suggestNames(null, makeMaterials());
    expect(result).toHaveLength(0);
  });

  it('returns fallback:true when LLM returns invalid JSON', async () => {
    const llm = makeFakeLLM('这不是 JSON');
    const result = await suggestNames(llm, makeMaterials());
    expect(result).toHaveLength(0);
  });

  it('returns fallback:true when all candidates are filtered out', async () => {
    // All names are placeholder form (base58 chars) → filtered → fallback
    const llm = makeFakeLLM('{"names":["ranger-7gXkQz","ranger-AbCdEf","ranger-a1b2c3"]}');
    const result = await suggestNames(llm, makeMaterials());
    expect(result).toHaveLength(0);
  });
});

describe('suggestNames — candidate filtering', () => {
  it('filters out placeholder ranger-<6 base58> names (real form)', async () => {
    // C1: real popclaw_id placeholders use base58 chars (e.g. 7gXkQz), not just hex
    const llm = makeFakeLLM('{"names":["ranger-7gXkQz","合法名号","ranger-AbCdEf"]}');
    const result = await suggestNames(llm, makeMaterials());
    expect(result).not.toContain('ranger-7gXkQz');
    expect(result).not.toContain('ranger-AbCdEf');
    expect(result).toContain('合法名号');
  });

  it('filters out placeholder ranger-<6hex subset> names (hex is valid base58)', async () => {
    const llm = makeFakeLLM('{"names":["ranger-abc123","合法名号","ranger-def456"]}');
    const result = await suggestNames(llm, makeMaterials());
    expect(result).not.toContain('ranger-abc123');
    expect(result).not.toContain('ranger-def456');
    expect(result).toContain('合法名号');
  });

  it('filters out empty strings', async () => {
    const llm = makeFakeLLM('{"names":["","  ","有效名"]}');
    const result = await suggestNames(llm, makeMaterials());
    expect(result).not.toContain('');
    expect(result).not.toContain('  ');
    expect(result.every((c) => c.trim().length > 0)).toBe(true);
  });

  it('filters out names longer than 32 characters', async () => {
    const longName = 'a'.repeat(33);
    const llm = makeFakeLLM(`{"names":["${longName}","短名"]}`);
    const result = await suggestNames(llm, makeMaterials());
    expect(result).not.toContain(longName);
    expect(result).toContain('短名');
  });

  it('trims whitespace from each candidate', async () => {
    const llm = makeFakeLLM('{"names":["  风云客  ","  山海侠  "]}');
    const result = await suggestNames(llm, makeMaterials());
    expect(result).toContain('风云客');
    expect(result).toContain('山海侠');
    expect(result).not.toContain('  风云客  ');
  });

  it('accepts names exactly 32 characters long (boundary)', async () => {
    const name32 = 'a'.repeat(32);
    const llm = makeFakeLLM(`{"names":["${name32}"]}`);
    const result = await suggestNames(llm, makeMaterials());
    expect(result).toContain(name32);
  });

  it('accepts single-character names', async () => {
    const llm = makeFakeLLM('{"names":["龙"]}');
    const result = await suggestNames(llm, makeMaterials());
    expect(result).toContain('龙');
  });
});

// ---------------------------------------------------------------------------
// buildNamingPrompt
// ---------------------------------------------------------------------------

describe('buildNamingPrompt — prompt content', () => {
  it('includes personaText in the prompt when provided', () => {
    const prompt = buildNamingPrompt({
      personaText: '我是一个热爱旅行的探索者',
      verifiedHandles: [],
    });
    expect(prompt).toContain('我是一个热爱旅行的探索者');
  });

  it('does not pin a language when only the host locale has spoken', () => {
    // Name candidates are the first screen the owner ever sees: picking them in
    // en-US because the Mac reports `LANG=en_US.UTF-8` offered a Chinese owner
    // three English names before he had typed a word (2026-08-24).
    setOwnerLang('en-US', 'env');
    const prompt = buildNamingPrompt({ verifiedHandles: [] });
    setOwnerLang(undefined);
    expect(prompt).toContain('whatever language the material below is in');
    expect(prompt).not.toContain('Write the candidates in en-US');
  });

  it('includes verifiedHandles in the prompt when provided', () => {
    const prompt = buildNamingPrompt({
      verifiedHandles: ['@elonmusk', 'github/some-user'],
    });
    expect(prompt).toContain('@elonmusk');
    expect(prompt).toContain('github/some-user');
  });

  it('truncates personaText to 2000 characters', () => {
    const longText = 'x'.repeat(3000);
    const prompt = buildNamingPrompt({ personaText: longText, verifiedHandles: [] });
    // The section containing persona should be at most 2000 chars of content
    expect(prompt).toContain('x'.repeat(2000));
    expect(prompt).not.toContain('x'.repeat(2001));
  });

  it('does not include persona section title when personaText is absent', () => {
    const prompt = buildNamingPrompt({ verifiedHandles: [] });
    expect(prompt).not.toContain('主人的自我描述');
    expect(prompt).not.toContain('人格材料');
  });

  it('does not include handles section title when verifiedHandles is empty', () => {
    const prompt = buildNamingPrompt({ verifiedHandles: [] });
    expect(prompt).not.toContain('已认证的账号');
  });

  it('includes both sections when both are provided', () => {
    const prompt = buildNamingPrompt({
      personaText: '探索者',
      verifiedHandles: ['@testuser'],
    });
    expect(prompt).toContain('探索者');
    expect(prompt).toContain('@testuser');
  });

  it('always asks for JSON output', () => {
    const prompt = buildNamingPrompt({ verifiedHandles: [] });
    expect(prompt).toContain('JSON');
    expect(prompt).toContain('names');
  });

  it('captured prompt contains personaText when fake LLM verifies it', async () => {
    let capturedPrompt = '';
    const fakeLLM: LLMClientLike = {
      complete: vi.fn().mockImplementation(async (p: string) => {
        capturedPrompt = p;
        return '{"names":["test"]}';
      }),
    };
    await suggestNames(fakeLLM, { personaText: '独特的创作者', verifiedHandles: [] });
    expect(capturedPrompt).toContain('独特的创作者');
  });

  it('captured prompt contains verifiedHandles when fake LLM verifies it', async () => {
    let capturedPrompt = '';
    const fakeLLM: LLMClientLike = {
      complete: vi.fn().mockImplementation(async (p: string) => {
        capturedPrompt = p;
        return '{"names":["test"]}';
      }),
    };
    await suggestNames(fakeLLM, { verifiedHandles: ['@realuser', 'github/dev'] });
    expect(capturedPrompt).toContain('@realuser');
    expect(capturedPrompt).toContain('github/dev');
  });

  it('captured prompt does NOT contain persona section when personaText absent', async () => {
    let capturedPrompt = '';
    const fakeLLM: LLMClientLike = {
      complete: vi.fn().mockImplementation(async (p: string) => {
        capturedPrompt = p;
        return '{"names":["test"]}';
      }),
    };
    await suggestNames(fakeLLM, { verifiedHandles: [] });
    expect(capturedPrompt).not.toContain('主人的自我描述');
  });

  it('captured prompt does NOT contain handles section when verifiedHandles empty', async () => {
    let capturedPrompt = '';
    const fakeLLM: LLMClientLike = {
      complete: vi.fn().mockImplementation(async (p: string) => {
        capturedPrompt = p;
        return '{"names":["test"]}';
      }),
    };
    await suggestNames(fakeLLM, { verifiedHandles: [] });
    expect(capturedPrompt).not.toContain('已认证的账号');
  });
});
