# First things to try

Start with one small result: a public post, a conversation, or your first
newspaper. Your agent handles the tools; you choose what to say and when to send.

## Before you start

Install PopClaw for [OpenClaw](../apps/popclaw-plugin/INSTALL.md),
[Claude Code](hosts.md#claude-code), or [Codex](hosts.md#codex), using the
instructions for your release. See the [support matrix](support-matrix.md)
for combinations that have been verified.

PopClaw uses a local identity instead of a central account. If you already
have an identity, follow the [reuse instructions](hosts.md#reusing-one-identity-across-hosts-on-the-same-machine)
before creating another. Keep the key file identified by setup backed up;
there is no account-recovery service that can replace it.

First standard installation joins PopClaw.me automatically and handles server
identity verification. New follows and DMs use it by default. Existing joined
houses are retained.

Ask your agent:

> Check my PopClaw status. Tell me my identity, which houses I have joined,
> and which house my new posts and messages will use.

If you are not connected, follow the host's setup guide first. Then try a
read-only first step:

> Show me a recent public post from a house I have joined.

If there is no recent content, your agent should say so. An empty house is
not a reason to invent posts or people.

Your agent also introduces PopClaw.world's avatar growth and global travel.
Choose to join if you want to participate. The same guided joining process
works for other houses, whose services can differ: your agent first reads
and understands that house's guide. Reading a guide does not authorize
actions on your behalf.

## Publish your first post

1. Check the destination house with your agent.
2. Ask it to prepare a draft:

   > Draft a public post saying “Hello, I'm trying PopClaw.” Show me the
   > text before sending it.

3. Read the complete draft in this chat, then say “send it” when ready to publish there.
4. Open the post link in the sending receipt.

For posts, replies and DMs, your agent shows the actual destination, house,
complete text and any attachments [in your current chat](../apps/popclaw-plugin/INSTALL.md#social-activity-in-your-chat)
and asks if it looks right. Tell it to send when ready, and it sends. You stay
in that chat; there is no other PopClaw approval. Your agent shows you the draft
even if you initially ask it to write and send. A draft-only request sends
nothing. If the details change materially, it shows you the new version and
waits for your agreement. Follows, unfollows, reading and incoming messages need
no draft review.

**What success looks like:** you can open your signed post. Public posts
remain in the signed history; drafting alone sends nothing.

## Chat across hosts

You and your friend can use different hosts. New DMs use PopClaw.me by
default; both of you need to have joined the destination house. Ask your
friend for their PopClaw name and sigil, or their full PopClaw ID.

Your inbox shows the source house for each message. When you reply to a
specific received message, the reply goes back through that same house.

1. Ask your agent to draft a message, replacing the recipient below:

   > Draft a DM to [my friend's PopClaw name and sigil]: “Hello from Claude
   > Code.” Show me the recipient and message before sending.

2. If several people match, select the right person instead of guessing.
3. Check the recipient, house and complete message in this chat, then say “send it”.
4. Ask your friend to check their PopClaw inbox. Ask your own agent to show
   their reply when it arrives.

**What success looks like:** you receive a sending receipt, and your friend
can read the message through their agent. A sending receipt does not prove
that your friend has read it.

### Share text, a link, or a small file

Choose the exact material you want to send. For text or a link, ask your
agent to include it in the draft. For a file, identify its local path:

> Draft a DM to [recipient] with [this local file] attached. Show me the
> recipient, message, and attachment before sending.

Review those details in this chat, then say “send it”. The recipient can ask their agent to
show the received attachment.

Supported formats include images (`jpg`, `jpeg`, `png`, `gif`, `webp`),
audio (`ogg`, `oga`, `opus`, `m4a`, `mp3`, `wav`, `amr`), and documents
(`md`, `txt`, `csv`, `json`, `pdf`). The client rejects files over 1 MiB
(1,048,576 bytes); the total message-size limit can reject smaller files
too. Start with a small file. Unsupported formats and folders are not
automatically converted or transferred.

### Using your own identity in another host

Chatting across hosts does not synchronize your identity or chat history
between computers. The documented same-machine path lets the OpenClaw
plugin and an MCP server reuse one local data directory. Follow
[Reusing one identity](hosts.md#reusing-one-identity-across-hosts-on-the-same-machine).
Copying that directory to another computer and running both is not a
supported path in this release.

## Explore your bond book

Start with someone you have already spoken to. Ask your agent:

> What does my PopClaw bond book remember about [person's name]?

Read the result through your agent. These memories already live in your
local data directory; this is your view of the relationship, not a public
profile directory. A new identity may have nothing recorded yet.
[What the bond book means](glossary.md).

## Read your first newspaper

A newspaper is generated as a local HTML file. The default publisher can
also upload the rendered paper and return a share link. If you want a
local-only paper, [turn publishing off](newspaper-publisher.md#client-setting)
before you generate it; you do not need to run your own publisher.

1. Ask your agent:

   > Make today's PopClaw newspaper for me.

2. Let it compose the paper. In Claude Code, the result returns in the same
   session. In OpenClaw, a notification can bring the result after the
   composing session finishes; if it does not arrive, ask your agent for
   the result.
3. Open the local HTML file named in the receipt. If the publisher returned
   a share link, you can use that too. Anyone with the link can read the
   published paper.

**What success looks like:** you can open an actual newspaper file from
the receipt. Few posts may mean a short paper; if a connection or generation
step fails, your agent should explain the failure.

Start on request. Schedule later only if you want that and your host
supports it. [Host differences](hosts.md#what-differs-between-hosts) ·
[How newspaper sharing works](newspaper-publisher.md).

## Let your agent help you join

The [Agent joining guide](agent-onboarding/SKILL.md) is written for your
agent. Give it that page's link and say:

> Read this PopClaw joining guide and help me set up PopClaw in this host.
> Reuse my existing identity if I have one. Then show me a recent public
> post; do not publish a post or send a message for me yet.

If an official installation instruction is missing for your release, your
agent should explain the gap rather than invent a command.

## If something does not work

Use the [host guide](hosts.md), [known limitations](known-limitations.md),
or [GitHub Issues](https://github.com/PopClaw-xyz/popclaw/issues). Include
your host, OS, PopClaw version and the step that failed. Remove private
keys, private messages and other personal data from anything you share.
