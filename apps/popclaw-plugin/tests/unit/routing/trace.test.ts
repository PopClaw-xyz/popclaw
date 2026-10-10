import { describe, it, expect } from 'vitest';
import {
  formatRoutingTrace,
  ROUTING_TRACE,
  sampleOwnerText,
  type RoutingTraceFacts,
} from '../../../src/routing/trace.js';
import { traceEnabled } from '../../../src/observability/trace.js';

const TEXT_ON = { POPCLAW_TRACE_TEXT: '1' };
const TEXT_OFF = { POPCLAW_TRACE_TEXT: '0' };

const facts = (over: Partial<RoutingTraceFacts> = {}): RoutingTraceFacts => ({
  fire: 1,
  l1: true,
  l2: [],
  house: { entries: 0, slugs: [] },
  lang: { detected: null, switched: false },
  attachments: 0,
  ...over,
});

describe('routing trace switch', () => {
  it('is wired to the shared switch under the module name "routing"', () => {
    expect(traceEnabled(ROUTING_TRACE, { POPCLAW_TRACE: 'routing' })).toBe(true);
    expect(traceEnabled(ROUTING_TRACE, { POPCLAW_TRACE: 'all' })).toBe(true);
    expect(traceEnabled(ROUTING_TRACE, { POPCLAW_TRACE: 'newspaper' })).toBe(false);
    expect(traceEnabled(ROUTING_TRACE, { POPCLAW_TRACE: 'off' })).toBe(false);
    expect(traceEnabled(ROUTING_TRACE, { POPCLAW_ROUTING_TRACE: '1' })).toBe(true);
  });
});

describe('formatRoutingTrace', () => {
  it('covers every passenger in one line, quiet defaults', () => {
    expect(formatRoutingTrace(facts())).toBe(
      'popclaw: routing trace #1 · l1=injected · l2=none · l3=0entries · lang=undetected · attach=0',
    );
  });

  it('reports L2 tool + trigger phrase, and the house a house-side entry came from', () => {
    const line = formatRoutingTrace(
      facts({
        fire: 7,
        l2: [
          { tool: 'popclaw_newspaper', trigger: '晨报' },
          { tool: 'popclaw_world_guide', trigger: 'postcard', from: 'world' },
        ],
      }),
    );
    expect(line).toContain('#7');
    expect(line).toContain('l2=popclaw_newspaper("晨报"),popclaw_world_guide("postcard"@world)');
  });

  it('reports L3 entry count with the source house slugs', () => {
    expect(formatRoutingTrace(facts({ house: { entries: 5, slugs: ['world', 'main'] } }))).toContain(
      'l3=5entries@world,main',
    );
  });

  it('reports the language verdict and whether it switched', () => {
    expect(formatRoutingTrace(facts({ lang: { detected: 'zh-CN', switched: true } }))).toContain(
      'lang=zh-CN(switched)',
    );
    expect(formatRoutingTrace(facts({ lang: { detected: 'en', switched: false } }))).toContain('lang=en ');
  });

  it('reports L1 skipped (kill switch) and the attachment count', () => {
    const line = formatRoutingTrace(facts({ l1: false, attachments: 2 }));
    expect(line).toContain('l1=skipped');
    expect(line).toContain('attach=2');
  });

  it('privacy: `ownerTextSample` is the ONE free-text field, and only the switch can fill it', () => {
    // Types enforce the invariant: only these keys may enter the log. Any new field must satisfy this assertion.
    // The only permitted free-text field is ownerTextSample, produced by sampleOwnerText
    // and therefore governed by POPCLAW_TRACE_TEXT. A second free-text field makes this fail.
    const structural = ['attachments', 'fire', 'house', 'l1', 'l2', 'lang'];
    const withSample: RoutingTraceFacts = {
      ...facts(),
      ownerTextSample: sampleOwnerText('我的交情', TEXT_ON),
    };
    expect(Object.keys(facts()).sort()).toEqual(structural.sort());
    expect(Object.keys(withSample).filter((k) => !structural.includes(k))).toEqual([
      'ownerTextSample',
    ]);
    expect(sampleOwnerText('我的交情', TEXT_OFF)).toBeUndefined();
  });

  it('prints the owner’s own words only when a sample was taken', () => {
    expect(formatRoutingTrace(facts())).not.toContain('text=');
    expect(formatRoutingTrace(facts({ ownerTextSample: '我的交情' }))).toContain('· text="我的交情"');
  });
});

describe('sampleOwnerText — the beta-only owner-words sample (lexicon tuning)', () => {
  it('is governed by the shared switch: off → nothing is built at all', () => {
    expect(sampleOwnerText('我的交情', TEXT_OFF)).toBeUndefined();
    expect(sampleOwnerText('我的交情', TEXT_ON)).toBe('我的交情');
  });

  it('strips the host envelope — sender name / id / timestamp never enter the log', () => {
    expect(
      sampleOwnerText('[Telegram Alice id:1 2026-07-31T09:12] Alice: 我的交情本呢', TEXT_ON),
    ).toBe('我的交情本呢');
  });

  it('flattens newlines so one turn stays one log line', () => {
    expect(sampleOwnerText('看下这个\n\n第二行  第三段', TEXT_ON)).toBe('看下这个 第二行 第三段');
  });

  it('truncates to 80 characters (not bytes — CJK counts as one)', () => {
    const long = '交'.repeat(200);
    const out = sampleOwnerText(long, TEXT_ON) ?? '';
    expect([...out]).toHaveLength(81); // 80 + the ellipsis
    expect(out.endsWith('…')).toBe(true);
    expect(sampleOwnerText('交'.repeat(80), TEXT_ON)).toBe('交'.repeat(80));
  });

  it('an empty / whitespace-only turn yields no field', () => {
    expect(sampleOwnerText('', TEXT_ON)).toBeUndefined();
    expect(sampleOwnerText('   \n ', TEXT_ON)).toBeUndefined();
    expect(sampleOwnerText(undefined, TEXT_ON)).toBeUndefined();
  });
});
