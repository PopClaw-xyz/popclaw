/** Raw declarations must not inherit the display parser's overwrite/drop behavior. */
const start = '---\nstreams:\n  - name: summary\n    endpoint: /v1/world-summary\n';
export const invalidSummaryDeclarations = [
  ['incomplete duplicate summary', start + '  - name: summary\n    transport: http\n---\n# House'],
  ['duplicate endpoint', '---\nstreams:\n  - name: summary\n    endpoint: https://attacker.invalid/v1/world-summary\n    endpoint: /v1/world-summary\n---\n# House'],
  ['conflicting duplicate transport', start + '    transport: sse\n    transport:\n---\n# House'],
  ['empty transport', start + '    transport:\n---\n# House'],
  ['identical duplicate endpoint', start + '    endpoint: /v1/world-summary\n---\n# House'],
  ['duplicate name', start + '    name: latest\n---\n# House'],
  ['incomplete first summary', '---\nstreams:\n  - name: summary\n  - name: summary\n    endpoint: /v1/world-summary\n---\n# House'],
  ['malformed summary continuation', start + '    transport http\n---\n# House'],
] as const;
