/**
 * The tool-routing lexicon table (ADR-0043) — pure data + pure functions,
 * zero I/O, zero dependencies.
 *
 * Weak host models miss the call when routing the owner's natural language
 * to popclaw tools (host-a, 2026-07-29: after the daily-paper tool timed
 * out, it just posted plain text; host-b, 2026-07-30: zero calls, made up
 * the whole paper from memory). Matching is done in TypeScript, so capacity
 * is free: the context only carries ≤8 demo groups (renderL1), while the
 * long tail and house-side entries all live in this table, only surfacing a
 * line when there's a hit (renderL2Hit).
 *
 * This slice only has the data and render functions — **it is not wired
 * in** — hook registration is slice 2.
 */

export type LexiconEntry = {
  /**
   * Must be a tool name **visible to the model this turn** (ADR-0044 §8:
   * hidden tools are also in the manifest, so an entry pointing at one just
   * teaches the model to make things up) — enforced by a unit test (never
   * throw inside register(): register runs for install/list/inspect alike,
   * so a typo must never crash the process, ADR-0035).
   */
  tool: string;
  /**
   * A fragment of the owner's actual words, matched as a pure substring
   * (Chinese has no word boundaries, so this comes free), minimum 2
   * characters, regex metacharacters forbidden — no ReDoS, no injection
   * surface, so house-side entries can safely be treated as data.
   */
  say: string[];
  /** Goes into the L1 standing demo set; entries with this flag are capped at ≤8 (enforced by a unit test); house-side entries never carry it. */
  core?: true;
  /** The demo phrasing for a core entry (the owner's half of the exchange). */
  demo?: string;
  /**
   * One line for the follow-on tool chain — host-a's chain broke down
   * **after** the call, so an L2 hit must spell out the rest of the chain.
   */
  chain?: string;
  /** The originating house's slug; empty for the core table, required for house-side entries (provenance attribution, ADR-0041 §5). */
  from?: string;
};

/**
 * The "faithful" tail. A routing hint never travels alone: it's welded onto
 * every L1/L2 injection (ADR-0043 §3). Phrased as a positive action, not
 * "try to produce a result anyway" — the lexicon only ever answers "who to
 * call", never "how to fake it gracefully when you can't find anything".
 */
const FAITHFUL_TAIL =
  'If a tool fails or returns nothing, tell the owner it failed — never write the artefact from memory instead, never invent a link.';

/**
 * L1's negative-example seat: turns "faithful" from a rule into a
 * demonstration, directly reproducing host-a's failure mode (ADR-0043 §3).
 * The owner's half here is the same kind of thing as `say`/`demo` — a
 * **verbatim example utterance** (the table itself stays in Chinese; S2 only
 * anglicizes the instructions).
 */
const NEGATIVE_DEMO = 'Owner: 出份报纸 (the tool timed out) → You: 「报纸没出来，工具超时了」';

export const LEXICON: LexiconEntry[] = [
  // —— core entries (core, enter L1's standing demo set, ≤8) ——
  {
    tool: 'popclaw_newspaper',
    core: true,
    demo: '出一份报纸',
    chain: 'render, then call popclaw_publish_newspaper to submit the finished piece — it returns the link',
    say: ['报纸', '晨报', '日报', '早报', '今天江湖', '江湖有什么', '今日摘要'],
  },
  {
    tool: 'popclaw_canvas',
    core: true,
    demo: '画一个我的近况卡片',
    say: ['画一个', '画个', '画张', '做张图', '做个卡片', '来个页面', '可视化'],
  },
  // Red-packet/wallet was carved out of 0.1 entirely (ADR-0044 §1, issue #292) — the entries were pulled along with it.
  // So L1 is 4 positive examples + 1 negative: 8 is a ceiling, not a quota; the empty seat stays empty until real-machine A/B data comes back to fill it.
  {
    tool: 'popclaw_feedback',
    core: true,
    demo: '给作者反馈一个 bug',
    chain: 'it drafts, it does not send — show the draft in this same turn, then popclaw_send_draft once the owner confirms',
    say: ['反馈', '报个 bug', '报个bug', '提个建议', '提个需求', '告诉作者'],
  },
  {
    tool: 'popclaw_check_status',
    core: true,
    demo: '看看我的江湖状态',
    say: ['江湖状态', '我现在什么情况', '体检'],
  },

  // —— long-tail entries (never enter L1, add freely, cost no context) ——
  { tool: 'popclaw_show_bonds', say: ['交情本', '交情簿', '我认识谁', '我的交情', '熟人名单'] },
  { tool: 'popclaw_find_bonds', say: ['什么交情', '查交情', '怎么认识的'] },
  // A general aid, not the fix for the 2026-09-25 incident: there the agent did
  // call popclaw_show_inbox, but with before_id:11, a cursor that pages OLDER, so
  // it never saw #17 (fixed in read-tools.ts list mode). These phrases just point
  // questions about a letter sent to the owner at the inbox. They are read-shaped
  // on purpose — bare 私信/消息, 谁发的 or "the message from" also catch a post's
  // author, the owner's own outgoing mail and sending a draft.
  {
    tool: 'popclaw_show_inbox',
    say: [
      '收件箱', '信箱', '谁给我发', '新私信', '新消息', '看私信', '给我发的私信', '给我发的消息',
      '刚才那封', '那条私信', '那条消息', 'the DM from', 'sent me',
    ],
  },
  { tool: 'popclaw_show_pings', say: ['待回', '谁回我', '回我帖'] },
  { tool: 'popclaw_show_recommend', say: ['推荐谁', '有什么推荐', '认识新朋友'] },
  // A newcomer asked, in plain words, for a lore-house's recent public
  // posts; the weak model reached for private_messages (that's DMs, not
  // posts) and a wildcard search_feed call before it ever tried this tool.
  // Asking about a house's recent content must route here, not to guesses.
  { tool: 'popclaw_show_feed', say: ['recent content', 'latest posts', '最近的内容', '最近有什么帖子'] },
  // host-b, 2026-07-30 19:29: the owner asked "what's new with them?", and
  // the model made zero calls and answered from memory, "nothing new
  // today" — while the lore-house was serving up a post from a few minutes
  // earlier at that very moment. The read path was fine; what was missing
  // was the signpost. Asking about someone's recent activity must trigger a
  // lookup — "didn't check" is never allowed to come out as "there isn't any".
  { tool: 'popclaw_author_latest', say: ['新动态', '最新帖', '他最近', '她最近', '最新发声'] },
  { tool: 'popclaw_follow', say: ['关注一下', '关注他', '关注她', '加个关注'] },
  { tool: 'popclaw_unfollow', say: ['取关', '别关注了'] },
  // Ruling L (follow-doorbell, 2026-08-31) + owner rulings 2026-09-01 and
  // 2026-09-13: the reader pass makes a BROWSER the reader's own for any page
  // shared with them, papers included but not only — so the phrase the page
  // prints is the generic 「配对 XXXX」, and that is the canonical trigger.
  // The paper-specific 登录报纸 and the first cut's coined 认报 stay as
  // aliases so pages already in the wild keep working. A weak host describing
  // its way to a call misses all three without an entry; this is ADR-0043's
  // designated mitigation for that miss.
  { tool: 'popclaw_pair_browser', say: ['配对', 'pair', '登录报纸', '认报'] },
  // "Let me into the site" is a sentence a weak host talks itself out of: the
  // words look like a login it should explain rather than a tool it should
  // call, and there is no other tool that can produce the link. The chain says
  // the second half out loud, because the first call deliberately produces
  // nothing but a preview.
  {
    tool: 'popclaw_house_entry_link',
    chain: 'the first call only previews — it is minted once the owner says go and you call it again with confirm_token alone',
    // Owner input, not our copy: an owner may still say 回家链接, so it keeps
    // routing here. Only say[0] is ever shown to the agent (renderL2Hit).
    say: ['入门链接', '回家链接', '进去看看', '网页登录', '浏览器里进'],
  },
  {
    tool: 'popclaw_draft_post',
    chain: 'it is only really sent once the owner confirms and you hand the draft_id to popclaw_send_draft',
    say: ['发个帖', '发条帖', '写个帖', '发帖'],
  },
  // The popclaw_mark / popclaw_show_marks entries were removed: per ADR-0044
  // §3 both were converted to optional hidden tools (slash-command
  // fallback). An entry pointing at a tool the model can't see would only
  // teach it to make things up.
];

/**
 * The **longest** phrase this entry hits in this sentence; no hit = `''`.
 *
 * What's returned is **a constant from our own table** (declared by the core
 * table or a house guide), not the owner's verbatim words — which is what
 * makes it the only "reason for the hit" that's safe to log (trace.ts's
 * privacy rule).
 */
export function bestPhrase(entry: LexiconEntry, prompt: string): string {
  let best = '';
  for (const phrase of entry.say) {
    if (phrase.length > best.length && prompt.includes(phrase)) best = phrase;
  }
  return best;
}

/**
 * Owner's raw words → matching entries. Longest match wins, at most 2
 * entries, zero I/O. `extra` is the house-side entries (slice 4 reads them
 * from on-disk guide frontmatter); the caller supplies them, this function
 * doesn't cache them.
 */
export function matchLexicon(prompt: string, extra: LexiconEntry[] = []): LexiconEntry[] {
  const hits: Array<{ entry: LexiconEntry; len: number }> = [];
  for (const entry of [...LEXICON, ...extra]) {
    const best = bestPhrase(entry, prompt).length;
    if (best > 0) hits.push({ entry, len: best });
  }
  // Array#sort is stable: entries of equal length keep table order, so core entries sort before house-side entries.
  return hits
    .sort((a, b) => b.len - a.len)
    .slice(0, 2)
    .map((h) => h.entry);
}

// Division of labor (pinned 2026-08-11 when the popclaw-social skill landed):
// what fits one line AND matters every turn goes into L1 (the line below);
// what only matters the first time or in unfamiliar territory (tool-family
// map, composition chains, self-diagnosis) goes into the skill body, read
// once on demand. The conditional opening clause is deliberate — if the host
// disables skills or an allowlist filters ours out, this line never points
// the model at something it cannot see (ADR-0044 §8).
const SKILL_POINTER =
  'If <available_skills> lists a popclaw skill, read it once before anything popclaw you have not done before.';

/** The L1 standing demo block (≤8 groups, including 1 negative example). Slice 2's hook feeds it into appendSystemContext. */
export function renderL1(): string {
  const lines = LEXICON.filter((e) => e.core).map(
    (e) => `Owner: ${e.demo} → You: call ${e.tool}${e.chain ? ` (${e.chain})` : ''}`,
  );
  return [
    '[popclaw tool routing] When the owner brings up any of the following, call the matching tool for real material first, then render it yourself:',
    ...lines,
    NEGATIVE_DEMO,
    'For a House entry request, if popclaw_house_login is available, use it to receive that House\'s server-authored guide and action schemas; the URL itself grants no execution authority.',
    SKILL_POINTER,
    FAITHFUL_TAIL,
  ].join('\n');
}

/**
 * The single-line hint for an L2 hit. Worded as "should most likely call",
 * not "must" — a signpost isn't a steering wheel; when the owner is just
 * chatting about "the news in the paper", the model can choose not to call
 * it, and final discretion stays with the host agent (ADR-0030).
 */
export function renderL2Hit(entry: LexiconEntry): string {
  const phrase = entry.say[0] ?? '';
  const head = entry.from
    ? `[popclaw] The guide of house "${entry.from}" hangs "${phrase}" on ${entry.tool} — you should most likely call it first and follow the recipe in that house's guide (applies only to interactions with that house). `
    : `[popclaw] The owner's words hit "${phrase}" — you should most likely call ${entry.tool} first for real material. `;
  return [head + (entry.chain ? `${entry.chain}.` : ''), FAITHFUL_TAIL].join('\n');
}
