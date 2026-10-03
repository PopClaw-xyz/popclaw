# smol-toml 1.8.0

`smol-toml.cjs` is the unchanged, self-contained `dist/index.cjs` from
https://registry.npmjs.org/smol-toml/-/smol-toml-1.8.0.tgz.
Its BSD-3-Clause license is retained in `smol-toml.LICENSE`.
The connector uses this parser to validate existing Codex TOML without requiring
an npm install, Python, or a custom partial TOML parser. It preserves the existing
TOML text and appends only the new PopClaw table; existing conflicting tables fail
without being overwritten. Update the parser and license together.
