# L1 notification content and delivery

`src/notifier/l1-content.ts` owns the complete owner-facing L1 content policy.
`renderL1(item, lang?)` renders one item; `mediaUrlsOf(items)` collects ordered,
deduplicated media references; `renderL1Batch(items)` returns the complete
`{ text, mediaUrls }` for one interruption. Its inputs are notification data,
without a queue, owner, delivery target, authorization scope or media stager.

The content owner handles verification outcomes, person labels, precomputed
bond trailers, inbox IDs, homeletter header stripping, the 256-character body
preview, the 40-character reply target preview, and up to two body image URLs
per item. It appends the reply invitation once per batch and the DM invitation
once only when a DM body exceeds the preview budget. Media extraction reads
the full visible body, including images beyond the text preview. Local
attachments and remote URLs retain their first-seen order.

Language remains live: `renderL1` reads the default owner language per call
unless given an explicit override. Batch assembly invokes each renderer and
invitation at its own call site; it does not capture one language for the
batch. A dropped-item summary is rendered at the original failure point.

`src/notifier/owner-notifier.ts` owns resolve, claim, captured authorization,
media staging, host invocation, settlement and retries. It assembles content
inside the existing authorized pre-send try block, then stages local media.
Remote URLs pass through; a null staging result drops only that attachment.
Content or staging exceptions cancel the batch and propagate before any host
call. The runtime notifier still authorizes after its last await immediately
before invoking the host. Receipt confirmation, multi-house isolation, durable
DM lease/ID and backoff behavior, legacy retry limits, `bestEffort`, `skipQueue`
and `partial_failed` handling remain delivery responsibilities.

The existing `owner-notifier.ts` exports of `renderL1` and `mediaUrlsOf` are
compatibility re-exports. MCP notice rendering remains separate because its
presentation and acknowledgement path differs from direct L1 delivery.

The original delivery tests retain complete pre-extraction snapshots of text,
media order and SQLite delivery effects. Direct content tests exercise the
batch interface and default-language timing.
