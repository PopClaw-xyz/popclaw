# Public protocol contracts

This directory is the entry point to PopClaw's public protocol.

The authoritative protocol source in this repository is the pinned,
cryptographically verified bundle at the repository root:

- **Location:** [`protocol/`](../../protocol)
- **Version:** `0.1.0-public-envelope-01.6` (baseline `public-envelope-01`)
- **Integrity:** 271 source files, bundle SHA-256
  `d01bd7a060cdaa2bb35937b67e5fb4dc64a350a646b30cf2fe5dd919701ea54b`
  (see `CONTRACT-MANIFEST.json` inside the bundle; every client protocol
  build re-verifies it via `scripts/verify-bundle.py`)

## What the bundle contains

- `packages/contracts/proto/` — canonical `.proto` message definitions
  (events, identity, profile, invite, quest, world interaction, public
  stream, house sessions) plus the compiled `descriptor.pb`
- `packages/contracts/protocol/` — the protocol specification set:
  `public-envelope-01/SPEC.md`, signing, canonicalization, receipts,
  runtime, trust and limits documents, and the pinned JSON schemas
  (`retained/` for private messages, profiles and participation)
- `packages/contracts/ts/` — the TypeScript codec and algorithms packages
  consumed by the client build
- `packages/contracts/python/`, `packages/contracts/crates/` — reference
  Python and Rust implementations of the same canonical rules
- `BUILD.md`, `TOOLCHAIN.json` — how to build and verify the bundle
  standalone, with pinned tool versions

## Working with the protocol

Do not hand-edit anything under `protocol/` — the bundle digest
is verified on every build and any local change fails the build. Protocol
changes ship as a new pinned bundle version.

To build and verify the bundle standalone:

```sh
cd protocol
python3 scripts/verify-bundle.py   # integrity check against the manifest
```

See `BUILD.md` inside the bundle for the full standalone toolchain.

Implementer-facing documents: start with
`packages/contracts/protocol/public-envelope-01/SPEC.md` and
`IMPLEMENTERS.md` in the same directory.
