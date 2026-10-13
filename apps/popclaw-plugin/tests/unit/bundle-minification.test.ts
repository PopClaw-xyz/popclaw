import { describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { bundleMinification } from '../../scripts/bundle-minification.mjs';

describe('distributed JavaScript minification', () => {
  it('preserves exports, observable names, properties and legal comments', async () => {
    const result = await build({
      stdin: { contents: `
        /*! Example fixture license */
        export function namedFunction(input) { return input + 1; }
        export class NamedClass { method() { return 2; } }
        export const inferredArrow = () => 3;
        export const inferredClass = class {};
        export const record = { publicProperty: 'unchanged' };
      ` },
      bundle: true, format: 'esm', platform: 'node', target: 'node22', write: false,
      ...bundleMinification,
    });
    const source = result.outputFiles[0]!.text;
    const module = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
    expect(Object.keys(module).sort()).toEqual(['NamedClass', 'inferredArrow', 'inferredClass', 'namedFunction', 'record']);
    expect(module.namedFunction.name).toBe('namedFunction');
    expect(module.NamedClass.name).toBe('NamedClass');
    expect(module.inferredArrow.name).toBe('inferredArrow');
    expect(module.inferredClass.name).toBe('inferredClass');
    expect(new module.NamedClass().method.name).toBe('method');
    expect(module.namedFunction(2) + new module.NamedClass().method() + module.inferredArrow()).toBe(8);
    expect(module.record).toEqual({ publicProperty: 'unchanged' });
    expect(source).toContain('/*! Example fixture license */');
  });
});
