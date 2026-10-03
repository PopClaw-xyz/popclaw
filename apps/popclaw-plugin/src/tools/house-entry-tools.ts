/**
 * `popclaw_house_entry_link` — the owner's way back into a house's website.
 *
 * The link this mints IS a login key. Anyone holding it is the owner on that
 * site until it expires, and there is no way to take it back before then. So
 * the whole design of this tool is about who decided to make one, and for
 * which site:
 *
 *  - the DESTINATION is never chosen here. It comes from the `browser_entry`
 *    block of the manifest whose proof was verified against the house's
 *    pinned key, projected in the same transaction as that pin
 *    (`browser-entry-authority.ts`). No URL a caller passed, no address out
 *    of a guide, no origin derived from the house's own hostname — the house
 *    origin and the application origin are genuinely different on real
 *    hardware, and the receipt says both out loud;
 *  - the KEY is never touched here. The payload goes to `Signer`, which
 *    returns a signature, exactly as `popclaw_pair_browser` does;
 *  - the DECISION is the owner's, per link. Mounting a house means the
 *    service is available; it is not a standing permission to hand out login
 *    keys for a website. So this is a two-call tool — preview, then confirm —
 *    built on the same draft table `popclaw_invite` and the write chain use:
 *    the first call resolves, validates, shows, and signs NOTHING; the second
 *    call carries a single-use reference to that one parked operation and is
 *    the only call that produces bytes or talks to the site. (The one network
 *    read a preview may make is to the HOUSE, not the site: when the local
 *    projection says "no entrance", its manifest is re-checked once through
 *    the verified confirm, because that projection can predate the entrance.
 *    Being a real confirm, that re-check can also BLOCK the pin — a house
 *    serving another incarnation is refused exactly as on a reconnect — and
 *    the preview then reports HOUSE_NOT_PINNED.)
 *    An unconfirmed preview leaves nothing behind but an entry that expires.
 *
 * Between the two calls the world can move, so the confirm re-runs the whole
 * decision and refuses if the identity, the pin or the declaration is not the
 * one the owner was shown. A receipt afterwards is not a substitute for that:
 * by then the key exists.
 */

import { HouseEntryLinkSchema } from './tool-schemas.js';
import { makeDraftToken, putDraft, takeDraft, type DraftKind } from './draft-store.js';
import type { ToolsCtx } from './tools-context.js';
import { ownerLang, failureText } from '../lexicon/owner-language.js';
import { renderCopy } from '../lexicon/index.js';
import { hostDbSlug, houseRefToSlug } from '../ingress/host-slug.js';
import { isLoopbackOrigin } from '../social-graph/relation-host.js';
import { deriveSigil } from '../invite/sigil.js';
import type { Signer } from '../identity/signer.js';
import type { HostDb } from '../host/host-db.js';
import {
  decideBrowserEntry,
  decideBrowserEntryRefreshing,
  type BrowserEntryAuthorityRefusal,
} from '../identity/browser-entry-authority.js';
import { declarationCheckedAt } from '../world/house-read-declaration.js';
import {
  browserEntryLongLink,
  mintBrowserEntryToken,
  SELF_PORTRAIT_KEYS,
  type SelfPortrait,
} from '../identity/browser-entry-token.js';
import { shortenBrowserEntryLink, type PostJson } from '../identity/browser-entry-shortener.js';

/**
 * This tool's own draft kind, and nothing else may execute it.
 *
 * One process-level table backs every confirm gate, so a token minted by one
 * tool is physically reachable through another tool's confirm parameter.
 * `takeDraft` demands the kinds the CALLER may execute: a `message-3` handed
 * here cannot fire a DM through this door, and a `house-entry-7` handed to
 * `popclaw_send_draft` cannot mint a login key.
 */
const HOUSE_ENTRY_KINDS = ['house-entry'] as const satisfies readonly DraftKind[];

/** The agent-facing half of the receipt — same role as invite-tools' CONFIRM_DISCIPLINE. */
const CONFIRM_DISCIPLINE =
  'Nothing has been signed and nothing has been sent. Read the preview back to the owner in their own ' +
  'language — including who the link would log in as, which site it opens, and that anyone holding it is ' +
  'them there until it expires. Only after they explicitly say go, call popclaw_house_entry_link again ' +
  'with confirm_token alone. That second call is the one that mints the key.';

/** Every parameter this tool knows. Anything else is refused, not ignored. */
const KNOWN_PARAMS = new Set(['house', 'description', 'persona', 'home_city', 'confirm_token']);

/** What the preview parked, and what the confirm has to still be true about. */
interface EntryBinding {
  readonly popclawId: string;
  readonly origin: string;
  readonly houseKey: string;
  readonly pinRevision: number;
  readonly fingerprint: string;
  readonly audience: string;
  readonly selfPortrait: SelfPortrait | undefined;
}

/** The runtime slots this tool reads. Narrow on purpose — it wants a key, a database and a house list. */
interface EntryRuntime {
  readonly boot: { readonly signer: Signer; readonly popclawId: string; readonly loreHouseUrls: readonly string[]; readonly nickname?: string };
  readonly host: { readonly db: HostDb };
  /**
   * The house's guarded public read lane (`HouseRuntime.houseReadFetch`): same
   * origin only, GET only, no credentials, no redirects, and only for a house
   * this machine has joined. Used for one thing — re-checking a manifest whose
   * local projection says "no entrance". Absent in a runtime that has none.
   */
  readonly houseRuntime?: { houseReadFetch(origin: string): typeof globalThis.fetch };
}

/** Injected in tests; production takes the real network and the real clock. */
export interface HouseEntryToolOptions {
  readonly postJson?: PostJson;
  readonly nowSeconds?: () => number;
}

export function registerHouseEntryTools(ctx: ToolsCtx, opts: HouseEntryToolOptions = {}): void {
  const { api, runtime } = ctx;
  const nowSeconds = opts.nowSeconds ?? (() => Math.floor(Date.now() / 1000));

  api.registerTool({
    name: 'popclaw_house_entry_link',
    description:
      'Call when the owner wants to open a house\'s WEBSITE in their browser as themselves — "give me an entry link", ' +
      '"let me into the site", "I want to log into <house> in my browser". Name the house the way the owner did: a ' +
      'mounted house name or slug, never a URL, and never one you chose. The link is a LOGIN KEY: it is good for ' +
      'seven days, it works on any device, and anyone who gets hold of it is the owner on that site until it expires. ' +
      'Always TWO calls: the first returns a preview — the identity it would log in as, the exact site it opens, the ' +
      'self-portrait text it would carry, and that key warning — plus a confirm_token, and signs nothing; read it ' +
      'back to the owner, and only once they say go, call this again with confirm_token alone. A token is ' +
      'single-use and expires in 30 minutes. The minted entry link is shown ONCE, alone below a separator line: hand it ' +
      'to the owner in that reply, and never repeat, quote or rewrite it in any later message. To enter again, issue a ' +
      'new one. This also applies to an entry link issued earlier, in this conversation or before it: never restate, ' +
      'summarize or re-link it from memory — issuing a new one does not revoke the old one, but repeating it is still ' +
      'reposting a live bearer key.',
    parameters: HouseEntryLinkSchema,
    execute: async (_callId: string, params: unknown) => {
      const lang = ownerLang();
      const p = (params ?? {}) as Record<string, unknown>;
      const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

      // An unexpected field is refused rather than dropped. A caller reaching
      // for `origin`, `audience`, `ttl`, `popclaw_id` or raw bytes is trying
      // to decide something this tool exists to decide for them, and silently
      // ignoring it would let them believe it took effect.
      const unknown = Object.keys(p).filter((k) => !KNOWN_PARAMS.has(k));
      if (unknown.length > 0) {
        return { type: 'text' as const, text: renderCopy(lang, 'houseEntry.unknownParameter', { fields: unknown.join(', ') }) };
      }

      // --- second call: the owner said go ---
      const confirmToken = str(p['confirm_token']);
      if (confirmToken) {
        const mint = takeDraft(confirmToken, HOUSE_ENTRY_KINDS);
        if (!mint) {
          return { type: 'text' as const, text: renderCopy(lang, 'houseEntry.draftUnknown', { token: confirmToken }) };
        }
        try {
          return { type: 'text' as const, text: (await mint()).text };
        } catch (err) {
          // The token was spent the moment it was taken (single-use by
          // design), so say so — otherwise the agent retries against a dead
          // reference for ever.
          return {
            type: 'text' as const,
            text: `${failureText('popclaw_house_entry_link', err)}\n${renderCopy(lang, 'houseEntry.mintFailed')}`,
          };
        }
      }

      // --- first call: resolve, validate, show, park ---
      const houseRef = str(p['house']);
      if (!houseRef) return { type: 'text' as const, text: renderCopy(lang, 'houseEntry.usage') };
      // A URL is not a house name. Accepting one would be exactly the
      // "caller names the destination" this tool refuses to allow, and the
      // fold below would happily turn `https://evil.example` into a slug.
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(houseRef)) {
        return { type: 'text' as const, text: renderCopy(lang, 'houseEntry.notAName', { house: houseRef }) };
      }

      let rt: EntryRuntime;
      try {
        rt = (await runtime()) as EntryRuntime;
      } catch (err) {
        return { type: 'text' as const, text: failureText('popclaw_house_entry_link', err) };
      }
      const urls = rt.boot.loreHouseUrls ?? [];
      const resolved = resolveMountedHouse(houseRef, urls);
      if ('refusal' in resolved) {
        return {
          type: 'text' as const,
          text: renderCopy(lang, 'houseEntry.notMounted', {
            house: houseRef,
            list: urls.map((u) => safeSlug(u)).join(' / ') || '-',
          }),
        };
      }

      const houseRuntime = rt.houseRuntime;
      const decision = await decideBrowserEntryRefreshing(rt.host.db, resolved.origin, {
        // The loopback exception, supplied exactly where the codebase already
        // supplies it: an isolated rig runs the whole triangle on 127.0.0.1,
        // and nothing but a loopback address can take it.
        allowInsecureOrigin: isLoopbackOrigin,
        // A "not declared" projection may simply predate the house's
        // entrance; it is re-checked once, through the verified confirm.
        ...(houseRuntime === undefined ? {} : { manifestFetch: (origin: string) => houseRuntime.houseReadFetch(origin) }),
        now: nowSeconds,
      });
      if ('refusal' in decision) {
        return {
          type: 'text' as const,
          text: refusalText(lang, rt.host.db, decision.refusal, decision.origin,
            'refreshFailed' in decision ? decision.refreshFailed : undefined),
        };
      }

      const selfPortrait = readSelfPortrait(p);
      const popclawId = await rt.boot.signer.popclawId();
      const binding: EntryBinding = {
        popclawId,
        origin: decision.origin,
        houseKey: decision.pin.houseKey,
        pinRevision: decision.pin.revision,
        fingerprint: decision.fingerprint,
        audience: decision.entry.audience,
        selfPortrait,
      };

      const token = makeDraftToken('house-entry');
      putDraft(token, async () => {
        const live = (await runtime()) as EntryRuntime;
        // Re-decide from scratch. Not "has the fingerprint changed" — the
        // whole decision, because a pin that got blocked, a house that
        // re-keyed and a manifest that moved the site are three different
        // ways for the thing the owner agreed to to stop existing.
        const again = decideBrowserEntry(live.host.db, binding.origin, {
          allowInsecureOrigin: isLoopbackOrigin,
        });
        // A moved binding is a refusal, not a crash: the reference has been
        // spent either way (single-use), so the owner gets the named reason
        // and the agent knows the recovery is a fresh preview.
        if ('refusal' in again) return { text: refusalText(lang, live.host.db, again.refusal, binding.origin) };
        const nowId = await live.boot.signer.popclawId();
        if (
          nowId !== binding.popclawId ||
          again.pin.houseKey !== binding.houseKey ||
          again.pin.revision !== binding.pinRevision ||
          again.fingerprint !== binding.fingerprint ||
          again.entry.audience !== binding.audience
        ) {
          return { text: renderCopy(lang, 'houseEntry.changed') };
        }

        // Only now. The clock is read here, not at preview: a draft's shelf
        // life is not the key's lifetime, and the seven days start when the
        // key is actually made.
        const minted = await mintBrowserEntryToken({
          signer: live.boot.signer,
          audience: again.entry.audience,
          nowSeconds: nowSeconds(),
          ...(binding.selfPortrait === undefined ? {} : { selfPortrait: binding.selfPortrait }),
        });
        const longLink = browserEntryLongLink(again.entry.entryUrl, minted.token);
        const shortened = await shortenBrowserEntryLink({
          entry: again.entry,
          token: minted.token,
          ...(opts.postJson === undefined ? {} : { postJson: opts.postJson }),
        });
        const identity = displayIdentity(binding.popclawId, live.boot.nickname);
        const link = shortened.kind === 'short' ? shortened.link : longLink;
        const head = renderCopy(lang, 'houseEntry.ok', {
          identity,
          audience: again.entry.audience,
          house: binding.origin,
          expires: String(minted.claims.exp),
        });
        const tail =
          shortened.kind === 'short'
            ? ''
            : `\n${renderCopy(lang, shortened.kind === 'not-offered' ? 'houseEntry.shortenUnavailable' : 'houseEntry.shortenFailed', { reason: shortened.reason ?? '' })}`;
        // The link appears exactly once, last, alone under a separator: the
        // explanation above it can be relayed without the key, and the
        // show-once instruction sits where the agent reads it before the link.
        // noRestate covers a DIFFERENT lapse than showOnce: an agent restating
        // a link issued in an earlier turn (or an earlier day) from memory,
        // with no link present in this reply at all.
        return {
          text:
            `${head}\n${renderCopy(lang, 'houseEntry.keyWarning', { audience: again.entry.audience })}${tail}\n` +
            `${renderCopy(lang, 'houseEntry.noRestate')}\n` +
            `${renderCopy(lang, 'houseEntry.showOnce')}\n\n${renderCopy(lang, 'houseEntry.linkLabel')}\n${link}`,
        };
      });

      const preview = renderCopy(lang, 'houseEntry.preview', {
        identity: displayIdentity(popclawId, rt.boot.nickname),
        house: decision.origin,
        audience: decision.entry.audience,
        entry: decision.entry.entryUrl,
        portrait: describePortrait(lang, selfPortrait),
      });
      return {
        type: 'text' as const,
        text:
          `${preview}\n${renderCopy(lang, 'houseEntry.keyWarning', { audience: decision.entry.audience })}\n` +
          `${renderCopy(lang, 'houseEntry.noRestate')}\n\nconfirm_token: ${token}\n${CONFIRM_DISCIPLINE}`,
      };
    },
  });
}

/** `name#sigil (popclaw_id)` — everything the owner needs to recognise whose key this is. */
function displayIdentity(popclawId: string, nickname: string | undefined): string {
  const sigil = deriveSigil(popclawId);
  return nickname ? `${nickname}#${sigil} (${popclawId})` : `#${sigil} (${popclawId})`;
}

/** Only the three allowlisted fields, only when the owner actually gave one. */
function readSelfPortrait(p: Record<string, unknown>): SelfPortrait | undefined {
  const out: Record<string, string> = {};
  for (const key of SELF_PORTRAIT_KEYS) {
    const raw = p[key];
    // Whitespace is not a self-portrait. Dropping a blank here is not
    // "cleaning input in place of validating it": the producer refuses an
    // empty value outright, and this is the difference between a field the
    // owner left alone and one they filled in.
    const value = typeof raw === 'string' ? raw.trim() : '';
    if (value.length > 0) out[key] = value;
  }
  return Object.keys(out).length === 0 ? undefined : (out as SelfPortrait);
}

/** The preview's portrait line: what will actually be sent, or that nothing will. */
function describePortrait(lang: ReturnType<typeof ownerLang>, portrait: SelfPortrait | undefined): string {
  if (portrait === undefined) return renderCopy(lang, 'houseEntry.portraitNone');
  return SELF_PORTRAIT_KEYS.filter((k) => portrait[k] !== undefined)
    .map((k) => `${k}: ${portrait[k]!}`)
    .join(' · ');
}

/**
 * The owner's word for a house → the origin this machine has mounted.
 *
 * Folded first, then matched against the mounted list, the same shape
 * `/popclaw feedback --house` uses (ADR-0042): a person says "popclaw.world"
 * and the machine calls that house `house-popclaw-world`, so folding alone
 * would produce a slug nobody owns. An exact hit wins; otherwise the one
 * mounted house whose slug contains it. Several matches refuse — guessing
 * which site gets a login key is not a thing this tool may do.
 */
function resolveMountedHouse(
  ref: string,
  urls: readonly string[],
): { readonly origin: string } | { readonly refusal: 'HOUSE_NOT_MOUNTED' } {
  const folded = houseRefToSlug(ref);
  const bySlug = new Map<string, string[]>();
  for (const url of urls) {
    const slug = safeSlug(url);
    bySlug.set(slug, [...(bySlug.get(slug) ?? []), url]);
  }
  const exact = bySlug.get(folded);
  if (exact !== undefined) {
    return exact.length === 1 ? { origin: exact[0]! } : { refusal: 'HOUSE_NOT_MOUNTED' };
  }
  const hits = [...bySlug.entries()].filter(([slug]) => slug.includes(folded));
  if (hits.length !== 1 || hits[0]![1].length !== 1) return { refusal: 'HOUSE_NOT_MOUNTED' };
  return { origin: hits[0]![1][0]! };
}

function safeSlug(url: string): string {
  try {
    return hostDbSlug(url);
  } catch {
    return url;
  }
}

/**
 * One refusal, one code, one sentence — and the CODE stays verbatim in the
 * message because owners forward these to whoever runs the house.
 */
function refusalText(
  lang: ReturnType<typeof ownerLang>,
  db: HostDb,
  refusal: BrowserEntryAuthorityRefusal,
  origin: string,
  refreshFailed?: string,
): string {
  if (refusal === 'BROWSER_ENTRY_NOT_DECLARED') {
    // Dated either way: this is what the last VERIFIED manifest said, and
    // when a re-check could not complete the copy says the answer may be old
    // rather than stating a snapshot as the house's current word.
    const at = declarationCheckedAt(db, origin);
    const checkedAt = at === undefined
      ? renderCopy(lang, 'houseEntry.checkedAtUnknown')
      : new Date(at * 1000).toISOString().replace('.000Z', 'Z');
    return refreshFailed === undefined
      ? renderCopy(lang, 'houseEntry.notDeclared', { house: origin, checkedAt })
      : renderCopy(lang, 'houseEntry.notDeclaredStale', { house: origin, checkedAt, reason: refreshFailed });
  }
  const key = {
    HOUSE_NOT_PINNED: 'houseEntry.notPinned',
    BROWSER_ENTRY_NOT_DECLARED: 'houseEntry.notDeclared',
    BROWSER_ENTRY_PROFILE_UNSUPPORTED: 'houseEntry.profileUnsupported',
    BROWSER_ENTRY_DECLARATION_INCOMPLETE: 'houseEntry.declarationIncomplete',
    BROWSER_ENTRY_INSECURE_URL: 'houseEntry.insecureUrl',
    BROWSER_ENTRY_ORIGIN_MISMATCH: 'houseEntry.originMismatch',
  }[refusal];
  return renderCopy(lang, key, { house: origin });
}
