import { afterEach, expect, it, vi } from 'vitest';
import { gatewayRuntimePorts } from '../../../src/host/openclaw-runtime-ports.js';
import { mcpRuntimePorts } from '../../../src/host/mcp-runtime-ports.js';
import { PopclawPaths } from '../../../src/host/popclaw-paths.js';

const ports = [
  ['Native', () => gatewayRuntimePorts({ api: { logger: { info() {}, warn() {}, error() {} } },
    host: {}, root: {}, storagePaths: new PopclawPaths('/unused'), releaseStorage() {} } as never)],
  ['MCP', () => mcpRuntimePorts({logger: {info() {},warn() {},error() {}}, dataRoot:'/unused',
    storagePaths:new PopclawPaths('/unused'),releaseStorage() {},serverBox:{},consumerId:()=> 'synthetic'} as never)],
] as const;
afterEach(() => vi.unstubAllEnvs());
it.each(ports)('%s defaults to public-v1 with no env switch', (_name, build) => {
  vi.stubEnv('POPCLAW_WORLD_STREAM',undefined);
  expect(build().platform.receiveMode()).toBe('public-v1');
});
it.each(ports)('%s rejects legacy and illegal explicit receive modes', (_name, build) => {
  for (const value of ['1','', ' ', 'legacy', 'PUBLIC-V1', ' public-v1']) {
    vi.stubEnv('POPCLAW_WORLD_STREAM',value);
    expect(() => build().platform.receiveMode()).toThrow(/RECEIVE_MODE_INVALID.*POPCLAW_WORLD_STREAM/);
  }
});

it.each(ports)('%s accepts the exact public-v1 value and captures one configuration for the boot',(_name,build)=>{
  vi.stubEnv('POPCLAW_WORLD_STREAM','public-v1');const selected=build();
  vi.stubEnv('POPCLAW_WORLD_STREAM','1');
  expect(selected.platform.receiveMode()).toBe('public-v1');
  expect(()=>build()).toThrow('RECEIVE_MODE_INVALID');
});
