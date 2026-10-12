/**
 * Complete public read-model snapshot for GET /v1/world-summary.snapshot.
 * This JSON view is not a signed event and never enters the event stream.
 * Fixed JSON shape from PR641 b05e1328147727b7a115e75992583fcf60b5df61.
 * UTC epoch milliseconds; counts are nonnegative safe integers except signed net deltas.
 * Null means unknown/unavailable, never zero. Windows are ordered 168, 24, 8 hours.
 * follow_coverage_start_ms is the actual observed growth start; null means no baseline.
 * Activity covers retained admitted public facts. It is not a complete network census.
 * body_preview contains at most 200 Unicode scalar values of original text.
 * All map keys, references and rank entries use full canonical IDs.
 */
export type SnapshotContentKind = 'post' | 'reply';
export type SnapshotAuthorship = 'native' | 'relayed';

export interface WorldSummarySnapshot {
  readonly version: number;
  readonly snapshot_id: string;
  readonly house_id: string;
  readonly generated_at_ms: number;
  readonly cutoff_at_ms: number;
  readonly refresh_interval_ms: number;
  readonly retained_since_ms: number | null;
  readonly totals: SnapshotTotals;
  readonly windows: readonly SnapshotWindow[];
  readonly people: Readonly<Record<string, SnapshotPerson>>;
  readonly contents: Readonly<Record<string, SnapshotContent>>;
  readonly popular_replies: readonly SnapshotContentRank[];
}

export interface SnapshotTotals {
  readonly identities: number;
  readonly namecards: number;
  readonly verified_accounts: number;
  readonly posts: number;
  readonly replies: number;
  readonly public_follows: number;
}

export interface SnapshotWindow {
  readonly hours: number;
  readonly starts_at_ms: number;
  readonly follow_coverage_start_ms: number | null;
  readonly activity: SnapshotActivity;
  readonly public_follow_net: number | null;
  readonly people_growth: readonly SnapshotPersonRank[];
  readonly top_posts: readonly SnapshotContentRank[];
}

export interface SnapshotActivity {
  readonly new_identities: number;
  readonly new_posts: number;
  readonly new_replies: number;
  readonly active_authors: number;
}

export interface SnapshotPersonRank {
  readonly person_id: string;
  readonly net_followers: number | null;
}

export interface SnapshotContentRank {
  readonly event_id: string;
  readonly new_replies: number;
}

export interface SnapshotPerson {
  readonly popclaw_id: string;
  readonly sigil: string;
  readonly nickname: string | null;
  readonly bio: string | null;
  readonly role: string | null;
  readonly public_followers: number;
  readonly accounts: readonly SnapshotAccount[];
}

export interface SnapshotAccount {
  readonly platform: string;
  readonly handle: string;
  readonly binding_verified_at_ms: number;
  readonly follower_count: number | null;
  readonly followers_captured_at_ms: number | null;
  readonly bio: string | null;
  readonly platform_verified: boolean | null;
  readonly platform_verification_label: string | null;
}

export interface SnapshotContent {
  readonly event_id: string;
  readonly kind: SnapshotContentKind;
  readonly author_id: string;
  readonly authorship: SnapshotAuthorship;
  readonly platform: string;
  readonly body_preview: string;
  readonly published_at_ms: number;
  readonly received_at_ms: number;
  readonly parent_event_id: string | null;
  readonly root_event_id: string | null;
  readonly reply_count_total: number;
  readonly reply_count_7d: number;
  readonly reply_count_24h: number;
  readonly reply_count_8h: number;
  readonly latest_reply_id: string | null;
}
