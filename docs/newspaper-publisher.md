# Newspaper publisher contract

**Status: draft v0, not stable.** This describes the publisher interface
used by the 0.1.8 client. Browser routes and retention notes describe the
[previously audited publisher implementation](https://github.com/PopClaw-xyz/popclaw/blob/6e6218bfb04c914f6380be8e343fca1f1114b23a/docs/newspaper-publisher.md#browser-endpoints),
not a fresh audit of the deployed service or its settings.
This client-to-service interface is separate from the event protocol;
it does not change the EventEnvelope wire format.

**Do not implement a third-party publisher against v0.** The upload,
follow-intent pull, pairing claim and page-state request pull do not bind
their signatures to the publisher's origin. The page-state reply does.
Existing domain tags separate signing purposes, but do not complete origin
binding across this interface. Use a publisher you trust; choosing one
service does not eliminate its signing and metadata limitations.

## What a publisher does

A publisher accepts rendered newspaper/onboarding HTML, returns capability
share links, pairs reader browsers, records their follow intents and exchanges
page-author follow state with their clients. The signature, identity and
retention boundaries for each operation are below.

## Client setting

The publisher is an owner-level setting. `canvas_base_url` belongs in
`<data root>/config/plugin.json`, not the host's configuration. Under
OpenClaw the default data root is `~/.openclaw/popclaw`; for MCP use the
`POPCLAW_DATA_ROOT` recorded by setup. Restart the corresponding PopClaw
host process after changing this setting.

| Precedence | Source |
| --- | --- |
| 1 | `canvas_base_url` in `<data root>/config/plugin.json` |
| 2 | `POPCLAW_CANVAS_BASE_URL` environment variable |
| 3 | Default: `https://canvas.popclaw.me` |

Unset means fall through to the next source. An explicit empty string at
the selected level disables the publisher. A nonempty configuration value
takes precedence over an empty environment variable. The client does not
take this address from a house's manifest or guide in v0.

### Without a publisher

Set `canvas_base_url` to `""` and restart the host to stop uploads,
follow-intent polling and page-state synchronization. The newspaper is
still composed and written locally:

- `<data root>/data/newspaper/issues/<YYYYMMDD-HHmmss>-<issue>.html`
- `<data root>/data/newspaper/last-newspaper.html`

There is no publisher share link or follow doorbell. Publisher-dependent
tools such as `popclaw_canvas` and `popclaw_pair_browser` report
`PUBLISHER_UNAVAILABLE`; the local paper remains usable. Disabling this
service does not disable house traffic, model calls or all resources that
a browser may fetch when opening a paper. See the
[threat model](threat-model.md#services-your-client-contacts).

## Workshop observation and final delivery

An OpenClaw `waitForRun` rejection means observation was lost, not that the
child stopped. The dispatcher keeps that child's original deadline and waits
for its completed publication. Unfinished/refused batches do not settle the
wait; a host-observed terminal status follows the normal receipt path.

The fallback is process-local. It does not restart the workshop, retry an
expired SDK call or persist a recovery task. After observation loss, settlement
clears local hand-off/duplicate-prevention state but retains the possibly active
host session. Publication or expiry does not authorize deleting it.

**Publication and chat delivery are separate.** Delivery still needs an
authorized owner route and a successful notifier send. This fallback cannot
repair a missing route, lost caller authority or a process restart. The
40-second inline and 12-minute workshop budgets remain unchanged. See the
[dispatcher](../apps/popclaw-plugin/src/newspaper/dedicated-session.ts).

## Collection window

The initial request uses the last **72 hours** by default. Choose integer
`hours` from 1–168, or `today: true` for the owner's local calendar day; both
together are refused. The slash equivalents are `/popclaw newspaper N` and
`/popclaw newspaper --today`.

Initial gather freezes one inclusive epoch-second lower bound, with no upper
time bound, for public preparation and local filtering. Workshop dispatch
forwards the selection; its actual gather freezes the cutoff. Cursor pages and
picks continue that issue without recomputing the window. See
[window selection](../apps/popclaw-plugin/src/newspaper/window.ts).

The [public-material index](../apps/popclaw-plugin/src/ingress/public-material-index.ts)
accelerates collection without replacing verification:

- A connection-local SQLite TEMP index preserves canonical observations and
  checkpoints before filtering. Initial collection verifies history; later
  collections process new frames and verify eligible original bytes.
- Index metadata, change queues and accounting roll back together. External
  writes, source-policy changes, discontinuities or a new connection rebuild
  it. Persistent protected-journal schemas and identity assets are unchanged;
  TEMP may use automatically removed files rather than only RAM.
- The connection-wide 100,000-frame ceiling stops incremental caching, not
  material collection. A later read rebuilds within the ceiling or falls back
  to full verification; query-only connections retain complete reads. Normal
  indexed reads use bounded original-frame lookups. Remote snapshots retain
  their existing explicitly partial coverage.
- Windowed results preserve candidates, original bodies, primary sources and
  order. An older source observation may be retained for primary-source
  deduplication without enumerating every older `alsoInHouses` attribution.
  Ordinary feed, search and author reads keep their existing behavior.

## Reading failures before publication

Initial collection has a [one-minute safety ceiling](../apps/popclaw-plugin/src/newspaper/read-policy.ts).
Declared digests, signed material acquisition and the optional summary reference
(up to 1.5 seconds) start independently. Local verification may take more than
ten seconds. Transport timeouts, earlier trusted parent deadlines, cancellation
and source-authority checks still apply. This scope grants no House authority;
Guide, Summary, writing and upload retain their own policies. Host setup and
tool wrappers can add to visible duration.

A summary or digest is editorial context, not verified article material.
Before saving a candidate basis, the client rechecks cancellation and authority;
a late response cannot authorize a new basis. Each synchronous validation call
captures each source once, checks every referenced frame/signature/body, then
rechecks source partition integrity, schema, DB and trust binding. Page,
selection and publication calls validate afresh; initial gather retains checks
both before persistence and on the saved document.

Ingress verification does not justify trusting later disk reads. Reusing a
cryptographic result would require identical canonical bytes, signature and key,
plus separate stored-byte/source/authority checks. A different verifier would
need acceptance/rejection compatibility tests. Those optimizations are not part
of the current read-budget change, which also gives no inode-level guarantee
against same-path physical file replacement.

Use the recorded stages to locate a failure:

| Evidence | What it establishes |
| --- | --- |
| Candidate manifest / `candidatePage=true` | Local progress; not proof the candidate reached the writer. Cancellation or a source change can still prevent return. |
| `materialPage`, `publishCalled`, `publishAccepted` | Distinct material, call and acceptance stages; a missing final receipt does not prove upload was attempted. |
| `stage.collectionFailure` | Safe failure code and available diagnostic fields, excluding origin URLs, headers, private content and raw errors. Missing fields mean unknown. |
| `budget=read-call` | The aggregate deadline; `HOUSE_REMOTE_TIMEOUT` alone does not identify a House or network phase. |
| Final publication receipt | Completed publication; tool-wrapper success alone is insufficient, and notification delivery needs separate evidence. |

Preserve the failed stage and safe diagnostics. Do not create repeated editions
to investigate an unfinished one. These are source guarantees, not proof of
successful operation on a particular deployment. The
[earlier investigation detail](https://github.com/PopClaw-xyz/popclaw/blob/6e6218bfb04c914f6380be8e343fca1f1114b23a/docs/newspaper-publisher.md#reading-failures-before-publication)
records the superseded ten-second aggregate deadline.

## Client endpoints and signature coverage

The client makes five types of request. A signature authenticates the
listed bytes; it must not be treated as covering every JSON field or query
parameter. The exact encodings are in
[canvas-signing.ts](../apps/popclaw-plugin/src/canvas/canvas-signing.ts).

| Method and path | Purpose | Signed scope |
| --- | --- | --- |
| `POST /v1/canvas` | Upload HTML; read the returned share URL | `canvas-upload` domain, title and HTML. Top-level `nickname` and optional `ttl_hours` are unsigned metadata; no publisher origin or freshness timestamp is signed. |
| `GET /v1/follow-intents` | Pull this identity's follow taps after a position | `intents-pull` domain, owner, nonce and timestamp. The `after` query position and publisher origin are not signed. The client refuses another owner's ID. |
| `POST /v1/pair/claim` | Claim the browser's pairing code | `pair-claim` domain, code, identity and timestamp; no publisher origin. |
| `GET /v1/sync-requests` | Pull page-state requests for this identity | Uses the same `intents-pull` signing format and four authentication headers as the follow-intent pull; no publisher origin. |
| `POST /v1/sync-reply` | Return local follow states for the requested page authors | `canvas-sync-reply-v1` domain, request ID, page ID and digest, viewer, validity window, sorted author/state pairs and `canvasOrigin`. |

The two signed GET calls carry `X-Popclaw-Id`, `X-Nonce`, `X-Ts` and
`X-Signature`. Upload and pairing claim carry their signatures in JSON;
the sync reply sends a `reply` object and its signature. The upload also
sends the identity used to verify its signature. These calls are
attributable to an identity, not anonymous analytics.

Domain prefixes already exist in this version. They are distinct from
publisher-origin binding; `intents-pull` is deliberately shared by two
endpoints. Do not construct signatures from this table: use the exact
byte layout in the linked source.

## Background traffic and page-state disclosure

With a publisher enabled and consumer storage available, a running
resident client starts page-state synchronization. It is not conditional
on having published a newspaper. OpenClaw must actually start its
registered service; installing a package alone is not this startup event.

The page-state loop makes an initial poll, then polls about every 60
seconds. Thrown failures cause backoff up to 15 minutes. The separate
follow-doorbell loop uses approximately 90-second, 5-minute and 30-minute
tiers and is also subject to its house activity gate.

For an accepted page-state request about its own identity, the client
sends the configured publisher a signed answer containing its local
follow state for the requested authors. The intended scope is the authors
of that page, not the entire follow list. The client caps a request at 200
authors but does not independently fetch the page to verify its author
list, so the publisher remains a trust dependency.

The wire format permits `follows`, `none` and `unknown`. The 0.1.8 resident
roots produce only `follows` or `none` from their local relation
projection; they do not yet produce `unknown` for missing history. These
answers are not proof of complete or up-to-date state at every house.
An attempted answer suppresses another answer for the same page digest
for five minutes, even if the publisher rejected it; that brake is local
and resets when the process restarts.

## Browser endpoints

The source-audited publisher exposes these browser routes. Browser
credentials are separate from client request signatures. A short link
allows reading the paper; it does not replace the reader's pairing cookie
for reading follow state.

| Method and path | Purpose | Identity mechanism |
| --- | --- | --- |
| `POST /v1/pair` | Create a pairing session and return a code | Creates the `pc_pair` cookie; not yet an authenticated reader |
| `GET /v1/pair/status` | Check pairing completion | `pc_pair`; completion establishes `pc_viewer` |
| `POST /v1/follow-intent` | Record a reader's follow tap | Valid page reference plus `pc_viewer`; an unpaired request returns `pair-first` without recording that intent |
| `GET /v1/page-state?c=…` | Read the reader's state for this page | Page short code plus `pc_viewer`; returns `unpaired`, `pending` or `ready` |

There are no `/v1/my-follows` or `/v1/owner-follows` routes in this
implementation. The surrounding publisher page receives the paired
reader's page-author state. It passes that state into the uploaded HTML's
sandboxed frame only when the reader is the page's publisher; this is not
a promise that every page author can see every reader's follow state.

## Known limitations of v0

- **Signatures cover only the bytes listed above.** Upload metadata is not
  authenticated; four client request types omit publisher origin. Transport
  protection and publisher validation do not expand signed scope.
- **No uniform replay boundary.** Upload has no timestamp/nonce. Timestamp
  checks on pulls and pairing do not ensure one use. Only the sync reply binds
  challenge, page, viewer, validity window and origin together.
- **Share links can spread.** Anyone holding a valid link can read the page.
  Referrer controls do not prevent copying, forwarding or logging it.
- **Expiry is not deletion.** The recorded implementation defaults to 24 hours,
  configurable by the service, and caps a positive per-upload lifetime at
  72 hours. Expired reads are refused; cleanup and periodic sweeps are separate.
  This establishes neither deployed settings nor physical deletion from
  databases, logs or backups. See [service disclosures](hosted-houses.md).
- **Intent collection does not delete records.** They retain reader, followee,
  label, time and count, without a paper ID. Separate page-state records bind
  reader, page and digest. An unpaired tap creates no intent, but HTTP logs,
  pairing sessions or other service records may remain.
- **Signed quotations remain third-party content.** The upload domain separates
  signing purposes; it does not make quoted posts the owner's original words
  or remove the need to review the paper.

## Roadmap

Future publisher work includes completing origin and metadata binding,
declaration inside a house's authenticated manifest, and a compatibility
test set for independent publishers. These are not current capabilities
or a committed release date. See the [roadmap](../ROADMAP.md).
