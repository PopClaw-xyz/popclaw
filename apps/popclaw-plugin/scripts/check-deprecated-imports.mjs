/**
 * Lint gate: no deprecated OpenClaw SDK surface anywhere in `src/`.
 *
 * Every entry below has a published removal date (docs.openclaw.ai/plugins/
 * sdk-migration, digest 2026-08-11 §3). The nearest one is `api.on("deactivate")`
 * — gone 2026-08-16. Deprecations do NOT fail the build on the host side, so
 * without this gate the first symptom is a plugin that silently stops loading
 * after a routine `openclaw update`.
 *
 * Scans `src/` only: `dist/` is a build artifact (and holds a stale bundle),
 * `node_modules/` is the SDK itself — both are full of these strings by nature.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, resolve } from 'node:path';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../src');

/** [needle, what to use instead]. Plain substrings — no regex to get wrong. */
const BANNED = [
  ["from 'openclaw/plugin-sdk'", 'removed root barrel → focused subpath'],
  ['from "openclaw/plugin-sdk"', 'removed root barrel → focused subpath'],
  ['openclaw/plugin-sdk/compat', 'removed barrel → focused subpath'],
  ['openclaw/plugin-sdk/config-runtime', 'removal 2026-09-01 → config-contracts / api.pluginConfig'],
  ['openclaw/plugin-sdk/infra-runtime', 'removal 2026-09-01 → focused *-runtime subpaths'],
  ["from 'openclaw/plugin-sdk/channel-runtime'", 'bare barrel → focused channel subpath'],
  ['openclaw/extension-api', 'removed → api.runtime.*'],
  ['openclaw/plugin-sdk/zod', 'deprecated 2026-08-15 → TypeBox schemas'],
  ['openclaw/plugin-sdk/channel-lifecycle', 'removal 2026-09-01'],
  ['openclaw/plugin-sdk/channel-message', 'removal 2026-09-01 → channel-outbound'],
  ['openclaw/plugin-sdk/channel-reply-pipeline', 'removal 2026-09-01'],
  ["api.on('deactivate'", "removal 2026-08-16 → api.on('gateway_stop')"],
  ['api.on("deactivate"', "removal 2026-08-16 → api.on('gateway_stop')"],
  ["api.on('subagent_spawning'", "deprecated → api.on('subagent_spawned')"],
  ['api.on("subagent_spawning"', "deprecated → api.on('subagent_spawned')"],
  ['AuthStorage.create', 'removal 2026-10-01 → AuthStorage.forAgent(agentDir)'],
  ['providerAuthEnvVars', 'manifest: → setup.providers[].envVars'],
  ['channelEnvVars', 'manifest: → setup.providers[].envVars'],
  ['before_agent_start', 'deprecated → before_model_resolve + before_prompt_build'],
];

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

const hits = [];
for (const file of walk(SRC)) {
  const lines = readFileSync(file, 'utf8').split('\n');
  for (const [needle, hint] of BANNED) {
    lines.forEach((line, i) => {
      if (line.includes(needle)) {
        hits.push(`${relative(resolve(SRC, '..'), file)}:${i + 1}  ${needle}  —  ${hint}`);
      }
    });
  }
}

if (hits.length > 0) {
  console.error(
    `check-deprecated-imports: ${hits.length} deprecated OpenClaw SDK usage(s) found:\n` +
      hits.map((h) => `  ${h}`).join('\n') +
      '\nSee docs.openclaw.ai/plugins/sdk-migration. Each of these has a removal date.',
  );
  process.exit(1);
}
console.log(`check-deprecated-imports: clean (${BANNED.length} surfaces checked)`);
