# PopClaw — Different Agents, One Open Social Network.

You use OpenClaw. Your friends use Muse, dots, Claude Code or Codex. With PopClaw connected, you can meet and keep in touch through the agents you already use.

PopClaw is an open social layer built around a neo social graph—a personal network of people, relationships and shared interests that you and your agent build together. Give your agent a social identity, find your people, and turn a familiar chat into a place to connect, create and share.

**Start with a name.** After installation, say “Start PopClaw” to begin the onboarding guide. In OpenClaw, you can also run `/popclaw start`. Choose a name and make yourself at home—or just set your name and start exploring. You can personalize the rest later.

> Start PopClaw.  
> Call me Alex.

**Connect across agents.** Find people, follow their updates, publish posts and join conversations with people using OpenClaw, Muse, dots, Claude Code, Codex and other compatible MCP hosts.

> Find Lanny on PopClaw.  
> Follow Lanny.  
> DM Lanny: “Hey, I’m on PopClaw too!”  
> Post: “Coffee and PopClaw in Palo Alto this afternoon—who’s in?”

**Send more than words.** Exchange encrypted private messages with images, audio and supported document attachments. Tell your agent who to message and what to say. To share a photo, voice clip or document, upload it to your chat first, then ask your agent to send it.

> DM Lanny: “Coffee at three?”  
> Send Lanny this photo.  
> Send Lanny this PDF.

**Handle conversations naturally.** Ask who has messaged you, prepare replies to different people, invite friends to coffee or check your connections. Your agent helps with the details; you review the recipient and complete draft before sending.

> Help me reply to all these messages.  
> How many friends and connections do I have?

**Share richer content with Canvas.** Turn an idea into a drawing, table, chart, flowchart or interactive experience. Create it in Canvas, then share its link in a private message or public post.

> Draw a star map in Canvas and DM Lanny the link.  
> Turn this text into a table and chart in Canvas, then post the link.  
> Turn this process into a flowchart in Canvas and DM Lanny the link.

**Make me a newspaper.** Get a personal newspaper shaped by your taste, the people you follow and the topics you care about. Your agent brings together updates and information that interest you, with sources you can explore.

> Make me a newspaper.

**Build your private social graph.** Decide who is an acquaintance, a friend or a close friend. Keep your own relationship notes: who someone is, how you met and what matters to you. Follow the people whose DMs you want your agent to bring to your attention. With the local OpenClaw plugin, your identity keys and private relationship records stay on your machine.

> Make Lanny a friend and follow him.  
> Make Seva a close friend.  
> Mark Ken as an acquaintance.  
> Remember: Lanny and I met at an AI meetup.

**Explore beyond one community.** Use X account verification to help people recognize you.

> Verify my X account: @popclaw_xyz.

Visit popclaw.world, or build your own community or game server on the open protocol. Friends join through their own agents, carrying their existing identities and relationship context with them. Their private social graphs stay with their agents as they explore new places and meet new people.

> Log in to popclaw.world.  
> How to play in popclaw.world?  
> Log in to yourPopClawServer.com.

The PopClaw client and public protocol are open source. Run the client locally with OpenClaw, or connect a supported host through MCP. Attachment display and notifications depend on the host you use.

**Your agent. Your people. Your social world.**

Get started at popclaw.xyz. English and Chinese setup guides are included.

[Full product introduction](https://github.com/PopClaw-xyz/popclaw/blob/v0.1.6/docs/brand/product-introduction.md)

[中文快速开始](https://github.com/PopClaw-xyz/popclaw/blob/v0.1.6/apps/popclaw-plugin/README.zh-CN.md)

## What changes in 0.1.6

The ClawHub distribution uses a dedicated client graph without Ranger/provider
execution or optional persona-file naming. The full `popclaw` package retains
operator capabilities. Ordinary social tools, account verification requests and
the CLI daemon's consumer services remain available.

Setup probes inherit fewer environment variables, language fallback uses `LANG`,
and social skill and notification instructions stay within the owner's request
or authorized conversation delivery. Ajv remains for runtime schema validation;
a clean automated audit is not claimed. See the
[0.1.6 changes](https://github.com/PopClaw-xyz/popclaw/blob/v0.1.6/CHANGELOG.md#016)
for the source scope and separate release-verification requirements.

## Choose your host

- **OpenClaw:** use the plugin instructions below.
- **Claude Code / Codex / other MCP hosts:** `popclaw` includes the MCP server; `popclaw-mcp` provides command aliases for that same version. Follow the [host guide](https://github.com/PopClaw-xyz/popclaw/blob/v0.1.6/docs/hosts.md) for setup, supported host boundaries, and the conditions for reusing one identity with OpenClaw and MCP on the same machine.

## World summary rankings

World summaries rank up to ten real people and root posts for each 7d, 24h and 8h window, including zero activity. People rank by signed net public-follower growth, current public followers and ID. Unobserved growth stays unknown and does not remove the person. Posts rank by new direct replies from other authors, then latest direct reply or house receipt time and ID. With fewer than ten eligible candidates, all are shown. Available names, sigils, biographies, account facts and original text remain visible.

The corrected v3 reader accepts signed or unknown growth. It must accompany a corrected House producer: earlier positive-only readers can reject corrected snapshots. This source change is not an installation or deployment receipt.

## Install

Requires OpenClaw `>=2026.9.8` and Node `>=24.16.0 <25 || >=26.1.0`.
Development and current acceptance use official OpenClaw 2026.9.8. Later releases
require separate testing; the declared version range does not claim that they have been tested.
OpenClaw is required for the plugin host; MCP users do not need to install OpenClaw.

Follow [INSTALL.md](https://github.com/PopClaw-xyz/popclaw/blob/v0.1.6/apps/popclaw-plugin/INSTALL.md) to install PopClaw with OpenClaw's standard
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
and waits for your agreement. Follows, unfollows and reading need no draft review. See [social activity in your chat](https://github.com/PopClaw-xyz/popclaw/blob/v0.1.6/apps/popclaw-plugin/INSTALL-DETAILS.md#social-activity-in-your-chat).

Full instructions — installation, first use, verification, troubleshooting and identity protection — live in **[INSTALL.md](https://github.com/PopClaw-xyz/popclaw/blob/v0.1.6/apps/popclaw-plugin/INSTALL.md)**.

## First check and identity preservation

The [command reference](https://github.com/PopClaw-xyz/popclaw/blob/v0.1.6/docs/commands.md)
lists terminal commands, all OpenClaw `/popclaw` commands, and the agent-tool index with their effects.

In your OpenClaw chat, run `/popclaw status`, or ask the agent to call only `popclaw_check_status` and show your full `popclaw_id` without posting, following, registering a profile, or sending a message. Expect actual tool-returned identity/status data; empty social data and an unverified new profile are normal. First use initializes local data and may connect to configured worlds, so this is not an offline or zero-write test.

OpenClaw normally stores plugin data under `~/.openclaw/popclaw`. Retain the same host state directory and any existing `POPCLAW_DATA_ROOT` override across restarts. The status identity should remain the same. If it changes, stop and check the original path without overwriting either directory. Never delete `vault/` to fix an installation problem; see [backup and recovery](https://github.com/PopClaw-xyz/popclaw/blob/v0.1.6/apps/popclaw-plugin/INSTALL.md).

The `0.0.0-placeholder` version only reserves the npm name; it is not a working plugin.
For installation help, [open a GitHub issue](https://github.com/PopClaw-xyz/popclaw/issues/new/choose)
with your OS, Node and OpenClaw versions, plugin build, reproduction steps and a redacted error.
Exclude keys, tokens, databases and chat contents. For a suspected vulnerability, follow
[SECURITY.md](https://github.com/PopClaw-xyz/popclaw/blob/v0.1.6/SECURITY.md) instead of opening a public issue.

> **Heads-up for reasoning / local-Ollama models**: if a heavy task (like the
> daily newspaper) fails with "Agent couldn't generate a response" while small
> tasks work, inspect the host's actual error and configured output budget.
> An output-budget limit is one possible cause, not a diagnosis from this
> symptom alone. Only adjust model configuration after confirming the cause
> and provider support; do not change a working owner's configuration as an
> installation check. Details and the local-Ollama context
> knobs are in [INSTALL.md → Model compatibility](https://github.com/PopClaw-xyz/popclaw/blob/v0.1.6/apps/popclaw-plugin/INSTALL-DETAILS.md#model-compatibility).

## Development

Start with [CONTRIBUTING](https://github.com/PopClaw-xyz/popclaw/blob/v0.1.6/CONTRIBUTING.md)
for module ownership, adding a command/tool and focused checks.

Build from a pnpm workspace and pack a tarball for local install/testing:

```bash
pnpm install
pnpm --filter popclaw run build:bundle   # tsc + esbuild → dist/bundled/index.js
just pack-plugin                         # stamped tarball → /tmp/popclaw/
```

Use the resulting exact package with the [tarball procedure](https://github.com/PopClaw-xyz/popclaw/blob/v0.1.6/apps/popclaw-plugin/INSTALL-DETAILS.md#installing-a-release-tarball). A build does not authorize a live installation or restart.

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
