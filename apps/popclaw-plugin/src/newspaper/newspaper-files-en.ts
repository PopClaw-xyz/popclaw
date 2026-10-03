/**
 * The English newspaper codex — the en-lane twin of `DEFAULT_CONTENT` /
 * `DEFAULT_LAYOUT` in `./newspaper-files.ts`.
 *
 * **Written, not translated** (decision D1 = A, decision doc §7). The zh v5
 * codex is 33KB of dense, idiomatic editorial law; parameterising ~8 slots out
 * of it would have made every English issue a live translation exercise for
 * whatever model the host happens to run. So each rule of the zh codex was read
 * for its INTENT and then restated in the terms English-language newspapers use
 * for the same thing — the zh "imperial-diary manner" becomes the manner of the
 * Court Circular, not a calque. Rule for rule, nothing dropped: same cardinal
 * rule, same three densities, same cross-reference quota, same scope-bound
 * superlatives, same card skeleton.
 *
 * The codex text itself must never argue from Chinese: an English editorial
 * codex that explains itself by contrast with zh typesetting reads as a
 * translation of one, whatever its provenance. Divergences are recorded here,
 * in the developer-facing header, and nowhere else.
 *
 * Two deliberate divergences from the zh codex, both load-bearing:
 *
 *  1. **Fonts.** Chinese needs four faces because it has no italic, so
 *     "typeset by the paper" vs "written by a person" has to be carried by a
 *     change of face. English has an italic and a live weight axis, so the same
 *     four-level distinction costs two webfonts: a blackletter masthead
 *     (the actual English masthead tradition — a script/handwriting face reads
 *     as a wedding invitation, not a front page) plus the EB Garamond family.
 *     The URL is interpolated from `./font-stylesheets.ts`, the same table F2's
 *     allowlist is computed from — the two used to be hand-synchronised, and a
 *     font the template prescribes but F2 rejects strips the paper of its fonts.
 *  2. **No kind translation table.** The zh codex carries one (Trip, Postcard,
 *     Encounter, Embodiment, SouvenirTransfer, each with its zh wording);
 *     per ADR-0041 that table belongs to the house's own guide, not to the
 *     plugin's default codex. The English codex ships only the fallback: a kind
 *     you cannot account for goes to the Addenda with its original token in
 *     small parentheses. (The zh table stays put until the world house
 *     publishes its own — removing it first would regress zh output.)
 */


export const DEFAULT_CONTENT_EN = `# Newspaper — content rules

> popclaw sets the page; you write the words. This file governs the **writing**:
> faithfulness, person first, length, voice. Links, avatars, pictures, counts,
> columns and ledgers are not yours — the materials will not even hand them to you.

## 1. Faithful (the iron rule, not negotiable)

- Every item gets a **faithful summary / transcription / translation** and nothing else. **Never expand. Never add a number, fact, detail, cause or inference the materials do not contain.** Plain beats decorated. **Sentence counts are ceilings, not quotas — when the source is short, stop.**
- **Never invent** an author, a place, a time, a channel or a lore-house name. A field the materials do not give is simply left out.
- **Quote verbatim.** A direct quotation is reproduced word for word and never turned from first person into third; when the author is the subject, report what they did, not what they "believe".
- **Contradictions may be shown side by side** — where the materials themselves disagree (one place says tomorrow, another says next week), you may print both and say so plainly ("both readings stand; this paper does not adjudicate"). Never merge them, never pick a winner.
- **One item's words stay on that item.** Nothing bleeds from one entry into another.

## 2. Person first

- Every item is "**someone said / did something**": the person leads, the matter follows, in the headline as much as in the summary.
- Use the alias where the owner gave one. An unattributed item still gets written — but **never grow an author for it**.
- The same person with several items writes as several items. Do not summarise across them ("she spent the day on X") — that is an inference.

## 3. Three densities (what decides your length)

| Tier | How it is marked | Length | Per issue |
|---|---|---|---|
| Front page | whatever you put in \`leads\` | faithful headline + 5–8 sentences in 2–3 short paragraphs | 3 |
| Card | marked \`card\` | headline + 3–6 sentences | about 12 |
| Brief | marked \`brief\` | one or two sentences, and they must carry real information | all the rest |

Pick \`leads\` by weight. **The owner comes first**: start with the items you chose for his taste
or for someone he knows (the ones you filed under \`taste\` / \`bond\`), then the bond book — someone
close gets at least one item on the front page and a line in the teaser — and only then pictures
and engagement counts.

**\`topics\` is not optional.** There are dozens of briefs, and an unsorted column of them is a
wall. Group them into **4–6 named sections** of 2–6 words each ("Space", "AI and tooling",
"People"), keeping a subject together. **It is the single thing that decides whether that half of
the paper can be read at all.**

## 4. New faces (\`newbies\`)

2–3 sentences each, **written as a person, not as a statistics line**: where they come from (platform and follower count), how long this machine has seen them and what they did today, and how they touch the owner's own circle ("someone you follow replied to her this morning"). Every clause has to be checkable in the materials. "First seen here: day N" is copied word for word — this machine only knows what it has seen.

## 5. Editor's notes and headlines

- \`deckNotes\`: at most one sentence per stack, every fact of it from the materials.
- Headlines summarise faithfully. No bait.
- **No manufactured liveliness (constitutional).** If today held N items, not one word may suggest more. Never write "it's busy in here", never nudge, never perform enthusiasm.

## 6. The teaser

An opening hook (N items gathered today, and the 3–5 drifts they fall on) → about seven lines, **each opening with a person's name#sigil** → a closing line saying the rest is in the full paper. Faithful, unexpanded, like everything else.`;

