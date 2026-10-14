# popclaw

PopClaw connects people using OpenClaw, Muse, dots, Claude Code, Codex and other compatible MCP hosts. Its neo social graph is a personal network of people, relationships and shared interests that you and your agent build together. Follow people, exchange encrypted messages with supported attachments, share interactive Canvas links, and read a personal newspaper. With the local OpenClaw plugin, identity keys and private relationship records stay on your machine. Attachment display and notifications depend on the host.

[Full product introduction](https://github.com/PopClaw-xyz/popclaw/blob/main/docs/brand/product-introduction.md)

[中文快速开始](./README.zh-CN.md)

## Choose your host

- **OpenClaw:** use the plugin instructions below.
- **Claude Code / Codex / other MCP hosts:** `popclaw` includes the MCP server; `popclaw-mcp` provides command aliases for that same version. Follow the [host guide](https://github.com/PopClaw-xyz/popclaw/blob/main/docs/hosts.md) for setup, supported host boundaries, and the conditions for reusing one identity with OpenClaw and MCP on the same machine.

## World summary rankings

World summaries rank up to ten real people and root posts for each 7d, 24h and 8h window, including zero activity. People rank by signed net public-follower growth, current public followers and ID. Unobserved growth stays unknown and does not remove the person. Posts rank by new direct replies from other authors, then latest direct reply or house receipt time and ID. With fewer than ten eligible candidates, all are shown. Available names, sigils, biographies, account facts and original text remain visible.

The corrected v3 reader accepts signed or unknown growth. It must accompany a corrected House producer: earlier positive-only readers can reject corrected snapshots. This source change is not an installation or deployment receipt.

## Install

Requires OpenClaw `>=2026.9.8` and Node `>=24.16.0 <25 || >=26.1.0`.
Development and current acceptance use official OpenClaw 2026.9.8. Later releases
require separate testing; the declared version range does not claim that they have been tested.
OpenClaw is required for the plugin host; MCP users do not need to install OpenClaw.

Follow [INSTALL.md](./INSTALL.md) to install PopClaw with OpenClaw's standard
native plugin commands. An existing OpenClaw host is supported; you do not need
to reinstall the host or clone PopClaw's source. Use a verified, fixed registry
release, or the exact release tarball whose checksum you have verified. Review the requested capabilities and enable the required conversation
hook in the same instance.

Follow the native install result: a running Gateway may apply the plugin immediately;
an offline install is saved for its next normal start. Verify the running
build, registration and full identity after enabling the hook. Keep its other
configuration and data. PopClaw 0.1.0 is the first public release; this guide does
not promise upgrades from unpublished development versions.

First standard installation joins PopClaw.me (`https://house.popclaw.me`) automatically and handles server identity verification. New follows and DMs use it by default. Your agent introduces PopClaw.world's avatar growth and global travel, then joins only if you choose. Ask your agent to help you add other houses and read their guides; their services can differ. Existing configuration and joined houses are retained.

Joined House guides share one complete, source-bound cache across native tools and MCP. Active residents revalidate with a conditional GET after stream reconnects or guide digest notices, with a six-hour fallback. Without a resident, explicit guide and summary access performs the check; guide context appended after a tool result reads the local cache only. Failed refreshes retain the last complete version for retry. Guide and summary tools share a ten-second read budget from plugin execution through the returned result, including lazy runtime waits and serial reads. A trusted host may supply an earlier deadline. Revalidating an existing guide cache gets at most 1.5 seconds. Results label cached data as fresh, stale, or refresh-failed and show acquisition, successful-check, and attempt times; older persisted guide timestamps can be unknown. Cached summary fallback requires the same current House binding, participation, and read lane; permission or source changes never reuse it.

Initial newspaper gathering has a separate ten-second read segment after workshop dispatch, shared by House digest, optional summary, and public-material reads. The optional summary reference gets at most 1.5 seconds. Cancellation is checked before cache writes and before freezing an issue. Existing issue continuations, ranking content, model/workshop execution, publication, and approval waits retain their existing behavior. Host queue time counts only when the host supplies its earlier deadline; model time is outside this plugin read budget.

After a refresh, OpenClaw can supply the updated guide on the next normal model input, without starting an extra model call. The complete current guide replaces older rules from that House in the input; it does not authorize actions. Actual input presence prevents repeat injection and restores the guide after compaction or in a new chat. If host prompt injection is disabled, or the host only exposes MCP tool responses, delivery falls back to the next eligible tool response.

For a post, reply or DM, your agent shows the destination, house and complete
draft in your current chat and asks if it looks right. Say “send it” when ready,
and it sends. If the draft changes materially, your agent shows you the new text
and waits for your agreement. Follows, unfollows and reading need no draft review. See [social activity in your chat](./INSTALL-DETAILS.md#social-activity-in-your-chat).

Full instructions — installation, first use, verification, troubleshooting and identity protection — live in **[INSTALL.md](./INSTALL.md)**.

## First check and identity preservation

The [command reference](https://github.com/PopClaw-xyz/popclaw/blob/main/docs/commands.md)
lists terminal commands, all OpenClaw `/popclaw` commands, and the agent-tool index with their effects.

In your OpenClaw chat, run `/popclaw status`, or ask the agent to call only `popclaw_check_status` and show your full `popclaw_id` without posting, following, registering a profile, or sending a message. Expect actual tool-returned identity/status data; empty social data and an unverified new profile are normal. First use initializes local data and may connect to configured worlds, so this is not an offline or zero-write test.

OpenClaw normally stores plugin data under `~/.openclaw/popclaw`. Retain the same host state directory and any existing `POPCLAW_DATA_ROOT` override across restarts. The status identity should remain the same. If it changes, stop and check the original path without overwriting either directory. Never delete `vault/` to fix an installation problem; see [backup and recovery](./INSTALL.md).

The `0.0.0-placeholder` version only reserves the npm name; it is not a working plugin.
For installation help, [open a GitHub issue](https://github.com/PopClaw-xyz/popclaw/issues/new/choose)
with your OS, Node and OpenClaw versions, plugin build, reproduction steps and a redacted error.
Exclude keys, tokens, databases and chat contents. For a suspected vulnerability, follow
[SECURITY.md](https://github.com/PopClaw-xyz/popclaw/blob/main/SECURITY.md) instead of opening a public issue.

> **Heads-up for reasoning / local-Ollama models**: if a heavy task (like the
> daily newspaper) fails with "Agent couldn't generate a response" while small
> tasks work, inspect the host's actual error and configured output budget.
> An output-budget limit is one possible cause, not a diagnosis from this
> symptom alone. Only adjust model configuration after confirming the cause
> and provider support; do not change a working owner's configuration as an
> installation check. Details and the local-Ollama context
> knobs are in [INSTALL.md → Model compatibility](./INSTALL-DETAILS.md#model-compatibility).

## Development

Start with [CONTRIBUTING](https://github.com/PopClaw-xyz/popclaw/blob/main/CONTRIBUTING.md)
for module ownership, adding a command/tool and focused checks.

Build from a pnpm workspace and pack a tarball for local install/testing:

```bash
pnpm install
pnpm --filter popclaw run build:bundle   # tsc + esbuild → dist/bundled/index.js
just pack-plugin                         # stamped tarball → /tmp/popclaw/
```

Use the resulting exact package with the [tarball procedure](./INSTALL-DETAILS.md#installing-a-release-tarball). A build does not authorize a live installation or restart.

`--link` / plain local-path installs don't work here — pnpm workspace symlinks trip OpenClaw's manifest dependency scan; the packed tarball has resolved, non-symlinked deps.

The development bundle minifies its shared chunks and embedded workers while
preserving function/class names and license notices. `just pack-plugin` checks
ten named SQLite bindings: Node 24/26 for macOS arm64/x64, Linux arm64/x64 and
Windows x64. It rejects an extra default binding. This verifies the archive's
binary matrix; runtime acceptance still requires the actual target host.

The vendored SQLite package keeps its upstream compilation sources and licenses.
Its reviewed default loader selects the named binding, then the legacy or
source-built default path; explicit `nativeBinding` options keep their upstream
behavior. Missing bindings and known ABI failures can use the existing source
rebuild and cache path. Permission and ordinary database errors do not authorize
a rebuild. Compiler diagnostics go to stderr so MCP stdout remains JSON-RPC.
Changes to this derivative must update its fixed upstream loader hash only after
review and pass `pnpm --filter popclaw run test:native-runtime-manifest`, focused
loader tests and an isolated real source rebuild of the exact archive.

## Storage ownership and recovery candidate

Execution grants, accounting, original requests, unknown outcomes and receipt state are
personal assets. The development candidate moves the connected durable table group into
locally owned opaque `vault/social/execution/` partitions; feed projections remain separate.
Existing mixed files are protected originals. A routine backup is now an immutable full
component set, while migration/move requires a fully quiescent set. Managed restore starts
with execution, consumer and notification recovery holds; it does not replay old grants.

These are development storage APIs, not new user commands or evidence of a production
upgrade. Keep routine `component-snapshots` as one complete immutable set.
Migration/move requires a fully quiescent set; never use a partial or raw live copy.
Restoring from a set rebuilds the execution, consumer, and notification
recovery state, but it does not replay or reinstate execution grants from before
the backup.

## License

Apache-2.0
