/** Runtime validation for the additive, public summary read contract. */
import { z } from 'zod';
import { deriveSigil } from '../invite/sigil.js';
import type { WorldSummarySnapshot } from './summary-snapshot-types.js';
import type { WorldSummaryResponse } from './world-summary-client.js';

const count = z.number().int().nonnegative().safe();
const timestamp = count.max(8_640_000_000_000_000);
const text = z.string();
const nonempty = text.min(1);
const id = text.regex(/^[0-9a-f]{64}$/);
const contentRank = z.object({ event_id: id, new_replies: count });
const account = z.object({
  platform: nonempty, handle: nonempty, binding_verified_at_ms: timestamp,
  follower_count: count.nullable(), followers_captured_at_ms: timestamp.nullable(),
  bio: text.nullable(), platform_verified: z.boolean().nullable(), platform_verification_label: text.nullable(),
});
const snapshotSchema = z.object({
  version: z.literal(3), snapshot_id: nonempty, house_id: nonempty,
  generated_at_ms: timestamp, cutoff_at_ms: timestamp, refresh_interval_ms: count.positive(), retained_since_ms: timestamp.nullable(),
  totals: z.object({ identities: count, namecards: count, verified_accounts: count, posts: count, replies: count, public_follows: count }),
  windows: z.array(z.object({
    hours: count, starts_at_ms: timestamp, follow_coverage_start_ms: timestamp.nullable(),
    activity: z.object({ new_identities: count, new_posts: count, new_replies: count, active_authors: count }),
    public_follow_net: z.number().int().safe().nullable(),
    people_growth: z.array(z.object({ person_id: nonempty, net_followers: count.positive() })).max(10),
    top_posts: z.array(contentRank).max(10),
  })).length(3),
  people: z.record(z.object({
    popclaw_id: nonempty, sigil: nonempty, nickname: text.nullable(), bio: text.nullable(), role: text.nullable(),
    public_followers: count, accounts: z.array(account),
  })),
  contents: z.record(z.object({
    event_id: id, kind: z.enum(['post', 'reply']), author_id: nonempty, authorship: z.enum(['native', 'relayed']), platform: nonempty,
    body_preview: text.refine(s => Array.from(s).length <= 200), published_at_ms: timestamp, received_at_ms: timestamp,
    parent_event_id: id.nullable(), root_event_id: id.nullable(), latest_reply_id: id.nullable(),
    reply_count_total: count, reply_count_7d: count, reply_count_24h: count, reply_count_8h: count,
  })),
  popular_replies: z.array(contentRank).max(10),
});
const legacySchema = z.object({
  window_hours: count.positive(), generated_at_ms: timestamp, total_posts: count, distinct_authors: count,
  authors: z.record(z.object({ nickname: text })),
  hot_posts: z.array(z.object({ event_id: nonempty, author: nonempty, platform: text, body_preview: text, reply_count: count, quote_count: count, created_at_ms: timestamp })),
  world_state: z.object({ identities_total: count, namecards_total: count, verified_accounts_total: count, native_posts_total: count }).optional(),
  notable_people: z.array(z.object({ popclaw_id: nonempty, nickname: text, followers_total: count, accounts: z.array(z.object({ platform: text, handle: text, follower_count: count })) })).optional(),
  summary_note: text.optional(),
}).passthrough();

function unique(values: readonly string[]): boolean { return new Set(values).size === values.length; }

/** Invalid advertised versions never fall back to legacy fields. */
export function parseWorldSummary(value: unknown): WorldSummaryResponse | null {
  const legacy = legacySchema.safeParse(value);
  if (!legacy.success) return null;
  if (!Object.hasOwn(legacy.data, 'snapshot')) return legacy.data as WorldSummaryResponse;
  const parsed = snapshotSchema.safeParse(legacy.data.snapshot);
  if (!parsed.success || !validReferences(parsed.data)) return null;
  return { ...legacy.data, snapshot: parsed.data } as WorldSummaryResponse;
}

function validReferences(s: WorldSummarySnapshot): boolean {
  const content = (key: string) => Object.hasOwn(s.contents, key) ? s.contents[key] : undefined;
  const person = (key: string) => Object.hasOwn(s.people, key) ? s.people[key] : undefined;
  if (s.cutoff_at_ms > s.generated_at_ms || (s.retained_since_ms !== null && s.retained_since_ms > s.cutoff_at_ms)) return false;
  for (const [key, p] of Object.entries(s.people)) {
    if (key !== p.popclaw_id || p.sigil !== deriveSigil(key) || !unique(p.accounts.map(a => `${a.platform}\0${a.handle}`))) return false;
    if (p.accounts.some(a => a.follower_count !== null && a.followers_captured_at_ms === null)) return false;
  }
  for (const [key, c] of Object.entries(s.contents)) {
    if (key !== c.event_id || !person(c.author_id) || c.received_at_ms > s.cutoff_at_ms) return false;
    if (c.root_event_id !== null && content(c.root_event_id)?.kind !== 'post') return false;
    if (c.kind === 'reply' && (c.parent_event_id === null || !content(c.parent_event_id) || c.root_event_id === null)) return false;
    if (c.kind === 'post' && (c.parent_event_id !== null || (c.root_event_id !== null && c.root_event_id !== key))) return false;
    if (c.latest_reply_id !== null) {
      const latest = content(c.latest_reply_id);
      if (latest?.kind !== 'reply' || latest.parent_event_id !== key) return false;
    }
    if (c.reply_count_8h > c.reply_count_24h || c.reply_count_24h > c.reply_count_7d || c.reply_count_7d > c.reply_count_total) return false;
    const seen = new Set<string>([key]);
    let parent = c.parent_event_id;
    while (parent !== null) {
      if (seen.has(parent)) return false;
      seen.add(parent);
      const entry = content(parent);
      if (!entry || (entry.kind === 'post' ? entry.event_id : entry.root_event_id) !== c.root_event_id) return false;
      parent = entry.parent_event_id;
    }
  }
  for (const [i, w] of s.windows.entries()) {
    if (w.hours !== [168, 24, 8][i] || w.starts_at_ms !== s.cutoff_at_ms - w.hours * 3_600_000) return false;
    if (w.follow_coverage_start_ms === null) {
      if (w.public_follow_net !== null || w.people_growth.length !== 0) return false;
    } else if (w.follow_coverage_start_ms < w.starts_at_ms || w.follow_coverage_start_ms > s.cutoff_at_ms || w.public_follow_net === null) return false;
    if (!unique(w.people_growth.map(p => p.person_id)) || w.people_growth.some(p => !person(p.person_id))) return false;
    if (!unique(w.top_posts.map(p => p.event_id)) || w.top_posts.some(p => content(p.event_id)?.kind !== 'post')) return false;
  }
  return unique(s.popular_replies.map(p => p.event_id)) && s.popular_replies.every(p => content(p.event_id)?.kind === 'reply');
}
