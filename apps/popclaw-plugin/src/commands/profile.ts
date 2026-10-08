/**
 * /popclaw profile <handle>#<sigil> — view another popclaw_id's Passport.
 *
 * Calls lore-house GET /v1/profile/by-handle/<handle>?sigil=<crockford32>.
 * Renders via shared renderPassport (same format as /popclaw status).
 *
 * Input validation:
 *   - must contain '#'
 *   - sigil must normalize (Crockford base32, o/i/l folded) to 6-12 chars
 *   - handle must be non-empty
 * Network: 404 → friendly "not found"; other errors → "lore-house unreachable".
 */

import { renderPassport, namecardDetails, type NamecardDetails, type PassportInput } from '../identity/passport-renderer.js';
import { mapVerifiedProfiles } from '../identity/profile-snapshot.js';
import { deriveSigil, parseSigilInput } from '../invite/sigil.js';
import { looksLikeBase58Id, displayNickname } from '../identity/person-resolver.js';
import { LORE_HOUSE_TIMEOUT_MS } from '../world/http-timeout.js';
import { renderCopy } from '../lexicon/index.js';
import { ownerLang } from '../lexicon/owner-language.js';
import { ActionInactiveError } from '../runtime/house-lifecycle/action-context.js';

export interface ProfileCommandDeps {
  readonly loreHouseUrl: string;
  readonly fetch: typeof globalThis.fetch;
  /**
   * The configured web base, handed to the renderer so the address on this
   * card is built by the one builder every surface uses (ADR-0032). Omitted →
   * the process default; one person must never end up with two links.
   */
  readonly webBaseUrl?: string | null;
  /**
   * The owner's own identity, when this call can see it.
   *
   * A fresh install is auto-named `ranger-xxxxxx`, and announce-namecard
   * deliberately publishes nothing for a placeholder name — so no house has a
   * `profile_cards` row for it and the by-id read comes back 404, or 200 with
   * an empty body. For a stranger that is honestly "no idea who that is"; for
   * the owner it is the normal state of a machine that just booted, and the
   * identity is sitting right here. Absent → the old behaviour for everyone.
   */
  readonly self?: { readonly popclawId: string; readonly nickname: string } | null;
  /** Display-only fallback from local resolution, scoped to the requested ID.
   * Does not assert publication or add a verified profile/namecard. */
  readonly knownPerson?: { readonly popclawId: string; readonly nickname: string };
}

export interface ProfileCommandDetails extends NamecardDetails {
  readonly namecard_source: 'house' | 'local';
  readonly public_namecard: 'observed' | 'unconfirmed';
  readonly source_house: string;
  readonly local_nickname?: string;
}

export interface ProfileCommandArgs {
  readonly target: string;  // raw "elonmusk#gdx8rgtp"
}

export async function runProfileCommand(
  args: ProfileCommandArgs,
  deps: ProfileCommandDeps,
): Promise<{ text: string; isError?: true; details?: ProfileCommandDetails }> {
  const raw = args.target.trim();
  const base = deps.loreHouseUrl.replace(/\/$/, '');
  // Two ways in, one renderer. `handle#sigil` is what the owner types at the
  // slash command; a bare popclaw_id is what person-resolution hands back, and
  // that is the only form the MCP hosts (Claude Code / Codex) can produce —
  // they get tools, never slash commands.
  let url: string;
  let handle = raw;
  let sigil = '';
  if (raw.includes('#')) {
    const [h, rawSigil] = raw.split('#');
    if (!h || h.length === 0) {
      return { text: '⚠️ handle is empty' };
    }
    const parsed = typeof rawSigil === 'string' ? parseSigilInput(rawSigil) : null;
    if (parsed === null) {
      return { text: renderCopy(ownerLang(), 'profile.badSigil') };
    }
    handle = h;
    sigil = parsed;
    url = `${base}/v1/profile/by-handle/${encodeURIComponent(h)}?sigil=${encodeURIComponent(parsed)}`;
  } else if (looksLikeBase58Id(raw)) {
    url = `${base}/v1/profile/${encodeURIComponent(raw)}`;
  } else {
    return { text: 'usage: /popclaw profile <handle>#<sigil>\nexample: /popclaw profile elonmusk#gdx8rgtp' };
  }

  // Is this the owner? Either form addresses them: the tools hand over a
  // popclaw_id, the slash command a name#sigil.
  const me = deps.self?.popclawId ? deps.self : null;
  const isSelf = me !== null && (raw === me.popclawId || (sigil !== '' && deriveSigil(me.popclawId) === sigil));
  /** The owner's card from local identity data alone — no house involved. */
  const ownCard = (): { text: string; details: ProfileCommandDetails } => {
    const passport: PassportInput = {
      popclawId: me!.popclawId, sigil: deriveSigil(me!.popclawId),
      handle: me!.nickname.trim() || `ranger-${me!.popclawId.slice(0, 6)}`,
      ...(deps.webBaseUrl === undefined ? {} : { webBaseUrl: deps.webBaseUrl }),
      card: null, profiles: [],
    };
    return {text: [...renderPassport(passport), renderCopy(ownerLang(), 'namecard.read.localOnly', {house: base})].join('\n'),
      details: {...namecardDetails(passport), namecard_source: 'local', public_namecard: 'unconfirmed', source_house: base}};
  };

  let resp: Response;
  try {
    resp = await deps.fetch(url, { signal: AbortSignal.timeout(LORE_HOUSE_TIMEOUT_MS) });
  } catch (err) {
    // Not-joined is not unreachable. The house is fine; this machine has left
    // it (here, or from the other host sharing this data directory), and the
    // raw class name of what threw says nothing the owner can act on. Same
    // three-line shape as popclaw-feed.ts. Every other error keeps its own
    // text verbatim, including the one lead we would otherwise destroy.
    if (err instanceof ActionInactiveError) return { text: renderCopy(ownerLang(), 'world.read.notJoined') };
    return { text: `⚠️ lore-house unreachable: ${String(err)}` };
  }

  if (resp.status === 404) {
    if (isSelf) return ownCard();
    return { text: renderCopy(ownerLang(), 'profile.notFound', { handle, sigil }) };
  }
  if (!resp.ok) {
    return { text: `⚠️ lore-house returned HTTP ${resp.status}` };
  }

  // Read as text first: 200 + an EMPTY body is the conformant "nobody by that
  // id yet" answer (PR #613/#614), which `resp.json()` turned into a thrown
  // SyntaxError — and this command has no wrapper to catch it. Same rule as
  // status.ts, which already reads this endpoint this way.
  const bodyText = await resp.text();
  // An empty body and a body that is not JSON at all (a captive portal serving
  // `<html>…`, a proxy error page) get the same answer. Neither is a person,
  // and `JSON.parse` throwing here reached the agent verbatim: this command
  // has no wrapper, so a raw SyntaxError WAS the tool result.
  let parsed: unknown;
  try {
    parsed = bodyText.trim() === '' ? null : JSON.parse(bodyText);
  } catch {
    parsed = null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    if (isSelf) return ownCard();
    return { text: renderCopy(ownerLang(), 'profile.notFound', { handle, sigil }) };
  }
  const body = parsed as {
    popclaw_id: string;
    sigil: string;
    house_follower_count?: number;
    profiles?: unknown;
    card?: {
      nickname?: string;
      one_line_intro?: string;
      taste_tags?: string[];
      role_persona?: string;
      location_hint?: string;
      avatar_uri?: string;
      declared_at_ms?: number;
    } | null;
  };
  const profiles = mapVerifiedProfiles(body.profiles);
  // The House card is the owner's published name. A newer local name is a
  // display fallback only when the House has no card; label that provenance.
  // Other people's verified native handle retains the established precedence.
  if (!raw.includes('#')) {
    const native = displayNickname(profiles.find((p) => p.platform === 'popclaw')?.handle);
    const cardName = displayNickname(body.card?.nickname);
    const ownName = isSelf ? displayNickname(me!.nickname) : '';
    // A hint for another ID must never label the response. Public evidence
    // remains exactly the house's card/profiles; this is only the heading.
    const knownName = deps.knownPerson?.popclawId === raw && body.popclaw_id === raw
      ? displayNickname(deps.knownPerson.nickname) : '';
    handle = isSelf ? cardName || ownName || native || knownName : native || cardName || knownName;
  }

  const passport: PassportInput = {
    popclawId: body.popclaw_id,
    sigil: body.sigil,
    handle,
    ...(deps.webBaseUrl === undefined ? {} : { webBaseUrl: deps.webBaseUrl }),
    houseFollowerCount: body.house_follower_count,
    card: body.card ? {
      nickname: body.card.nickname ?? '',
      one_line_intro: body.card.one_line_intro ?? '',
      taste_tags: body.card.taste_tags ?? [],
      role_persona: body.card.role_persona ?? '',
      location_hint: body.card.location_hint ?? '',
      avatar_uri: body.card.avatar_uri ?? '',
      declared_at: body.card.declared_at_ms ?? 0,
    } : null,
    profiles,
  };
  const publicName = displayNickname(body.card?.nickname);
  const localFallback = isSelf && !publicName;
  const lines = renderPassport(passport);
  if (localFallback) lines.push(renderCopy(ownerLang(), 'namecard.read.localOnly', {house: base}));
  return {text: lines.join('\n'), details: {...namecardDetails(passport),
    namecard_source: localFallback ? 'local' : 'house', public_namecard: publicName ? 'observed' : 'unconfirmed',
    source_house: base, ...(isSelf ? {local_nickname: me!.nickname} : {})}};
}
