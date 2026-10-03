import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SUPPORTED_NODE_LINES,
  SUPPORTED_NODE_TEXT,
  parseNodeVersion,
  unsupportedNodeReason,
} from '../../../src/runtime/node-support.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = resolve(HERE, '../../../package.json');
const ROOT = resolve(HERE, '../../../../..');
const CI = resolve(ROOT, '.github/workflows/ci.yml');
/** The exporter that GENERATES the public repo's ci.yml, and so carries a
 *  second copy of the same pin. It is private-repo-only — it is not in its own
 *  INCLUDE_PATHS — so the exported tree has nothing to check here. */
const EXPORTER = resolve(ROOT, 'docs/release-review/export-popclaw-public.sh');
/** The image the server end runs. Private-repo-only for the same reason: the
 *  public repo ships the plugin, not our deployment. */
const DOCKERFILE = resolve(ROOT, 'deploy/Dockerfile.node-stack');
const SERVER_PKGS = ['apps/popclaw-canvas', 'apps/popclaw-web'].map((d) =>
  resolve(ROOT, d, 'package.json'),
);

/** The floor of the lowest supported line, which is what a CI pin must be:
 *  testing the OLDEST version we promise is the entire point of pinning. */
const FLOOR = [...SUPPORTED_NODE_LINES].sort((a, b) => a[0] - b[0])[0]!.join('.');
const pinIn = (file: string): string | null =>
  /^\s*NODE_VERSION:\s*"([^"]+)"/m.exec(readFileSync(file, 'utf8'))?.[1] ?? null;

describe('node-support', () => {
  // 单一真相：这张表是给运行时用的，engines 是给 npm 用的，两边说的必须是同一件事。
  // 谁改了一边忘了另一边，这条就红 —— 而不是等某台机器上出怪事才发现。
  it('和 package.json 的 engines.node 逐字一致', () => {
    const engines = JSON.parse(readFileSync(PKG, 'utf8')).engines.node as string;
    expect(SUPPORTED_NODE_TEXT).toBe(engines);
    // 文字之外，把范围也解出来比一遍，防止文案对了、表错了。
    const fromText = engines
      .split('||')
      .map((s) => /(\d+)\.(\d+)\.(\d+)/.exec(s)!)
      .map((m) => [Number(m[1]), Number(m[2]), Number(m[3])]);
    expect(SUPPORTED_NODE_LINES.map((l) => [...l])).toEqual(fromText);
  });

  // CI 是第三处说法。前两处早有这条测试绑着，ci.yml 没有——2026-09-17 抬地板时
  // 它被落下，CI 于是继续在一个插件自己拒绝启动的版本上跑，还一路绿着跑过下面
  // 那条「22.22.3 不受支持」的断言。漂移无声，正因为没人把它们绑在一起。
  // skipIf 的理由与导出脚本那条相同，不是偷懒：公开仓的 ci.yml 由导出脚本现生，
  // 真正导出的那棵树里这个文件是有的，这条照跑；只有手工移植的中间态候选树缺它。
  it.skipIf(!existsSync(CI))('CI 钉的版本 = 最低受支持线的下限', () => {
    const pin = pinIn(CI);
    expect(pin).not.toBeNull();
    expect(unsupportedNodeReason(`v${pin}`)).toBeNull();
    expect(pin).toBe(FLOOR);
  });

  // 公开仓的 ci.yml 不是拷过去的，是导出脚本用 heredoc 现生的——里面是**另一份**
  // 同样的 pin。只改 .github/ 那份，公开仓照样会诞生在一个自己 package.json
  // 禁止的 Node 上，而那是外部贡献者看到的第一眼。
  it.skipIf(!existsSync(EXPORTER))('导出脚本里那份 pin 与 CI 逐字相同', () => {
    expect(pinIn(EXPORTER)).toBe(pinIn(CI));
  });

  // 第三处说法：服务端。canvas / web 只在我们自己的镜像里跑，所以它们的 engines
  // 跟的是那一行 FROM，不是插件契约——两端的 Node 线不同是刻意的（CLAUDE.md
  // 「刻意的非常规设计」第⑥条）。2026-09-19 这条被写反过一次：六个包一律按插件
  // 契约声明，其中 canvas/web 因此宣称需要一个它们的部署根本不提供的 Node。
  // 声明跑到运行时前面，仓库就在说假话，而 pnpm 不强制 engines，没人会因此装不上。
  it.skipIf(!existsSync(DOCKERFILE))('服务端包的 engines 跟着镜像那一行走', () => {
    const from = /^FROM node:([0-9]+)[.-]/m.exec(readFileSync(DOCKERFILE, 'utf8'))?.[1];
    expect(from).toBeDefined();
    for (const pkg of SERVER_PKGS) {
      const declared = (JSON.parse(readFileSync(pkg, 'utf8')) as { engines?: { node?: string } }).engines?.node;
      expect(declared, pkg).toBeDefined();
      // 每一条被声明的线都必须是镜像给得出的那条。镜像挪一行，这里就红。
      for (const line of declared!.split('||')) {
        expect(/(\d+)\./.exec(line)![1], `${pkg} declares a line the image does not provide`).toBe(from);
      }
    }
  });

  it('低于本线下限 → 报出来（22.19 就是 issue #332 那台）', () => {
    expect(unsupportedNodeReason('v24.15.9')).toContain('below the supported floor');
    expect(unsupportedNodeReason('v26.0.9')).toContain('below the supported floor');
  });

  it('线上不支持的大版本 → 报出来', () => {
    expect(unsupportedNodeReason('v25.9.0')).toContain('not a supported line');
    expect(unsupportedNodeReason('v22.22.3')).toContain('not a supported line');
  });

  it('支持的版本 → null（含各线下限那一版本身）', () => {
    for (const v of ['v24.16.0', 'v24.19.0', 'v26.1.0', 'v26.8.2']) {
      expect(unsupportedNodeReason(v)).toBeNull();
    }
  });

  it('解不出版本就别拦（绝不因为自己的正则挡住启动）', () => {
    expect(parseNodeVersion('not-a-version')).toBeNull();
    expect(unsupportedNodeReason('not-a-version')).toBeNull();
  });
});
