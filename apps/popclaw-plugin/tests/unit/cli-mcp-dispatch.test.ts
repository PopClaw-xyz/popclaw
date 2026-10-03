import { describe, expect, it, vi } from 'vitest';
import { dispatchCliEntry } from '../../src/main';

/**
 * `popclaw mcp` must reach the MCP composition root WITHOUT the ordinary CLI
 * bootstrap, and no other head may reach it.
 *
 * Before this dispatch existed, `popclaw mcp` fell through to `main()`, which
 * parses `mcp` as an unknown subcommand and exits 2 — while the published
 * install instructions taught `npx -y popclaw@0.1.0 mcp`. The three
 * destinations are injected so the routing can be asserted without starting a
 * daemon, a setup run, or a stdio server.
 */
function spyPorts() {
  return { runSetup: vi.fn(), startMcp: vi.fn(), runCli: vi.fn() };
}

/** argv as Node hands it over: [execPath, scriptPath, ...args]. */
function argv(...args: string[]): string[] {
  return ['/usr/bin/node', '/pkg/dist/bundled/cli.js', ...args];
}

describe('popclaw bin entry dispatch', () => {
  it('routes `mcp` to the MCP entry and never to the CLI bootstrap', () => {
    const ports = spyPorts();
    dispatchCliEntry(argv('mcp'), ports);
    expect(ports.startMcp).toHaveBeenCalledOnce();
    expect(ports.runCli).not.toHaveBeenCalled();
    expect(ports.runSetup).not.toHaveBeenCalled();
  });

  it('ignores anything after `mcp` — the MCP entry takes no subcommand arguments', () => {
    const ports = spyPorts();
    dispatchCliEntry(argv('mcp', '--host', 'claude'), ports);
    expect(ports.startMcp).toHaveBeenCalledOnce();
    expect(ports.runCli).not.toHaveBeenCalled();
  });

  it('never starts MCP for another head', () => {
    // Positive control above: these same ports DO record a call for `mcp`, so
    // an assertion of "not called" here cannot pass by wiring nothing.
    for (const head of ['login', 'logout', 'daemon', 'status', 'invite', 'world', 'bogus', '--help']) {
      const ports = spyPorts();
      dispatchCliEntry(argv(head), ports);
      expect(ports.startMcp, `head ${head} must not start MCP`).not.toHaveBeenCalled();
      expect(ports.runCli, `head ${head} must reach the CLI bootstrap`).toHaveBeenCalledOnce();
    }
  });

  it('still routes `setup` to setup, and a bare invocation to the CLI bootstrap', () => {
    const setupPorts = spyPorts();
    dispatchCliEntry(argv('setup', '--host', 'claude'), setupPorts);
    expect(setupPorts.runSetup).toHaveBeenCalledOnce();
    expect(setupPorts.startMcp).not.toHaveBeenCalled();
    expect(setupPorts.runCli).not.toHaveBeenCalled();

    const barePorts = spyPorts();
    dispatchCliEntry(argv(), barePorts);
    expect(barePorts.runCli).toHaveBeenCalledOnce();
    expect(barePorts.startMcp).not.toHaveBeenCalled();
    expect(barePorts.runSetup).not.toHaveBeenCalled();
  });
});
