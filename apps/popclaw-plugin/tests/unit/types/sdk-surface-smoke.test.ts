import { describe, it, expectTypeOf } from 'vitest';
import type {
  OpenClawPluginApi,
  PluginCommandContext,
  PluginLogger,
} from 'openclaw/plugin-sdk/plugin-entry';
import type { sendDurableMessageBatch } from 'openclaw/plugin-sdk/channel-outbound';

/**
 * Compile-time sentinel for the real SDK surface (replaced handwritten shim self-checks with real
 * types on 2026-08-11). Pin only the surfaces actually used so host changes fail here instead of
 * silently breaking a live path for three weeks, as in #374.
 */
describe('openclaw SDK surface — 编译期哨兵', () => {
  it('OpenClawPluginApi 上我们用的那几格还在', () => {
    expectTypeOf<OpenClawPluginApi>().toHaveProperty('on');
    expectTypeOf<OpenClawPluginApi>().toHaveProperty('registerService');
    expectTypeOf<OpenClawPluginApi>().toHaveProperty('registerCommand');
    expectTypeOf<OpenClawPluginApi>().toHaveProperty('registerTool');
    expectTypeOf<OpenClawPluginApi>().toHaveProperty('registrationMode');
    // ADR-0035: load modes other than full must not open sockets or databases.
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
    // Without this, the write-ahead queue replays the notification as a second message.
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
