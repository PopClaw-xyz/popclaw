import { describe, expect, it } from 'vitest';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { registerPopclawTools, OPTIONAL_TOOLS } from '../../../src/tools/register-tools.js';

// ADR-0044 §8: a manual that points at a tool the model cannot see teaches it to
// fabricate calls. This suite is the SKILL.md analogue of register-tools.test.ts's
// "openclaw.plugin.json contracts.tools stays in sync" test — it fails the moment
// the skill text and the real tool registry drift apart, in either direction.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const SKILL_PATH = resolve(ROOT, 'skills/popclaw-social/SKILL.md');

/** Same fake api shape as register-tools.test.ts: captures registered tool names. */
function buildFakeApi() {
  const tools: Array<{ name: string }> = [];
  const push = (tool: { name?: string; execute?: unknown }) => {
    if (tool?.name && typeof tool.execute === 'function') tools.push(tool as { name: string });
  };
  const api = {
    registerTool: (tool: unknown, _opts?: unknown) => {
      const resolved =
        typeof tool === 'function'
          ? (tool as (ctx: unknown) => unknown)({ agentId: 'main-agent', config: { fake: true } })
          : tool;
      if (Array.isArray(resolved)) resolved.forEach((t) => push(t as { name?: string; execute?: unknown }));
      else push(resolved as { name?: string; execute?: unknown });
    },
  } as Parameters<typeof registerPopclawTools>[0]['api'];
  return { api, tools };
}

/** Registers the FULL tool set (inboundMediaDirs + world/onboarding getters open,
 * onboarding/world/house getters), mirroring register-tools.test.ts's manifest-sync
 * test — the skill text may legitimately name any tool in the full set, not just
 * the always-on subset. Anything it names that is NOT in this set counts as a
 * fabricated tool and fails the check below — which is what keeps the carved-out
 * wallet / red-packet names out of SKILL.md. It names none of them today. */
function fullRegisteredToolNames(): string[] {
  const { api, tools } = buildFakeApi();
  registerPopclawTools({
    socialSendHost: 'local-stdio',
    api,
    runtime: (async () => ({})) as unknown as Parameters<typeof registerPopclawTools>[0]['runtime'],
    inboundMediaDirs: [tmpdir()],
    getOrchestrator: (async () => ({})) as unknown as Parameters<
      typeof registerPopclawTools
    >[0]['getOrchestrator'],
    getWorldDeps: (async () => ({})) as unknown as Parameters<
      typeof registerPopclawTools
    >[0]['getWorldDeps'],
    // The skill text names the house + world-interaction tools; open those
    // getters so the "full set" is actually full.
    getHouseCommandContext: (async () => ({})) as unknown as Parameters<
      typeof registerPopclawTools
    >[0]['getHouseCommandContext'],
    getWorldCommandContext: (async () => ({})) as unknown as Parameters<
      typeof registerPopclawTools
    >[0]['getWorldCommandContext'],
  });
  return tools.map((t) => t.name);
}

function readSkillText(): string {
  expect(existsSync(SKILL_PATH), `SKILL.md not found at ${SKILL_PATH}`).toBe(true);
  return readFileSync(SKILL_PATH, 'utf-8');
}

function frontmatterOf(text: string): Record<string, string> {
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  expect(m, 'SKILL.md: no --- frontmatter block found').toBeTruthy();
  const fm: Record<string, string> = {};
  for (const line of m![1]!.split('\n')) {
    const kv = line.match(/^([a-zA-Z-]+):\s*(.*)$/);
    if (kv) fm[kv[1]!] = kv[2]!.trim();
  }
  return fm;
}

/** The two notification tools live only in the MCP bridge (src/mcp.ts) — they are
 * never registered through `registerPopclawTools`, so they are absent from the
 * manifest's contracts.tools by design. The skill may still name them: on an MCP
 * host they are the relay the owner depends on. */
const MCP_ONLY_TOOLS = [] as const;

/** Sentences the MCP bridge's `initialize.instructions` hands every MCP host. Each one
 * is a contiguous substring of a single string literal in src/mcp.ts, so it can be
 * searched for in both files. SKILL.md quotes them verbatim (the skill mirrors mcp.ts;
 * mcp.ts stays self-contained because an MCP host may never load the skill at all). */
const MCP_INSTRUCTION_SENTENCES = [
  'popclaw_notifications first to pull whatever is waiting and relay it to the owner.',
  'When the owner asks to view messages, retrieve the requested messages and attachments with the existing tools and present them in this chat without asking again.',
  'inside an MCP host popclaw cannot push anything itself, it depends on',
] as const;

/** Markdown wraps sentences across lines; compare on a single-spaced form. */
function flat(text: string): string {
  return text.replace(/\s+/g, ' ');
}

/** Just the `initialize.instructions` string of the MCP bridge — comments and the rest of
 * src/mcp.ts must not be able to satisfy the verbatim check on their own. */
function mcpInstructions(): string {
  const src = readFileSync(resolve(ROOT, 'src/mcp.ts'), 'utf-8');
  const start = src.indexOf('instructions:');
  const end = src.indexOf('languageDirective()', start);
  expect(start, 'src/mcp.ts: no initialize.instructions').toBeGreaterThan(-1);
  expect(end, 'src/mcp.ts: instructions no longer ends with languageDirective()').toBeGreaterThan(start);
  return flat(src.slice(start, end));
}

function manifestTools(): string[] {
  const manifest = JSON.parse(readFileSync(resolve(ROOT, 'openclaw.plugin.json'), 'utf-8')) as {
    contracts?: { tools?: string[] };
  };
  expect(manifest.contracts?.tools, 'openclaw.plugin.json: no contracts.tools').toBeTruthy();
  return manifest.contracts!.tools!;
}

function descriptionOf(text: string): string {
  const raw = frontmatterOf(text).description;
  expect(raw, 'SKILL.md: no frontmatter description').toBeTruthy();
  return raw!.replace(/^"(.*)"$/s, '$1');
}

describe('skills/popclaw-social/SKILL.md', () => {
  it.each([
    ['health check', '**The health check rides'],
    ['feedback recipe', '**Draft feedback to the makers.**'],
    ['troubleshooting', '**Symptom C'],
  ])('%s separates the owner request, complete preview and send confirmation', (_name, heading) => {
    const text = readSkillText();
    const start = text.indexOf(heading);
    expect(start).toBeGreaterThan(-1);
    const end = text.indexOf('\n\n', start);
    const section = flat(text.slice(start, end === -1 ? undefined : end));
    // Each entry path stands on its own; a correct paragraph elsewhere cannot
    // excuse a troubleshooting recipe that still tells the agent to send at once.
    expect(section).toMatch(/owner explicitly asks[\s\S]*popclaw_feedback/);
    expect(section).toMatch(/(?:does not send|never sends)/);
    expect(section).toMatch(/preview verbatim: recipient, lore-house and full letter/);
    expect(section).toMatch(/Only after the owner has read it and explicitly confirmed sending[\s\S]*draft_id[\s\S]*popclaw_send_draft/);
    expect(section).toContain('Permission to draft is not permission to send');
    expect(section).not.toMatch(/Send it in the same turn|show the receipt/);
  });

  it('every popclaw_* name it mentions is a real, non-hidden tool', () => {
    const text = readSkillText();
    // MCP_ONLY_TOOLS are registered by the stdio bridge, not by this pass — see the
    // constant's note; the skill names them for MCP hosts and they are real there.
    const registered = new Set([...fullRegisteredToolNames(), ...MCP_ONLY_TOOLS]);
    const mentioned = new Set(text.match(/popclaw_[a-z_]+/g) ?? []);
    expect(mentioned.size).toBeGreaterThan(0); // sanity: the regex must actually find something

    const fabricated = [...mentioned].filter((name) => !registered.has(name) && name !== 'popclaw_notification_notice');
    expect(fabricated, `SKILL.md names tools that do not exist: ${fabricated.join(', ')}`).toEqual([]);

    const hidden = [...mentioned].filter((name) => (OPTIONAL_TOOLS as readonly string[]).includes(name));
    expect(hidden, `SKILL.md points at hidden/optional tools: ${hidden.join(', ')}`).toEqual([]);
  });

  it('frontmatter name is not "popclaw" (would collide with the plugin\'s own /popclaw command)', () => {
    const fm = frontmatterOf(readSkillText());
    expect(fm.name).toBeTruthy();
    expect(fm.name).not.toBe('popclaw');
  });

  it('openclaw.plugin.json declares a skills[] dir that exists and contains a SKILL.md', () => {
    const manifest = JSON.parse(readFileSync(resolve(ROOT, 'openclaw.plugin.json'), 'utf-8')) as {
      skills?: string[];
    };
    expect(manifest.skills, 'openclaw.plugin.json: no top-level "skills" field').toBeTruthy();
    expect(manifest.skills!.length).toBeGreaterThan(0);
    for (const dir of manifest.skills!) {
      const abs = resolve(ROOT, dir);
      expect(existsSync(abs), `skills dir does not exist: ${abs}`).toBe(true);
      // Plugin skills publish one skill per subdirectory of `skills/` (collectSkillTargets);
      // every subdirectory must carry its own SKILL.md.
      const subdirs = readdirSync(abs, { withFileTypes: true }).filter((d) => d.isDirectory());
      expect(subdirs.length).toBeGreaterThan(0);
      for (const sub of subdirs) {
        expect(existsSync(join(abs, sub.name, 'SKILL.md')), `missing SKILL.md in ${dir}/${sub.name}`).toBe(
          true,
        );
      }
    }
  });

  it('package.json "files" includes "skills" so it ships in the tarball', () => {
    const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf-8')) as { files: string[] };
    expect(pkg.files).toContain('skills');
  });

  // --- #587 drift guards -------------------------------------------------
  // The tool-families list is a hand-maintained fourth tool table (register code,
  // MCP adapter, manifest, this skill). Nothing but this test keeps it honest.

  it('every popclaw_* name it mentions is declared in the manifest (or is an MCP-only notification tool)', () => {
    const declared = new Set<string>([...manifestTools(), ...MCP_ONLY_TOOLS]);
    const mentioned = new Set(readSkillText().match(/popclaw_[a-z_]+/g) ?? []);
    const undeclared = [...mentioned].filter((name) => !declared.has(name) && name !== 'popclaw_notification_notice');
    expect(
      undeclared,
      `SKILL.md names tools that openclaw.plugin.json does not declare: ${undeclared.join(', ')}`,
    ).toEqual([]);
  });

  it('does not name popclaw_resolve_message (folded into popclaw_show_inbox as resolve_message_id)', () => {
    expect(readSkillText()).not.toContain('popclaw_resolve_message');
  });

  it('frontmatter description survives the compact catalog\'s 220-char cut, English and whole', () => {
    const description = descriptionOf(readSkillText());
    // OpenClaw's compact skill catalog truncates at `descriptionMaxChars ?? 220`; the
    // full string is shown in non-compact mode. So everything load-bearing — why to read
    // this, what it covers, and the call-it-yourself rule — must land inside the first
    // 220 chars, and that prefix must be English (a half-cut CJK trigger list teaches
    // nothing). The trigger terms ride behind the cut, where they cost nothing.
    const compact = description.slice(0, 220);
    expect(compact).toMatch(/^Read before your first popclaw task/);
    expect(compact).toContain('Call popclaw_* tools yourself, never a subagent.');
    expect(compact, 'the first 220 chars must stay English').not.toMatch(/[\u4e00-\u9fff]/);
  });

  it('frontmatter description still carries the owner\'s trigger words behind the cut', () => {
    const description = descriptionOf(readSkillText());
    for (const term of ['feedback', '江湖', '名号', '交情簿', '报纸', '发帖', '私信']) {
      expect(description, `description lost the trigger term ${term}`).toContain(term);
    }
  });

  it('quotes the MCP notifications handoff verbatim from src/mcp.ts initialize.instructions', () => {
    const skill = flat(readSkillText());
    const mcp = mcpInstructions();
    for (const sentence of MCP_INSTRUCTION_SENTENCES) {
      expect(mcp, `src/mcp.ts initialize.instructions no longer says: ${sentence}`).toContain(sentence);
      expect(skill, `SKILL.md must quote mcp.ts verbatim: ${sentence}`).toContain(sentence);
    }
  });
});
