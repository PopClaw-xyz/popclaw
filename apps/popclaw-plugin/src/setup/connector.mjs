#!/usr/bin/env node
/** Project-only setup for the locally distributed PopClaw MCP bridge. */
import { existsSync, lstatSync, statSync, realpathSync, readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync, chmodSync, readdirSync, accessSync, constants } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, isAbsolute, relative, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import toml from './vendor/smol-toml.cjs';
import { CODEX_TOOL_TIMEOUT_SECONDS } from '../host/approval-window.mjs';

const events = ['SessionStart', 'UserPromptSubmit', 'PostToolUse'];
const identityFile = 'vault/social/identity/master.key';
const hash = value => createHash('sha256').update(value).digest('hex').slice(0, 16);
const quote = value => "'" + value.replaceAll("'", "'\"'\"'") + "'";
const equal = (a, b) => JSON.stringify(sort(a)) === JSON.stringify(sort(b));
function sort(x) { return Array.isArray(x) ? x.map(sort) : x && typeof x === 'object' ? Object.fromEntries(Object.keys(x).sort().map(k => [k, sort(x[k])])) : x; }
function object(x, context) { if (!x || Array.isArray(x) || typeof x !== 'object') throw new Error(`${context} must be an object`); return x; }

export function safePath(path, base) {
  const parts = relative(base, path).split(/[\\/]/);
  if (parts.includes('..')) throw new Error('Path escapes its configuration root');
  let p = base;
  for (const part of parts) {
    p = join(p, part);
    let stat;
    try { stat = lstatSync(p); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (stat?.isSymbolicLink()) throw new Error(`Refusing symlink in configuration path: ${p}`);
  }
}
function read(path, base) {
  safePath(path, base);
  if (!existsSync(path)) return undefined;
  if (!statSync(path).isFile()) throw new Error(`Not a configuration file: ${path}`);
  return readFileSync(path, 'utf8');
}
function parseJSON(text, path) {
  try { return object(JSON.parse(text ?? '{}'), path); } catch { throw new Error(`Invalid JSON object in ${path}; nothing was changed`); }
}
function parseTOML(text, path) {
  try { return toml.parse(text ?? ''); } catch { throw new Error(`Invalid TOML in ${path}; nothing was changed`); }
}
/** Codex's per-server tool timeout is ours to raise, never to lower: a binding
 *  that differs only in it is still our binding. */
function withoutToolTimeout(server) {
  if (!server || typeof server !== 'object') return server;
  const { tool_timeout_sec: _ignored, ...rest } = server;
  return rest;
}
/**
 * Raise `tool_timeout_sec` inside the existing `[mcp_servers.popclaw]` table by
 * editing that one line (or inserting it under the header), so every other
 * byte of the user's config.toml — comments, order, spacing — is untouched.
 * The result is re-parsed and must equal the original with only that key
 * changed; any other form (inline table, dotted keys) is refused rather than
 * rewritten.
 */
function raiseCodexToolTimeout(text, data, value, path) {
  const lines = text.split('\n');
  const header = lines.findIndex(line => /^\s*\[\s*mcp_servers\s*\.\s*popclaw\s*\]\s*(#.*)?\r?$/.test(line));
  let edited = null;
  if (header !== -1) {
    let end = lines.findIndex((line, i) => i > header && /^\s*\[/.test(line));
    if (end === -1) end = lines.length;
    const eol = lines[header].endsWith('\r') ? '\r' : '';
    const at = lines.findIndex((line, i) => i > header && i < end && /^\s*tool_timeout_sec\s*=/.test(line));
    const next = [...lines];
    if (at === -1) next.splice(header + 1, 0, `tool_timeout_sec = ${value}${eol}`);
    else next[at] = next[at].replace(/^(\s*tool_timeout_sec\s*=\s*)[^#\r]*?(\s*(#.*)?\r?)$/, `$1${value}$2`);
    edited = next.join('\n');
  }
  const expected = structuredClone(data); expected.mcp_servers.popclaw.tool_timeout_sec = value;
  let parsed; try { parsed = edited === null ? undefined : toml.parse(edited); } catch { parsed = undefined; }
  if (!parsed || !equal(parsed, expected)) {
    throw new Error(`Codex PopClaw binding in ${path} is written in a form setup cannot edit safely; set tool_timeout_sec = ${value} under [mcp_servers.popclaw] by hand. Nothing was changed`);
  }
  return edited;
}
function uniquePaths(paths) {
  return [...new Set(paths.filter(p => p && isAbsolute(p) && existsSync(p)).map(p => realpathSync(p)))];
}
async function choose(label, values, ask) {
  if (values.length === 1) return values[0];
  if (!values.length) throw new Error(`No ${label} found`);
  if (!ask) throw new Error(`Multiple ${label}: ${values.join(', ')}. Select one with --root, --host or --claude-profile.`);
  const answer = await ask(`${label}:\n${values.map((v, i) => `  ${i + 1}. ${v}`).join('\n')}\nChoose a number: `);
  const index = Number(answer) - 1;
  if (!Number.isInteger(index) || index < 0 || index >= values.length) throw new Error('No valid selection; nothing was changed');
  return values[index];
}
function installedCommand(name, env) {
  return (env.PATH ?? '').split(delimiter).some(p => existsSync(join(p, name)));
}

async function claudeProfile(home, env, options) {
  if (options.claudeProfile || env.CLAUDE_CONFIG_DIR) {
    const selected = realpathSync(options.claudeProfile ?? env.CLAUDE_CONFIG_DIR);
    if (existsSync(join(selected, '.claude.json'))) accessSync(join(selected, '.claude.json'), constants.R_OK);
    return selected;
  }
  // Alternate HOME wrappers (including GLM) keep .claude.json one level below
  // the real home. Inspect only this marker, never shell functions or auth files.
  const candidates = [home, ...readdirSync(home, { withFileTypes: true }).filter(e => e.isDirectory() && e.name.startsWith('.')).map(e => join(home, e.name))];
  const readable = []; const inaccessible = [];
  for (const candidate of candidates) {
    const path = join(candidate, '.claude.json');
    if (!existsSync(path)) continue;
    try { accessSync(path, constants.R_OK); readable.push(candidate); } catch { inaccessible.push(path); }
  }
  if (!readable.length) {
    if (inaccessible.length) throw new Error('Claude profile is unreadable; use --claude-profile for your existing readable profile. No file permissions were changed');
    return home;
  }
  return choose('readable Claude profiles', uniquePaths(readable), options.ask);
}

/**
 * The tools the hooks setup installs send the agent to (src/mcp-hook.ts): list
 * pending notices, read the indicated message, acknowledge after handoff.
 * Without all three the installed hooks point at nothing. Keep this list to
 * names that exist: tests/setup/probe-tool-surface.test.ts checks it against
 * the built bundle and the static manifest.
 */
export const MCP_REQUIRED_TOOLS = ['popclaw_notifications', 'popclaw_show_inbox', 'popclaw_acknowledge_notifications'];

/** Handshake/list only: no runtime boot, inbox reads, outbound messages or relay assertion. */
export function probeMcp(pkg, root, node, env, timeout = 10000) {
  return new Promise((resolveProbe, reject) => {
    const child = spawn(node, [join(pkg, 'dist/bundled/mcp.js')], {
      cwd: pkg, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...env, POPCLAW_DATA_ROOT: root, POPCLAW_NOTIFICATION_CONSUMER: 'setup-probe', POPCLAW_SETUP_RECEIPT: '', POPCLAW_RECEIVE_ON_START: '0', POPCLAW_MCP_ENABLE_RANGER: '0' },
    });
    let done = false, buffer = '', total = 0;
    const finish = (error) => { if (done) return; done = true; clearTimeout(timer); child.kill('SIGKILL'); error ? reject(error) : resolveProbe(); };
    const timer = setTimeout(() => finish(new Error('MCP connection timed out; configuration was not written')), timeout);
    const send = q => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...q }) + '\n');
    child.on('error', () => finish(new Error('MCP process could not start; check Node and the installed package')));
    child.on('exit', code => { if (!done) finish(new Error(`MCP process exited (${code}) before verification`)); });
    child.stdin.on('error', () => finish(new Error('MCP input closed before verification')));
    child.stderr.on('data', () => {}); // Never echo credentials or arbitrary server output.
    child.stdout.on('data', chunk => {
      total += chunk.length;
      if (total > 1024 * 1024) return finish(new Error('MCP response exceeded the setup limit'));
      buffer += chunk.toString();
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        if (!line.trim()) continue;
        let message;
        try { message = JSON.parse(line); } catch { return finish(new Error('MCP returned invalid JSON')); }
        if (message.error) return finish(new Error('MCP rejected the setup probe'));
        if (message.id === 1) {
          if (!message.result?.serverInfo || !message.result?.capabilities?.tools) return finish(new Error('MCP initialization did not advertise tools'));
          send({ method: 'notifications/initialized' }); send({ id: 2, method: 'tools/list', params: {} });
        }
        if (message.id === 2) {
          const names = new Set(message.result?.tools?.map(t => t.name));
          const missing = MCP_REQUIRED_TOOLS.filter(n => !names.has(n));
          if (missing.length) return finish(new Error(`MCP package is missing collaboration tools: ${missing.join(', ')}; upgrade PopClaw first`));
          finish();
        }
      }
    });
    send({ id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'popclaw-connect', version: '1' } } });
  });
}

function addHooks(data, host, pkg, root, consumer, node) {
  const result = structuredClone(data);
  result.hooks = object(result.hooks ?? {}, 'hooks');
  for (const event of events) {
    const command = ['/usr/bin/env', `POPCLAW_DATA_ROOT=${root}`, `POPCLAW_NOTIFICATION_CONSUMER=${consumer}`, node, join(pkg, 'dist/bundled/mcp-hook.js'), event].map(quote).join(' ');
    const group = { ...(event === 'PostToolUse' ? { matcher: host === 'claude' ? 'Bash|Edit|Write' : 'exec_command|apply_patch' } : {}), hooks: [{ type: 'command', command, timeout: 5 }] };
    const existing = result.hooks[event] ?? [];
    if (!Array.isArray(existing)) throw new Error(`hooks.${event} must be an array`);
    if (!existing.some(x => equal(x, group))) {
      if (existing.some(x => x.hooks?.some(h => h.command?.includes(`POPCLAW_NOTIFICATION_CONSUMER=${consumer}`)))) throw new Error(`Existing PopClaw ${event} hook changed; review it before reconnecting`);
      result.hooks[event] = [...existing, group];
    }
  }
  return result;
}

export function commitFiles(plans, project, backupBase, home, beforeWrite) {
  const changed = plans.filter(p => p.before !== p.after);
  if (!changed.length) return { changed: [] };
  for (const p of changed) {
    p.mode = p.before === undefined ? 0o600 : statSync(p.path).mode & 0o777;
    if (!(p.mode & 0o222)) throw new Error(`Configuration is read-only: ${p.path}; nothing was changed`);
  }
  const backup = join(backupBase, `${Date.now()}-${randomUUID()}`);
  safePath(backupBase, home);
  mkdirSync(backup, { recursive: true, mode: 0o700 }); chmodSync(backup, 0o700);
  const written = [];
  try {
    for (const p of changed) {
      if (read(p.path, project) !== p.before) throw new Error(`Configuration changed concurrently: ${p.path}`);
      if (p.before !== undefined) {
        const dest = join(backup, relative(project, p.path)); mkdirSync(dirname(dest), { recursive: true, mode: 0o700 }); writeFileSync(dest, p.before, { flag: 'wx', mode: 0o600 });
      }
    }
    writeFileSync(join(backup, 'manifest.json'), JSON.stringify(changed.map(p => ({ path: p.path, existed: p.before !== undefined })), null, 2), { mode: 0o600, flag: 'wx' });
    for (const [index, p] of changed.entries()) {
      beforeWrite?.(p.path, index);
      if (read(p.path, project) !== p.before) throw new Error(`Configuration changed concurrently: ${p.path}`);
      mkdirSync(dirname(p.path), { recursive: true, mode: 0o700 });
      const tmp = `${p.path}.popclaw-${randomUUID()}`;
      try {
        writeFileSync(tmp, p.after, { mode: p.mode, flag: 'wx' });
        chmodSync(tmp, p.mode);
        renameSync(tmp, p.path); written.push(p);
      } finally { if (existsSync(tmp)) unlinkSync(tmp); }
    }
  } catch (error) {
    const recovery = [];
    for (const p of written.reverse()) {
      const tmp = `${p.path}.popclaw-restore-${randomUUID()}`;
      try {
        if (read(p.path, project) !== p.after) { recovery.push(`${p.path}: concurrently edited, not restored`); continue; }
        if (p.before === undefined) unlinkSync(p.path);
        else {
          writeFileSync(tmp, p.before, { mode: p.mode, flag: 'wx' }); chmodSync(tmp, p.mode); renameSync(tmp, p.path);
        }
      } catch (restoreError) { recovery.push(`${p.path}: ${restoreError.code ?? 'restore failed'}`); }
      finally { try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* Preserve the main error and remaining recovery attempts. */ } }
    }
    throw new Error(`${error.message}. Backup: ${backup}${recovery.length ? '. Manual recovery needed: ' + recovery.join('; ') : ''}`);
  }
  return { changed: changed.map(p => p.path), backup };
}

export async function setup(options = {}) {
  if (process.platform === 'win32') throw new Error('This local connector currently supports macOS/Linux; use the documented manual host setup on Windows');
  const [major, minor, patch] = process.versions.node.split('.').map(Number);
  if (!((major === 22 && (minor > 22 || (minor === 22 && patch >= 3))) || (major === 24 && minor >= 15) || (major === 25 && minor >= 9) || major > 25)) throw new Error('Node must meet the installed PopClaw engine range (22.22.3+, 24.15+, or 25.9+)');
  if (typeof options.validateRoot !== 'function') throw new Error('Use the first-install setup core to validate identity roots');
  const rootAccepted = options.validateRoot;
  const home = realpathSync(options.home ?? homedir());
  const project = realpathSync(options.project ?? process.cwd());
  const env = options.env ?? process.env;
  const node = realpathSync(options.node ?? process.execPath);
  let host = options.host;
  if (!host) {
    const hosts = ['claude', 'codex'].filter(h => installedCommand(h, env) || existsSync(join(home, `.${h}`)));
    host = await choose('installed hosts', hosts.length > 1 ? [...hosts, 'both'] : hosts, options.ask);
  }
  if (!['claude', 'codex', 'both'].includes(host)) throw new Error('--host must be claude, codex or both');
  const hosts = host === 'both' ? ['claude', 'codex'] : [host];
  const selectedClaudeProfile = hosts.includes('claude') ? await claudeProfile(home, env, options) : undefined;
  const local = {};
  for (const h of hosts) {
    const path = join(project, h === 'claude' ? '.mcp.json' : '.codex/config.toml');
    const text = read(path, project); const data = h === 'claude' ? parseJSON(text, path) : parseTOML(text, path);
    if (options.requireNewBinding && (h === 'claude' ? data.mcpServers : data.mcp_servers)?.popclaw) throw new Error('PopClaw is already configured differently or its setup receipt is missing; restore the original receipt before reconnecting');
    local[h] = { path, text, data };
  }
  const stateDir = env.OPENCLAW_STATE_DIR ? resolve(env.OPENCLAW_STATE_DIR) : join(home, '.openclaw');
  const roots = [];
  if (env.POPCLAW_DATA_ROOT) {
    if (!rootAccepted(env.POPCLAW_DATA_ROOT)) throw new Error('POPCLAW_DATA_ROOT must name an existing identity and social database');
    roots.push(env.POPCLAW_DATA_ROOT);
  }
  for (const h of hosts) {
    const globalPath = h === 'codex' ? join(env.CODEX_HOME ?? join(home, '.codex'), 'config.toml') : join(selectedClaudeProfile, '.claude.json');
    const globalText = existsSync(globalPath) ? readFileSync(globalPath, 'utf8') : undefined;
    const globalData = h === 'codex' ? parseTOML(globalText, globalPath) : parseJSON(globalText, globalPath);
    const globalServer = (h === 'claude' ? globalData.mcpServers : globalData.mcp_servers)?.popclaw;
    const claudeLocalServer = h === 'claude' ? globalData.projects?.[project]?.mcpServers?.popclaw : undefined;
    if (globalServer || claudeLocalServer) throw new Error(`${h} has an existing global/local-scoped PopClaw server. Review that server with /mcp before adding a project connection; no existing configuration was changed`);
    for (const data of [local[h].data, globalData]) {
      const server = (h === 'claude' ? data.mcpServers : data.mcp_servers)?.popclaw;
      if (server?.env?.POPCLAW_DATA_ROOT) {
        if (!rootAccepted(server.env.POPCLAW_DATA_ROOT)) throw new Error(`PopClaw is already configured with a missing or invalid existing identity in ${h}; fix that path first`);
        roots.push(server.env.POPCLAW_DATA_ROOT);
      }
    }
  }
  let root;
  if (options.root) {
    if (!rootAccepted(options.root)) throw new Error('--root must name an existing identity and social database; no identity will be created');
    root = options.planOnly && options.validateRoot ? resolve(options.root) : realpathSync(options.root);
  } else root = await choose('existing identities', uniquePaths(roots).filter(validRoot), options.ask);
  const packagePath = options.package ?? join(stateDir, 'extensions/popclaw');
  if (!existsSync(packagePath)) throw new Error('No installed PopClaw package found; install the local tarball with install-popclaw.sh first, or use --package for a complete extracted package');
  const pkg = realpathSync(packagePath);
  for (const file of ['dist/bundled/mcp.js', 'dist/bundled/mcp-hook.js', 'dist/native-deps', 'migrations/025-dm-delivery-lease.sql']) {
    if (!existsSync(join(pkg, file))) throw new Error(`Installed PopClaw is missing ${file}; upgrade it with install-popclaw.sh first`);
  }
  const plans = [];
  for (const h of hosts) {
    const consumer = `${h}:${hash(project)}`;
    const server = { command: node, args: [join(pkg, 'dist/bundled/mcp.js')], env: { POPCLAW_DATA_ROOT: root, POPCLAW_NOTIFICATION_CONSUMER: consumer, POPCLAW_RECEIVE_ON_START: '1', POPCLAW_SETUP_RECEIPT: join(project,'.popclaw/setup.json') } };
    const item = local[h];
    const legacy = value => value ? { ...value, env: Object.fromEntries(Object.entries(value.env).filter(([key]) => key !== 'POPCLAW_SETUP_RECEIPT')) } : undefined;
    const priorServer = options.previousPackage ? { ...server, args: [join(options.previousPackage, 'dist/bundled/mcp.js')] } : undefined;
    if (h === 'claude') {
      const data = structuredClone(item.data); data.mcpServers = object(data.mcpServers ?? {}, 'mcpServers');
      if (data.mcpServers.popclaw && !equal(data.mcpServers.popclaw, server) && !equal(data.mcpServers.popclaw, priorServer) && !(options.previousPackage && (equal(data.mcpServers.popclaw, legacy(server)) || equal(data.mcpServers.popclaw, legacy(priorServer))))) throw new Error('Claude PopClaw is already configured differently; nothing was overwritten');
      if (!equal(data.mcpServers.popclaw, server)) { data.mcpServers.popclaw = server; plans.push({ path: item.path, before: item.text, after: JSON.stringify(data, null, 2) + '\n' }); }
    } else {
      // Codex only: its tool timeout could end the call while an approval
      // dialog is open (the pause seen in newer CLI source is an observation,
      // not a guarantee), so the binding carries install headroom: a timeout
      // that outlasts the window, derived from
      // the longest window the plugin can use. Nothing like it is written for
      // Claude Code, whose stdio limit is already far above the window.
      const current = item.data.mcp_servers?.popclaw;
      // One documented, explicitly selected Codex opt-in is managed alongside
      // the standard binding. Strip only this exact value for matching; every
      // other env/owned-field difference remains a conflict. Never read the
      // parent process's stream setting to choose or introduce it.
      const publicV1 = current?.env?.POPCLAW_WORLD_STREAM === 'public-v1';
      const compared = withoutToolTimeout(current);
      if (publicV1) {
        compared.env = { ...compared.env };
        delete compared.env.POPCLAW_WORLD_STREAM;
      }
      const same = (a, b) => b !== undefined && equal(a === current ? compared : withoutToolTimeout(a), withoutToolTimeout(b));
      if (current && !same(current, server) && !same(current, priorServer) && !(options.previousPackage && (same(current, legacy(server)) || same(current, legacy(priorServer))))) throw new Error('Codex PopClaw is already configured differently; nothing was overwritten');
      // A user's own larger value is kept; a missing or smaller one is raised.
      const existing = current?.tool_timeout_sec;
      const timeout = typeof existing === 'number' && existing >= CODEX_TOOL_TIMEOUT_SECONDS ? existing : CODEX_TOOL_TIMEOUT_SECONDS;
      if (current && same(current, priorServer) && !same(current, server)) {
        const updated = structuredClone(item.data);
        updated.mcp_servers.popclaw = { ...server, tool_timeout_sec: timeout,
          ...(publicV1 ? { env: { ...server.env, POPCLAW_WORLD_STREAM: current.env.POPCLAW_WORLD_STREAM } } : {}) };
        plans.push({ path: item.path, before: item.text, after: toml.stringify(updated) });
      } else if (current && existing !== timeout) {
        plans.push({ path: item.path, before: item.text, after: raiseCodexToolTimeout(item.text ?? '', item.data, timeout, item.path) });
      }
      if (!current) {
        const after = (item.text ?? '') + '\n# PopClaw project connection (host trust is required).\n' + toml.stringify({ mcp_servers: { popclaw: { ...server, tool_timeout_sec: CODEX_TOOL_TIMEOUT_SECONDS } } });
        parseTOML(after, item.path); // Reject inline/sealed parent tables instead of corrupting them.
        plans.push({ path: item.path, before: item.text, after });
      }
      if (item.data.hooks) throw new Error('Codex has inline TOML hooks; keep one hook source per layer. Review this configuration before connecting');
    }
    const path = join(project, h === 'claude' ? '.claude/settings.local.json' : '.codex/hooks.json');
    const before = read(path, project); const data = parseJSON(before, path); const cleaned = structuredClone(data);
    if (options.previousPackage) {
      const oldHooks = addHooks({}, h, options.previousPackage, root, consumer, node).hooks;
      for (const event of events) if (Array.isArray(cleaned.hooks?.[event])) cleaned.hooks[event] = cleaned.hooks[event].filter(group => !oldHooks[event].some(old => equal(old, group)));
    }
    const merged = addHooks(cleaned, h, pkg, root, consumer, node);
    if (data.disableAllHooks === true) throw new Error(`${h} hooks are disabled in this project; review that setting before connecting`);
    if (!equal(data, merged)) plans.push({ path, before, after: JSON.stringify(merged, null, 2) + '\n' });
  }
  if (options.planOnly) return { plans, project, root, package: pkg, hosts, claudeProfile: selectedClaudeProfile };
  await probeMcp(pkg, root, node, env, options.probeTimeout);
  const result = commitFiles(plans, project, join(home, '.local/state/popclaw-connect', hash(project)), home, options.beforeWrite);
  return { ...result, project, root, package: pkg, hosts, claudeProfile: selectedClaudeProfile, connection: 'mcp-handshake-passed', trust: 'pending-host-review', relay: 'not-tested' };
}
