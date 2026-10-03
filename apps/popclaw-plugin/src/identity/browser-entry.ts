/**
 * What a house declared about its browser entrance — lifted out of the
 * manifest we VERIFIED, and validated strictly before anything is signed for
 * it.
 *
 * Pure: no database, no network, no clock. The decision that reads a pin and
 * a projected row lives next door in `browser-entry-authority.ts`, the same
 * split as `read-credential.ts` / `read-authority.ts`.
 *
 * ## The house origin is not the application origin
 *
 * This is the whole reason the declaration exists. On real hardware the pin
 * names `https://house.popclaw.world` while the browser key is for
 * `https://popclaw.world` — one is the house this machine trusts, the other
 * is the site the owner ends up logged into. Neither can be derived from the
 * other, so the application origin has to be DECLARED, by the house, inside
 * bytes whose proof was checked against the pinned key. A guide cannot say
 * it (a guide is fetched without a proof), and a tool argument certainly
 * cannot.
 *
 * ## Lift leniently, validate strictly
 *
 * `browserEntryOf` grants nothing. It reads whatever the manifest put there
 * and keeps the distinction the read declaration already keeps: `undefined`
 * is a house that said nothing at all, and a present-but-useless block is a
 * house that said something naming nothing. They are different things to
 * tell someone, and collapsing them would report a misconfigured house as a
 * house without the feature.
 *
 * `selectBrowserEntry` is where the refusals live, and every one of them is
 * by name: the owner forwards these codes.
 */

/** The only profile this build speaks. Exact match — not a prefix, not a range. */
export const BROWSER_ENTRY_PROFILE = 'popclaw-browser-entry-v2';

/** The manifest's `browser_entry` block as declared, with nothing decided about it yet. */
export interface DeclaredBrowserEntry {
  readonly profile?: string;
  readonly audience?: string;
  readonly entryUrl?: string;
  readonly shortenUrl?: string;
}

/** A declaration that passed every check. These four strings are safe to act on. */
export interface VerifiedBrowserEntry {
  readonly profile: string;
  /** The application origin, exactly — scheme, host and port, no path. */
  readonly audience: string;
  readonly entryUrl: string;
  /** Absent when the house offers no shortener; the long link is then the deliverable. */
  readonly shortenUrl?: string;
}

export type BrowserEntryRefusal =
  /** No `browser_entry` block at all: this house does not offer a browser entrance. */
  | 'BROWSER_ENTRY_NOT_DECLARED'
  /** A block naming a profile this build cannot speak (or naming none). */
  | 'BROWSER_ENTRY_PROFILE_UNSUPPORTED'
  /** The right profile, but the block is missing an audience or an entry URL. */
  | 'BROWSER_ENTRY_DECLARATION_INCOMPLETE'
  /** A URL that is not https (outside the loopback exception), or carries userinfo. */
  | 'BROWSER_ENTRY_INSECURE_URL'
  /** The audience is not a bare origin, or a URL does not sit on it. */
  | 'BROWSER_ENTRY_ORIGIN_MISMATCH';

export type BrowserEntryChoice =
  | { readonly entry: VerifiedBrowserEntry }
  | { readonly refusal: BrowserEntryRefusal };

export interface BrowserEntryOptions {
  /**
   * The loopback exception, supplied by the caller rather than decided here.
   *
   * Production is https-only. An isolated test rig runs the whole triangle on
   * 127.0.0.1, and the codebase already lets each call site opt in the same
   * way (`isLoopbackOrigin(origin) ? { allowInsecureOrigin: true } : {}`).
   * Keeping it a caller-supplied predicate means this module never has to
   * decide what counts as "local", and no configuration can widen it.
   */
  readonly allowInsecureOrigin?: (url: string) => boolean;
}

/**
 * Lift `browser_entry` out of a parsed manifest. Grants nothing.
 *
 * A present block always yields an object, even an empty one: that is the
 * house saying something that named nothing, and it earns a different refusal
 * from silence. Non-string fields are dropped rather than coerced — a number
 * where a URL belongs is not a URL, and stringifying it would invent one.
 */
export function browserEntryOf(doc: Record<string, unknown>): DeclaredBrowserEntry | undefined {
  const block = doc['browser_entry'];
  if (block === undefined || block === null) return undefined;
  if (typeof block !== 'object' || Array.isArray(block)) return {};
  const b = block as Record<string, unknown>;
  const str = (key: string): string | undefined => {
    const v = b[key];
    return typeof v === 'string' && v.length > 0 ? v : undefined;
  };
  return {
    ...(str('profile') === undefined ? {} : { profile: str('profile')! }),
    ...(str('audience') === undefined ? {} : { audience: str('audience')! }),
    ...(str('entry_url') === undefined ? {} : { entryUrl: str('entry_url')! }),
    ...(str('shorten_url') === undefined ? {} : { shortenUrl: str('shorten_url')! }),
  };
}

/**
 * Turn a declaration into something signable, or refuse it by name.
 *
 * The order matters. Profile first, because a block this build cannot read is
 * not a block whose URLs are worth judging. Then completeness, then the URLs
 * themselves — and a URL failure never falls back to another value, because
 * the only alternative to "the site the house named" is "some other site".
 */
export function selectBrowserEntry(
  declared: DeclaredBrowserEntry | undefined,
  opts: BrowserEntryOptions = {},
): BrowserEntryChoice {
  if (declared === undefined) return { refusal: 'BROWSER_ENTRY_NOT_DECLARED' };
  if (declared.profile !== BROWSER_ENTRY_PROFILE) return { refusal: 'BROWSER_ENTRY_PROFILE_UNSUPPORTED' };
  const { audience, entryUrl, shortenUrl } = declared;
  if (audience === undefined || entryUrl === undefined) {
    return { refusal: 'BROWSER_ENTRY_DECLARATION_INCOMPLETE' };
  }
  const allow = opts.allowInsecureOrigin ?? (() => false);

  const audienceUrl = parseSafeUrl(audience, allow);
  if (audienceUrl === undefined) return { refusal: 'BROWSER_ENTRY_INSECURE_URL' };
  // An audience carrying a path, a query or a fragment is not an origin, and
  // the same-origin comparison below would then be comparing a URL against
  // something that is not one. Reported as a mismatch because that is what it
  // makes every other URL: nothing can sit on an origin that was never stated.
  if (audienceUrl.origin !== audience) return { refusal: 'BROWSER_ENTRY_ORIGIN_MISMATCH' };

  for (const url of [entryUrl, ...(shortenUrl === undefined ? [] : [shortenUrl])]) {
    const parsed = parseSafeUrl(url, allow);
    if (parsed === undefined) return { refusal: 'BROWSER_ENTRY_INSECURE_URL' };
    if (parsed.origin !== audience) return { refusal: 'BROWSER_ENTRY_ORIGIN_MISMATCH' };
  }

  return {
    entry: {
      profile: declared.profile,
      audience,
      entryUrl,
      ...(shortenUrl === undefined ? {} : { shortenUrl }),
    },
  };
}

/** https, or http where the caller says loopback is allowed. Never with credentials in it. */
function parseSafeUrl(raw: string, allow: (url: string) => boolean): URL | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  // Credentials in a URL are how a link is made to read as one site while
  // pointing at another; nothing legitimate declares one.
  if (url.username !== '' || url.password !== '') return undefined;
  if (url.protocol === 'https:') return url;
  if (url.protocol === 'http:' && allow(raw)) return url;
  return undefined;
}

/**
 * A stable string for "is this still the declaration I decided on".
 *
 * Covers every field, not just the ones this build happens to act on: a house
 * that moved its shortener has changed the thing the owner was shown, and a
 * fingerprint that ignored it would let a preview be confirmed against a
 * different destination. Separator is `\u0000`, which none of these values
 * can contain, so two different declarations cannot fold into one string.
 */
export function browserEntryFingerprint(declared: DeclaredBrowserEntry | undefined): string {
  if (declared === undefined) return 'none';
  return [declared.profile, declared.audience, declared.entryUrl, declared.shortenUrl]
    .map((v) => v ?? '')
    .join('\u0000');
}

/** The projection column's value: the declaration verbatim, or NULL for silence. */
export function serializeBrowserEntry(declared: DeclaredBrowserEntry | undefined): string | null {
  return declared === undefined ? null : JSON.stringify(declared);
}

/** Read it back. Unparseable storage is a house that said something meaningless, not silence. */
export function parseStoredBrowserEntry(raw: string | null): DeclaredBrowserEntry | undefined {
  if (raw === null) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as DeclaredBrowserEntry;
  } catch {
    return {};
  }
}
