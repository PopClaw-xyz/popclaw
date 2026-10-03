/**
 * The candidate page: everything the day carried, laid out for one decision —
 * **which of these belong in the owner's paper**.
 *
 * Why this exists at all (the owner's ruling, 2026-08-26: read as much as there is, then
 * choose the hundred-odd that belong — a paper that prints whatever it happened to read is
 * not a paper). Until now gather took
 * `inWindow.slice(0, 80)` — the newest eighty, never once *chosen* — and the paper printed
 * whatever that happened to be. On a real day (2026-08-26) that meant two accounts held
 * 63% of the page, because those two accounts post the most.
 *
 * What decides the choice, in order: the owner's taste, then the bond book, then heat as
 * a substitute. The first two are judgements, and the only thing here that can make a
 * judgement is the writer — so this page hands it the taste profile and the bond book
 * **as prose** and asks for a verdict. The plugin does not score anything: on real
 * hardware every ranking signal it has (followers, replies, marks, verification) reads
 * zero or reads true for everyone, and a score built on those is a random number with a
 * rationale attached.
 *
 * Grouped by author, not by time. A person's whole day sits together, so the writer
 * decides "this person is worth two of today's ninety" once, rather than meeting them
 * twenty separate times down a chronological list — and the per-author ceiling becomes
 * something it can see rather than a rule it has to remember.
 */
import { tierLabel, type BondTier } from '../bonds/bond-tier.js';
import { languageDirective } from '../lexicon/directive.js';
import { renderCopy, type Lang } from '../lexicon/index.js';
import { langOf, ownerLang } from '../lexicon/owner-language.js';
import { budgetKnown } from './host-budget.js';
import type { IssueData, PulseItem } from './issue.js';
import { authorKey, candidateNumberAt } from './issue-identity.js';

/** One line of a candidate: enough to judge it by, never enough to write from. */
const PREVIEW = 80;
/** Authors with at most this many items collapse into one "loose pages" group at the end. */
const LOOSE = 2;

export interface CandidatePageOptions {
  /** The owner's taste, as prose — their own layer plus what dreaming and memory harvested. */
  tasteText: string;
  /** The bond book, one line per person, already rendered by the caller. */
  bondLines: readonly string[];
  /** The token the second call carries back with its picks. */
  publishToken: string;
  /**
   * The range the page suggests. Not a target and not enforced: the owner struck the fixed
   * count (2026-08-28) because writing fewer items properly is worth more to him than
   * writing many thinly — how many fit is something only the writer's own budget knows.
   */
  suggestMin: number;
  suggestMax: number;
  /** Under this the plugin tops the issue up itself, so the page says so before it happens. */
  floor: number;
  /** The weight this page was laid out against — quoted only when it is a guess, so the next incident has a number. */
  budget: number;
  /** How many the day actually held. Differs from what is listed whenever the page had to be trimmed. */
  dayTotal: number;
  /**
   * True when the page still weighs more than the budget after trimming — the trim stops at a
   * floor of twelve rather than gut the page, so this is reachable, and it is exactly the case
   * where the host cuts the middle out. Promising completeness here is the lie that sends a
   * writer to the feed for the "missing" items.
   */
  overBudget: boolean;
  /** The most any one person may hold in the issue. */
  perAuthorMax: number;
  /**
   * The session this page is built for (dedicated-session cut 1): the budget
   * the completeness promise leans on is bucketed per sessionKey. Not injected
   * = the default bucket (the old single-number behavior).
   */
  sessionKey?: string;
}

/**
 * Who wrote it: `name#sigil`, and the platform handle behind it. The handle is here because
 * choosing by the bond book means recognising people, and on a mirrored feed the handle is
 * often the half the owner actually knows ("levelsio" reads to them, a sigil does not).
 */
function who(p: PulseItem, lang: Lang): string {
  // The handle only earns its space when it says something the name does not.
  const at = p.handle && p.handle !== p.author ? ` (@${p.handle})` : '';
  if (!p.author) {
    return `${renderCopy(lang, 'newspaper.material.pulse.unattributed', { platform: p.platform })}${at}`;
  }
  return `${p.author}${p.sigil ? `#${p.sigil}` : ''}${at}`;
}

/**
 * One candidate, one line: number, who said it when that isn't already in the heading above,
 * the opening of what they said, and the few marks worth having.
 *
 * `named` is false inside the loose-pages group, where there is no per-author heading — and
 * a line there without a name is unjudgeable: half of what this page is for is choosing
 * people, which cannot be done off an anonymous sentence.
 */
function line(c: { lang: Lang }, p: PulseItem, n: number, named: boolean): string {
  const head = named ? '' : `${who(p, c.lang)} · `;
  const body = (p.text || '').replace(/\s+/g, ' ').trim().slice(0, PREVIEW);
  const marks = [
    p.media.length ? renderCopy(c.lang, 'newspaper.candidates.mark.media') : '',
    p.replyCount ? renderCopy(c.lang, 'newspaper.candidates.mark.replies', { count: String(p.replyCount) }) : '',
  ].filter(Boolean);
  return `[${n}] ${head}${body}${marks.length ? ` · ${marks.join(' ')}` : ''}`;
}

/**
 * Group the day by author, in the order the owner would care: the people they have a
 * bond with first, then whoever carried the day, then everyone who wrote once or twice
 * gathered at the end so a long tail of singletons doesn't bury the rest.
 */
function groups(
  pulse: readonly PulseItem[],
  lang: Lang,
): { head: string; named: boolean; items: { p: PulseItem; n: number }[] }[] {
  const byKey = new Map<string, { p: PulseItem; n: number }[]>();
  pulse.forEach((p, i) => {
    const key = authorKey(p, i);
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key)!.push({ p, n: candidateNumberAt(i) });
  });
  const all = [...byKey.values()];
  const bonded = all.filter((g) => g[0]!.p.bondTier);
  const loose = all.filter((g) => !g[0]!.p.bondTier && g.length <= LOOSE);
  const rest = all.filter((g) => !g[0]!.p.bondTier && g.length > LOOSE);
  // Fewest first among the strangers. The account that posted 163 times does not get the
  // top of the page as well: the reader is freshest at the start, and a firehose only ever
  // yields six items however early it is read.
  bonded.sort((a, b) => b.length - a.length);
  rest.sort((a, b) => a.length - b.length);
  const named = [...bonded, ...rest].map((g) => {
    const first = g[0]!.p;
    const vars = { who: who(first, lang), count: String(g.length) };
    return {
      // "New face" belongs to the person, not to each of their ninety-six posts: on real
      // hardware nearly every author is new to the machine, so marking every line with it
      // said nothing at all — while saying it once, above their stack, is the whole point
      // of "someone worth meeting".
      head:
        (first.bondTier
          ? renderCopy(lang, 'newspaper.candidates.authorBonded', {
              ...vars,
              bond: tierLabel(first.bondTier as BondTier, lang),
            })
          : renderCopy(lang, 'newspaper.candidates.author', vars)) +
        (first.newcomerDays !== undefined
          ? ` ${renderCopy(lang, 'newspaper.candidates.mark.newFace')}`
          : ''),
      items: g,
      named: true,
    };
  });
  const looseItems = loose.flat();
  return looseItems.length
    ? [
        ...named,
        {
          head: renderCopy(lang, 'newspaper.candidates.loose', { count: String(looseItems.length) }),
          items: looseItems,
          named: false,
        },
      ]
    : named;
}

/**
 * The order the page will show them in: grouped by author, bonded first, then strangers
 * fewest-first, loose pages last.
 *
 * The caller stores the candidate set in exactly this order, so the numbers run 1, 2, 3 down
 * the page with no gaps. They used to be storage indices while the page was grouped, which
 * put `[18] [242] [415] [176]` at the top of a numbered list — and a writer reading a
 * numbered list full of holes draws the only available conclusion, that the rest was cut
 * off. On the first real day both machines drew it: one announced the material was truncated
 * and went to the feed to "fill in the missing items", the other spent its whole output
 * budget on the same idea and died with `stopReason=length`. Nothing had been truncated.
 * Never ask a reader to believe that gaps in a sequence are normal; remove the gaps.
 */
export function candidateOrder(pulse: readonly PulseItem[], lang?: Lang): PulseItem[] {
  return groups(pulse, lang ?? ownerLang()).flatMap((g) => g.items.map((x) => x.p));
}

/**
 * The whole page. Head and tail carry the instructions on purpose: a host that has to
 * truncate a tool result keeps both ends, and the rule the writer must not lose is
 * "call again with picks", not any single candidate.
 *
 * **The token is printed at both ends.** It used to appear only in the closing
 * hand-in block, and on 2026-08-27 a machine came back with "the candidate page was
 * truncated, it has no token, so I cannot publish" — whether the tail was really lost
 * or the writer simply never reached it, the outcome is the same and it is the whole
 * issue: everything else on this page is recoverable by calling again, the token is
 * not. One line at the top costs nothing and closes the class.
 */
export function buildCandidatePage(issue: IssueData, opts: CandidatePageOptions): string {
  const lang: Lang = issue.language ? langOf(issue.language) : ownerLang();
  const m = (key: string, vars: Record<string, string> = {}): string =>
    renderCopy(lang, `newspaper.candidates.${key}`, vars);
  /**
   * The line this page ends with, bound to this batch by its own count and id.
   *
   * Minted here rather than appended after the trim: `gather-materials` re-renders the
   * whole page on every trim step and weighs what it gets back, so the sentinel rides
   * inside every measurement and can never be the thing that pushes a page over budget.
   */
  const sentinel = m('batch.sentinel', {
    count: String(issue.pulse.length),
    id: opts.publishToken,
  });
  const out: string[] = [
    issue.language ? languageDirective(lang, issue.language) : languageDirective(),
    ``,
    m('head', {
      owner: issue.ownerNickname,
      date: issue.dateLabel,
      total: String(opts.dayTotal),
      min: String(opts.suggestMin),
      max: String(opts.suggestMax),
      token: opts.publishToken,
      // Only promise completeness when this machine's real cap has reached us. Where it has
      // not, say so and give the writer somewhere honest to go — the alternative is what it
      // did on 2026-08-29, which was to stop believing the page and fetch its own data.
      shown: String(issue.pulse.length),
      trimmed: String(Math.max(0, opts.dayTotal - issue.pulse.length)),
      integrity: opts.overBudget
        ? m('integrity.overBudget', { budget: String(opts.budget) })
        : budgetKnown(opts.sessionKey)
          ? m('integrity.known')
          : m('integrity.estimated', { budget: String(opts.budget) }),
    }),
    ``,
    // What this page carries and how it ends — checkable, unlike a promise.
    m('batch.head', { count: String(issue.pulse.length), sentinel }),
    ``,
    // The case the integrity lines never covered: no notice, no omission marker, and the
    // writer believes the page is short anyway (2026-09-13). One line only — what to DO in
    // that state is the workshop's system prompt (dedicated-session.ts CHILD_SYSTEM_PROMPT),
    // which is sent once per session instead of riding on every page.
    m('cutShort.suspected'),
    ``,
    m('ladder', {
      min: String(opts.suggestMin),
      max: String(opts.suggestMax),
      floor: String(opts.floor),
      perAuthor: String(opts.perAuthorMax),
    }),
    ``,
    m('taste.head'),
    opts.tasteText.trim() || m('taste.none'),
    ``,
    m('bonds.head', { count: String(opts.bondLines.length) }),
    ...(opts.bondLines.length ? opts.bondLines.map((b) => `- ${b}`) : [m('bonds.none')]),
    ``,
    m('list.head', { total: String(issue.pulse.length) }),
  ];
  for (const g of groups(issue.pulse, lang)) {
    out.push(``, g.head);
    for (const { p, n } of g.items) out.push(line({ lang }, p, n, g.named));
  }
  out.push(
    ``,
    m('handIn', {
      token: opts.publishToken,
      min: String(opts.suggestMin),
      max: String(opts.suggestMax),
      perAuthor: String(opts.perAuthorMax),
    }),
    // Last, with nothing after it: the whole point of a tail sentinel is that seeing it
    // means the tail arrived.
    ``,
    sentinel,
  );
  return out.join('\n');
}
