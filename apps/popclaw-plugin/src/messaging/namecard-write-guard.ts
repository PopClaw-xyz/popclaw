/**
 * Public-client namecard write guard (private-beta source boundary).
 *
 * A house stores the Profile as a whole-row upsert (ADR-0008): every re-issue
 * replaces every field. This public client owns only the fields it actually
 * writes — nickname, locally authoritative biography and declaredAt. Other
 * Profile fields remain unowned. If the profile row a house
 * already holds carries content this client cannot re-emit — legacy payout
 * addresses from the pre-beta wallet, or any field outside the public card
 * vocabulary — a rename/rebroadcast would silently clear it. Fail closed:
 * let that specific write fail clearly and keep every other capability
 * (reads, DMs, login) untouched.
 *
 * Evidence contract — encoded from the FIXED server source
 * (`apps/lore-house/src/http/profiles.rs` at the verified e753 revision), not
 * from client-side comments:
 *
 *   - `ProfileResponse.card` is `Option<CardResponse>` with
 *     `#[serde(skip_serializing_if = "Option::is_none")]`: the conformant
 *     "no Profile yet" answer OMITS the `card` key entirely. A JSON `null`
 *     never occurs from that server and is an unknown shape here.
 *   - When a card exists, serde serializes ALL EIGHT fields — nickname,
 *     one_line_intro, taste_tags, role_persona, location_hint, avatar_uri,
 *     declared_at_ms, payout_addresses (`Vec<PayoutAddr>` with
 *     `{chain: String, address: String}` elements, empty when none
 *     declared). A card missing any field is a partial response and is NOT
 *     evidence of anything; `{}` is not a complete Profile.
 *   - `ProfileResponse` itself always serializes `popclaw_id`, `sigil`,
 *     `profiles` and `house_follower_count` alongside the optional `card`.
 *
 * What may count as "no old profile to preserve" for a write decision:
 *
 *   - a conformant body whose `card` key is omitted;
 *   - a complete, correctly-typed card whose only non-empty fields are the
 *     client-owned fields. Biography replacement is authorized only for an
 *     explicit bio edit; rename and self-heal require the persisted exact intro. Content in any other field (payout_addresses
 *     included) blocks the write.
 *
 * Everything else — 404 (an unimplemented or renamed profile route is
 * indistinguishable from identity-not-found at the client), a `null` or
 * partial card, a wrong identity, a non-object body, invalid JSON, a
 * redirect, an oversized body, a transport failure — is UNREADABLE and
 * blocks the write. An unreachable or partial answer must never become
 * evidence that there was nothing to preserve. The SAME evidence rules
 * apply to every actual push path, the self-heal loop included: it also
 * performs the whole-row upsert and gets no exemption.
 *
 * Transport: `redirect: 'error'` (a redirect must not launder another
 * origin's answer in as this house's), a bounded body read, and no
 * synthesized house origins.
 *
 * Coverage: the houses read are the houses written. A command captures ONE
 * write plan (`captureNamecardWritePlan`) from the egress it will send
 * through; the guard reads every house in that plan and the send goes only
 * to that plan. Reading the configured houses while broadcasting to every
 * house mounted at send time let a house joined by login (or reloaded from
 * persisted participation) receive a whole-row write nobody had checked.
 */
import { LORE_HOUSE_TIMEOUT_MS } from '../world/http-timeout.js';
import type { EventEgress } from '../egress/event-egress.js';

/** The complete card vocabulary the fixed server always serializes (profiles.rs CardResponse). */
const CARD_VOCABULARY: Readonly<Record<string, 'string' | 'stringArray' | 'number' | 'payouts'>> = {
  nickname: 'string',
  one_line_intro: 'string',
  taste_tags: 'stringArray',
  role_persona: 'string',
  location_hint: 'string',
  avatar_uri: 'string',
  declared_at_ms: 'number',
  payout_addresses: 'payouts',
};

/** Fields this public client writes. Everything else must be empty on the house row. */
const CLIENT_OWNED = new Set(['nickname', 'declared_at_ms']);

/** Bodies larger than this are not a profile projection — refuse instead of buffering. */
const MAX_PROFILE_BODY_BYTES = 256 * 1024;

export type CardClassification =
  /** A complete, correctly-typed card whose content this client can re-emit without losing anything. */
  | { readonly kind: 'clean'; readonly declaredAtMs: number; readonly nickname: string; readonly oneLineIntro: string }
  /** The card carries fields this client cannot re-emit (names listed). */
  | { readonly kind: 'unowned'; readonly fields: readonly string[] }
  /** Unknown response shape: partial card, wrong types, null — not evidence of anything. */
  | { readonly kind: 'malformed'; readonly detail: string };

function isFiniteCount(v: unknown): boolean {
  return typeof v === 'number' && Number.isFinite(v);
}

/** ProfileEntry as the fixed server serializes it (profiles.rs): all always-serialized members typed. */
function isProfileEntry(v: unknown): boolean {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const e = v as Record<string, unknown>;
  return (
    typeof e.platform === 'string' &&
    typeof e.handle === 'string' &&
    typeof e.verified_at === 'string' &&
    typeof e.source_task_id === 'string' &&
    typeof e.follower_count === 'number' && Number.isFinite(e.follower_count) &&
    typeof e.avatar_url === 'string' &&
    typeof e.bio === 'string' &&
    (e.profile_url === undefined || typeof e.profile_url === 'string')
  );
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((e) => typeof e === 'string');
}

function isPayoutArray(v: unknown): boolean {
  return (
    Array.isArray(v) &&
    v.every(
      (e) =>
        typeof e === 'object' && e !== null && !Array.isArray(e) &&
        typeof (e as Record<string, unknown>).chain === 'string' &&
        typeof (e as Record<string, unknown>).address === 'string',
    )
  );
}

/**
 * Classify a serialized house card against what this client may overwrite.
 * The input is the JSON value of `ProfileResponse.card` as the wire produced
 * it. Pure — the test file pins every branch.
 */
export function classifyNamecardCard(card: unknown, authority: NamecardIntroAuthority = {}): CardClassification {
  if (card === null || card === undefined) {
    return { kind: 'malformed', detail: 'card is null/undefined — the conformant no-card answer omits the key' };
  }
  if (typeof card !== 'object' || Array.isArray(card)) {
    return { kind: 'malformed', detail: 'card is not an object' };
  }
  const record = card as Record<string, unknown>;
  for (const key of Object.keys(CARD_VOCABULARY)) {
    if (!(key in record)) {
      return { kind: 'malformed', detail: `partial card: ${key} missing` };
    }
  }
  const unowned: string[] = [];
  for (const [key, value] of Object.entries(record)) {
    const expected = CARD_VOCABULARY[key];
    if (expected === undefined) {
      unowned.push(key);
      continue;
    }
    const wellTyped =
      expected === 'string' ? typeof value === 'string'
      : expected === 'number' ? typeof value === 'number' && Number.isFinite(value)
      : expected === 'stringArray' ? isStringArray(value)
      : isPayoutArray(value);
    if (!wellTyped) {
      // A number where a string belongs is an unknown response shape, not an
      // empty field — never interpret it as "nothing to preserve".
      return { kind: 'malformed', detail: `card.${key} is not ${expected === 'stringArray' ? 'string[]' : expected === 'payouts' ? '{chain,address}[]' : expected}` };
    }
    if (CLIENT_OWNED.has(key)) continue;
    if (key === 'one_line_intro' && (authority.allowIntroReplacement || value === (authority.oneLineIntro ?? ''))) continue;
    const nonEmpty =
      (typeof value === 'string' && value.length > 0) ||
      (Array.isArray(value) && value.length > 0);
    if (nonEmpty) unowned.push(key);
  }
  if (unowned.length > 0) return { kind: 'unowned', fields: unowned };
  const declaredAtMs = record.declared_at_ms;
  return { kind: 'clean', declaredAtMs: typeof declaredAtMs === 'number' ? declaredAtMs : 0,
    nickname: record.nickname as string, oneLineIntro: record.one_line_intro as string };
}

/** One house's answer, reduced to what a write decision may legally rest on. */
export type HouseProfileEvidence =
  /** Conformant body with the `card` key omitted — the contract's explicit "no Profile yet". */
  | { readonly status: 'no-card' }
  /** A complete clean card; `declaredAtMs` for staleness comparisons. */
  | { readonly status: 'clean-card'; readonly declaredAtMs: number; readonly nickname: string; readonly oneLineIntro: string }
  | {
      readonly status: 'blocked';
      readonly kind: 'unreadable' | 'unowned';
      readonly detail: string;
    };

export interface NamecardIntroAuthority {
  /** Current local biography, read from MyNamecard. Never populated from the remote row. */
  readonly oneLineIntro?: string;
  /** Only an explicit owner bio edit may replace a correctly typed remote intro. */
  readonly allowIntroReplacement?: boolean;
}

export interface HouseProfileReadDeps extends NamecardIntroAuthority {
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
}

async function readBounded(resp: Response, cap: number): Promise<string> {
  const reader = resp.body?.getReader();
  if (!reader) return resp.text();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > cap) throw new Error(`body exceeds ${cap} bytes`);
      chunks.push(value);
    }
  } catch (err) {
    // Release the socket/body instead of leaving a half-drained stream open.
    await reader.cancel().catch(() => {});
    throw err;
  } finally {
    reader.releaseLock();
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    joined.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder().decode(joined);
}

/**
 * Read one house's profile answer under the evidence rules above. This is
 * the single shared reader for the write guard and the self-heal loop —
 * they answer different questions but rest on the same evidence.
 */
export async function readHouseProfileEvidence(
  origin: string,
  popclawId: string,
  deps: HouseProfileReadDeps = {},
): Promise<HouseProfileEvidence> {
  const fetchFn = deps.fetch ?? globalThis.fetch;
  const timeout = deps.timeoutMs ?? LORE_HOUSE_TIMEOUT_MS;
  const base = origin.replace(/\/$/, '');
  const endpoint = `${base}/v1/profile/${encodeURIComponent(popclawId)}`;
  let resp: Response;
  try {
    resp = await fetchFn(endpoint, {
      signal: AbortSignal.timeout(timeout),
      redirect: 'error',
    });
  } catch (err) {
    return { status: 'blocked', kind: 'unreadable', detail: String(err) };
  }
  // 404 is deliberately NOT "no row": an unimplemented or renamed profile
  // route is indistinguishable from identity-not-found at the client.
  if (!resp.ok) {
    // Release the (unconsumed) body without changing the blocked outcome.
    await resp.body?.cancel().catch(() => {});
    return { status: 'blocked', kind: 'unreadable', detail: `HTTP ${resp.status}` };
  }
  let body: unknown;
  try {
    body = JSON.parse(await readBounded(resp, MAX_PROFILE_BODY_BYTES));
  } catch (err) {
    return { status: 'blocked', kind: 'unreadable', detail: `unreadable body: ${String(err)}` };
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { status: 'blocked', kind: 'unreadable', detail: 'body is not an object' };
  }
  const record = body as Record<string, unknown>;
  if (record.popclaw_id !== popclawId) {
    return { status: 'blocked', kind: 'unreadable', detail: 'body popclaw_id does not match the queried identity' };
  }
  // Always-serialized ProfileResponse members (fixed profiles.rs contract):
  // popclaw_id, sigil, profiles, house_follower_count, house_post_count,
  // house_reply_received_count. Their presence AND types pin that this
  // really is a /v1/profile answer and not some other JSON route; the
  // optional-card omission is only trusted inside a complete match.
  if (
    typeof record.sigil !== 'string' ||
    !Array.isArray(record.profiles) ||
    !isFiniteCount(record.house_follower_count) ||
    !isFiniteCount(record.house_post_count) ||
    !isFiniteCount(record.house_reply_received_count)
  ) {
    return { status: 'blocked', kind: 'unreadable', detail: 'body is not a complete ProfileResponse (sigil/profiles/house_follower_count/house_post_count/house_reply_received_count)' };
  }
  for (const entry of record.profiles) {
    if (!isProfileEntry(entry)) {
      return { status: 'blocked', kind: 'unreadable', detail: 'profiles[] is not a conformant ProfileEntry' };
    }
  }
  if (!('card' in record)) return { status: 'no-card' };
  const classification = classifyNamecardCard(record.card, deps);
  if (classification.kind === 'malformed') {
    return { status: 'blocked', kind: 'unreadable', detail: classification.detail };
  }
  if (classification.kind === 'unowned') {
    return { status: 'blocked', kind: 'unowned', detail: `card carries ${classification.fields.join(', ')}` };
  }
  return { status: 'clean-card', declaredAtMs: classification.declaredAtMs,
    nickname: classification.nickname, oneLineIntro: classification.oneLineIntro };
}

export interface NamecardWriteGuardDeps extends NamecardIntroAuthority {
  readonly popclawId: string;
  /** Every house a whole-row re-issue would land on (config order). */
  readonly houseOrigins: readonly string[];
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
}

export type NamecardWriteCheck =
  | { readonly ok: true }
  | {
      readonly ok: false;
      /** `unreadable` = preservation not established; `unowned` = the row visibly carries fields this client cannot re-emit. */
      readonly kind: 'unreadable' | 'unowned';
      readonly house: string;
      readonly detail: string;
    };

/**
 * Fail-closed gate for rename/rebroadcast/renewal writes. Callers must not
 * push a namecard when this returns ok:false — the owner message says the
 * existing profile is preserved as-is and the write is deferred, never that
 * anything was lost.
 */
export async function guardNamecardWrite(deps: NamecardWriteGuardDeps): Promise<NamecardWriteCheck> {
  for (const origin of deps.houseOrigins) {
    const evidence = await readHouseProfileEvidence(origin, deps.popclawId, {
      oneLineIntro: deps.oneLineIntro, allowIntroReplacement: deps.allowIntroReplacement,
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
      ...(deps.timeoutMs ? { timeoutMs: deps.timeoutMs } : {}),
    });
    if (evidence.status === 'blocked') {
      return { ok: false, kind: evidence.kind, house: origin, detail: evidence.detail };
    }
  }
  return { ok: true };
}

/** One namecard write's houses: what the guard reads and where the card may go. */
export interface NamecardWritePlan {
  /** Sends to exactly `houses`; each house's send-time checks still apply. */
  readonly egress: EventEgress;
  /** In send order (`[0]` = home). No `origin` = the house cannot be read. */
  readonly houses: readonly { readonly house: string; readonly origin?: string; readonly slug?: string }[];
}

/**
 * Capture the write plan once per command, before the guard runs. An egress
 * that can gain houses (MultiHouseEgress) supplies the exact read addresses
 * of its frozen targets. An egress without `capturePlan`
 * (single house) cannot gain houses, so the configured list stands.
 */
export function captureNamecardWritePlan(
  egress: EventEgress,
  configuredOrigins: readonly string[],
): NamecardWritePlan {
  if (!egress.capturePlan) {
    return { egress, houses: configuredOrigins.map((origin) => ({ house: origin, origin })) };
  }
  const plan = egress.capturePlan();
  return {
    egress: plan.egress,
    houses: plan.targets.map(({ slug, origin }) => {
      if (origin === undefined) return { house: slug, slug };
      return { house: origin, origin, slug };
    }),
  };
}

/** `guardNamecardWrite` over every house in the plan; an unreadable target blocks. */
export async function guardNamecardWritePlan(
  plan: NamecardWritePlan,
  deps: Omit<NamecardWriteGuardDeps, 'houseOrigins'>,
): Promise<NamecardWriteCheck> {
  const origins: string[] = [];
  for (const { house, origin } of plan.houses) {
    if (origin === undefined) {
      return { ok: false, kind: 'unreadable', house, detail: 'no address is known for this house' };
    }
    origins.push(origin);
  }
  return guardNamecardWrite({ ...deps, houseOrigins: origins });
}
