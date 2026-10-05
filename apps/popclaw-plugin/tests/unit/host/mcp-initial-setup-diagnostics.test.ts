import { describe, expect, it, vi } from 'vitest';
import { logMcpInitialMe, logMcpInitialGuide, logMcpInitialSetupFailure } from '../../../src/host/mcp-initial-setup-diagnostics.js';
import type { LoginResult } from '../../../src/runtime/house-lifecycle/manager.js';
import type { HouseGuideResult } from '../../../src/world/house-guide-context.js';

const logger = () => ({info:vi.fn(),warn:vi.fn(),error:vi.fn()});
const login = (extra: Partial<LoginResult> = {}): LoginResult => ({scope:'local_installation',origin:'https://house.popclaw.me',
  status:'connecting',sessionId:'PRIVATE_SESSION',operationId:'PRIVATE_OPERATION',...extra});

describe('bounded MCP initial setup diagnostics',()=>{
  it('exposes soft refusal and guide unavailability without private result fields',()=>{
    const log=logger();
    logMcpInitialMe(log,login({errorCode:'HOUSE_CONTROL_HISTORY_UNPROVEN'}));
    logMcpInitialGuide(log,{status:'unavailable',origin:'https://house.popclaw.me',code:'HOUSE_GUIDE_CONTEXT_STALE'});
    expect(log.warn.mock.calls.map(c=>c[0])).toEqual([
      {stage:'initial_me',status:'connecting',hasOperationId:true,errorCode:'HOUSE_CONTROL_HISTORY_UNPROVEN'},
      {stage:'house_guide',status:'unavailable',code:'HOUSE_GUIDE_CONTEXT_STALE'},
    ]);
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain('PRIVATE');
  });
  it('does not label undefined activation or configured legacy participation as a failure',()=>{
    const log=logger();logMcpInitialMe(log,undefined);
    logMcpInitialMe(log,login({status:'unsupported',admission:'configured',legacyAvailable:true,operationId:undefined}));
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.info.mock.calls.map(c=>c[0])).toEqual([{stage:'initial_me',status:'no_result'},
      {stage:'initial_me',status:'unsupported',hasOperationId:false,admission:'configured',legacyAvailable:true}]);
  });
  it('does not print arbitrary uppercase codes, exceptions, guide bodies or credentials',()=>{
    const log=logger(),privateValue='PRIVATE_RECEIPT_CONFIG_KEY_BODY';
    logMcpInitialMe(log,login({errorCode:privateValue,legacyRefusal:privateValue}));
    logMcpInitialGuide(log,{status:'unavailable',origin:privateValue,code:privateValue});
    logMcpInitialGuide(log,{status:'available',origin:privateValue,guide:privateValue,entry:privateValue,guideUrl:privateValue,
      bindingDigest:privateValue,guideDigest:privateValue,opSeq:1,delivered:false});
    logMcpInitialSetupFailure(log,'initial_me',new Error(privateValue));
    const serialized=JSON.stringify([log.info.mock.calls,log.warn.mock.calls]);
    expect(serialized).not.toContain(privateValue);expect(serialized).toContain('UNCLASSIFIED_ERROR_CODE');
    expect(log.info.mock.calls.at(-1)?.[0]).toEqual({stage:'house_guide',status:'available'});
  });
  it('preserves known thrown codes and stage while suppressing stack/message fields',()=>{
    const log=logger();logMcpInitialSetupFailure(log,'house_guide',new Error('HOUSE_GUIDE_FETCH_FAILED'));
    expect(log.warn.mock.calls[0]?.[0]).toEqual({stage:'house_guide',status:'threw',errorCode:'HOUSE_GUIDE_FETCH_FAILED'});
  });
  it('redacts invalid statuses and never calls a runtime or makes a retry',()=>{
    const log=logger();logMcpInitialMe(log,login({status:'PRIVATE_STATUS'} as unknown as Partial<LoginResult>));
    logMcpInitialGuide(log,{status:'PRIVATE_STATUS'} as unknown as HouseGuideResult);
    expect(JSON.stringify(log.info.mock.calls)).not.toContain('PRIVATE_STATUS');
    expect(log.info.mock.calls.map(c=>c[0].status)).toEqual(['unknown','unknown']);
  });
});
