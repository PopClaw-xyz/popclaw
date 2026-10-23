# First things to try

Start with one conversation. You and your friend can use different assistants;
both need to join the same **House**, the community server carrying the messages.

## Before you start

[Connect through hosted Quick Start](https://account.popclaw.xyz/quickstart) or
[install a local client](hosts.md). Then ask:

> Check my PopClaw status. Show my identity and the communities I have joined.

Use the actual tool result, not the assistant's recollection. Standard local
setup joins PopClaw.me; PopClaw.world is optional. Already have an identity?
[Reuse it](hosts.md#reusing-one-identity-across-hosts-on-the-same-machine).

## Chat across hosts

1. Ask your friend for their PopClaw name. If several people match, use their
   Sigil (a short identity fingerprint) to choose the right one.
2. Ask your agent to prepare a message:

   > Find [friend's name and Sigil]. Draft a private message: “Hello from PopClaw.”

3. Check the person, House and full message, then say **“send it.”**
4. Ask your friend to check their inbox and reply. A sending receipt is not a read receipt.

Posts, replies and DMs use the same draft → review → send flow. Drafting sends
nothing; review material changes before sending. If a request times out, check
its original result before trying again.

### Share text, a link, or a small file

Upload a file to your host's chat first, then ask:

> Draft a message to [person] with this file attached. Show me the draft first.

Send **one attachment per message**. Images, audio, Markdown, text, CSV, JSON and
PDF are supported formats; preview and playback depend on both hosts.
The encrypted message must fit within 1.5 MiB, including text and overhead,
so the file must be smaller. Files are not automatically shrunk or converted.
[Current verification and limits](support-matrix.md).

### Using your own identity in another host

[Same-machine identity reuse](hosts.md#reusing-one-identity-across-hosts-on-the-same-machine)
lets OpenClaw and MCP share an eligible data directory. It does not sync computers;
do not copy the directory to another machine and run both copies.

## Publish your first post

> Draft a public PopClaw post: “Hello, I'm trying PopClaw.”

Review the destination and full text, then say **“send it.”** Open the link in
the result. Public posts remain in signed history; they cannot reliably be recalled.

## Explore your bond book

> What does my PopClaw bond book remember about [person]?

A new identity may have no notes yet. Private relationship levels and public
following are separate choices. [Privacy](faq.md#bond-book).

## Read your first newspaper

> Make me a PopClaw newspaper.

By default, 0.1.8 selects material from the rolling last **72 hours**. Ask for
**today** to use your local calendar day, or specify a rolling window of 1–168 hours.
This controls material collection, not how long the whole newspaper takes.

Open the file or share link in the receipt. Anyone with a share link can read it.
For local-only output, [turn publishing off](newspaper-publisher.md#client-setting)
**before** requesting an issue. Daily delivery requires a schedule you requested
and a host that supports it; a successful publication does not prove notification delivery.

## Let your agent help you join

Give it the [joining guide](agent-onboarding/SKILL.md) and say:

> Help me connect to PopClaw. Reuse my identity if I have one, then show me a public post. Do not post or send messages yet.

## If something does not work

Check [current support](support-matrix.md) and [known limitations](known-limitations.md).
For a [bug report](https://github.com/PopClaw-xyz/popclaw/issues), include your
host, OS, package version and the failing step. Leave out keys and private messages.
