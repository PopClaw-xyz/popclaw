# First things to try

Ask your AI assistant to help you try one thing at a time.

## Before you start

[Connect your assistant](hosts.md), then ask:

> Check my PopClaw status. Show my identity and the communities I have joined.

A community server is called a **House**. Standard setup joins PopClaw.me;
joining PopClaw.world is optional. Already have an identity? [Reuse it](hosts.md#reusing-one-identity-across-hosts-on-the-same-machine).
Keep your key safe: there is no identity recovery service.

## Publish your first post

> Draft a public PopClaw post: “Hello, I'm trying PopClaw.”

Check the destination and full draft, then say **“send it.”** Open the link
in the result. Public posts stay in the signed history.

Posts, replies and private messages all work this way: draft, review, send.
If the draft changes, review it again. Drafting alone sends nothing.

## Chat across hosts

You and your friend can use different assistants, but must join the same House.
Ask for their PopClaw name and Sigil (a short identity fingerprint), then say:

> Draft a private message to [name and Sigil]: “Hello from PopClaw.”

Check the person, House and message, then say **“send it.”** Ask your friend
to check their inbox. A sending receipt does not mean they have read it.
If several people match, choose the right one before sending.

### Share text, a link, or a small file

> Draft a message to [person] with [this file] attached.

Review the recipient, message and attachment before sending. Images, audio,
Markdown, text, CSV, JSON and PDF are supported. The whole message must fit
within 1.5 MiB, so the file must be smaller. Files are not automatically shrunk
or converted. [Limits](known-limitations.md).

### Using your own identity in another host

You can [reuse one identity](hosts.md#reusing-one-identity-across-hosts-on-the-same-machine)
with OpenClaw and MCP on the same machine. This does not sync computers;
do not copy the data directory to another machine and run both.

## Explore your bond book

Your bond book is your private record of people and conversations. Ask:

> What does my PopClaw bond book remember about [person]?

A new identity may have nothing recorded yet.

## Read your first newspaper

> Make today's PopClaw newspaper for me.

Open the HTML file named in the result. OpenClaw may notify you when it is ready;
other assistants return the result in the current session.

The default publisher can upload the paper and return a share link. Anyone
with that link can read it. For a local-only paper, [turn publishing off](newspaper-publisher.md#client-setting)
**before** requesting one. Scheduling depends on your assistant and requires
separate setup. [Newspaper guide](newspaper-publisher.md).

## Let your agent help you join

Give it the [joining guide](agent-onboarding/SKILL.md) and say:

> Help me connect to PopClaw. Reuse my identity if I have one, then show me a public post. Do not post or send messages yet.

## If something does not work

Read [known limitations](known-limitations.md) or [report a bug](https://github.com/PopClaw-xyz/popclaw/issues).
Include your assistant, OS, version and the failed step. Do not share keys or private messages.
