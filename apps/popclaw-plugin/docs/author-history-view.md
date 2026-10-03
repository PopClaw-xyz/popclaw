# Author history presentation

`src/tools/author-history-view.ts` owns the complete successful response from
`popclaw_author_latest`: headers, platform suffixes, item order and text, source
links, owner-local dates, shortfall copy and the long-format footer.

`renderAuthorHistory({ author, items, requestedCount, webBaseUrl, lang })` is
synchronous. Its item type is a readonly field projection of
`WorldSnapshotItemLike`; it takes no runtime, store or client. The query handler
captures copy language before fetching sources, while dates resolve the live
owner timezone through `timeContext` during rendering. Body decoding comes
directly from `ingress/feed-item-projection.ts`.

Requests of at most five items use untruncated previews without dates or a
footer. Larger requests decode envelope text, fall back to the preview for
missing or empty decoded text, trim, and slice at 500 UTF-16 units before adding
an ellipsis. The selected body is trimmed after fallback selection; decoder-specific
whitespace behavior is preserved. Decode errors still
propagate. Both formats share one native/mirror/missing-source link policy.

`world-tools.ts` retains count normalization and the 100-item query cap, source
aggregation and resolution, alias and declared owner-name precedence, failure
and empty responses, and side effects. `person_asked` is recorded after
resolution and before author fetching, even when that fetch fails. Observed
native post ids are remembered after a nonempty snapshot and before rendering,
including a rendering error.

Focused validation: `tests/unit/tools/author-history-view.test.ts` checks the
public text interface; `tests/unit/tools/world-tools.test.ts` checks the actual
registered tool and side effects. Resolver, notable-author and summary-format
tests cover the retained source dependencies.
