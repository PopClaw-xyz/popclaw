/**
 * publishNewspaper — the write half of the newspaper (v0.2).
 *
 * The agent (in its own turn, on the host's model) has written the copy; this
 *   1. checks the copy against the issue it was written for;
 *   2. **lays out the page** from the stored issue + that copy + the owner's style;
 *   3. **writes the page to disk** — that file is the paper;
 *   4. hands a copy to the publisher, if the owner has one, for a short link;
 *   5. returns the channel message (teaser + where the file is + the link, if any
 *      + whatever the copy got wrong).
 *
 * Before v0.2 the agent handed in a whole page of HTML and this checked every
 * link in it against a manifest (F2). The agent never sees a URL now, so there is
 * nothing left to police: the check, the manifest and the CSS-injection patch are
 * all gone.
 *
 * Step 3 used to be step 4, after the upload, reached only from a `catch` — which
 * made the canvas the place the paper lived and the local file a consolation prize.
 * It is the other way round: the paper is written on this machine, and a publisher
 * is a way to share it. So a publisher that is absent, switched off, or simply down
 * costs the receipt a link line and nothing else; the one honest failure left is a
 * file we could not write.
 * See spec 2026-06-18.
 */
import { PublicMaterialRefusal } from './public-material-source.js';
import type { Signer } from '../identity/signer.js';
import { putEdit, deleteIssue } from './issue-store.js';
import { formatHouseCounts, type IssueData } from './issue.js';
import { renderNewspaper, unshareColophon, type RenderOptions } from './render-newspaper.js';
import { DEFAULT_STYLE, type NewspaperStyle } from './newspaper-style.js';
import { inlineAvatars, monogramFallback, type InlineAvatarDeps } from './avatar-inline.js';
import { safeRecord, type SocialLogRecorder } from '../social-log/social-log.js';
import {
  followableAuthorsOf,
  type FollowableAuthorRow,
  type RecordFollowableAuthors,
} from './followable-authors.js';
import type { NewspaperIssueArchive, SavedNewspaperIssue } from './newspaper-artifacts.js';
import { renderCopy, type Lang } from '../lexicon/index.js';
import { ownerLang } from '../lexicon/owner-language.js';
import { beginReading } from './reading-page.js';
import { admitHandIn, reprintOf } from './admit-hand-in.js';

// Kept importable from here: tests and callers reach checkEdit through this module.
export { checkEdit } from './admit-hand-in.js';

const footerOf = (lang: Lang): string => `\n\n——\n${renderCopy(lang, 'newspaper.publish.footer')}`;

export interface PublishDeps {
  /** Host response capacity for continuation receipts, never an issue content limit. */
  sessionKey?: string;
  validateMaterials?: (issue: IssueData) => void;
  upload: (a: {
    baseUrl: string;
    signer: Signer;
    nickname: string;
    title: string;
    html: string;
    assertCurrent?: () => void;
  }) => Promise<{ url: string }>;
  signer: Signer;
  nickname: string;
  /**
   * The publisher's base URL, or `null`/`undefined` when the owner has no publisher
   * (an explicit empty `canvas_base_url`, or a host that wires none). No publisher =
   * no upload, and a receipt that says so — never a failed publish.
   */
  canvasBaseUrl?: string | null;
  /** Saves the local master copy and retains the selected edition for correction. */
  archive: NewspaperIssueArchive;
  /** P7: log the publish event into the social log (P-004, append-only). Not injected = not recorded, and that must never block publishing. */
  socialLog?: SocialLogRecorder;
  /**
   * Persists the issue's followable-author set (doorbell §5) once the paper
   * lands. Not injected = not written, and that must never block publishing —
   * same convention as `socialLog`.
   */
  recordFollowable?: RecordFollowableAuthors;
  /** Where the issue ledger lives (`PopclawPaths.newspaperManifestsDir()`). Not injected = only the in-process table is consulted. */
  manifestDir?: string;
  /**
   * The owner's layout knobs, already resolved, plus whatever `style.json` got
   * wrong. Not injected = the shipped defaults. The notes ride along on the
   * receipt: a knob that silently did nothing is the exact failure this feature
   * exists to end.
   */
  style?: { style: NewspaperStyle; notes: readonly string[] };
  /**
   * The follow doorbell's next-day piggyback (doorbell spec §6.5 fallback
   * leg): unresolved pending rows, appended to the delivery text as a
   * numbered list carrying its own reply syntax — the catch-all for a batch
   * every other surfacing leg missed. Not injected = no piggyback, and that
   * must never block publishing — same convention as `socialLog`.
   */
  pendingList?: () => Array<{ display_name: string }>;
  /**
   * Where the baked faces are kept between issues, and the fetch seam behind them
   * (`newspaper/avatar-inline.ts`). Not injected = the faces stay remote urls,
   * which is the old behaviour and still renders — an honest degradation for test
   * rigs and for a host that gives us no data directory.
   */
  avatars?: InlineAvatarDeps;
  /**
   * `newspaper.fonts` — what the finished page is allowed to link (`web` default,
   * `system` links nothing). Passed straight through to the renderer.
   */
  fonts?: RenderOptions['fonts'];
  /**
   * `newspaper.avatars` — `inline` (default) bakes the faces in at publish time,
   * `off` means nobody fetches a face at all. Named `avatarMode` here only because
   * `avatars` above is already the inliner's dependency bundle; it is the same knob,
   * and it reaches both the renderer and the inliner.
   */
  avatarMode?: RenderOptions['avatars'];
  /** Receipt language. Not injected = `ownerLang()`. */
  lang?: Lang;
  /**
   * The host's own logger (`api.logger`, same convention as elsewhere in this
   * plugin — e.g. `follow-doorbell-service.ts`). Only used for a warn line if
   * `unshareColophon` cannot find the claim it is meant to walk back on an
   * upload failure; not injected = the warning is silently dropped, same as
   * every other optional PublishDeps entry.
   */
  logger?: { warn(m: string): void };
}

/**
 * The ledger for one issue: date · material count · per-lore-house counts · ping
 * count. Derived from the stored issue rather than settled a second time at
 * gather, so the log and the page can never disagree. The social log is an
 * internal ledger (P-004, append-only), written per the "logs are always English" rule.
 */
function publishSummary(issue: IssueData): string {
  return [
    `edited the ${issue.dateLabel} issue`,
    `${issue.totalCount} items`,
    formatHouseCounts({ ...issue.byHouse }),
    `${issue.pings.length} awaiting reply`,
    // F3: lore-house letters get diverted out of the pings, so tack on a field for the ledger — diverting them must not turn into an undercount.
    issue.houseLetters?.length ? `${issue.houseLetters.length} letters from the world` : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

/** Same rule as `safeRecord`: persisting a by-product must never sink the receipt. */
function recordFollowableSafely(
  record: RecordFollowableAuthors | undefined,
  rows: FollowableAuthorRow[],
): void {
  try {
    record?.(rows);
  } catch {
    /* never let this bubble up */
  }
}

/**
 * The numbered leftovers block riding the delivery message ('' = no ride).
 * Names render verbatim `name#sigil` as stored — the same string the paper,
 * the L1 and the injection passenger show, so the owner's reply vocabulary
 * and the agent's matching basis never drift apart. Reading the pending set
 * is a by-product of delivering the paper: a store that cannot be read costs
 * the piggyback its ride, never the paper its receipt (same rule as
 * `recordFollowableSafely`).
 */
function piggybackOf(
  lang: Lang,
  pendingList: (() => Array<{ display_name: string }>) | undefined,
): string {
  if (!pendingList) return '';
  let rows: Array<{ display_name: string }>;
  try {
    rows = pendingList();
  } catch {
    return '';
  }
  if (!rows.length) return '';
  const list = rows.map((r, i) => `${i + 1}. ${r.display_name}`).join(' ');
  return `\n\n${renderCopy(lang, 'newspaper.doorbell.piggyback', { n: String(rows.length), list })}`;
}

export async function publishNewspaper(
  deps: PublishDeps,
  input: { publishToken?: string; edit: unknown; teaser?: string },
): Promise<{ text: string; landed?: boolean; accepted?: boolean; sourceRefused?: boolean }> {
  const lang = deps.lang ?? ownerLang();
  const { style, notes: styleNotes } = deps.style ?? { style: DEFAULT_STYLE, notes: [] };

  const admission = admitHandIn(input, deps, lang);
  if (admission.kind === 'refused') {
    return { text: admission.publishToken ? beginReading(admission.publishToken, admission.text, deps) : admission.text };
  }
  const { publishToken, issue, edit, notes: admissionNotes } = admission;
  const assertCurrent = (): void => deps.validateMaterials?.(issue);
  assertCurrent();
  // The live nickname signs the paper (doorbell §6.1): masthead attribution and
  // the share line at the foot. The issue's own `ownerNickname` is a gather-time
  // snapshot; publish hands the renderer the name it would put on the upload.
  const publisherConfigured = Boolean(deps.canvasBaseUrl);
  const avatarMode = deps.avatarMode ?? 'inline';
  // Who signed this paper, so their own byline is never offered a follow chip
  // on it. Read from the signer rather than taken as one more optional dep: it
  // is the one thing here that cannot be wrong about who the owner is, and a
  // caller cannot forget to pass it. Asked only when there is a doorbell to
  // keep honest — a paper nobody can publish prints no chips at all.
  const ownerPopclawId = publisherConfigured ? await deps.signer.popclawId() : '';
  assertCurrent();
  const page = renderNewspaper(issue, edit, style, lang, {
    ownerNickname: deps.nickname,
    fonts: deps.fonts ?? 'web',
    avatars: avatarMode,
    // The follow chips and their script only mean something on a page someone can
    // click through to a publisher. With no publisher there is nothing to ring, so
    // the doorbell leaves no trace on the page at all.
    doorbell: publisherConfigured,
    ownerPopclawId,
  });
  // Bake the faces in, so opening the paper reaches no third party. Bounded: past
  // the budget a face falls back to its drawn monogram, so this can never push the
  // page over the canvas cap (see avatar-inline.ts).
  //
  // No fetcher wired (MCP hosts, and any harness that injects nothing) does NOT
  // mean "leave the remote urls in". `inlineAvatars` ends on the same monogram
  // swap; without it the swap still has to happen, or the page the owner saves
  // reports to unavatar.io on every open. Defence in depth for the ruling: no
  // remote avatar url survives a published page, whatever the host wired.
  const baked = deps.avatars
    ? await inlineAvatars(page.html, { ...deps.avatars, mode: avatarMode })
    : { html: monogramFallback(page.html), notes: [] };
  assertCurrent();
  const teaser = edit.teaser ?? input.teaser ?? '';
  // The writer could not finish in one hand-in. Since the owner struck the fixed count
  // (2026-08-28) this is the exception rather than the rule — the writer picks what it can
  // write — but a stock host still caps a reply at 8192 tokens, so an over-picked issue has
  // to be finishable across hand-ins. The ledger entry survives for the rest of the copy.
  // Not offered after a heat fallback: that trimmed the issue under the numbering the
  // writer answered with, so a second batch's item numbers would point somewhere else.
  const unfinished = page.unwritten > 0;
  // Settling the ledger is the same decision on both the published and the canvas-down
  // path: an unfinished issue keeps its entry either way. Deleting it because the upload
  // failed would take the rest of the paper down with the upload.
  const settle = (): void => {
    if (unfinished) putEdit(publishToken, edit, deps.manifestDir);
    else deleteIssue(publishToken, deps.manifestDir);
  };
  const complaints = [...admissionNotes, ...styleNotes, ...page.notes, ...baked.notes];
  const html = baked.html;
  const noteBlockOf = (extra: readonly string[] = []): string => {
    const all = [...complaints, ...extra];
    return all.length
      ? `\n\n${renderCopy(lang, 'newspaper.publish.notes')}\n${all.map((n) => `· ${n}`).join('\n')}`
      : '';
  };
  const noteBlock = noteBlockOf();

  // An issue that is not finished is not published. It used to be: publish every batch, thin
  // but whole. That hands the owner a link to a paper missing most of its items and then a
  // second, different link to the real one — canvas mints a fresh url every upload — and two
  // links to the same day's paper, the first one gutted, is worse than waiting for the real
  // one. His own rule settles it: "too few, or empty, is no good either" (2026-08-28).
  if (unfinished) {
    assertCurrent();
    settle();
    return {
      // Not landed, but the copy in this hand-in was kept — the difference the dispatch
      // ledger needs to tell "it never published anything" from "it published some and
      // stopped".
      accepted: true,
      text: beginReading(publishToken, `${renderCopy(lang, 'newspaper.publish.moreToWrite', {
        count: String(page.unwritten),
        numbers: `[${page.unwrittenNumbers.join('] [')}]`,
      })}${noteBlock}\n\n${reprintOf(issue, page.unwrittenNumbers, lang)}`, deps),
    };
  }

  // ── The master copy ────────────────────────────────────────────────────
  // The paper is written HERE. Everything below this line is a statement that it
  // exists, so nothing below runs if the file did not get written.
  let localPath: string;
  let saved: SavedNewspaperIssue;
  assertCurrent();
  try {
    saved = deps.archive.save({ token: publishToken, html, nowMs: Date.now() });
    localPath = saved.path;
  } catch (err) {
    // The one honest failure left. The ledger entry is deliberately NOT settled:
    // the copy is good and the disk is not, so the writer can hand the same batch
    // in again once there is somewhere to put it.
    return { text: renderCopy(lang, 'newspaper.publish.localWriteFailed', { error: String(err) }) };
  }
  // P7: the paper is out — it is on the owner's own disk. The url of a publish is
  // the file they can open; a short link, when there is one, is a copy of it.
  try {
    assertCurrent();
    safeRecord(deps.socialLog, { kind: 'newspaper_published', text: publishSummary(issue), url: localPath });
    // Doorbell §5: the author set is answerable the moment the owner can read the
    // paper it came from, which is now — with or without a publisher. Descriptors
    // quote the headlines this very page printed (`headsByNumber`).
    assertCurrent();
    recordFollowableSafely(
      deps.recordFollowable,
      followableAuthorsOf(issue, page.headsByNumber, Date.now()),
    );
    assertCurrent();
    settle();
  } catch (error) { return { landed: true, sourceRefused: true,
    text: renderCopy(lang, 'newspaper.source.savedRefused', { path: localPath, reason: String(error) }) }; }

  const whereItIs = [
    renderCopy(lang, 'newspaper.publish.localIssue', { path: localPath }),
    renderCopy(lang, 'newspaper.publish.localIssue.howOpenClaw'),
    renderCopy(lang, 'newspaper.publish.localIssue.howCli', { path: localPath }),
  ].join('\n');

  // ── The publisher, if the owner has one ────────────────────────────────
  // Absent, switched off, or down: a line on the receipt, never a failed publish.
  let linkLine = '';
  const publisherNotes: string[] = [];
  if (!publisherConfigured) {
    publisherNotes.push(renderCopy(lang, 'newspaper.publish.publisherOffNote'));
  } else {
    try {
      assertCurrent();
      const { url } = await deps.upload({
        baseUrl: deps.canvasBaseUrl!,
        signer: deps.signer,
        nickname: deps.nickname,
        title: renderCopy(lang, 'newspaper.publish.canvasTitle'),
        html,
        assertCurrent,
      });
      linkLine = `\n\n${renderCopy(lang, 'newspaper.publish.fullText', { url })}`;
    } catch (err) {
      if (err instanceof PublicMaterialRefusal) return { landed: true, sourceRefused: true,
        text: renderCopy(lang, 'newspaper.source.savedRefused', { path: localPath, reason: err.code }) };
      publisherNotes.push(renderCopy(lang, 'newspaper.publish.uploadFailedNote', { error: String(err) }));
      // The disk copy was written assuming this would work (doorbell on ⇒ colophon
      // promised a share link). It did not, so the master copy — the file the
      // receipt actually points the owner at — gets walked back to the plain
      // colophon too. Best-effort: the paper on disk is already a real file
      // either way, so a failure here costs a stale sentence, not the paper.
      try {
        const unshared = unshareColophon(html, lang, issue.pulse.length, deps.logger);
        saved.rewrite(unshared);
      } catch {
        // See above: cosmetic only.
      }
    }
  }

  return {
    text:
      `${teaser}\n\n${whereItIs}${linkLine}` +
      `${noteBlockOf(publisherNotes)}${footerOf(lang)}${piggybackOf(lang, deps.pendingList)}`,
    // The owner is holding the paper: it is a file on this machine, named on the
    // receipt. The dedicated-session hand-off treats that as delivered — which is
    // what it is, whether or not a link came with it.
    landed: true,
    accepted: true,
  };
}
