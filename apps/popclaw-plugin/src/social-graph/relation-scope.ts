/**
 * Where a relation event goes, and whether that house will take it ordered —
 * the production `resolveScope` the producer's contract has demanded since
 * relation-producer.ts landed ("the producer never picks a house").
 *
 * Three inputs, deliberately kept apart because collapsing them is how a
 * house gets chosen by whoever answered fastest:
 *
 *   routing      which house this EDGE belongs to. A new declare uses home unless
 *               the owner names an exact configured house; a
 *               revoke follows the ledger's declaration — an unfollow goes
 *               back to the house that holds the follow, never to wherever
 *               the person happens to be now.
 *   identity     the pin, keyed by ORIGIN — and CURRENT AUTHORIZATION, not a
 *               bare verification. A slug cannot be reverse-resolved into
 *               one, so the caller supplies the strict slug→origin map built
 *               from the current configuration; an unknown or conflicted slug
 *               is refused, not guessed home. The trust answer
 *               then rides the SHARED immutable prepare→commit confirmation:
 *               unblocked pin and ACTIVE participation before
 *               the network, and ONE commit transaction re-checking the pin
 *               revision, the exact participation generation, and the served
 *               key/incarnation — so a logout, block, pin change, or house
 *               restore landing during the fetch refuses instead of
 *               authorising a capability answer (an incarnation move BLOCKS
 *               the pin, which is that boundary's security outcome).
 *   capability  parsed from the SAME verified manifest bytes the proof was
 *               checked over — only after the shared boundary confirmed —
 *               with no cache, no second endpoint, no handle from a previous
 *               fetch. The rules are the frozen v1 contract:
 *                 relations absent                → unsupported
 *                 relations.ordered === 1 (int)   → supported
 *                 anything else present           → capability-unknown
 *               A manifest that is not valid JSON is not "declares nothing";
 *               it is unreadable — capability-unknown, never unsupported.
 *
 * What a `supported` here is NOT: a promise the house executes honestly or
 * holds complete history. It is the house's own signed statement, and the
 * receipt at push time still means transport acceptance and nothing more.
 */
import type { HostDb } from '../host/host-db.js';
import { normalizeHouseOrigin } from '../runtime/house-lifecycle/control-client.js';
import {
  commitHouseTrust,
  prepareConfirmHouseTrust,
  verifiedManifestBytes,
} from '../world/house-trust.js';
import { isLoopbackOrigin } from './relation-host.js';
import type { RelationScope, RelationScopeRequest } from './relation-producer.js';

/** One configured house: the slug the configuration knows it by, and the
 *  origin its manifest and pin live at. */
export interface RelationScopeHouse {
  readonly slug: string;
  readonly origin: string;
}

export interface RelationScopeResolverDeps {
  readonly db: HostDb;
  /**
   * The strict slug→origin mapping, built by each root from its CURRENT
   * supported configuration. Duplicate slugs make every lookup of that slug
   * refuse: a config that cannot name its houses uniquely cannot route to
   * them, and picking one of the two silently is how the wrong house gets a
   * follow.
   */
  readonly houses: readonly RelationScopeHouse[];
  /** Retained caller input; discovery never authorizes a new follow route. */
  readonly houseOf?: (followee: string) => string | undefined;
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => number;
}

type Capability =
  | { readonly kind: 'supported' }
  | { readonly kind: 'unsupported' }
  | { readonly kind: 'unknown'; readonly detail: string };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * The frozen v1 capability read. No "≤ highest known level"
 * future-compat: a level this build does not know is UNKNOWN, because what a
 * newer level means is not this build's to guess. Extra unrelated fields
 * inside `relations` are allowed — the contract names `ordered`, and only it.
 */
function parseOrderedCapability(rawBytes: Uint8Array): Capability {
  const text = new TextDecoder().decode(rawBytes);
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return { kind: 'unknown', detail: 'manifest is not valid JSON' };
  }
  if (!isPlainObject(doc)) {
    return { kind: 'unknown', detail: 'manifest is not a JSON object' };
  }
  const relations = doc['relations'];
  if (relations === undefined) {
    return { kind: 'unsupported' };
  }
  if (!isPlainObject(relations)) {
    return { kind: 'unknown', detail: 'manifest relations block is not an object' };
  }
  const ordered = relations['ordered'];
  if (ordered === undefined) {
    return { kind: 'unknown', detail: 'manifest relations block names no ordered level' };
  }
  if (typeof ordered !== 'number' || !Number.isInteger(ordered) || ordered !== 1) {
    // Strings, 0, negatives, decimals, and levels this build does not know —
    // all one answer, on purpose: none of them is the house saying "1".
    return {
      kind: 'unknown',
      detail: `manifest declares ordered=${JSON.stringify(ordered) ?? String(ordered)}, this build knows only 1`,
    };
  }
  return { kind: 'supported' };
}

export interface StrictSlugMap {
  /** The home house's slug — the first configured house. */
  readonly homeSlug: string | undefined;
  lookup(slug: string): { readonly origin: string } | { readonly conflict: true } | undefined;
}

/**
 * The strict slug→origin map every relation-side consumer shares (scope
 * resolution AND the push adapter): a slug maps to exactly one origin or it
 * answers nothing. Built from the caller's CURRENT configuration, never
 * refreshed or extended from observed traffic.
 */
export function buildStrictSlugMap(houses: readonly RelationScopeHouse[]): StrictSlugMap {
  // CANONICALISED ONCE, here, because this is the single place the relation
  // side turns configuration into origins — and every consumer of this map
  // then spends that origin as a pin-table key.
  //
  // `config.lore_houses` is validated by `z.string().url()` and nothing more,
  // so `https://house.popclaw.me/` and `https://House.popclaw.me` both arrive
  // verbatim. The pin is filed under the CANONICAL origin (migration 034:
  // "Canonical origin, no trailing slash, no path"; `HouseRuntime` normalises
  // before it binds) and `pinnedBinding` is an exact `WHERE origin = ?` — so a
  // raw spelling here finds no pin at all, at a house the owner configured and
  // the runtime trusts. Canonicalising at each consumer instead would be the
  // same conversion written down repeatedly, which is how the next consumer
  // comes to forget it.
  //
  // An address with no canonical form THROWS, deliberately and consistently
  // with the surrounding code: `HouseRuntime`'s constructor normalises the
  // same configured list and throws on the same input, and it is constructed
  // before the relation producer in all three roots — so boot has already
  // refused such a house before this runs, and this can only ever be the
  // second opinion that agrees.
  const bySlug = new Map<string, { origin: string; origins: Set<string> }>();
  for (const h of houses) {
    const origin = normalizeHouseOrigin(h.origin);
    const existing = bySlug.get(h.slug);
    if (existing === undefined) {
      bySlug.set(h.slug, { origin, origins: new Set([origin]) });
    } else {
      // Conflicts are STICKY: a slug accumulates the set of distinct CANONICAL
      // origins ever mapped to it, and any second one marks it conflicted
      // forever after. A [A, B, B] sequence must not end "unconflicted B"
      // because the last entry repeated — the config named two houses by one
      // name, and picking either is the guess this map exists to refuse.
      //
      // Two SPELLINGS of one house are not two houses, so they collapse here
      // rather than conflicting: the same answer `plugin-bootstrap` already
      // gives one layer up ("reject distinct origins before deduplicating
      // equivalent URLs"), and the same answer this map already gave for an
      // exactly repeated line. Conflicting instead would make one duplicated
      // config line refuse every relation at that house.
      existing.origins.add(origin);
    }
  }
  return {
    homeSlug: houses[0]?.slug,
    lookup(slug: string) {
      const hit = bySlug.get(slug);
      if (hit === undefined) return undefined;
      return hit.origins.size > 1 ? { conflict: true } : { origin: hit.origin };
    },
  };
}

export function makeRelationScopeResolver(
  deps: RelationScopeResolverDeps,
): (req: RelationScopeRequest) => Promise<RelationScope> {
  return async (req) => {
    // Snapshot the current list once; this request keeps its selected origin across awaits.
    const houses = [...deps.houses];
    const map = buildStrictSlugMap(houses);
    const homeSlug = map.homeSlug;
    let explicit: string | undefined;
    if (req.house !== undefined) {
      if (typeof req.house !== 'string') return { support: 'unproven', detail: 'explicit house must be a string' };
      explicit = req.house.trim();
      if (explicit.includes('://') || explicit.startsWith('//')) {
        try {
          const origin = normalizeHouseOrigin(explicit);
          const suffix = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]+(.*)$/i.exec(explicit)?.[1];
          if (suffix !== '' && suffix !== '/') throw new Error('house must be an origin');
          explicit = houses.find(h => normalizeHouseOrigin(h.origin) === origin)?.slug;
        } catch { explicit = undefined; }
      }
      if (explicit === undefined || !map.lookup(explicit)) {
        return { support: 'unproven', detail: 'explicit house is not an exact configured slug or origin' };
      }
    }
    if (req.activeUncertainty && (explicit === undefined || req.uncertainHouses === undefined ||
        req.uncertainHouses.some(h => (h ?? homeSlug) === explicit))) {
      return { support: 'unproven', reason: 'RELATION_SIGNING_NOT_READY', houseSlug: explicit,
        detail: req.activeUncertainty };
    }
    const active = req.activeHouses === undefined ? undefined : [...new Set(req.activeHouses.map(h => h ?? homeSlug))];
    let slug = explicit;
    if (slug === undefined) {
      if (active !== undefined && active.length > 1) {
        if (req.action === 'declare' && homeSlug !== undefined && active.includes(homeSlug)) slug = homeSlug;
        else return { support: 'unproven', reason: 'HOUSE_SELECTION_REQUIRED', detail: 'multiple house edges; specify house' };
      } else slug = active?.[0] ?? req.declaredEdge?.houseSlug ?? homeSlug;
    }
    if (req.action === 'revoke' && active !== undefined && !active.includes(slug)) {
      return { support: 'unproven', reason: 'RELATION_NOT_FOLLOWING', houseSlug: slug, detail: 'no active follow at this house' };
    }
    if (slug === undefined) {
      return { support: 'unproven', detail: 'no houses are configured' };
    }
    const house = map.lookup(slug);
    if (house === undefined) {
      return {
        support: 'unproven',
        houseSlug: slug,
        detail: 'house is not present in the current configuration',
      };
    }
    if ('conflict' in house) {
      return {
        support: 'unproven',
        houseSlug: slug,
        detail: 'the current configuration maps this slug to more than one origin',
      };
    }

    // Identity AND current authorization, through the SHARED immutable
    // prepare→commit trust confirmation: a verified signature is
    // not a participation authorization. The prepare refuses before the
    // network when there is no unblocked pin or no ACTIVE participation for
    // the pinned key; the commit is ONE transaction re-checking the pin's
    // revision, the exact participation generation, AND the served
    // key/incarnation against the pin — so a logout, a block, a pin change,
    // or a house restore landing during the fetch refuses here instead of
    // authorising a capability answer (an incarnation move blocks the pin,
    // which is the security outcome that boundary exists for).
    // Loopback is this machine — the one case allowInsecureOrigin exists
    // for (local test houses and dev lore-houses; the SAME rule the attach
    // path applies at relation-host:280). Everything else stays https-or-
    // refused (the scope path must not be stricter than the
    // attach path it feeds, nor looser than the trust rules allow).
    const prepared = await prepareConfirmHouseTrust(deps.db, house.origin, {
      fetch: deps.fetch,
      ...(isLoopbackOrigin(house.origin) ? { allowInsecureOrigin: true } : {}),
    });
    if (!prepared.ok) {
      // The prepare's refusals before the network are trust facts (unproven);
      // a fetch refusal is the network's (unreachable); proof failures are
      // trust facts again.
      const r = prepared.refusal;
      if (r === 'HOUSE_NOT_TRUSTED' || r === 'HOUSE_OWNER_MOVED_ON') {
        return { support: 'unproven', houseSlug: slug, detail: r };
      }
      if (r === 'MANIFEST_PROOF_MALFORMED' || r.startsWith('MANIFEST_PROOF_') || r === 'HOUSE_PIN_INVALID') {
        return { support: 'unproven', houseSlug: slug, detail: r };
      }
      return { support: 'unreachable', houseSlug: slug, detail: String(r) };
    }
    const committed = commitHouseTrust(deps.db, prepared.prepared);
    if (!committed.ok) {
      // The world moved between the fetch and the commit — or the served
      // binding disagrees with the pin (key/incarnation change, now blocked).
      // Either way this end has no authorization to answer 'supported'.
      return { support: 'unproven', houseSlug: slug, detail: String(committed.refusal) };
    }
    const verifiedBytes = verifiedManifestBytes(prepared.prepared);
    if (verifiedBytes === undefined) {
      return { support: 'unproven', houseSlug: slug, detail: 'no verified manifest bytes on the prepared fact' };
    }

    // Capability, from the SAME verified bytes the proof was checked over —
    // parsed only after the shared boundary confirmed, so the answer rides an
    // authorization that is current as of this call.
    const cap = parseOrderedCapability(verifiedBytes);
    if (cap.kind === 'supported') {
      return { support: 'supported', houseKey: committed.binding.houseKey, houseSlug: slug };
    }
    if (cap.kind === 'unsupported') {
      return {
        support: 'unsupported',
        houseKey: committed.binding.houseKey,
        houseSlug: slug,
        detail: 'the manifest declares no ordered relations',
      };
    }
    return {
      support: 'capability-unknown',
      houseKey: committed.binding.houseKey,
      houseSlug: slug,
      detail: cap.detail,
    };
  };
}
