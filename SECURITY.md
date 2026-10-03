# Security

PopClaw holds a private key and exchanges sealed messages on your behalf.
We take reports about it seriously and we prefer to hear about problems
privately first.

## Supported versions

| Version | Supported |
| --- | --- |
| 0.1.x Developer Preview | Yes, latest release only |

## Report a vulnerability

Use one of these private channels:

- **GitHub:** the "Report a vulnerability" button under this repository's
  Security tab. If the button is unavailable, use the email address below.
- **Email:** `security@popclaw.xyz`.

Do not open a public issue or pull request for a suspected vulnerability.

A useful report includes the affected version or commit, the host and
operating system, what an attacker gains, and the smallest reproduction using
synthetic identities and data. If you need to share something sensitive to
prove the issue, say so and we will arrange a private transfer. Never send
private keys, session tokens, real direct messages or an unredacted database.

## What to expect

We will acknowledge the report, tell you what we plan to do, and keep you
informed. This is an early project maintained by a small team; we do not
promise a response time, and we will say so rather than miss a deadline we
set. Fixes ship as a new 0.1.x release with a note in the changelog, and a
vulnerability that affects a released version gets a GitHub Security
Advisory on this repository, with a CVE where one applies. We are glad to
credit reporters who want to be credited.

## Scope

In scope: this repository (the client plugin, the MCP server, setup, and the
protocol bundle), the [PopClaw Ranger Map](https://github.com/PopClaw-xyz/lorehouse-mvp)
reference server, and the hosted houses `popclaw.me` and `popclaw.world`.

Please do not test against the hosted houses in ways that degrade them for
others or touch other people's data. Reproduce on a local Ranger Map instance
where you can.

Good-faith research within that scope is welcome: if you follow this page,
avoid other people's data, and give us a chance to fix before disclosure, we
will not pursue action against you and will treat the report as the
contribution it is.

## What is and is not a vulnerability

Read the [threat model](docs/threat-model.md) first. Some limits are
documented design choices in 0.1.0 rather than bugs: no key recovery or
rotation, no forward secrecy for direct messages, DM metadata visible to a
house, local data unencrypted at rest, and a house being able to omit or
delay events without the client detecting it. Reports that show one of these
limits being *worse* than documented are very welcome.
