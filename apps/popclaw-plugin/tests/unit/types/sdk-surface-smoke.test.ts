import { describe, it, expectTypeOf } from 'vitest';
import type {
  OpenClawPluginApi,
  PluginCommandContext,
  PluginLogger,
} from 'openclaw/plugin-sdk/plugin-entry';
import type { sendDurableMessageBatch } from 'openclaw/plugin-sdk/channel-outbound';

/**
 * 真 SDK 面的编译期哨兵（前身是手写 shim 的自检，2026-08-11 换成真类型）。
 *
 * 只钉**我们真的踩在上面**的那几格：宿主升级把哪一格挪走了，这里当场红，
 * 而不是等真机上某条链路静默死掉三周（#374 的教训）。
 */
describe('openclaw SDK surface — 编译期哨兵', () => {
  it('OpenClawPluginApi 上我们用的那几格还在', () => {
    expectTypeOf<OpenClawPluginApi>().toHaveProperty('on');
    expectTypeOf<OpenClawPluginApi>().toHaveProperty('registerService');
    expectTypeOf<OpenClawPluginApi>().toHaveProperty('registerCommand');
    expectTypeOf<OpenClawPluginApi>().toHaveProperty('registerTool');
    expectTypeOf<OpenClawPluginApi>().toHaveProperty('registrationMode');
    // ADR-0035：`full` 之外的加载都不许开 socket/DB。
    expectTypeOf<OpenClawPluginApi['registrationMode']>().extract<'full'>().not.toBeNever();
  });

  it('service 是 start/stop(ctx) —— 不给句柄（stop 要收拾的东西留闭包里）', () => {
    type Service = Parameters<OpenClawPluginApi['registerService']>[0];
    expectTypeOf<Service['start']>().parameters.toMatchTypeOf<[{ stateDir: string }]>();
    expectTypeOf<Service>().toHaveProperty('stop');
  });

  it('三只 typed hook（api.on，不是 registerHook —— #374）都还在', () => {
    type HookName = Parameters<OpenClawPluginApi['on']>[0];
    expectTypeOf<'before_dispatch'>().toMatchTypeOf<HookName>();
    expectTypeOf<'before_prompt_build'>().toMatchTypeOf<HookName>();
    expectTypeOf<'gateway_stop'>().toMatchTypeOf<HookName>();
  });

  it('sendDurableMessageBatch 仍收 skipQueue（@internal，exactly-once 全靠它）', () => {
    // 没了 = 通知会被写前队列重放成第二条。
    expectTypeOf<Parameters<typeof sendDurableMessageBatch>[0]>().toHaveProperty('skipQueue');
  });

  it('命令 ctx 上我们捕获投递地址用的那几格还在', () => {
    expectTypeOf<PluginCommandContext>().toHaveProperty('sessionKey');
    expectTypeOf<PluginCommandContext>().toHaveProperty('channel');
    expectTypeOf<PluginCommandContext>().toHaveProperty('to');
    expectTypeOf<PluginCommandContext>().toHaveProperty('accountId');
    expectTypeOf<PluginCommandContext>().toHaveProperty('messageThreadId');
    expectTypeOf<PluginCommandContext>().toHaveProperty('args');
  });

  it('logger 只收字符串（visibleLogger 那层的前提）', () => {
    expectTypeOf<PluginLogger['info']>().parameters.toEqualTypeOf<[string]>();
  });
});
