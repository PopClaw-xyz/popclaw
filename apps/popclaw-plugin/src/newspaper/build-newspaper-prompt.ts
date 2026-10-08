/**
 * The agent-facing brief for one issue (v0.2).
 *
 * Before v0.2 this file also carried the whole layout codex — the class-name
 * dictionary, the person-card skeleton, the link rules, the picture rules — and
 * the agent handed back a full page of HTML. That cost ≈41,200 weighted units of
 * fixed overhead per issue, which ate straight through the host's 16k and 32k
 * tool-result tiers, and it made every issue's layout a coin toss on whether the
 * model copied the codex faithfully that turn.
 *
 * Now the layout lives in `render-newspaper.ts` and this file asks the agent for
 * one thing: **the words**. No HTML, no URLs, no counting.
 */
import { tierLabel, tierRank, type BondTier } from '../bonds/bond-tier.js';
import { languageDirective } from '../lexicon/directive.js';
import { renderCopy, type Lang } from '../lexicon/index.js';
import { langOf, ownerLang } from '../lexicon/owner-language.js';
import { castList, followerLabel, needsEditorial, numberedPulse, type IssueData, type PulseItem } from './issue.js';

export { houseCounts, castList, formatHouseCounts } from './issue.js';
export type { PulseItem, PingItem, HouseLetterItem, MantleItem, HomeItem, HomeSection, IssueData } from './issue.js';

/**
 * The small bond-book tag for this person: `bond: close friend` /
 * `alias "old dragon"`, and nothing at all if there's none.
 *
 * The tier label goes through `tierLabel()`, defaulting to the owner's current
 * language (the newspaper brief is agent-facing material, consistent with how S3
 * treats the rest of the materials). **Only maps "acquaintance" and above**: a
 * stranger / someone not yet in the bond book has no tier to speak of, and
 * printing "stranger" would just give the agent a label it might treat as
 * writable; blocked/rejected people can't even get this far (gather already
 * filters them out) — the tierRank gate here is just a second layer of the same discipline.
 */
function bondLines(
  b: { bondTier?: string; remarkName?: string; bondDynamic?: string },
  indent: string,
  lang: Lang = ownerLang(),
): string[] {
  const out: string[] = [];
  const tier = b.bondTier as BondTier | undefined;
  const label = tier && tierRank(tier) >= tierRank('acquaintance') ? tierLabel(tier, lang) : '';
  if (label) out.push(`${indent}bond: ${label}`);
  if (b.remarkName) out.push(`${indent}alias "${b.remarkName}"`);
  // The sole material source for "editor's note: <summary of the recent update>" (content.md §3). No line at all if there's none.
  if (b.bondDynamic) out.push(`${indent}recent: ${b.bondDynamic}`);
  return out;
}

/** Kept in step with the renderer's quotas so the brief never invites more than the page will print. */
const MAX_PULLS = 4;
const MAX_XREFS = 8;

/**
 * The safe size of one hand-in — a fallback, not a rule.
 *
 * The binding limit is the host's **output** cap, not its tool-result cap: OpenClaw
 * ships `maxTokens = 8192`, and an item costs ~110 tokens of copy. This number used to
 * be a hard instruction, because an issue was a fixed ninety items and three hand-ins
 * were unavoidable. The owner then struck the fixed count (2026-08-28) — the writer now
 * picks what it can write well, so a normal issue finishes in one hand-in and this
 * number never comes up. It stays for the day a writer over-picks, because a reply cut
 * off mid-tool-call loses the call itself, which is not a thin paper but no paper at
 * all (real hardware, 2026-08-27).
 */
const BATCH_MAX = 30;

export interface BriefOptions {
  contentRules: string;
  publishToken: string;
  /**
   * How many items the front page may hold, quoted into the brief so the agent's
   * `leads` list and the renderer's cap agree. The renderer is still the one that
   * enforces it (a longer list is trimmed, never rejected) — this is only so the
   * agent isn't asked to pick ten and then watch seven vanish.
   */
  leadMax: number;
  /** How many the writer actually chose, before any trimming to fit one hand-over. */
  pickedCount: number;
  /** True when this page still weighs more than the budget after trimming — see the candidate page. */
  overBudget: boolean;
  /**
   * The session this brief is built for (dedicated-session cut 1): the budget
   * the completeness promise leans on is bucketed per sessionKey. Not injected
   * = the default bucket (the old single-number behavior).
   */
  sessionKey?: string;
}

/**
 * One item's block exactly as the material page prints it: the author line with
 * its [number] and tier, the recommendation reasons, the lore-house, the kind,
 * the reply and mark counts, and the body.
 *
 * Extracted so the publish receipt can reprint the material of the items still
 * owed (2026-09-11). The writer loses the page the moment its context is
 * trimmed, and a receipt that names numbers it can no longer see is a receipt it
 * has to answer from memory — which is where another item's summary comes from.
 * One source for this block means the reprint can never drift from the page the
 * copy was written against.
 */
export function materialItemLines(p: PulseItem, n: number, lang: Lang): string[] {
  const m = (key: string, vars: Record<string, string> = {}): string =>
    renderCopy(lang, `newspaper.material.${key}`, vars);
  const who = p.author
    ? `${p.author}${p.sigil ? `#${p.sigil}` : ''}`
    : m('pulse.unattributed', { platform: p.platform });
  const lines: string[] = [`${m('pulse.author', { i: String(n), who })} · ${m(`tier.${p.tier}`)}`];
  // Recommendation-reason material belongs to this specific post (the taste words
  // are matched against this post's own body), so it stays on the item. The
  // renderer prints the reason line itself — it is here so the summary can lean on it.
  if (p.reasons?.length) lines.push(`    ${m('pulse.reasons', { reasons: p.reasons.join(', ') })}`);
  if (p.houseSlug) lines.push(`    ${m('pulse.house', { house: p.houseSlug })}`);
  if (p.kind) lines.push(`    ${m('pulse.kind', { kind: p.kind })}`);
  if (p.sourceCreatedAt !== undefined) lines.push(`    source created at (unix seconds): ${p.sourceCreatedAt}`);
  if (p.replyCount) lines.push(`    ${m('pulse.replies', { count: String(p.replyCount) })}`);
  if (p.markCount) lines.push(`    ${m('pulse.marks', { count: String(p.markCount) })}`);
  lines.push(`    ${m('pulse.body', { text: p.text })}`);
  return lines;
}

/**
 * The material blocks for exactly these item numbers, in material-page order.
 * A number that is not an editable item of this issue is skipped rather than
 * guessed at — the reprint may only ever show what the page itself showed.
 */
export function materialBlocksFor(
  issue: IssueData,
  numbers: readonly number[],
  lang: Lang,
): string {
  const wanted = new Set(numbers);
  return numberedPulse(issue.pulse)
    .filter(({ p, n }) => wanted.has(n) && needsEditorial(p))
    .flatMap(({ p, n }) => materialItemLines(p, n, lang))
    .join('\n');
}

/**
 * Build the agent-facing brief. The AGENT writes the copy in its own turn (on the
 * host's model — popclaw itself never calls an LLM, spec 2026-06-18), then submits
 * one `edit` object via popclaw_publish_newspaper, which lays out the page.
 */
export function buildNewspaperPrompt(issue: IssueData, opts: BriefOptions): string {
  const lang: Lang = issue.language ? langOf(issue.language) : ownerLang();
  const m = (key: string, vars: Record<string, string> = {}): string =>
    renderCopy(lang, `newspaper.material.${key}`, vars);
  const ownerLanguage = issue.language || `the owner's language`;
  const castLabel = m('cast.label');
  // The materials. Only items that need words: anything the lore-house published
  // with its own fields (an outing, a postcard, a chance meeting) is laid out
  // verbatim from those fields by the renderer — asking the agent to rewrite it
  // would be asking it to break the iron rule.
  //
  // Hoisted above the page because the head has to state this count and name the
  // closing line before either is printed (2026-09-13 batch markers).
  const editable = numberedPulse(issue.pulse).filter(({ p }) => needsEditorial(p));
  /**
   * The line this page ends with, bound to this batch by its own count and basis.
   *
   * Built here rather than appended after the trim: `pick-issue` re-renders the whole
   * page on every trim step and weighs what it gets back, so the sentinel is inside
   * every measurement and can never be the thing that pushes a page over budget.
   */
  const sentinel = m('batch.sentinel', { count: String(editable.length), id: opts.publishToken });
  const lines: string[] = [];

  lines.push(
    // The language directive is self-contained in the brief: the tool path and the slash-command path each get exactly one copy.
    issue.language ? languageDirective(lang, issue.language) : languageDirective(),
    ``,
    `You are popclaw, editing today's (${issue.dateLabel}) paper for ${issue.ownerNickname}. The whole point of this paper is **to discover people through the news** — it is read to connect and interact with people, not just to take in information; the newspaper form is only there to make that reading better.`,
    ``,
    `**You write the words. popclaw lays out the page.** You never write HTML, never write or repeat a URL, never place a picture, never count anything, never name a section: the page, every link, every avatar, every figure and every ledger is assembled from these same materials after you hand your copy in. Everything that is yours to decide is a field in the \`edit\` object below.`,
    ``,
    // Anti-panic, placed this high on purpose: when a host does cut this payload it
    // keeps the HEAD, so this line survives every cap tier.
    `[READING CONTINUATIONS] Read the saved document through page_cursor. A single long source can span several pages; join its complete parts before quoting or summarizing. Never replace a continuation with fresh feed data or remembered text.`,
    ``,
    // What this page carries and how it ends, so "is it whole" is a thing the writer
    // can check rather than a thing we assert at it.
    m('batch.head', { count: String(editable.length), sentinel }),
    ``,
    // The case the instruction above never covered: no notice, no omission marker, and
    // the writer believes the page is short anyway. That is the state the 2026-09-13 run
    // was actually in, and nothing told it what to do in it. One line only — the rule
    // itself is the workshop's system prompt (dedicated-session.ts CHILD_SYSTEM_PROMPT),
    // which is sent once per session instead of riding on every page.
    'Write selected items in batches as needed; each accepted batch stays bound to this exact issue.',
    ``,
    `[IRON RULE — break it and the issue has failed]`,
    `**Faithful.** Every item gets a faithful summary / transcription / translation (into ${ownerLanguage}) and nothing more. **Never expand. Never add a number / fact / detail / cause / inference the materials do not contain.** Short and plain beats embellished, exaggerated or invented. Where you quote, quote verbatim and never turn a first-person line into a third-person one. Never invent a person, a place, a time or a channel; a field the materials do not give is simply left out.`,
    ``,
    // The basis line is the batch selector (2026-09-06 r7, tightened r9): the numbers
    // below mean THIS page, and `edit.basis` is how publish knows that. It is a plain
    // field of the edit object — not a *_token tool argument — so the channels that
    // rewrite token arguments to `***` have no rule against it; that is a property of
    // the protocol's shape plus the instruction below, not a physical guarantee any
    // host must honor, which is exactly why publish REFUSES a hand-in carrying neither
    // basis nor a real token instead of guessing (r9). The token is still named for
    // hosts that can carry it.
    `[What you hand in] Call popclaw_publish_newspaper with \`edit\` = one JSON object of exactly this shape. **Copy the \`basis\` value below into every edit you hand in, verbatim** — it names the exact materials your item numbers refer to. It is **this page's own id**, not the \`candidate_basis\` you carried to get here: that one named the candidate page you chose from, and it is never what \`edit.basis\` carries. (A real publish_token="${opts.publishToken}" also binds this exact issue if your host can carry it; the basis needs no token at all.)`,
    `**Item numbers are identities, not list positions.** Copy each printed [number] exactly into items/leads/pulls/xrefs/topics. Selected items keep their candidate-page numbers, so gaps are intentional (unselected or non-editorial items), not missing material. Never renumber them 1..N. Use only the full materials below, not candidate previews. Any unknown number rejects the entire hand-in without saving it.`,
    `**\`q\` is the anchor.** Before writing an item, copy a passage of its body verbatim into \`q\`; publish checks \`q\` against that very item's body and refuses copy whose \`q\` is not found there, so a summary can never land under another item's number. Write \`h\` and \`s\` from the same body you just quoted. \`q\` is checked and never printed — copy it from the text after \`${m('pulse.body', { text: '' }).trim()}\` (never the label), at least about four English words or five Chinese characters, or the whole body when it is shorter; a passage that other items also contain does not count. \`pulls\` is the quotation the page prints.`,
    ``,
    `{`,
    `  "basis": "${opts.publishToken}",`,
    `  "masthead": "<the paper's name>",`,
    `  "edition": "<name it for the hour — morning edition / evening edition>",`,
    `  "weather": ["<3-5 words naming today's drifts, drawn only from the materials>"],`,
    `  "leads": [<the item numbers that earn the front page, weightiest first, at most ${opts.leadMax}>],`,
    `  "items": { "<item number>": { "q": "<passage copied verbatim from this item's body — a few words at least, the whole body when it is short>", "h": "<headline>", "s": "<the faithful summary>" } },`,
    `  "pulls": { "<item number>": "<one sentence quoted verbatim from that item, to set as a pull quote>" },`,
    `  "xrefs": { "<item number>": "<one sentence naming a real connection to another item in this issue>" },`,
    `  "topics": { "<item number>": "<subsection name, 2-6 words — e.g. spaceflight>" },`,
    `  "deckNotes": { "<lore-house slug>": "<at most one sentence of editor's note>" },`,
    `  "newbies": { "<sigil>": "<2-3 sentences on this new face>" },`,
    `  "translations": { "<one of the word-for-word lines listed at the end, copied exactly>": "<its translation>" },`,
    `  "teaser": "<the trailer — see below>"`,
    `}`,
    ``,
    `- **Every selected editorial item must be written up in \`items\`, across as many batches as needed.** The full issue stays saved and is published only when all selected items are complete.`,
    `- **\`basis\` rides in every hand-in, batches included** — copy it from the line above. It is the one thing that tells publish which page your numbers refer to; a hand-in with neither a basis nor a real publish_token is refused, not guessed.`,
    `- **Try to finish in one hand-in — but hand in early rather than squeeze.** A reply cut off mid-tool-call loses the call itself and there is no paper at all (real hardware, 2026-08-27, and again 2026-08-30 when a flash-tier model died mid-way through thirty-two items in one call). About a dozen items per hand-in is safe on every host — a stock host takes up to about ${BATCH_MAX} — so when in doubt hand the first dozen in and continue after the receipt. Whatever you hand in is kept, and the receipt tells you how many are still unwritten; a later batch needs only \`items\` (each with its own \`q\`, plus \`pulls\`/\`xrefs\`/\`topics\` if you have them).`,
    `- \`h\` is a faithful headline, never clickbait. \`s\` is the summary: an item you put in \`leads\` gets 5-8 sentences; an item marked \`${m('tier.card')}\` gets 3-6; an item marked \`${m('tier.brief')}\` gets 2-3. **These are ceilings, not quotas — when the source is short, stop.**`,
    `- **Every item earns its own space or it should not have been chosen.** The paper exists so the owner finds people worth knowing: an item summed up in a line gives him nothing to be interested in, and nobody to follow. Read all continuation pages and write the selected items in batches with faithful depth. The issue has no total content quota.`,
    `- \`masthead\`, \`items\` and \`teaser\` are required on the **first** hand-in; everything else may be left out.`,
    `- \`topics\` groups a lore-house's **brief notes** into named subsections, in the order you first use each name. Give the same name to the items that belong together and leave the rest out; omit the field entirely and the column runs unbroken. **A person's several items always share one card, so name them together.**`,
    `- \`pulls\` at most ${MAX_PULLS} in the issue, \`xrefs\` at most ${MAX_XREFS}, and anything past the quota is dropped. A pull quote is a sentence **already present in that item's own text**; a cross-reference names a real shared thing between two items (the same fog, the same person writing and waiting on a reply) — a bare pointer ("see the front page") is not one.`,
    `- \`deckNotes\` is keyed by lore-house slug (the slugs are listed with the materials), \`newbies\` by the sigil after a person's name. Only the new faces marked in the ${castLabel} roster may appear in \`newbies\`, and each entry is written **in the manner of a person, not a statistics line**: where they come from, what the materials say they did today, and how they touch the owner's circle — every word of it verifiable in the materials.`,
    `- \`translations\` is for the lines at the very end of these materials — the ones the layout prints word for word. Translate the ones that are not in ${ownerLanguage}; leave the rest out. **Never** put a person's name, a #sigil or a place name in it.`,
    `- \`teaser\`: an opening hook (**${issue.totalCount} items** gathered ${issue.windowLabel}, and the drifts they fall on), then about 7 headlines one per line **each opening with a person's name#sigil**, then a closing line saying the rest is in the full paper. This is what the owner reads before opening it.`,
  );

  // CONTENT rules (newspaper/content.md) — the editorial voice; the layout half of the old codex is gone (it is code now).
  if (opts.contentRules.trim()) {
    lines.push(``, `[Content rules (content.md)]`, opts.contentRules.trim());
  }

  // Awaiting-reply: laid out by the renderer, listed here only so the teaser can be honest about it.
  lines.push(
    ``,
    m('pings.head', {
      count: String(issue.pings.length),
      letters: issue.houseLetters?.length
        ? m('pings.letters', { count: String(issue.houseLetters.length) })
        : '',
    }),
  );
  // `@` dropped: the address already carries `#sigil` as its identity marker (`@#3m8v5x1p` would stack two marker systems).
  issue.pings.forEach((p, i) => {
    const bond = bondLines(p, '', lang).join(' · ');
    lines.push(`[${i + 1}] ${p.fromShort}${bond ? ` (${bond})` : ''}: ${p.body ?? p.bodyPreview}`);
  });

  // The lore-house distribution: the agent needs the slugs for `deckNotes`, and the
  // figures keep the teaser honest. The stack order, the counts on the page and the
  // zero-item stacks are all the renderer's business.
  if (Object.keys(issue.byHouse).length) {
    const counts = Object.entries(issue.byHouse)
      .map(([slug, n]) => m('houseCount', { slug, count: String(n) }))
      .join(' · ');
    lines.push(``, m('houseDistribution', { counts }));
  }

  // Cast roster = author roster (P3 + I3): every "belongs to the person" field
  // appears exactly once, here. Measured on real data, 60 material items had only
  // 4 authors — repeating the identity triplet per item ran 5.5x the body's volume.
  // v0.2 drops the avatar and page URLs from it: the agent never writes a link.
  const cast = castList(issue.pulse);
  if (cast.length) {
    lines.push(``, m('cast.head', { label: castLabel, count: String(cast.length) }));
    for (const c of cast) {
      const p = c.first;
      lines.push(
        [
          `- ${c.label}`,
          p.handle ? `(@${p.handle})` : '',
          p.platform,
          followerLabel(p.followerCount, lang),
          p.verified ? 'verified✓' : '',
          `follow state: ${p.isFollowing ? 'following' : 'not following'}`,
          m('cast.items', { count: String(c.count) }),
          ...bondLines(p, '', lang),
          p.newcomerDays !== undefined ? m('cast.newcomer', { days: String(p.newcomerDays) }) : '',
        ]
          .filter(Boolean)
          .join(' · '),
      );
    }
  }

  // Three numbers live on this page — the day's whole take, what was chosen out of it, and
  // how much of that the writer has to write — and until 2026-08-29 only the first was ever
  // spelled out (in the teaser instruction).
  // A writer told "336 items gathered" that then counts forty entries draws the one
  // available conclusion, that the rest was cut off: on real hardware it went to the feed
  // to "fill in the missing items" and wrote the issue from *that* instead, so every piece
  // of copy landed on somebody else's item. Same failure as the candidate page's skipped
  // numbers (2026-08-27), a different page. Say all three in the same breath — and say why
  // the numbering below skips, because lore-house items keep their position but are laid out
  // from their own fields, so a page of [1][2][4] is normal here and must not read as a cut.
  lines.push(
    ``,
    m('pulse.chosen', {
      chosen: String(issue.pulse.length),
      picked: String(opts.pickedCount),
      dropped: String(Math.max(0, opts.pickedCount - issue.pulse.length)),
      total: String(issue.totalCount),
      toWrite: String(editable.length),
      laidOut: String(issue.pulse.length - editable.length),
      integrity: 'All selected originals are saved. Read every page_cursor continuation until the complete-document end marker.',
    }),
    m('pulse.head', { count: String(editable.length) }),
  );
  for (const { p, n } of editable) lines.push(...materialItemLines(p, n, lang));
  // Lines the layout prints word for word. They are other people's own words, so the
  // renderer never rewrites them — but a line in a language the owner cannot read is
  // worth nothing to them (owner's ruling, 2026-08-26), and only the writer of this
  // issue can translate it. Listed last on purpose: a host that has to cut this payload
  // cuts the middle, and these lines are cheap to keep whole. Names, sigils and place
  // names are deliberately absent — translating an identifier loses the person.
  const verbatimLines = [
    ...(issue.homeSections ?? []).flatMap((h) => [
      ...(h.rankingBasis ? [h.rankingBasis] : []),
      ...h.homes.map((home) => home.voice).filter((v): v is string => !!v),
    ]),
  ];
  if (verbatimLines.length) {
    lines.push(``, m('verbatim.head', { lang: ownerLanguage }));
    for (const v of verbatimLines) lines.push(`- ${v}`);
  }

  // Last, with nothing after it: the whole point of a tail sentinel is that seeing it
  // means the tail arrived.
  lines.push(``, sentinel);

  return lines.join('\n');
}
