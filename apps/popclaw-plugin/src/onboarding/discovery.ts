import type { MessagePresentation } from './act-cards.js';
import {
  briefingCard,
  buildExpandedCard,
  cardText,
  lanternUnreachableText,
  markFailedText,
  markSavedText,
  mehAckText,
  ordinalRetryText,
  tasteSavedText,
} from './act-cards.js';
import { buildLanternBriefing, buildAttuneBriefing, renderBriefingForAgent } from './briefing.js';
import { isProceedKeyword, matchMark, matchMeh } from './answer-keywords.js';
import { ownerLang, t } from '../lexicon/owner-language.js';
import type { Lang } from '../lexicon/index.js';
import type { LLMClientLike } from './naming.js';
import type { NameChain } from '../identity/person-name.js';
import { displayPerson } from '../identity/person-resolver.js';
import { appendCorePrivate } from '../taste/taste-writer.js';
import type { LearnedPick, LearnedSignal } from '../taste/learned-writer.js';
import { renderLanternPage, uploadOnboardingPage, type OnboardingCanvasDeps } from './canvas-pages.js';
import { parseGuideFrontmatter, type HouseEntry } from '../world/guide.js';
import {
  formatHotPostLine,
  formatNotablePersonLine,
  formatNotableAuthorLine,
  formatWorldStateLine,
  platformLabel,
  NOTABLE_PEOPLE_CAP,
} from '../world/summary-format.js';
import { rankBySummaryTaste } from '../world/summary-ranker.js';
import { aggregateNotableAuthors, type AuthorSource } from '../world/notable-authors.js';
import type { HotPost, WorldSummaryResponse } from '../world/world-summary-client.js';
import type { SessionContextIndex } from './context-index.js';

export interface GuideClientLike {
  /** Full text of guide.md; failure → null (GuideClient contract). */
  fetchGuideText(): Promise<string | null>;
}

export interface SummaryClientLike {
  fetchSummary(windowHours?: number): Promise<WorldSummaryResponse | null>;
}

/** Minimal projection of a WorldFeedClient.fetchSnapshot entry (compatible with pbjs IWorldFeedItem). */
export interface SnapshotItemLike {
  readonly authorPopclawId?: string | null;
  readonly actorNickname?: string | null;
  readonly platform?: string | null;
}

export interface SnapshotClientLike {
  fetchSnapshot(q: { limit?: number }): Promise<SnapshotItemLike[]>;
}

export interface TasteSourcesLike {
  enabledSources(): Promise<Array<{ path: string; content: string }>>;
}

export interface LearnedWriterLike {
  appendPick(pick: LearnedPick): Promise<void>;
}

/** Minimal surface of the mark execution chain (ADR-0019: local snapshot + taste saved + signed report all included). */
export interface OnboardingMarkServiceLike {
  mark(item: {
    eventId: string;
    platform: string;
    platformPostId: string;
    authorPopclawId: string;
    handle: string;
    textPreview: string;
    originalUrl: string;
  }): Promise<{ pushed: boolean; error?: string }>;
}

/**
 * A house that is **already mounted**. The house name/self-description always
 * comes from data (boot config + mounting-handshake cache) — the plugin never
 * hardcodes any house name (ADR-0041). A house that isn't mounted is never
 * mentioned at all.
 */
export interface MountedHouse {
  readonly slug: string;
  readonly name: string;
  /** The house's self-description opening paragraph (guide/notice board); omit the whole line if absent. */
  readonly blurb?: string;
  /** The guide body — the settling-in list page uses it to explain "how to play at this house". */
  readonly guide?: string;
  /**
   * The "first thing to do" that the house itself declares (guide frontmatter
   * `entry:`, R1 spec §1). **No declaration = undefined, and every surface's
   * behavior stays byte-for-byte the same as today** — the plugin never guesses a cell of it.
   */
  readonly entry?: HouseEntry;
}

/** A previously-shown highlighted entry (drafts persistence, the authoritative data source for answer handling). */
interface LanternEntry {
  readonly eventId: string;
  readonly authorPopclawId: string;
  readonly nickname: string;
  readonly platform: string;
  /** The server's full-length preview (the list line shows only the first 120 chars; the expanded card uses the full text). */
  readonly bodyPreview: string;
  readonly replyCount: number;
  /** The line rendered on the card (the linkage anchor for contextIndex / learned / marks). */
  readonly line: string;
}

/** Persisted answer material. The state machine owns this data; the session never copies it into an answer cache. */
export interface DiscoveryDrafts {
  /** lantern: the highlighted entries fetched; 'degraded' = the lore-house didn't respond (next retries). */
  lantern?: 'degraded' | { entries: LanternEntry[] };
  /** attune: the same batch of entries carried over from lantern (reranking must use that same batch). */
  attune?: { entries: LanternEntry[] };
}

/** Only material I/O: no identity, lifecycle, stage transitions or gap ledger. */
export interface DiscoveryDeps {
  presenter: { present(card: MessagePresentation): Promise<void> };
  llm: LLMClientLike | null;
  tasteRoot: string;
  guideClient: GuideClientLike;
  summaryClient: SummaryClientLike;
  snapshotClient: SnapshotClientLike;
  tasteLoader: TasteSourcesLike;
  learnedWriter: LearnedWriterLike;
  markService: OnboardingMarkServiceLike;
  contextIndex: Pick<SessionContextIndex, 'register'>;
  webBaseUrl: string;
  nameOf?: NameChain;
  houses?: () => readonly MountedHouse[];
  canvas?: OnboardingCanvasDeps;
  houseKnowsYou(slug: string): boolean;
  nowSeconds(): number;
  drafts(): DiscoveryDrafts;
  setDrafts(drafts: DiscoveryDrafts): void;
  recordDone(line: string): void;
}

/** A continuation carries the exact persisted batch; only the spine can enter the next stage. */
export type LanternAnswer = { text: string } | { attune: NonNullable<DiscoveryDrafts['attune']> };

/** Highlights time window (last 24h). */
const SUMMARY_WINDOW_HOURS = 24;
/** Highlights list cap (≤8 entries; numbering stays in strict sync with the canvas). */
const ENTRY_CAP = 8;
/** Cap on active mirror accounts. */
const MIRROR_CAP = 3;
/** Snapshot sample size for mirror-account aggregation. */
const SNAPSHOT_LIMIT = 100;
/** A glimpse of the world is only valid for the day — it's telling you "who and what's around right now", and that stops being true after a day. */
const PAGE_TTL_HOURS = 24;
/** Below this number of people speaking up, just say plainly "it's pretty quiet here right now" — never dress up the quiet. */
const QUIET_AUTHORS = 5;

/**
 * The material interaction shared by lantern and attune. Owns preparation,
 * numbering, feedback, taste reranking and presentation-only session caches.
 * Persistent drafts remain the sole authority for answers. Effects stay inline:
 * callers cannot accidentally present before a draft write or advance after a
 * failed presentation. Stage transitions and the settling-in ledger belong to
 * the orchestrator.
 */
export class OnboardingDiscovery {
  private cachedLantern: {
    houseLines: string[];
    statLine?: string;
    entryLines: string[];
    notablePeopleLines: string[];
    mirrorAuthorLines: string[];
    canvasUrl: string | null;
    quiet: boolean;
  } | null = null;
  private cachedTasteText: string | null = null;
  private cachedRerank: string[] | null = null;

  constructor(private readonly deps: DiscoveryDeps) {}

  async presentLantern(): Promise<{ text: string }> {
    const [guideText, summary, snapshot] = await Promise.all([
      this.deps.guideClient.fetchGuideText().catch(() => null),
      this.deps.summaryClient.fetchSummary(SUMMARY_WINDOW_HOURS).catch(() => null),
      this.deps.snapshotClient
        .fetchSnapshot({ limit: SNAPSHOT_LIMIT })
        .catch(() => [] as SnapshotItemLike[]),
    ]);
    if (summary === null) {
      // An unreachable lore-house never blocks the spine: give an honest card, next retries, skip just moves on.
      this.deps.setDrafts({ lantern: 'degraded' });
      return this.presentCard({ blocks: [{ kind: 'text', text: lanternUnreachableText() }] });
    }

    // Gradient cold start: only spend one LLM matrix call once core taste is
    // non-empty (right now it's usually still empty → falls back to
    // popularity order). Once the attune act has the owner's taste, it reranks **this same batch of entries** once.
    const coreText = await this.coreTasteText();
    const ranked = await rankBySummaryTaste(this.deps.llm, coreText, summary.hot_posts);
    const entries = this.toEntries(ranked, summary);
    this.deps.contextIndex.register(
      entries.map((e) => ({
        eventId: e.eventId,
        authorPopclawId: e.authorPopclawId,
        authorNickname: e.nickname,
        summaryLine: e.line,
        source: 'summary' as const,
      })),
    );

    const houses = this.houses();
    // The house line: the house's self-reported headline takes priority (the
    // face it chose to show), and if none is declared it falls back to the
    // status quo — the self-description's opening paragraph. Both are data;
    // the plugin never hardcodes a single line of house description (ADR-0041).
    const houseLines = houses.map((h) => {
      const say = h.entry?.headline ?? houseBlurb(h, () => this.houses(), guideText);
      const knows = this.deps.houseKnowsYou(h.slug) ? t('onboarding.lantern.houseKnowsYou') : '';
      return `${h.name}${knows}` + (say ? ` — ${say}` : '');
    });
    const statLine = summary.world_state ? formatWorldStateLine(summary.world_state) : undefined;
    const people = (summary.notable_people ?? []).slice(0, NOTABLE_PEOPLE_CAP);
    const mirrors = aggregateNotableAuthors(
      this.authorSources(summary, snapshot),
      MIRROR_CAP,
      this.deps.nameOf,
    );
    const quiet = summary.distinct_authors < QUIET_AUTHORS || entries.length === 0;

    const canvasUrl = await this.uploadPage(
      t('onboarding.lanternPage.title'),
      renderLanternPage({
        ...(statLine ? { statLine } : {}),
        notables: people.map((p) => ({
          name: p.nickname,
          // Background narrative: only lists which platforms have a verified account for them, never writes a live follower count.
          story: t('onboarding.lanternPage.verifiedAs', {
            accounts: p.accounts.map((a) => `${platformLabel(a.platform)} @${a.handle}`).join(' · '),
          }),
        })),
        posts: entries.map((e, i) => ({
          n: i + 1,
          author: e.nickname,
          preview: e.bodyPreview,
          replyCount: e.replyCount,
        })),
        mirrors: mirrors.map((m) => ({
          name: m.nickname,
          note: t('onboarding.lanternPage.activeOn', {
            platforms: m.platforms.map(platformLabel).join('/'),
          }),
        })),
      }),
      PAGE_TTL_HOURS,
    );

    this.cachedLantern = {
      houseLines,
      ...(statLine ? { statLine } : {}),
      entryLines: entries.map((e) => e.line),
      notablePeopleLines: people.map((p) => formatNotablePersonLine(p)),
      mirrorAuthorLines: mirrors.map((a) => formatNotableAuthorLine(a)),
      canvasUrl,
      quiet,
    };
    this.deps.recordDone(t('onboarding.did.lantern'));
    this.deps.setDrafts({ lantern: { entries: [...entries] } });
    return this.presentCard(briefingCard(this.lanternBriefing(ownerLang())));
  }

  // A continuation is synchronous: the spine must enter attune before another
  // answer can observe the old stage. I/O replies retain their own promises.
  answerLantern(trimmed: string): LanternAnswer | Promise<{ text: string }> {
    const drafts = this.deps.drafts().lantern;
    if (drafts === undefined || drafts === 'degraded') return this.presentLantern();
    const entries = drafts.entries;
    if (!trimmed) return { attune: { entries: [...entries] } };
    const mark = matchMark(trimmed);
    if (mark !== null) return this.handleMark(entries, mark);
    const meh = matchMeh(trimmed);
    if (meh !== null) return this.handleMeh(entries, meh);
    const ord = trimmed.match(/^(\d+)$/);
    if (ord) return this.handleExpand(entries, Number(ord[1]));
    if (isProceedKeyword(trimmed)) return { attune: { entries: [...entries] } };
    return { text: ordinalRetryText(entries.length) };
  }

  /** (1) Expand: full-preview card + learned expanded (a write failure never blocks). */
  private async handleExpand(
    entries: readonly LanternEntry[],
    n: number,
  ): Promise<{ text: string }> {
    const e = entries[n - 1];
    if (!e || n < 1) return { text: ordinalRetryText(entries.length) };
    await this.recordLearned(e, 'expanded');
    return this.presentCard(
      buildExpandedCard({
        ordinal: n,
        nickname: e.nickname,
        platform: e.platform,
        bodyPreview: e.bodyPreview,
        replyCount: e.replyCount,
        eventId: e.eventId,
        postUrlBase: this.deps.webBaseUrl,
      }),
    );
  }

  /**
   * (2) Mark: the markService execution chain (local snapshot + taste saved
   * + signed report, ADR-0019). If mark throws → report the error honestly
   * (never claim it was marked when it wasn't); pushed:false → it's still
   * kept locally, retriable.
   */
  private async handleMark(
    entries: readonly LanternEntry[],
    n: number,
  ): Promise<{ text: string }> {
    const e = entries[n - 1];
    if (!e || n < 1) return { text: ordinalRetryText(entries.length) };
    let result: { pushed: boolean; error?: string };
    try {
      result = await this.deps.markService.mark({
        eventId: e.eventId,
        platform: e.platform,
        platformPostId: e.eventId, // Onboarding only has eventId, use it as a stand-in
        authorPopclawId: e.authorPopclawId,
        handle: e.nickname,
        textPreview: e.bodyPreview,
        originalUrl: '', // Highlighted entries have no source URL
      });
    } catch {
      return { text: markFailedText(n) };
    }
    this.deps.recordDone(t('onboarding.did.mark', { n: String(n) }));
    return { text: markSavedText(n, result.pushed) };
  }

  /** (3) Not interested: learned meh + a short acknowledgment. */
  private async handleMeh(entries: readonly LanternEntry[], n: number): Promise<{ text: string }> {
    const e = entries[n - 1];
    if (!e || n < 1) return { text: ordinalRetryText(entries.length) };
    await this.recordLearned(e, 'meh');
    return { text: mehAckText(n) };
  }

  async presentAttune(): Promise<{ text: string }> {
    return this.presentCard(
      briefingCard(
        buildAttuneBriefing({}, ownerLang()),
      ),
    );
  }

  /**
   * Persist taste, rerank the persisted batch, then await presentation. Invoke
   * the spine's continuation in that same reaction: another answer must see
   * the next stage as soon as the reranked card has finished presenting.
   */
  async saveTaste(
    trimmed: string,
    presentNext: () => Promise<{ text: string }>,
  ): Promise<{ text: string }> {
    await appendCorePrivate({ tasteRoot: this.deps.tasteRoot }, trimmed);
    this.cachedTasteText = trimmed;
    this.deps.recordDone(t('onboarding.did.taste'));

    const entries = this.deps.drafts().attune?.entries ?? [];
    const ranked = await rankBySummaryTaste(this.deps.llm, trimmed, entries.map(toHotPost));
    const byId = new Map(entries.map((e, i) => [e.eventId, { e, original: i + 1 }]));
    const reordered = ranked
      .map((p) => byId.get(p.event_id))
      .filter((h): h is { e: LanternEntry; original: number } => h !== undefined);
    const lines = reordered.map((h, i) =>
      t('onboarding.brief.attune.rerankLine', {
        n: String(i + 1),
        was: String(h.original),
        nickname: h.e.nickname,
        body: h.e.bodyPreview.slice(0, 120),
      }),
    );
    this.cachedRerank = lines;
    // Numbering only ever honors **the batch the owner last saw**: the
    // moment the reranked card is shown, the current batch is the new order.
    // Without re-registering it, the next time the owner says "1" it would
    // point at an old ordering they can no longer even see.
    this.deps.contextIndex.register(
      reordered.map((h, i) => ({
        eventId: h.e.eventId,
        authorPopclawId: h.e.authorPopclawId,
        authorNickname: h.e.nickname,
        summaryLine: lines[i] ?? h.e.line,
        source: 'summary' as const,
      })),
    );

    const rerankCard = briefingCard(
      buildAttuneBriefing(
        {
          tasteText: trimmed,
          rerankedLines: lines,
        },
        ownerLang(),
      ),
      tasteSavedText(),
    );
    await this.deps.presenter.present(rerankCard);
    const next = await presentNext();
    return { text: `${cardText(rerankCard)}\n\n${next.text}` };
  }

  /** Cache hits stay synchronous; only an uncached graduation reads sources. */
  tasteText(): string | Promise<string> {
    return this.cachedTasteText ?? this.coreTasteText();
  }

  /** Zero I/O and no writes. Cache lifetime is this instance, including stop/start of its spine. */
  currentCardText(stage: 'lantern' | 'attune'): string {
    if (stage === 'lantern') {
      if (!this.cachedLantern) return t('onboarding.readonly.lantern');
      return renderBriefingForAgent(this.lanternBriefing());
    }
    return renderBriefingForAgent(
      buildAttuneBriefing({
        ...(this.cachedTasteText ? { tasteText: this.cachedTasteText } : {}),
        ...(this.cachedRerank ? { rerankedLines: this.cachedRerank } : {}),
      }),
    );
  }

  /** `lang` defaults to the English source the agent reads; card callers pass `ownerLang()`. */
  private lanternBriefing(lang: Lang = 'en') {
    const c = this.cachedLantern!;
    return buildLanternBriefing(
      {
        houseLines: c.houseLines,
        ...(c.statLine ? { statLine: c.statLine } : {}),
        entryLines: c.entryLines,
        notablePeopleLines: c.notablePeopleLines,
        mirrorAuthorLines: c.mirrorAuthorLines,
        canvasUrl: c.canvasUrl,
        quiet: c.quiet,
      },
      lang,
    );
  }

  private toEntries(ranked: readonly HotPost[], summary: WorldSummaryResponse): LanternEntry[] {
    return ranked.slice(0, ENTRY_CAP).map((p, i) => {
      const nickname = nicknameOf(summary, p.author, this.deps.nameOf);
      return {
        eventId: p.event_id,
        authorPopclawId: p.author,
        nickname,
        platform: p.platform,
        bodyPreview: p.body_preview,
        replyCount: p.reply_count,
        line: formatHotPostLine(i + 1, {
          nickname,
          bodyPreview: p.body_preview,
          platform: p.platform,
          replyCount: p.reply_count,
        }),
      };
    });
  }

  /** The two sources for mirror-account aggregation: the full set of highlighted posts + a client-side snapshot sample (zero new server-side endpoints). */
  private authorSources(
    summary: WorldSummaryResponse,
    snapshot: readonly SnapshotItemLike[],
  ): AuthorSource[] {
    return [
      ...summary.hot_posts.map((p) => ({
        popclawId: p.author,
        platform: p.platform,
        nickname: nicknameOf(summary, p.author, this.deps.nameOf),
      })),
      ...snapshot
        .filter((it) => (it.authorPopclawId ?? '').length > 0)
        .map((it) => ({
          popclawId: it.authorPopclawId ?? '',
          platform: it.platform ?? 'popclaw',
          nickname: it.actorNickname ?? undefined,
        })),
    ];
  }

  /** Canvas upload: never throws, never blocks. Not wired up / fails → null (the card just loses one link line). */
  private async uploadPage(title: string, html: string, ttlHours: number): Promise<string | null> {
    if (!this.deps.canvas) return null;
    return uploadOnboardingPage(this.deps.canvas, title, html, ttlHours);
  }

  private houses(): readonly MountedHouse[] {
    try {
      return this.deps.houses?.() ?? [];
    } catch {
      return [];
    }
  }

  /** A learned write failure never blocks the UX. */
  private async recordLearned(e: LanternEntry, signal: LearnedSignal): Promise<void> {
    try {
      await this.deps.learnedWriter.appendPick({
        ts: this.deps.nowSeconds(),
        eventId: e.eventId,
        signal,
        summaryLine: e.line,
      });
    } catch {
      // Losing one learning signal doesn't affect the owner's experience right now.
    }
  }

  /** taste core layer body text (the gradient cold-start gate); read failure → '' (falls back to popularity order). */
  private async coreTasteText(): Promise<string> {
    try {
      const sources = await this.deps.tasteLoader.enabledSources();
      return sources
        .filter((s) => s.path.startsWith('core/'))
        .map((s) => s.content)
        .join('\n\n')
        .trim();
    } catch {
      return '';
    }
  }

  private async presentCard(card: MessagePresentation): Promise<{ text: string }> {
    await this.deps.presenter.present(card);
    return { text: cardText(card) };
  }
}

/** Reranking needs a HotPost; the entry's fields are enough to assemble one (quote/time only affect things outside the prompt). */
function toHotPost(e: LanternEntry): HotPost {
  return {
    event_id: e.eventId,
    author: e.authorPopclawId,
    platform: e.platform,
    body_preview: e.bodyPreview,
    reply_count: e.replyCount,
    quote_count: 0,
    created_at_ms: 0,
  };
}

/** The first paragraph of the guide body (the house's self-description opening paragraph; works even without frontmatter). */
function firstParagraph(guideText: string | null): string | undefined {
  if (!guideText) return undefined;
  const { body } = parseGuideFrontmatter(guideText);
  const para = body
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0 && !l.startsWith('#'));
  return para && para.length > 0 ? para.slice(0, 120) : undefined;
}

/** Nickname fallback translated for a lore-house id (same rule as WorldSummaryClient.nicknameFor). */
function nicknameOf(
  summary: WorldSummaryResponse,
  popclawId: string,
  nameOf?: NameChain,
): string {
  // The name the server gives is the other party's self-reported name — it only contends for tier two of the chain; an alias overrides it.
  const server = summary.authors[popclawId]?.nickname;
  return (nameOf ? nameOf(popclawId, server) : server) || displayPerson(popclawId);
}

/**
 * The house's self-description line: the house's own blurb > the opening
 * paragraph of its published guide > the guide fetched live from the home
 * house (only the lantern act has guideText on hand). All three sources are data.
 */
export function houseBlurb(
  h: MountedHouse,
  houses: () => readonly MountedHouse[],
  guideText?: string | null,
): string | undefined {
  return (
    h.blurb ??
    firstParagraph(h.guide ?? null) ??
    (h.slug === houses()[0]?.slug ? firstParagraph(guideText ?? null) : undefined)
  );
}
