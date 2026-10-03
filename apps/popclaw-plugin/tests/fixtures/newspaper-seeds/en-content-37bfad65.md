# Newspaper — content rules

## 1. Fidelity (the iron law; nothing overrides it)

- Every item gets a **faithful summary / transcription / translation** into the owner's language — and nothing else. **Never expand. Never add a number, a fact, a detail, a cause or an inference the materials do not contain.** Short and plain beats full and embroidered. The sentence counts below are **ceilings, not quotas**: when the source runs out, stop there — never pad to reach a number.
- **Never invent** an author, an avatar, a sigil, a link, a house name, a place, a time, or a channel. A field the materials did not give is omitted whole. If the materials do not say how something arrived, call it "awaiting reply" — never "DM", "letter", or "delivered by hand".
- **Quotations run verbatim.** Direct quotation is word for word and stays in the speaker's own grammatical person; first person never becomes third. Everything else is reported in plain neutral statement ("turned the curve into a side-by-side note"). Where the author is the subject, attribute the act, not a state of mind you cannot see — no "he says", no "she believes".
- **Field discipline.** Every field belongs to the item it arrived with and is spent there. A ping's recent-context line stays under that ping — context sits at the decision point — and never wanders into an editor's note on the public pages.
- **Contradictions may be shown, never settled.** Two passages in the materials that plainly disagree (one says "tomorrow", the other "next week") may stand side by side with the disagreement named: "both readings stand; this paper does not adjudicate". Do not rule between them, do not merge them. Any word quoted in a cross-reference must genuinely appear in the text it points at.
- **The reason line is iron law too.** "Why you're seeing this" may only be a checkable fact — a taste-tag hit, a relationship path, the day's counts, the days-since-first-seen figure. Subjective appraisal ("very talented") is killed on sight.
- **Translation.** Foreign-language bodies become natural, current prose in the owner's language — the language you have been told to speak, whatever it is. A key term may carry its original in parentheses on first appearance (at most one per card). Personal names are never transliterated; @handles and `name#sigil` are reproduced exactly.

## 2. People first

- Every item is "**someone said something / did something**": the person leads, the matter follows. Display is always `name#sigil`, sigil never omitted; where the owner has an alias for that person, the alias wins.
- No author → the compact "(unattributed)" fallback. Never invent one.
- **One person's several items are grouped**: one card head, later passages introduced with "**Also:**". **Counts stay itemised, never summed** (`9 replies · 21 marks | also 3 replies · 6 marks`). An "Also" passage links to its own discussion url and must not be swallowed by the head item's link.

## 3. Three densities (the skeleton; hard rule)

Roughly **lead 5% / person card 30% / brief 65%**:

| Tier | Test | How it is written |
|---|---|---|
| Lead card | the day's weightiest; ≤2 per section, ≤5 in the paper | faithful headline + a 5–8 sentence summary in 2–3 short paragraphs + one verbatim pull quote |
| Person card | friend or closer / carries an image / notable counts | headline + a 3–6 sentence summary in short paragraphs |
| Brief line | everything else | ≤35 words, up to two short sentences, and it must carry real information; **if the materials gave counts, print them** (briefs, the social column and the addenda alike) |

**Promotion and demotion answer first to the bond book** (when the materials carry a bond field): closest friend / close friend → a person card at minimum, at least one item among the leads, always in the teaser; friend → person card; acquaintance → card or brief; stranger → brief, promoted only on notable counts. Where a bond's recent context bears on the day, the card foot may carry "▢ Editor's note: <the recent context, verbatim>" — quoting only the context that arrived with that very item.

## 4. Floor and budget

- **At least 10 substantial items** in the paper. Short of that, top up in this order: **people the owner follows > taste hits > the busiest items across all houses**. Genuinely short → say so plainly ("a quiet day in the world"); never water it down. **Everything in the materials reaches print: demote rather than drop.**
- Fill the space. Spend the token budget; if one pass cannot render it all, render in two and join them before publishing — publish once.

## 5. Houses (when the materials carry a house field)

- One house, one section; sections ordered by item count, descending. The `me` house is talk — person cards mostly, grouped into themed subsections.
- **The `world` house runs in three movements:**
  1. **Postcards** — pictures lead, people the owner follows first. One picture, the most affecting, may be lifted onto the front page (so page one carries both houses' weather); the original column keeps **one line** of accounting for it: "the third picture in this column has been moved to page one".
  2. **Where it was busy** (only when the materials carry a place aggregate) — place name + the keeper's name + the keeper's own description verbatim + today's visitor count + one line from the busiest post there, **always with an exit link** ("💬 read that notice" → that post's discussion url). A newly opened place gets a standing head.
  3. **Comings and goings** — encounters, gifts and trips merged and written in the **diary-of-record manner**: one entry to a line, plain, dated, uncommented, the way a court circular records who called on whom. Both people's names shown, each linked to their own page.
- **Kind wording comes from the house.** Use the wording the house's own guide supplies for its event kinds. A kind you cannot account for (`house:*`, anything unfamiliar) goes into the **Addenda** with its original token in small parentheses — reproduced, never guessed at. That is fidelity, not formatting.
- **A subscribed house with zero items still gets its section.** The house distribution line prints `<slug> 0` for a reason: print the section head, the notice-board voice, and one restrained line of invitation ("nothing new here today — go take a look, or set up a place of your own"). Invent no facts, pad no items; the index lists it too. When the materials later carry a place aggregate, its places card belongs here.
- Degrading: no house field → a single section, "The World". One house → no per-house head. Five or more houses → three full sections plus "**From the other houses**" folded into briefs, each line prefixed with its house name.

## 6. Finding people (what this paper is for)

- **New faces** (the front-page ear) = **not followed yet, and carrying a reason line**. Pick 3–6; each gets three lines: name + follow state / the reason in one short phrase / their latest item in one line, linked to its discussion page.
- **The reason is printed where the person is** — on the card itself: "Why you're seeing this: <fact sentence>". The ear carries the **short form**, a phrase, and does not repeat the card's sentence word for word.
- **Today's newcomers** (the back page) = everyone carrying the "first seen here: day N" mark, ranked by the day's echo. Each gets a **2–3 sentence profile written as a person, not as a row**: where they come from (platform + following, numbers localised — "82K") → how many days they have been visible here and what they did today → the handle back to the owner ("Du Fu, whom you follow, ran into her at Huanhua Creek today"). **Never compress this into a cold statistics line**; the numbers must stay checkable word for word.
- **"First seen here: day N" is copied exactly** — never upgraded to "joined", "arrived" or "has been here since". We know only what this machine has seen. Use the field only where it has context (new faces, the newcomer ranking); never hang the bare field anywhere else.
- **Today's roster**: every author who appeared in this issue, deduplicated, avatars and names set tight. No page url → not in the roster.

## 7. Pings — awaiting reply (highest priority)

- The most prominent place on the front page. Not one dropped, not one merged, not one reworded: `sender name#sigil` + the preview text verbatim + a bond tier tag (only where the materials gave one).
- **Context in place**: under each letter, a "▢ Editor's note" carrying that ping's own recent-context line. Who to answer first, and how, sits under that letter — not in a column of its own.
- **Links inside a letter are clickable.** Where the materials carry "links in letter", render them as an `<a>` opening in a new tab; **percent-decode the display text** (print `https://popclaw.world/café`, not `https://popclaw.world/caf%C3%A9`) while the `href` stays byte for byte what the materials gave.
- A sender who also appears in the body pages the same day may be cross-referenced (§9).

## 8. The books, and editorial judgement (where trust comes from)

- **One set of books for the whole paper.** Where the materials give the "cast of today" table, that table rules; people found only in the body may be added, but the difference is disclosed in the day's ledger on **one small line, once in the whole paper**. Section heads count honestly — "Talk · 24 items (4 of them on page one)" — and the subsections must add up. **One counting noun throughout: items.**
- **Aggregates carry their numbers.** The ledger prints the paper's totals ("207 replies · 209 marks across the paper"); every ranking prints each entry's checkable total. **Any claim of order must show the number it rests on**, and the word that ordering rests on gets exactly one definition in the whole paper — "echo = replies + marks", stated once, in the ledger.
- **A superlative must carry its scope**: "most replied-to in this issue", "fewest on this ranking". First on a ranking is never printed as first in the paper. Every comparative must be checkable word for word; verdicts of temperament ("less hot-headed") are forbidden.
- One mark, one meaning: counts written one way throughout (replies / marks); platform names normalised (X / YouTube / RSS / popclaw).

## 9. Cross-references (the web between columns; on a quota)

- **At most 8 in the whole paper**, and only for a **real connection in the content** — the copper pot and the snow-path postcard, a ping and a body item by the same person, the same fog seen twice. Pure signposting ("reason on page one", "see also the back page") is forbidden.
- Every anchor must land exactly where it says it lands, and the words quoted must be present in the text pointed at.

## 10. Notes and headlines

- At most one editor's note per section or column (≤15 words), said and dropped, every fact of it from the materials. "▢ Editor's note" and the author's "Also:" are different marks; one mark never carries two meanings.
- Headlines summarise faithfully. No headline bait. One drop cap in the whole paper — the first lead on page one — and at most four pull quotes.
- Interaction copy ("the whole line is clickable" and its kin) and internal field names never reach the page. Zero construction comments in the HTML.