/** One complete summary presentation shared by explicit reads and newspaper material. */
import type { SnapshotContent, WorldSummarySnapshot } from './summary-snapshot-types.js';
import { rememberObservedPeople } from '../identity/observed-people.js';
import type { NameChain } from '../identity/person-name.js';
import { renderCopy, lexiconFor, type Lang } from '../lexicon/index.js';
import { ownerLang } from '../lexicon/owner-language.js';
import { timeContext } from '../time/time-context.js';
import { rememberObservedSummaryEventIds, summaryEventRef, type PostRefSources } from './post-ref.js';
import { WorldSummaryClient, type WorldSummaryResponse } from './world-summary-client.js';
import { formatNotablePersonLine, formatWorldStateLine, hotPostsFallbackHeading, notablePeopleHeading, platformLabel } from './summary-format.js';

export interface SummaryFormatOptions {
  readonly lang?: Lang;
  readonly nameOf?: NameChain;
  readonly sources?: PostRefSources;
}

export function renderWorldSummary(summary: WorldSummaryResponse, opts: SummaryFormatOptions = {}): string {
  const lang = opts.lang ?? ownerLang();
  return summary.snapshot ? renderSnapshot(summary.snapshot, { ...opts, lang }) : renderLegacy(summary, opts, lang);
}

function date(ms: number): string {
  const t = timeContext(ms / 1000);
  return `${t.ymd} ${t.hm} (${t.tz})`;
}

function renderSnapshot(s: WorldSummarySnapshot, opts: SummaryFormatOptions & { lang: Lang }): string {
  const copy = (key: string, vars?: Record<string, string>) => renderCopy(opts.lang, `world.snapshot.${key}`, vars);
  const unknown = copy('unknown');
  const ids = Object.keys(s.contents);
  const refs = new Map(ids.map(id => [id, summaryEventRef(id, opts.sources ?? {}, ids)]));
  const ref = (id: string) => refs.get(id) ?? id;
  const person = (id: string): string => {
    const p = s.people[id]!;
    const publicName = p.nickname || p.accounts[0]?.handle || '';
    const alias = opts.nameOf?.(id, publicName) || publicName;
    const facts = [`${alias}#${p.sigil}`];
    if (publicName && alias !== publicName) facts.push(copy('publicName', { name: publicName }));
    if (p.bio) facts.push(copy('bio', { bio: p.bio }));
    if (p.role) facts.push(copy('role', { role: p.role }));
    facts.push(copy('publicFollowers', { count: String(p.public_followers) }));
    for (const a of p.accounts) {
      facts.push(copy('account', {
        platform: platformLabel(a.platform), handle: a.handle, verified: date(a.binding_verified_at_ms),
        count: a.follower_count === null ? unknown : String(a.follower_count),
        captured: a.followers_captured_at_ms === null ? unknown : date(a.followers_captured_at_ms),
      }));
      if (a.bio) facts.push(copy('accountBio', { platform: platformLabel(a.platform), bio: a.bio }));
      if (a.platform_verified !== null) facts.push(copy('platformBadge', { platform: platformLabel(a.platform), value: a.platform_verified ? a.platform_verification_label || copy('yes') : copy('no') }));
    }
    return facts.join(' · ');
  };
  const content = (c: SnapshotContent): string => [
    person(c.author_id),
    `${date(c.published_at_ms)} · ${platformLabel(c.platform)} · ${copy(c.authorship)} · #${ref(c.event_id)}`,
    c.body_preview,
    copy('replyCounts', { total: String(c.reply_count_total), week: String(c.reply_count_7d), day: String(c.reply_count_24h), eight: String(c.reply_count_8h) }),
    ...(c.kind === 'reply' ? [copy('relations', { parent: ref(c.parent_event_id!), root: ref(c.root_event_id!) })] : []),
  ].join('\n');
  const totals = s.totals;
  const blocks = [
    copy('title', { generated: date(s.generated_at_ms), cutoff: date(s.cutoff_at_ms), house: s.house_id }),
    copy('totals', Object.fromEntries(Object.entries(totals).map(([key, value]) => [key, String(value)]))),
    copy('retained', { since: s.retained_since_ms === null ? unknown : date(s.retained_since_ms) }),
    copy('ranking'),
  ];
  for (const w of s.windows) {
    const label = w.hours === 168 ? '7d' : `${w.hours}h`;
    const activity = w.activity;
    blocks.push(copy('window', { window: label, start: date(w.starts_at_ms), end: date(s.cutoff_at_ms) }) + '\n' +
      copy('activity', { identities: String(activity.new_identities), posts: String(activity.new_posts), replies: String(activity.new_replies), authors: String(activity.active_authors) }));
    const coverage = w.follow_coverage_start_ms === null
      ? copy('baselineUnknown')
      : copy(w.follow_coverage_start_ms > w.starts_at_ms ? 'partialCoverage' : 'fullCoverage', { start: date(w.follow_coverage_start_ms), end: date(s.cutoff_at_ms), net: String(w.public_follow_net) });
    blocks.push(copy('peopleHeading', { window: label }) + '\n' + coverage + '\n' +
      (w.people_growth.length ? w.people_growth.map((p, i) => `${i + 1}. ${person(p.person_id)} · ${copy('growth', { count: String(p.net_followers) })}`).join('\n') : copy('emptyPeople')));
    blocks.push(copy('postsHeading', { window: label }) + '\n' +
      (w.top_posts.length ? w.top_posts.map((rank, i) => {
        const c = s.contents[rank.event_id]!;
        const latest = c.latest_reply_id ? s.contents[c.latest_reply_id] : undefined;
        return `${i + 1}. ${content(c)}\n${copy('newReplies', { count: String(rank.new_replies) })}\n` +
          (latest ? `${copy('latestReply')}\n${content(latest)}` : copy('noLatestReply'));
      }).join('\n\n') : copy('emptyPosts')));
  }
  blocks.push(copy('repliesHeading') + '\n' + (s.popular_replies.length
    ? s.popular_replies.map((p, i) => `${i + 1}. ${content(s.contents[p.event_id]!)}\n${copy('newReplies', { count: String(p.new_replies) })}`).join('\n\n')
    : copy('emptyReplies')));
  return blocks.join('\n\n');
}

function renderLegacy(s: WorldSummaryResponse, opts: SummaryFormatOptions, lang: Lang): string {
  const blocks = [renderCopy(lang, 'world.summary.title', { windowHours: String(s.window_hours), totalPosts: String(s.total_posts), distinctAuthors: String(s.distinct_authors) })];
  if (s.world_state) blocks.push(formatWorldStateLine(s.world_state, lang));
  if (s.notable_people?.length) blocks.push(notablePeopleHeading(lang) + '\n' + s.notable_people.slice(0, 10).map(p => formatNotablePersonLine(p, lang)).join('\n'));
  const lines = s.hot_posts.slice(0, 10).map((p, i) => `${i + 1}. [${WorldSummaryClient.nicknameFor(s, p.author, opts.nameOf)}] ${Array.from(p.body_preview).slice(0, 200).join('')} · ${platformLabel(p.platform)} · ${p.reply_count}${lexiconFor(lang).terms.worldSummary.repliesUnit}`);
  blocks.push(lines.length ? `${s.summary_note ?? hotPostsFallbackHeading(lang)}:\n${lines.join('\n')}` : renderCopy(lang, 'world.summary.noHotPosts'));
  return blocks.join('\n\n');
}

/** Commit only material that a current tool is actually returning. */
export function rememberWorldSummary(summary: WorldSummaryResponse, opts: SummaryFormatOptions = {}): void {
  const s = summary.snapshot;
  if (!s) return;
  rememberObservedSummaryEventIds(Object.keys(s.contents));
  rememberObservedPeople(Object.values(s.people).flatMap(p => {
    const publicName = p.nickname || p.accounts[0]?.handle || '';
    return [publicName, opts.nameOf?.(p.popclaw_id, publicName) || publicName].map(nickname => ({ popclawId: p.popclaw_id, nickname }));
  }));
}
