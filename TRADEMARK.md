# PopClaw Trademark Policy

*English is the authoritative version; see [中文版](./TRADEMARK.zh-CN.md).*

The PopClaw™ **code** is free software under the Apache License 2.0. The
PopClaw **name and marks** are not. This document explains the difference and
tells you exactly what you may do without asking.

Apache-2.0 is explicit about this. Section 6 of the license grants you no rights
to our trade names, trademarks, service marks, or product names. That is not an
oversight — it is how open source and identity coexist. Anyone may take this
code and build on it. No one may take the name and speak as us.

## 1. The marks

The following are trademarks of the PopClaw project (whether or not marked with
™ in any particular place):

- **POPCLAW** / **PopClaw**, in any capitalization, and any name confusingly
  similar to it
- The **PopClaw logo** and the project's lantern device and other distinctive
  visual identity elements
- **LOREHOUSE** / **LoreHouse**, the name of the project's official server
  product. The generic word for any server that implements the protocol is
  *house*; LoreHouse is one house implementation among others, and the only
  one that carries this name.
- **L.SHOW**, **LORESHOW**, and the associated domains
- The organization identifier **PopClaw-xyz** and the domains **popclaw.me**,
  **popclaw.xyz**, **loreshow.com**, **l.show**, together with the project's
  official accounts on any platform

We do **not** claim trademark rights in the ordinary descriptive vocabulary the
project uses — words such as *ranger*, *sigil*, *bond-book*, *taste*, *charter*,
*butler*, or *world*. Use them freely to describe what your software does.

PopClaw is an independent project. It can run as a plugin for the OpenClaw
agent framework and connects to MCP hosts such as Claude Code and Codex, but it
is not affiliated with, endorsed by, or maintained by OpenClaw, its maintainers
or trademark holders, or by Anthropic, OpenAI, X Corp., Meta, TikTok, or
Google/YouTube. Provider or platform names identify compatibility only.
It is also unrelated to other
products that share the word, including the desktop AI companion marketed at
popclaw.ai.

## 2. What you may do, with no permission needed

We want the protocol to spread. These uses are always allowed, and we will never
ask you to stop:

- Stating truthfully that your software **implements the PopClaw protocol**, is
  **compatible with PopClaw**, **works with PopClaw**, or **connects to the
  PopClaw federation**.
- Naming your project in the `for popclaw` / `popclaw-compatible` form, so long
  as your own distinct name comes first: *"Foo, a PopClaw client"* is fine;
  *"PopClaw Foo"* is not.
- Running your own house, publicly or privately, and saying that it speaks the
  PopClaw protocol.
- Running a **house** and saying so. *House* is the generic word for any
  server that implements the PopClaw protocol; it is free for everyone: "Foo,
  a house for chess clubs", "a PopClaw-compatible house". If your house runs
  our software you may say so truthfully ("runs LoreHouse 0.x",
  "LoreHouse-compatible"); running LoreHouse does not make a house
  project-operated or endorsed.
- Redistributing **unmodified** official releases, with attribution intact.
- Packaging an official release for a Linux distribution, host marketplace, or
  package registry under the PopClaw name, including builds with only
  packaging-level changes (build flags, install paths, dependency pins, or
  clearly identified security backports), provided the package states the
  upstream version it is built from and that it is a downstream build. Changes
  that alter behavior fall under §4.
- Using the marks in articles, tutorials, talks, reviews, comparisons, academic
  work, and community discussion — including critical discussion.
- Using the logo unaltered to link to or refer to this project.

This is nominative use, and it is your right. We spell it out because a policy
that leaves it unsaid gets read as hostile, and because the value of a protocol
lies in other people being able to say they speak it.

## 3. What requires our written permission

- Naming a **fork, derivative, distribution, product, service, package, or
  company** `popclaw`, or any name confusingly similar to it. This explicitly
  includes host- or platform-qualified variants such as *PopHermes*,
  *PopClaw Pro*, *PopClaw Cloud*, *popclaw-ng*, *popclaw2*, and translations or
  transliterations of the mark into other languages or scripts.
- Any use that implies **official status, endorsement, affiliation, or
  certification** — including describing a server, client, or service as
  "official", "certified", "verified", or "the PopClaw network".
- Registering **domain names, social media handles, organization names, or
  package/registry namespaces** that consist of a mark alone or imply official
  status: `popclaw`, `@popclaw`, `popclaw-official`, `popclaw-cloud`,
  `getpopclaw`, and the like, on npm, crates.io, PyPI, ClawHub, container
  registries, and app stores. The bare names and the `@popclaw` npm scope are
  reserved for the project's own releases.

  Package, crate, module, and repository **identifiers** that contain the word
  as a truthful technical qualifier need no permission, in either position:
  `foo-popclaw`, `popclaw-foo`, `foo-for-popclaw`, `popclaw_exporter`. The
  package's own name or description must make clear that it is an independent
  work for or compatible with PopClaw, not an official release. (Product and
  service *names* still follow §2: your own name first.)
- **Modifying the logo** or creating derivative visual identity from it.
- Using the marks on **merchandise**, or in advertising for a product that is
  not this project.
- Using the marks in a way suggesting your **house is the PopClaw
  federation** rather than one house within it.
- Naming a server product, service, or distribution **LoreHouse**, or
  **LoreHouse <something>** with our word first, or describing your house as
  **the** LoreHouse or the **official** LoreHouse. "Runs LoreHouse",
  "LoreHouse-compatible", and "works with LoreHouse" are descriptive and need
  no permission; the product name is ours.

Forks are welcome under the license. Fork under a different name.

## 4. Modified versions

If you distribute a modified build, you must not present it as PopClaw. Change
the name, and make the change visible where a user would look: the package
name, the CLI banner, the version string, and the documentation. You may still
state truthfully that it is *derived from* or *compatible with* PopClaw.

This matters more here than in most projects. PopClaw signs and carries a
person's identity. A build that behaves differently while wearing our name puts
someone's keys, relationships, and reputation at risk on our reputation.

## 5. Federation and identity

Anyone may run a house — that is the point of a federated protocol, and we will
never restrict it. But an independent house is not us. Do not name your house,
its domain, or its branding in a way that suggests it is operated by, or
endorsed by, the PopClaw project. Call it what you like, say it is a house
that implements the PopClaw protocol, and, if true, that it runs LoreHouse.

## 6. If you are not sure

Ask. The test we apply is simple: **would a reasonable person, seeing this,
believe it came from us or was approved by us?** If yes, it needs permission. If
no, it is almost certainly fine.

Permission requests, questions, and reports of misuse: open an issue in this
repository, or contact the maintainers through the address in
[`MAINTAINERS.md`](./MAINTAINERS.md#contact).

## How we enforce

By asking first, then through the dispute processes of the registries and
platforms involved. We will never make trademark permission a condition of
protocol compatibility, and we will never cut off, throttle, or deprioritize a
house, client, or relay over a naming dispute. Operational measures against
impersonation, phishing, and abuse are a separate matter and remain in force.

## 7. Changes

We may update this policy. Changes are not retroactive: a use that complied when
you started remains permitted for a reasonable transition period.

---

*Nothing here restricts your rights under the Apache License 2.0 to use, modify,
and redistribute the code. This policy governs the name and marks only, which
that license does not grant.*
