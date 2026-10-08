/**
 * Hand-in admission for the daily paper: which issue an edit belongs to, and
 * what of it is kept. Synchronous orchestration over the ledger — it reads
 * issues and edits (which may touch disk and evict expired cache entries),
 * and a candidate-set refusal scans the ledger via latestIssueFromCandidate —
 * so it is not a pure validator, and not every refusal is free of ledger IO.
 *
 * Moved out of publishNewspaper unchanged. The caller keeps rendering and the
 * side effects in their order: render → (unfinished: putEdit + receipt) or
 * (finished: master copy → social log → followable authors → settle →
 * upload).
 */

import { getIssue, getEdit, candidateOf, latestIssueFromCandidate } from './issue-store.js';
import { needsEditorial, numberedPulse, type IssueData } from './issue.js';
import type { NewspaperEdit } from './render-newspaper.js';
import { anchorIsAmbiguous, anchorMatches, anchorVerdict, hasQuotableBody } from './copy-anchor.js';
import { materialBlocksFor } from './build-newspaper-prompt.js';
import { renderCopy, type Lang } from '../lexicon/index.js';
import { langOf } from '../lexicon/owner-language.js';
import { cleanProvenanceId, isCandidateId, isPlaceholderId } from './issue-identity.js';

/**
 * The door check on the agent's copy. Anything wrong is **named and worked
 * around**, never thrown: the owner should get a paper plus a clear account of
 * what was thin about it, not a failed tool call and no paper at all. Only a
 * total absence of copy is refused, because that is not a thin issue, it is no issue.
 *
 * `prior` is the copy already published for this issue, when it is being written a
 * batch at a time. With one in hand the masthead and the teaser stop being required:
 * they are already printed on the page the owner has, and asking for them again per
 * batch spends output budget on words that cannot change anything.
 */
export function checkEdit(
  raw: unknown,
  lang: Lang,
  prior?: NewspaperEdit,
): { edit: NewspaperEdit } | { error: string } {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: renderCopy(lang, 'newspaper.publish.editNotObject') };
  }
  const e = raw as Record<string, unknown>;
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined);
  // The basis id is copied by the writer off the material page — the same cleaning the
  // token argument gets (trim + strip flanking quotes), so `"tok_x"` pasted with quotes
  // still resolves.
  const basis = str(e.basis)?.trim().replace(/^["']|["']$/g, '');
  const strMap = (v: unknown): Record<string, string> => {
    const out: Record<string, string> = {};
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        const s = str(x);
        if (s) out[k] = s;
      }
    }
    return out;
  };
  const items: Record<string, { h?: string; s?: string; q?: string }> = {};
  if (e.items !== null && typeof e.items === 'object' && !Array.isArray(e.items)) {
    for (const [k, v] of Object.entries(e.items as Record<string, unknown>)) {
      if (v === null || typeof v !== 'object') continue;
      const { h, s, q } = v as { h?: unknown; s?: unknown; q?: unknown };
      const head = str(h);
      const body = str(s);
      // The anchor rides along but never makes an item exist: an item still counts as
      // written on `h` or `s` alone, exactly as before. A bare `q` with no copy is
      // nothing to publish, and refusing it here would mean refusing it twice.
      const quote = str(q)?.trim();
      if (head ?? body) {
        items[k] = {
          ...(head ? { h: head } : {}),
          ...(body ? { s: body } : {}),
          ...(quote ? { q: quote } : {}),
        };
      }
    }
  }
  if (!Object.keys(items).length) return { error: renderCopy(lang, 'newspaper.publish.editNoItems') };
  const teaser = str(e.teaser) ?? prior?.teaser;
  if (!teaser) return { error: renderCopy(lang, 'newspaper.publish.editNoTeaser') };
  const masthead = str(e.masthead) ?? prior?.masthead;
  // An empty masthead is an empty `<h1>` and a title that opens with " · " — the
  // paper has no name at all. That is a re-hand-in, not a thin issue.
  if (!masthead) return { error: renderCopy(lang, 'newspaper.publish.editNoMasthead') };

  return {
    edit: {
      masthead,
      // The batch selector rides along with the copy (2026-09-06 r7): a second batch
      // that omits it still resolves through the merged prior's basis.
      ...(basis ? { basis } : {}),
      ...(str(e.edition) ? { edition: str(e.edition)! } : {}),
      weather: Array.isArray(e.weather) ? e.weather.filter((w): w is string => typeof w === 'string') : [],
      leads: Array.isArray(e.leads)
        ? e.leads.map(Number).filter((n) => Number.isInteger(n) && n > 0)
        : [],
      items,
      pulls: strMap(e.pulls),
      xrefs: strMap(e.xrefs),
      topics: strMap(e.topics),
      deckNotes: strMap(e.deckNotes),
      newbies: strMap(e.newbies),
      translations: strMap(e.translations),
      teaser,
    },
  };
}

/**
 * Two hand-ins for one issue, merged **fill-only**.
 *
 * Whatever the earlier batch said stands: a later batch may fill a slot that is
 * still empty, never rewrite one that is already on the page. The owner has read
 * that page — an item whose headline changes under them between two links to the
 * same issue is the paper contradicting itself, and no amount of "the second pass
 * was better" is worth that.
 */
function mergeEdits(prior: NewspaperEdit, next: NewspaperEdit): NewspaperEdit {
  const fill = <T>(
    a: Readonly<Record<string, T>> | undefined,
    b: Readonly<Record<string, T>> | undefined,
  ): Record<string, T> => ({ ...b, ...a });
  const fillItems = (
    a: NewspaperEdit['items'],
    b: NewspaperEdit['items'],
  ): Record<string, { h?: string; s?: string; q?: string }> => {
    const out: Record<string, { h?: string; s?: string; q?: string }> = { ...b, ...a };
    for (const key of Object.keys(out)) {
      const earlier = a?.[key];
      const later = b?.[key];
      if (!earlier || !later) continue;
      out[key] = {
        ...(earlier.h ?? later.h ? { h: earlier.h ?? later.h } : {}),
        ...(earlier.s ?? later.s ? { s: earlier.s ?? later.s } : {}),
        // The anchor is checked before the merge and never read again, but it is
        // kept alongside the copy it vouched for rather than quietly dropped here.
        ...(earlier.q ?? later.q ? { q: earlier.q ?? later.q } : {}),
      };
    }
    return out;
  };
  return {
    masthead: prior.masthead ?? next.masthead,
    // A second batch without its own basis keeps the first batch's: both were written
    // off the same page.
    basis: prior.basis ?? next.basis,
    ...(prior.edition ?? next.edition ? { edition: (prior.edition ?? next.edition)! } : {}),
    weather: prior.weather?.length ? prior.weather : (next.weather ?? []),
    leads: prior.leads?.length ? prior.leads : (next.leads ?? []),
    // `items` is the one map whose values are objects, so a whole-key merge is not fill-only
    // — it is replace-only one level down. A first hand-in carrying just `h` would keep the
    // key, the later `s` would be thrown away with the rest of that key, and `hasCopy` counts
    // an item as written on `h` alone: a headline with no body, permanently, and never listed
    // among the items still owed. Fill each field on its own.
    items: fillItems(prior.items, next.items),
    pulls: fill(prior.pulls, next.pulls),
    xrefs: fill(prior.xrefs, next.xrefs),
    topics: fill(prior.topics, next.topics),
    deckNotes: fill(prior.deckNotes, next.deckNotes),
    newbies: fill(prior.newbies, next.newbies),
    translations: fill(prior.translations, next.translations),
    teaser: prior.teaser ?? next.teaser,
  };
}

/**
 * The refused/unwritten numbers in material-page order, so the receipt lists them
 * the way the page printed them rather than the way the hand-in happened to be keyed.
 */
function materialNumbers(issue: IssueData, keys: readonly string[]): number[] {
  const wanted = new Set(keys);
  return numberedPulse(issue.pulse).flatMap(({ n }) => (wanted.has(String(n)) ? [n] : []));
}

/**
 * The material of the items still owed, reprinted verbatim under the instructions.
 *
 * A receipt that names numbers and stops assumes the writer can still see the
 * material page. It often cannot — the page is the largest thing in its context and
 * the first to be trimmed — and a writer answering from memory is exactly how one
 * item's summary ends up under another item's number (2026-09-11). Printed LAST on
 * purpose: a host that truncates keeps the head, and the instructions matter more
 * than the reprint they introduce.
 */
export function reprintOf(issue: IssueData, numbers: readonly number[], lang: Lang): string {
  // The blocks are printed in the MATERIAL PAGE's language, not the receipt's: the
  // writer is holding that page, and a reprint whose labels are translated where the
  // page printed them untranslated is a second, differently-worded copy of the same item — the one thing
  // a reprint must never be.
  const pageLang = issue.language ? langOf(issue.language) : lang;
  return `${renderCopy(lang, 'newspaper.publish.materialAgain', { count: String(numbers.length) })}\n${materialBlocksFor(issue, numbers, pageLang)}`;
}

export type Admission =
  | { kind: 'refused'; text: string; publishToken?: string }
  | {
      kind: 'admitted';
      /** The issue this hand-in is bound to (the token, or the basis when the token was unusable). */
      publishToken: string;
      issue: IssueData;
      /** The accepted copy merged fill-only into what earlier batches wrote. */
      edit: NewspaperEdit;
      /** binding → anchor → pull, in that order; the caller appends its own after them. */
      notes: string[];
    };

/**
 * Bind a hand-in to its issue and decide what of it is admitted. `lang` is
 * the receipt language the caller fixed at the start of the publish call.
 */
export function admitHandIn(
  input: { publishToken?: string; edit: unknown },
  /** Absent in some callers' deps, exactly as before: the ledger functions take it as optional. */
  deps: { manifestDir?: string },
  lang: Lang,
): Admission {
  // Two provenance fields, normalized the same way (2026-09-06 r9): the publish_token
  // argument, and `edit.basis` — the id the material page prints and teaches the writer
  // to carry back inside the edit object. The token stays optional because on some
  // hosts it can never arrive (2026-08-30: the primary host's serving path rewrites any
  // `*_token` argument to `***` in flight, 62/62 across six days, while `edit` travels
  // intact); the basis is the protocol's answer for exactly those hosts — a plain edit
  // field, required by instruction, not a physical guarantee that every model carries
  // it. "Optional" never meant "guessable": r9's ruling is NO-GUESS — publish binds
  // only what a field actually names, and a hand-in that names nothing is refused
  // before anything is uploaded or consumed.
  const givenToken = cleanProvenanceId(input.publishToken);
  const tokenReliable = !isPlaceholderId(givenToken);
  const rawEdit = input.edit as Record<string, unknown> | null | undefined;
  const basis = cleanProvenanceId(rawEdit?.basis);
  const basisReliable = !isPlaceholderId(basis);
  // Defect 2 (2026-09-06 r9): two reliable names for two DIFFERENT issues is a
  // contradiction, and resolving it by silently picking either is a guess — this used
  // to let the token win without even reading the basis. Refused here, before any
  // upload, putEdit or ledger consumption; a consistent pair (or either field alone)
  // proceeds untouched.
  let publishToken = givenToken;
  const bindingNotes: string[] = [];
  if (tokenReliable && basisReliable && basis !== givenToken) {
    // The candidate-ancestry bind (2026-09-12, verified on two live hosts). Until the
    // picks argument was renamed to `candidate_basis`, one word named two pages, and a
    // strong model handed in `edit.basis = ctok_…` alongside the right publish_token.
    // That pair is not a contradiction at all: it is a page and its own parent, and the
    // issue itself says so (`fromCandidate`, stamped at pick time). Bound — but only on
    // the issue's OWN recorded ancestry, never on shape alone, so the attribution
    // guarantee holds: the item numbers are still read against the page they were
    // written from, which is the issue the publish_token names.
    if (isCandidateId(basis) && !isCandidateId(givenToken) && candidateOf(givenToken, deps.manifestDir) === basis) {
      bindingNotes.push(
        renderCopy(lang, 'newspaper.publish.candidateAncestryNote', { token: givenToken, candidate: basis }),
      );
    } else {
      // Two names for two different pages. Where exactly one of them is material-page
      // shaped, the refusal says WHICH — the live incident lost a whole round to a
      // refusal that named both values and told the writer nothing about which to keep.
      const material = [basis, givenToken].filter((v) => !isCandidateId(v));
      const named = material.length === 1 ? material[0] : undefined;
      return {
        kind: 'refused',
        text: named
          ? renderCopy(lang, 'newspaper.publish.tokenBasisConflictNamed', {
              basis,
              token: givenToken,
              material: named,
            })
          : renderCopy(lang, 'newspaper.publish.tokenBasisConflict', { basis, token: givenToken }),
      };
    }
  }
  if (!tokenReliable) {
    // Defect 1 (2026-09-06 r9): "exactly one live issue in scope" used to bind here —
    // but a lone survivor is not provenance. The page the copy was numbered from may
    // have expired minutes ago (the --expired-a probe: A swept, only B left, A's late
    // hand-in published against B with A's summaries under B's authors), and once that
    // page is gone the ledger cannot prove which page the numbers belong to. No
    // inference available here is independently verifiable, so none is made: without a
    // reliable token OR basis, refuse — the writer re-sends carrying the basis printed
    // on its material page, or re-gathers if that page is gone.
    if (!basisReliable) {
      return { kind: 'refused', text: renderCopy(lang, 'newspaper.publish.noProvenance') };
    }
    // The basis names the exact page the copy was numbered from — bind it and say so,
    // even when a newer issue was minted since (a re-gather, another round): the copy
    // belongs to that page, and that page is what should print. A basis that resolves
    // to nothing refuses loudly; falling back to "newest" would be the misattribution
    // engine wearing the fallback's clothes.
    if (!getIssue(basis, deps.manifestDir)) {
      return { kind: 'refused', text: renderCopy(lang, 'newspaper.publish.basisExpired', { basis }) };
    }
    publishToken = basis;
    bindingNotes.push(renderCopy(lang, 'newspaper.publish.basisBoundNote', { token: basis }));
  }

  const issue = getIssue(publishToken, deps.manifestDir);
  if (!issue) {
    // It used to publish against the most recent ledger entry here and say so on the
    // receipt. That is safe only if the two issues are numbered the same, and nothing
    // guarantees it: `edit.items` is keyed by position in **the issue the copy was written
    // for**, so laying it over a different issue gives every item somebody else's words
    // under its own author and its own source link. That happened on real hardware
    // (2026-08-29) and the receipt's "the token did not match" line did not begin to
    // describe it — the paper looked finished and was lying on every line.
    //
    // Misattribution is the worst way to break the faithfulness rule, so this refuses now.
    // The materials are still on disk; calling popclaw_newspaper again is cheap, and a
    // named failure the writer can act on beats a paper nobody can trust.
    return { kind: 'refused', text: renderCopy(lang, 'newspaper.publish.tokenMismatch') };
  }

  // Publishing off a candidate set puts the whole day on the page — the exact thing the
  // choosing step exists to prevent. This used to re-select by heat and publish anyway,
  // which **renumbers the issue underneath copy written for the old numbering**: the
  // misattribution engine, dressed as a rescue. It refuses now.
  //
  // Judged two ways, because each covers what the other misses. **What the issue is**: a
  // candidate set is far larger than any chosen issue. **What the token is**: candidate
  // tokens are minted with a `c` prefix. The name check used to be the only one and a
  // machine walked straight through it (2026-08-27) by inventing a `tok_`-shaped token,
  // which then reached the candidate set through `latestIssue()`; that route is gone with
  // that function, so the prefix is precise again — and it catches a candidate set that
  // happens to be small.
  if (isCandidateId(publishToken)) {
    // Sending the writer back to the candidate page costs it everything it has already
    // written, because choosing again renumbers the issue. When a material page minted
    // from this very candidate page is still live, name it instead (2026-09-12: the
    // second lost round of the live incident was exactly this refusal).
    const child = isCandidateId(publishToken)
      ? latestIssueFromCandidate(publishToken, deps.manifestDir)
      : undefined;
    return {
      kind: 'refused',
      text: child
        ? renderCopy(lang, 'newspaper.publish.notChosenHasMaterial', {
            count: String(issue.pulse.length),
            token: child.token,
          })
        : renderCopy(lang, 'newspaper.publish.notChosen', { count: String(issue.pulse.length) }),
    };
  }

  // A token binds an issue, not positional guesses. Use the same immutable IDs as the
  // material page and renderer. One unknown reference rejects the entire batch BEFORE
  // merge/save/upload: keeping the overlapping keys can silently attach copy to another
  // author, and fill-only merging would make that contamination permanent.
  let editableNumbers: Set<string>;
  try {
    editableNumbers = new Set(numberedPulse(issue.pulse).flatMap(({ p, n }) => needsEditorial(p) ? [String(n)] : []));
  } catch {
    return { kind: 'refused', text: renderCopy(lang, 'newspaper.publish.invalidMaterialNumbering') };
  }
  const prior = getEdit(publishToken, deps.manifestDir);
  const references = (raw: unknown): { field: string; key: string }[] => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
    const e = raw as Record<string, unknown>;
    return [
      ...['items', 'pulls', 'xrefs', 'topics'].flatMap(field => {
        const value = e[field];
        return value && typeof value === 'object' && !Array.isArray(value)
          ? Object.keys(value).map(key => ({ field, key })) : [];
      }),
      ...(Array.isArray(e.leads) ? e.leads.map(n => ({ field: 'leads', key: String(n) })) : []),
    ];
  };
  const refs = [...references(input.edit), ...references(prior)];
  const stray = refs.filter(({ key }) => !editableNumbers.has(key));
  if (stray.length) {
    return {
      kind: 'refused',
      text: renderCopy(lang, 'newspaper.publish.wrongNumbering', {
        stray: String(stray.length),
        total: String(refs.length),
        numbers: stray.map(({ field, key }) => `${field}[${key}]`).join(' '),
      }),
    };
  }

  const checked = checkEdit(input.edit, lang, prior);
  if ('error' in checked) {
    // Do NOT consume the ledger entry — let the agent hand the copy in again.
    return { kind: 'refused', text: checked.error };
  }
  // The faithfulness anchor (2026-09-11). The numbering gate above proves a number
  // exists on this page; it cannot prove the copy filed under it was written from
  // THAT item, and on real hardware that is precisely what failed — legal numbers,
  // another item's summary underneath. Each item's `q` is a passage of its own body
  // copied verbatim, so the check is mechanical: no `q` from this item's body, no
  // item. Refused per item, not per hand-in — one mis-anchored item must not cost
  // the writer the nine it got right.
  const materialText = new Map<string, string>(
    numberedPulse(issue.pulse).flatMap(({ p, n }) => (needsEditorial(p) ? [[String(n), p.text] as const] : [])),
  );
  // A number missing from the map cannot happen past the numbering gate above; if it
  // ever did, there is no body to anchor against and the item is refused, not waved in.
  const written = (it: { h?: string; s?: string } | undefined): boolean =>
    Boolean(it?.h?.trim() ?? it?.s?.trim());
  // The refusal is named, not just counted: "your copy does not quote its own source"
  // covers four different mistakes, and a writer that cannot tell them apart picks one
  // at random to fix. Each refused number carries its own reason onto the receipt.
  const refusedWhy = new Map<string, 'missing' | 'notInBody' | 'tooShort' | 'ambiguous'>();
  for (const [n, it] of Object.entries(checked.edit.items ?? {})) {
    // Already on the page. Fill-only merging makes that copy immutable, so this
    // hand-in's `q` for it cannot change a word of what prints — reporting it as
    // "not accepted" would send the writer to fix what it can no longer fix.
    if (written(prior?.items?.[n])) continue;
    const text = materialText.get(n);
    const verdict = text === undefined ? 'notInBody' : anchorVerdict(text, it.q);
    if (verdict !== 'ok') {
      refusedWhy.set(n, verdict);
      continue;
    }
    // A passage two items share anchors to both, which is the same as anchoring to
    // neither: the swap this gate exists to catch walks through every check
    // (review, 2026-09-11 — two items of one author opening with the same `@handle`
    // run, the exact shape of the live failure).
    const others = [...materialText].flatMap(([k, other]) => (k === n ? [] : [other]));
    if (anchorIsAmbiguous(it.q, text!, others)) refusedWhy.set(n, 'ambiguous');
  }
  const refused = [...refusedWhy.keys()];
  const refusedSet = new Set(refused);
  const anchorNotes: string[] = [];
  let accepted = checked.edit;
  if (refused.length) {
    const keep = <T,>(m: Readonly<Record<string, T>> | undefined): Record<string, T> =>
      Object.fromEntries(Object.entries(m ?? {}).filter(([k]) => !refusedSet.has(k)));
    // A refused item takes its whole retinue with it: a pull quote, a cross-reference
    // or a topic attached to copy that never landed would be the same misattribution
    // wearing a smaller hat.
    //
    // `leads` is deliberately NOT stripped. The renderer already ignores a front-page
    // slot whose item has no copy, and mergeEdits keeps the FIRST non-empty leads
    // array — so dropping the number here would demote that item off the front page
    // for good, long after a later hand-in fixed its anchor.
    accepted = {
      ...checked.edit,
      items: keep(checked.edit.items),
      pulls: keep(checked.edit.pulls),
      xrefs: keep(checked.edit.xrefs),
      topics: keep(checked.edit.topics),
    };
    const numbers = materialNumbers(issue, refused);
    anchorNotes.push(
      renderCopy(lang, 'newspaper.publish.anchorRefused', {
        count: String(refused.length),
        numbers: numbers
          .map((n) => `[${n}] (${renderCopy(lang, `newspaper.publish.anchorReason.${refusedWhy.get(String(n))!}`)})`)
          .join(' '),
      }),
    );
    // Every item refused = there is nothing to lay out, so nothing is saved and the
    // ledger is not consumed — the same stance as the checkEdit error path. The writer
    // gets the material of exactly those items back and re-sends the whole hand-in.
    if (!Object.keys(accepted.items ?? {}).length) {
      return {
        kind: 'refused',
        publishToken,
        text: `${anchorNotes[0]!}\n\n${reprintOf(issue, numbers, lang)}`,
      };
    }
  }
  // `pulls` gets the same check, with a gentler consequence. It is the one field the
  // page prints INSIDE QUOTATION MARKS under a person's name, and the brief has always
  // asked for "a sentence already present in that item's own text" — but nothing
  // enforced it. A summary that drifts reads as a summary; an invented pull quote reads
  // as something that person said. A bad one costs the quotation, never the item: the
  // copy itself may be perfectly faithful.
  const pullNotes: string[] = [];
  const badPulls = Object.entries(accepted.pulls ?? {}).flatMap(([n, pull]) => {
    // A quotation an earlier batch already printed is immutable (fill-only merging), so
    // this hand-in cannot change it and complaining about it would be unactionable.
    // Refused items' pulls are already gone with the item above.
    if (prior?.pulls?.[n] !== undefined) return [];
    const body = materialText.get(n) ?? '';
    // A body with nothing in it to quote (an emoji-only post, a bare picture) gets NO
    // quotation. The anchor deliberately waives itself there so the item's own copy
    // stays writable — but under that waiver `anchorMatches` says yes to ANY non-blank
    // text, which here means a sentence its author never said, printed in quotation
    // marks under their name on a page that carries a follow button.
    return !hasQuotableBody(body) || !anchorMatches(body, pull) ? [n] : [];
  });
  if (badPulls.length) {
    const bad = new Set(badPulls);
    accepted = {
      ...accepted,
      pulls: Object.fromEntries(Object.entries(accepted.pulls ?? {}).filter(([k]) => !bad.has(k))),
    };
    pullNotes.push(
      renderCopy(lang, 'newspaper.publish.pullNotVerbatim', {
        numbers: `[${materialNumbers(issue, badPulls).join('] [')}]`,
      }),
    );
  }
  const edit = prior ? mergeEdits(prior, accepted) : accepted;
  return { kind: 'admitted', publishToken, issue, edit, notes: [...bindingNotes, ...anchorNotes, ...pullNotes] };
}
