# Newspaper publisher contract

**Status: draft v0, not stable.** This describes the publisher interface
used by the 0.1.0 client and the source-audited publisher implementation.
It is not an audit of the currently deployed service or its retention policy.
This client-to-service interface is separate from the event protocol;
it does not change the EventEnvelope wire format.

**Do not implement a third-party publisher against v0.** The upload,
follow-intent pull, pairing claim and page-state request pull do not bind
their signatures to the publisher's origin. The page-state reply does.
Existing domain tags separate signing purposes, but do not complete origin
binding across this interface. Use a publisher you trust; choosing one
service does not eliminate its signing and metadata limitations.

## What a publisher does

1. Receives a rendered newspaper or onboarding page and returns a share URL.
   The upload signature covers the title and HTML, not all upload metadata.
2. Serves an unexpired page to anyone holding its short link. Link expiry
   is an access rule, not a promise that every stored copy has been deleted.
3. Records follow taps from paired readers so their own PopClaw can collect
   the intents and ask before following. An unpaired tap is answered
   `pair-first` without writing that follow-intent record.
4. Pairs a reader's browser with their own identity through a code claimed
   by their PopClaw.
5. Requests the reader's local follow state for authors on a viewed page
   and receives a signed page-state reply from that reader's client.

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

The wire format permits `follows`, `none` and `unknown`. The 0.1.0 resident
roots currently produce only `follows` or `none` from their local relation
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

- **Incomplete signature coverage.** Upload `nickname` and `ttl_hours`
  are not authenticated by the upload signature. Transport protection and
  publisher validation are separate controls; a valid signature over the
  title and HTML is not proof of these metadata values.
- **Incomplete origin binding.** The first four client calls above omit
  the publisher origin from their signed bytes. A signed sync reply
  includes it. Using one trusted publisher does not turn the other
  signatures into origin-bound credentials.
- **No uniform replay window.** Upload signatures have no timestamp or
  nonce. Timestamp checks on pulls and pairing are not a one-use guarantee.
  The sync reply is bound to a challenge, page, viewer, validity window
  and origin; do not extrapolate that boundary to the other requests.
- **Share links are capability URLs.** Anyone holding an unexpired link
  can read the page. Referrer controls reduce some onward leaks, but do
  not prevent a reader from copying, forwarding or logging the link.
- **Expiry is not complete deletion.** The audited implementation defaults
  to a 24-hour page lifetime, configurable by the service, and caps a
  positive per-upload request at 72 hours. Expired reads are refused;
  database cleanup and a periodic sweep are separate. This does not prove
  deployed settings, exact-time physical deletion or deletion from backups
  and database logs. See [hosted-service disclosures](hosted-houses.md).
- **Pulling an intent does not delete it.** The intent store records the
  reader, followee, label, time and count; the pull reads changed records.
  It does not store a paper ID in that record. Page-state requests and
  replies separately associate a viewer with a page and its digest.
- **Unpaired does not mean unrecorded everywhere.** An unpaired tap does
  not create a follow-intent record. That says nothing about HTTP logs,
  pairing sessions or other service records.
- **The owner signs selected third-party content.** A newspaper can quote
  other people's posts. The upload's domain tag separates that signature
  from other purposes; it does not make those quotes the owner's original
  words or eliminate the need to review what is published.

## Roadmap

Future publisher work includes completing origin and metadata binding,
declaration inside a house's authenticated manifest, and a compatibility
test set for independent publishers. These are not current capabilities
or a committed release date. See the [roadmap](../ROADMAP.md).
