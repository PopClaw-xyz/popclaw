import { optionalWorldOffer } from './optional-world.js';
import {
  OnboardingDiscovery,
  houseBlurb,
  type DiscoveryDrafts,
  type GuideClientLike,
  type SummaryClientLike,
  type SnapshotClientLike,
  type TasteSourcesLike,
  type LearnedWriterLike,
  type OnboardingMarkServiceLike,
  type MountedHouse,
} from './discovery.js';
export type {
  GuideClientLike,
  SummaryClientLike,
  SnapshotItemLike,
  SnapshotClientLike,
  TasteSourcesLike,
  LearnedWriterLike,
  OnboardingMarkServiceLike,
  MountedHouse,
} from './discovery.js';
import type { MessagePresentation } from './act-cards.js';
import type { OnboardingStateMachine } from './state-machine.js';
import type { Notifier } from '../notifier/notifier.js';
import type { HostAdapter } from '../host/host-adapter.js';
import type { Signer } from '../identity/signer.js';
import {
  broadcastAll,
  outcomeOk,
  type EventEgress,
  type HouseBroadcastOutcome,
} from '../egress/event-egress.js';
import type { LLMClientLike } from './naming.js';
import { timeContext } from '../time/time-context.js';
import {
  buildArrivalBriefing,
  buildPassportBriefing,
  buildErrandBriefing,
  buildCadenceBriefing,
  hourLabel,
  buildGraduationBriefing,
  renderBriefingForAgent,
  renderBriefingForUser,
} from './briefing.js';
import {
  briefingCard,
  cardText,
  channelNoticeText,
  errandAmbiguousText,
  errandNotFoundText,
  errandSkippedText,
  followedText,
  namingRetryText,
  namingConfirmText,
  ordinalRetryText,
  attuneSkippedText,
  noNameYetText,
  pushFailedText,
  textCard,
  verifiedNudgeText,
} from './act-cards.js';
import { suggestNames } from './naming.js';
import { persistNickname, isPlaceholderNickname, readNameSource, type NameSource } from './identity-writer.js';
import { fallbackName } from './fallback-name.js';
import { interpretArrivalAnswer } from './arrival-answer.js';
import {
  isBailKeyword,
  isNotSelfDescription,
  isPassportReissueRequest,
  isRenameRequest,
  readCadenceChoice,
  readCadenceHour,
} from './answer-keywords.js';
import { renderCopy, type Lang } from '../lexicon/index.js';
import {
  firstContact,
  guessLangFromText,
  ownerLang,
  setOwnerLang,
  t,
  tFirstContact,
} from '../lexicon/owner-language.js';
import {
  loadMyNamecard,
  bumpNamecardDeclaredAt,
  signMyNamecard,
} from '../messaging/my-namecard.js';
import {
  captureNamecardWritePlan,
  guardNamecardWritePlan,
  type NamecardWriteCheck,
} from '../messaging/namecard-write-guard.js';
import { deriveSigil } from '../invite/sigil.js';
import { profileUrl as buildProfileUrl } from '../lshow/sources/web-fallback.js';
import type { NameChain } from '../identity/person-name.js';
import { legalNextStages, type OnboardingStage } from './stages.js';
import {
  renderPassportPage,
  uploadOnboardingPage,
  type OnboardingCanvasDeps,
} from './canvas-pages.js';
import type { PassportDoor, PassportStamp } from './passport-stamps.js';
import type { SessionContextIndex } from './context-index.js';
import { writeBailedAt, clearBailedAt } from './settling-gaps.js';

export interface CardPresenter {
  present(card: MessagePresentation): Promise<void>;
}

/** Combined identify-person + follow result for the errand act (index.ts wires this into the existing identify-person chain). */
export type ErrandFollowOutcome =
  | { kind: 'followed'; display: string; verifiedPlatform?: string; house?: string }
  | { kind: 'choose'; lines: readonly string[] }
  | { kind: 'notFound'; ref: string }
  | { kind: 'unavailable'; reason: string };

export interface OnboardingOrchestratorDeps {
  stateMachine: OnboardingStateMachine;
  /** Reserved for a future "first daily paper delivered" notification; this slice doesn't consume it. */
  notifier: Notifier;
  presenter: CardPresenter;
  identity: { popclawId: string };
  host: HostAdapter;
  signer: Signer;
  egress: EventEgress;
  /** The configured houses. A re-issued namecard is a whole-row upsert
   *  (ADR-0008), so the issue is blocked unless the existing profile row on
   *  every house it will land on is provably safe to re-emit. Those houses are
   *  the write plan captured from `egress`; this list supplies targets only
   *  for an egress that cannot gain houses — see namecard-write-guard.ts. */
  houseOrigins: readonly string[];
  /** Namecard write-guard read transport; defaults to globalThis.fetch. */
  fetch?: typeof globalThis.fetch;
  /** LLM naming suggestions + digest reranking; null = no LLM, everything falls back to static. */
  llm: LLMClientLike | null;
  /** taste root directory (<dataRoot>/popclaw/taste); the taste self-description is written to core/private.md. */
  tasteRoot: string;
  /** persona authorization gate: only has content if the owner explicitly gave a path. */
  readOwnerPersona: () => Promise<string | undefined>;
  /** verified-handles naming material (lore-house /v1/profile; empty on failure). */
  fetchVerifiedHandles: () => Promise<string[]>;
  guideClient: GuideClientLike;
  summaryClient: SummaryClientLike;
  snapshotClient: SnapshotClientLike;
  /** taste sources (gradient cold-start gate: only spend one LLM matrix call once core is non-empty). */
  tasteLoader: TasteSourcesLike;
  /** Digest feedback → learned/picks.jsonl (a write failure never blocks the UX). */
  learnedWriter: LearnedWriterLike;
  /** Mark → MarkService (snapshot + taste + signed report, all included). ADR-0019. */
  markService: OnboardingMarkServiceLike;
  /** Session context index: highlighted entries are registered here, so errand's reference resolution has something to work with. */
  contextIndex: SessionContextIndex;
  /** Web base URL (no trailing slash), from plugin-bootstrap's three-tier resolution. */
  webBaseUrl: string;
  /** The single canonical name chain (alias > self-reported name > handle). */
  nameOf?: NameChain;
  /** Mounted houses (passport stamps + door cards + lantern house lines + settling-in list content). Absent = only the home house counts. */
  houses?: () => readonly MountedHouse[];
  /**
   * Whether this house has "already started" — the only criterion is whether
   * the house's official name has ever sent the owner a message
   * (`InboxStore.hasIncomingFrom`). **Can't tell ≠ hasn't started**: absent /
   * false only means we can't say either way, so at most it gets a light
   * one-line nudge, never a follow-up question (R1 spec §3).
   */
  houseStarted?: (houseSlug: string) => boolean;
  /** Canvas upload surface. Absent / upload failure → card text stays byte-for-byte, just one fewer link line. */
  canvas?: OnboardingCanvasDeps;
  /** errand's identify-person + follow. Absent = this act degrades to "noted, I'll find them later". */
  followPerson?: (ref: string) => Promise<ErrandFollowOutcome>;
}

/** Per-act sub-state (drafts_json). Cleared by default on stage transition; anything that needs to carry over must be passed explicitly. */
interface Drafts extends DiscoveryDrafts {
  /** arrival: the name candidates given this round (used to resolve number references). */
  arrival?: {
    candidates: string[];
    blind: boolean;
    /** A name read out of the owner's sentence, awaiting his yes before it is signed (N1). */
    pendingName?: string;
  };
  /** passport: whether the namecard has actually been sent out yet (no = a bare next just retries). */
  passport?: 'ok' | 'retry';
}

/** The honest line to say when the passport can't be signed (`no_name`, a push failure and a blocked whole-row write are three different things — don't conflate them in the report). */
function passportFailureText(issued: {
  nickname: string;
  status: number | 'network' | 'no_name' | 'blocked';
  blocked?: NamecardWriteCheck;
}): string {
  if (issued.status === 'no_name') return noNameYetText();
  if (issued.status === 'blocked' && issued.blocked && !issued.blocked.ok) {
    return t('onboarding.passport.writeBlocked', {
      house: issued.blocked.house,
      detail: issued.blocked.detail,
    });
  }
  return pushFailedText(issued.nickname, issued.status as number | 'network');
}

/**
 * The invitation line on the very first screen (Decision 5, tier 1) — one of
 * the `firstContact` surfaces: bilingual until the owner's language is known
 * for real, because this line is exactly what's asking him to speak up.
 */
function answerHint(): string {
  return tFirstContact('onboarding.start.answerHint');
}

/** Recent people considered by errand sentence matching. */
const ERRAND_RECENT_PEOPLE = 8;
/** Passport TTL is 72h (R1 spec §2): it's telling you "who you are, where you can go" — those two facts don't expire by the day. */
const PASSPORT_TTL_HOURS = 72;
/** Number of excerpt lines from each house's guide shown on the settling-in list page (it's material for the agent, not a data warehouse). */
const HOUSE_GUIDE_EXCERPT_LINES = 20;

/**
 * OnboardingOrchestrator — the six-act spine (Plan C spec 2026-07-29).
 *
 *   arrival → passport → lantern → attune → errand → cadence → completed
 *
 * Every act actually does one real thing (pick a name / sign and broadcast
 * the namecard / get to know the houses / rerank by taste / follow one
 * person / set a cadence) — no act is merely "an introduction". Three
 * disciplines run through all of them:
 *  - **Honesty**: say plainly when things are quiet, report plainly when a
 *    stamp didn't land, the bond book is local-only (wording lives in act-cards);
 *  - **No follow-up questions**: a skip is a skip, the gap gets recorded on
 *    the ledger for the status to-do list and the settling-in list page — never ask a second time;
 *  - **The canvas is allowed to fail**: an upload that doesn't go through
 *    just loses one link line, the card text itself stays byte-for-byte.
 */
export class OnboardingOrchestrator {
  private started = false;
  /** In-session cache — used for currentCardText's read-only, zero-network re-narration. */
  private cachedPassport: {
    nickname: string;
    sigil: string;
    profileUrl: string;
    stamps: PassportStamp[];
    canvasUrl: string | null;
  } | null = null;
  /** Per-house stamping results (the criterion for the "already knows you ✓" line in the glimpse of the world). */
  private stampBySlug = new Map<string, boolean>();
  private readonly discovery: OnboardingDiscovery;
  private cachedVerifiedHandles: string[] = [];
  /** Things the owner **actually did** this time through — the settling-in list's "what you already know how to do" may only list items from here. */
  private readonly done: string[] = [];
  /** Gaps left this time through (acts that were skipped). */
  private readonly gaps: string[] = [];

  constructor(private readonly deps: OnboardingOrchestratorDeps) {
    this.discovery = new OnboardingDiscovery({
      presenter: deps.presenter,
      llm: deps.llm,
      tasteRoot: deps.tasteRoot,
      guideClient: deps.guideClient,
      summaryClient: deps.summaryClient,
      snapshotClient: deps.snapshotClient,
      tasteLoader: deps.tasteLoader,
      learnedWriter: deps.learnedWriter,
      markService: deps.markService,
      contextIndex: deps.contextIndex,
      webBaseUrl: deps.webBaseUrl,
      nameOf: deps.nameOf,
      houses: () => this.houses(),
      houseKnowsYou: (slug) => this.stampBySlug.get(slug) === true,
      canvas: deps.canvas,
      nowSeconds: () => this.nowSeconds(),
      drafts: () => this.drafts(),
      setDrafts: (drafts) => this.setDrafts(drafts),
      recordDone: (line) => this.done.push(line),
    });
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.deps.stateMachine.ensureStarted(this.deps.identity.popclawId);
    this.started = true;
  }

  async stop(): Promise<void> {
    this.started = false;
  }

  async handleStartCommand(): Promise<{ text: string }> {
    const popclawId = this.deps.identity.popclawId;
    this.deps.stateMachine.ensureStarted(popclawId);
    let current = this.deps.stateMachine.current(popclawId);

    if (current === 'completed') return { text: t('onboarding.completed') };
    if (current === 'idle') {
      this.deps.stateMachine.transition(popclawId, 'arrival');
      current = 'arrival';
    }
    const opening = await this.presentStage(current);
    return { text: `${opening.text}\n\n${answerHint()}\n\n${optionalWorldOffer(ownerLang())}` };
  }

  /**
   * A reply from the owner. `skip` = skip this step (advance the spine + record the gap);
   * a reply saying "that's enough for now / let me look around" = bail (the whole onboarding stops here, every gap gets recorded).
   */
  async handleAdvance(action: 'next' | 'skip', answer?: string): Promise<{ text: string }> {
    // S1, the last tier of the language chain: whatever script the owner's
    // first substantive text is written in, speak that from now on.
    // **Only registered in-process, never persisted to disk** — persisting it
    // would get read back on next boot as "explicit configuration", locking
    // in a guess for good. The real language is written back either by the
    // agent's own observation (owner_language) or by the owner speaking up
    // (popclaw_update_cadence), and either of those overrides this tier.
    if (typeof answer === 'string') {
      const guessed = guessLangFromText(answer);
      if (guessed !== undefined) setOwnerLang(guessed, 'guess');
    }

    const popclawId = this.deps.identity.popclawId;
    // Same first move as handleStartCommand: `current()` THROWS when no row
    // exists. On the gateway a row always exists by now (the orchestrator
    // service calls start() at boot), but under MCP nothing ever does — so a
    // brand-new citizen whose very first popclaw call was this one got an
    // exception instead of an answer. Idempotent.
    this.deps.stateMachine.ensureStarted(popclawId);
    const current = this.deps.stateMachine.current(popclawId);

    // Nothing started yet? `next` IS the start. `/popclaw start` is a gateway-only
    // surface — an MCP citizen (Claude Code / Codex) has no slash command to type,
    // so pointing them at one used to leave them stuck at idle forever: the six
    // acts were only ever walkable there by hand-editing the state DB. The owner
    // saying "let's do it" and the agent calling continue is the same act of
    // consent as the owner typing the command himself, which is why this is one
    // code path for both roots rather than a host branch ("settling in is a
    // checklist, not a rail"). `skip` is deliberately NOT a starter: there is no
    // act to skip yet, and a stray skip must never quietly begin onboarding.
    //
    // `answer` is deliberately dropped on this path: at idle there was no
    // question on the table, so the owner's words ("let's do it") answer
    // nothing — act one opens by offering name candidates regardless. The one
    // thing worth keeping from those words, the language guess, was already
    // taken a few lines above, before we ever looked at the stage.
    if (current === 'idle') {
      return action === 'next'
        ? this.handleStartCommand()
        : { text: tFirstContact('onboarding.notStarted.hint') };
    }

    const trimmed = answer?.trim() ?? '';
    // "Give me another passport" = re-render on demand, **even after
    // graduation** (the passport's 72h TTL expires, and once the owner's
    // link on hand goes dead there has to be a working path to a new one).
    // It's neither advancing the spine nor re-running an act.
    if (trimmed && isPassportReissueRequest(trimmed)) return this.reissuePassport();

    if (current === 'completed') return { text: t('onboarding.completed') };

    // bail: this isn't skipping this one step, it's stopping here for now. The gap still gets recorded, and it's always possible to come back and finish.
    if (trimmed && isBailKeyword(trimmed)) return this.bail(current);

    switch (current) {
      case 'arrival':
        return this.advanceArrival(action, trimmed);
      case 'passport':
        return this.advancePassport(action, trimmed);
      case 'lantern':
        return this.advanceLantern(action, trimmed);
      case 'attune':
        return this.advanceAttune(action, trimmed);
      case 'errand':
        return this.advanceErrand(action, trimmed);
      case 'cadence':
        return this.advanceCadence(action, trimmed);
    }
  }

  /** Re-present a given act (`/popclaw start` re-entering mid-way = idempotently replaying the current act). */
  private async presentStage(stage: OnboardingStage): Promise<{ text: string }> {
    switch (stage) {
      case 'arrival':
        return this.presentArrival();
      case 'passport':
        return this.presentPassport();
      case 'lantern':
        return this.discovery.presentLantern();
      case 'attune':
        return this.discovery.presentAttune();
      case 'errand':
        return this.presentErrand();
      default:
        return this.presentCadence();
    }
  }

  // -------------------------------------------------------------------------
  // ① arrival — the opening act of picking a name
  // -------------------------------------------------------------------------

  /**
   * Candidates = the existing real name (if any) + suggestNames (persona
   * authorization gate + verified handles, a single LLM call), ≤3 total. If
   * none can be drafted → one neutral fallback name + honestly say we don't know the owner yet.
   */
  private async presentArrival(): Promise<{ text: string }> {
    const popclawId = this.deps.identity.popclawId;
    const current = await this.currentNickname();
    const hasRealName = !isPlaceholderNickname(current);

    const [persona, handles] = await Promise.all([
      this.deps.readOwnerPersona().catch(() => undefined),
      this.deps.fetchVerifiedHandles().catch(() => [] as string[]),
    ]);
    this.cachedVerifiedHandles = handles;
    const suggested = await suggestNames(this.deps.llm, {
      personaText: persona,
      verifiedHandles: handles,
    });
    const candidates = [...new Set([...(hasRealName ? [current] : []), ...suggested])].slice(0, 3);
    // `blind` is exactly "the list above came out empty": no verified handles,
    // no persona, no existing name — so the only candidate is one we make up.
    const blind = suggested.length === 0 && !hasRealName;
    // ...and that one has to be made up **per lane**. The card below is
    // rendered once in each language when we don't know the owner's yet, and a
    // single `ownerLang()`-flavoured fallback put an English name inside the
    // Chinese half ("1. Night drifter", 2026-08-24 smoke). Always one
    // candidate either way, so both halves number it the same.
    const candidatesFor = (lang: Lang): string[] =>
      blind ? [fallbackName(popclawId, lang)] : candidates;

    this.setDrafts({ arrival: { candidates: candidatesFor(ownerLang()), blind } });
    // Act one is first contact: on a fresh identity with nothing but the host
    // locale to go on, the whole card goes out bilingual rather than betting
    // the owner speaks whatever `LANG` happens to say (2026-08-24 smoke).
    const card = textCard(
      firstContact((lang) =>
        renderBriefingForUser(buildArrivalBriefing({ candidates: candidatesFor(lang), blind }, lang)),
      ),
      persona === undefined ? tFirstContact('onboarding.personaHint') : undefined,
    );
    return this.presentCard(card);
  }

  private async advanceArrival(action: 'next' | 'skip', trimmed: string): Promise<{ text: string }> {
    const draft = this.drafts().arrival;
    // Blind = the candidate was our own fallback name, and it was drafted
    // before the owner had said a word. He has now, so re-derive it in the
    // language he actually answered in rather than adopting the half of the
    // bilingual card he wasn't reading.
    const candidates =
      draft?.blind === true ? [fallbackName(this.deps.identity.popclawId)] : draft?.candidates ?? [];
    const decision = interpretArrivalAnswer({
      candidates,
      pendingName: draft?.pendingName,
      action,
      answer: trimmed,
    });
    // Preserve the old pending clear as its own write and failure boundary,
    // before replacement, retry, presentation or adoption.
    if (decision.invalidatePending) this.setArrivalPending(undefined);
    switch (decision.kind) {
      case 'offerCandidates':
        return this.presentArrival();
      case 'repeatCandidates':
        return this.representArrival(candidates, draft?.blind === true);
      case 'repeatConfirmation':
        return { text: namingConfirmText(decision.name) };
      case 'askConfirmation':
        this.setArrivalPending(decision.name);
        return { text: namingConfirmText(decision.name) };
      case 'adopt':
        return this.adoptName(decision.name, decision.fromCandidate);
      case 'retry':
        return { text: namingRetryText(decision.reason) };
    }
  }

  /** Whether a name is waiting on the naming confirmation card (the inbound gate asks). */
  hasPendingName(): boolean {
    try {
      if (this.deps.stateMachine.current(this.deps.identity.popclawId) !== 'arrival') return false;
    } catch {
      return false;
    }
    return this.drafts().arrival?.pendingName !== undefined;
  }

  /** The candidates card again, from the draft — no new LLM call, no new names. */
  private async representArrival(candidates: string[], blind: boolean): Promise<{ text: string }> {
    const lang = ownerLang();
    return this.presentCard(
      textCard(renderBriefingForUser(buildArrivalBriefing({ candidates, blind }, lang))),
    );
  }

  private setArrivalPending(pendingName: string | undefined): void {
    const arrival = { ...(this.drafts().arrival ?? { candidates: [], blind: false }) };
    if (pendingName === undefined) delete arrival.pendingName;
    else arrival.pendingName = pendingName;
    this.setDrafts({ arrival });
  }

  /**
   * Name settled → write to config → move into passport to get the passport issued.
   * `fromCandidate` decides name_source: a candidate = auto (we picked it for
   * you, status will lightly nudge toward a rename); something the owner
   * wrote themselves = owner. If the one picked happens to match their
   * original name → keep the original source.
   */
  private async adoptName(nickname: string, fromCandidate: boolean): Promise<{ text: string }> {
    const popclawId = this.deps.identity.popclawId;
    const current = await this.currentNickname();
    let source: NameSource = fromCandidate ? 'auto' : 'owner';
    if (nickname === current && !isPlaceholderNickname(current)) {
      source = (await readNameSource(this.deps.host)) ?? source;
    }
    await persistNickname(this.deps.host, nickname, source);
    // Namecard content changed → advance declared_at by one tick (the house
    // side checks `declared_at >=`, so without a bump it gets silently
    // rejected). Only bump it here: reissuing a passport (reissuePassport)
    // doesn't change the content, and the signed bytes must match the
    // previous ones exactly so the house side's event dedup can catch it
    // (my-namecard.ts D4).
    await bumpNamecardDeclaredAt(this.deps.host, () => this.nowSeconds());
    this.done.push(t('onboarding.did.named', { nickname }));
    this.deps.stateMachine.transition(popclawId, 'passport');
    return this.presentPassport();
  }

  // -------------------------------------------------------------------------
  // ② passport — get the passport issued (the vermillion-seal moment)
  // -------------------------------------------------------------------------

  /**
   * signMyNamecard → broadcast to every house (**result recorded per house**) → passport Canvas → chat card.
   * If the home house doesn't accept it = don't advance, report the error honestly, a bare next just retries (the name is already recorded locally).
   * A secondary house failing only marks a ✗ on its stamp line — it never blocks the spine.
   */
  private async presentPassport(): Promise<{ text: string }> {
    const issued = await this.issuePassport();
    if (!issued.ok) {
      this.setDrafts({ passport: 'retry' });
      return { text: passportFailureText(issued) };
    }
    this.done.push(
      t('onboarding.did.passport', {
        ok: String(issued.stamps.filter((s) => s.ok).length),
        total: String(issued.stamps.length),
      }),
    );
    this.setDrafts({ passport: 'ok' });
    return this.presentCard(briefingCard(this.passportBriefing(ownerLang())));
  }

  /**
   * Sign the namecard → broadcast to every house (**result recorded per
   * house**) → render the passport page → upload → cache in the session.
   * Home house not accepting it = `ok:false` (the caller decides whether to
   * not advance or just report it honestly); a secondary house failing only
   * marks a ✗ on its stamp line, it never blocks the spine. The name is
   * signed on this machine, the stamp is the receipt the house gives back —
   * these are two separate things and are reported separately.
   */
  private async issuePassport(): Promise<
    | { ok: false; nickname: string; status: number | 'network' | 'no_name' | 'blocked'; blocked?: NamecardWriteCheck }
    | { ok: true; nickname: string; stamps: readonly PassportStamp[] }
  > {
    const plan = captureNamecardWritePlan(this.deps.egress, this.deps.houseOrigins);
    const nickname = await this.currentNickname();
    const sigil = deriveSigil(this.deps.identity.popclawId);
    // The single point of signing (my-namecard.ts D2/D3). The public client
    // declares nickname, local biography and declaredAt, and the house-side upsert replaces
    // the whole row (ADR-0008) — so the write gate runs first: a house row
    // this client cannot re-emit is left untouched instead of clobbered.
    const card = await loadMyNamecard({
      host: this.deps.host,
      now: () => this.nowSeconds(),
    });
    if (!card) {
      // Still a placeholder name (e.g. the owner already said "that's enough
      // for now" back at arrival). A placeholder name is never pushed out
      // (same gate as my-namecard.ts's self-heal check) — say honestly that
      // the name isn't set yet, don't misreport it as a network failure.
      return { ok: false, nickname, status: 'no_name' };
    }
    const signed = await signMyNamecard(this.deps.signer, card);
    // One plan for this issue: the guard reads exactly the houses the
    // broadcast below may reach, and the broadcast reaches no other.
    const gate = await guardNamecardWritePlan(plan, {
      popclawId: this.deps.identity.popclawId,
      oneLineIntro: card.oneLineIntro,
      fetch: this.deps.fetch,
    });
    if (!gate.ok) return { ok: false, nickname, status: 'blocked', blocked: gate };

    let outcomes: readonly HouseBroadcastOutcome[];
    if (plan.egress.broadcastEach) {
      outcomes = await plan.egress.broadcastEach(signed.signedPayloadBytes);
    } else {
      try {
        const result = await broadcastAll(plan.egress, signed.signedPayloadBytes);
        outcomes = [{ slug: this.houses()[0]?.slug ?? '', result }];
      } catch {
        return { ok: false, nickname, status: 'network' };
      }
    }
    const home = outcomes[0];
    if (!home || !outcomeOk(home)) {
      return { ok: false, nickname, status: home?.result?.status ?? 'network' };
    }

    const stamps: PassportStamp[] = outcomes.map((o) => ({
      houseName: this.houseName(o.slug),
      ok: outcomeOk(o),
    }));
    this.stampBySlug = new Map(outcomes.map((o) => [o.slug, outcomeOk(o)]));
    const profileUrl = buildProfileUrl(nickname, sigil, this.deps.webBaseUrl);
    const canvasUrl = await this.uploadPage(
      t('onboarding.passportPage.title', { nickname, sigil }),
      renderPassportPage({
        nickname,
        sigil,
        profileUrl,
        stamps,
        issuedDate: this.today(),
        doors: this.passportDoors(),
      }),
      PASSPORT_TTL_HOURS,
    );

    this.cachedPassport = {
      nickname,
      sigil,
      profileUrl,
      stamps,
      canvasUrl,
    };
    return { ok: true, nickname, stamps };
  }

  /**
   * "Give me another passport" — re-render on demand using **current** data
   * (a newly mounted house, the latest stamps, all naturally reflected).
   * Doesn't touch the state machine, doesn't record anything: this isn't re-running an act, it's just reissuing the piece of paper.
   */
  private async reissuePassport(): Promise<{ text: string }> {
    const issued = await this.issuePassport();
    if (!issued.ok) return { text: passportFailureText(issued) };
    return this.presentCard(briefingCard(this.passportBriefing(ownerLang())));
  }

  /**
   * Per-house door cards (the passport page's "where you can go"). **The
   * only fallback**: if the home house doesn't declare a door → fall back to
   * the owner's own home page base (webBaseUrl); every other house's path is never guessed (ADR-0041).
   */
  private passportDoors(): PassportDoor[] {
    return this.houses().map((h, i) => {
      const blurb = houseBlurb(h, () => this.houses());
      const home = h.entry?.home ?? (i === 0 ? this.deps.webBaseUrl : undefined);
      return {
        houseName: h.name,
        knowsYou: this.stampBySlug.get(h.slug) === true,
        ...(blurb ? { blurb } : {}),
        ...(h.entry?.headline ? { headline: h.entry.headline } : {}),
        ...(home ? { homeUrl: home } : {}),
        ...(h.entry?.firstMove ? { firstMove: h.entry.firstMove } : {}),
      };
    });
  }

  /**
   * The **text version** of the doors (so nothing is lost if the canvas
   * fails). A house with no declaration doesn't take up a line.
   *
   * Built per lane, never cached: the house's own words (name / headline /
   * first_move) are data, but the scaffolding around them is ours and has to
   * match the lane the briefing is being built in. It used to be a hardcoded
   * `say "…" to start`, which put an English frame around Chinese data on a
   * zh card (2026-08-23 MCP smoke).
   */
  private doorLines(lang: Lang): string[] {
    const lines: string[] = [];
    for (const h of this.houses()) {
      const e = h.entry;
      if (!e?.headline && !e?.firstMove) continue;
      lines.push(
        [
          h.name,
          e.headline,
          e.firstMove ? renderCopy(lang, 'onboarding.doorLine.firstMove', { move: e.firstMove }) : undefined,
        ]
          .filter((p): p is string => typeof p === 'string' && p.length > 0)
          .join(' · '),
      );
    }
    return lines;
  }

  /** `lang` defaults to the English source the agent reads; card callers pass `ownerLang()`. */
  private passportBriefing(lang: Lang = 'en') {
    const p = this.cachedPassport!;
    return buildPassportBriefing(
      {
        nickname: p.nickname,
        sigil: p.sigil,
        profileUrl: p.profileUrl,
        stamps: p.stamps,
        canvasUrl: p.canvasUrl,
        doorLines: this.doorLines(lang),
      },
      lang,
    );
  }

  /** No mandatory decision here: any non-rename input advances; "change my name" goes back to arrival; a next when nothing was sent = retry. */
  private async advancePassport(action: 'next' | 'skip', trimmed: string): Promise<{ text: string }> {
    const popclawId = this.deps.identity.popclawId;
    if (trimmed && isRenameRequest(trimmed)) {
      this.deps.stateMachine.transition(popclawId, 'arrival');
      return this.presentArrival();
    }
    if (action === 'next' && this.drafts().passport !== 'ok') {
      return this.presentPassport(); // Retry the push
    }
    this.deps.stateMachine.transition(popclawId, 'lantern');
    return this.discovery.presentLantern();
  }

  // -------------------------------------------------------------------------
  // ③ lantern — getting to know the houses (guide + digest merged into one)
  // -------------------------------------------------------------------------

  private async advanceLantern(action: 'next' | 'skip', trimmed: string): Promise<{ text: string }> {
    const popclawId = this.deps.identity.popclawId;
    if (action === 'skip') {
      // Taste has no context until the owner has looked: skip both acts.
      this.recordGap(t('onboarding.gap.notLooked'));
      this.recordGap(t('onboarding.gap.noTaste'));
      this.deps.stateMachine.transition(popclawId, 'errand');
      return this.presentErrand();
    }
    const answer = this.discovery.answerLantern(trimmed);
    if (!('attune' in answer)) return answer;
    return this.enterAttune(answer.attune);
  }

  private async enterAttune(attune: NonNullable<DiscoveryDrafts['attune']>): Promise<{ text: string }> {
    this.deps.stateMachine.transition(this.deps.identity.popclawId, 'attune', {
      drafts: { attune },
    });
    return this.discovery.presentAttune();
  }

  // Forward the successful branch directly: awaiting discovery here would
  // insert a reaction between its presenter and the root's stage transition.
  private advanceAttune(action: 'next' | 'skip', trimmed: string): Promise<{ text: string }> {
    const popclawId = this.deps.identity.popclawId;
    if (action === 'skip' || !trimmed || isNotSelfDescription(trimmed)) {
      return this.skipAttune(popclawId);
    }
    return this.discovery.saveTaste(trimmed, () => {
      this.deps.stateMachine.transition(popclawId, 'errand');
      return this.presentErrand();
    });
  }

  private async skipAttune(popclawId: string): Promise<{ text: string }> {
    this.recordGap(t('onboarding.gap.noTaste'));
    this.deps.stateMachine.transition(popclawId, 'errand');
    const errand = await this.presentErrand();
    return { text: `${attuneSkippedText()}\n\n${errand.text}` };
  }

  // -------------------------------------------------------------------------
  // ⑤ errand — the first task
  // -------------------------------------------------------------------------

  private async presentErrand(): Promise<{ text: string }> {
    const people = this.deps.contextIndex.lastBatch();
    const seen = new Set<string>();
    const peopleLines: string[] = [];
    people.forEach((p, i) => {
      if (seen.has(p.authorPopclawId)) return;
      seen.add(p.authorPopclawId);
      peopleLines.push(`${i + 1}. ${p.authorNickname}`);
    });
    const nudge = this.houseNudge();
    // If it's mentioned, it gets recorded: if the owner doesn't act on it there's no follow-up question, the gap is left for the graduation list and the status to-do list.
    if (nudge) this.recordGap(nudge.gap);
    return this.presentCard(
      briefingCard(
        buildErrandBriefing(
          {
            peopleLines,
            ...(nudge ? { houseNudge: nudge.line } : {}),
          },
          ownerLang(),
        ),
      ),
    );
  }

  /**
   * A light **one-line** nudge about another house (R1 spec §3.3). Three gates:
   *  (1) that house itself has declared `first_move` (no declaration means
   *      there's no "first thing to do" at all);
   *  (2) it hasn't started yet over there (the house's official name has
   *      never sent the owner a message);
   *  (3) never mention the home house — tonight's run through is already the
   *      home house's first thing to do, mentioning it again would be pointless.
   * With multiple houses, only the first one gets mentioned: one line stays one line, no queue, no numbering.
   */
  private houseNudge(): { line: string; gap: string } | undefined {
    for (const h of this.houses().slice(1)) {
      const move = h.entry?.firstMove;
      if (!move || this.houseStarted(h.slug)) continue;
      // Both strings reach the owner (the errand card / the graduation list),
      // so both come from the owner's lane. `headline` reuses the nudge
      // table's own joiner, so the dash-vs-full-width choice stays in one place.
      const headline = h.entry?.headline
        ? t('onboarding.nudge.house.headline', { headline: h.entry.headline })
        : '';
      const vars = { house: h.name, headline, move };
      return {
        line: t('onboarding.errand.houseNudge.line', vars),
        gap: t('onboarding.errand.houseNudge.gap', vars),
      };
    }
    return undefined;
  }

  /** "Already started" check; unable to tell = false (we simply can't say), at most one extra line gets mentioned, never a follow-up question. */
  private houseStarted(slug: string): boolean {
    try {
      return this.deps.houseStarted?.(slug) ?? false;
    } catch {
      return false;
    }
  }

  /**
   * Resolution chain: session context index (number / hint) → two local
   * sources + lore-house `/v1/resolve` (injected via followPerson, the same
   * identify-person chain as /popclaw follow).
   * Following is a lightweight, reversible action → **no second confirmation**, just do it.
   */
  private async advanceErrand(action: 'next' | 'skip', trimmed: string): Promise<{ text: string }> {
    const popclawId = this.deps.identity.popclawId;
    if (action === 'skip' || !trimmed) {
      this.recordGap(t('onboarding.gap.noFollows'));
      this.deps.stateMachine.transition(popclawId, 'cadence');
      const cadence = await this.presentCadence();
      return { text: `${errandSkippedText()}\n\n${cadence.text}` };
    }
    if (!this.deps.followPerson) {
      // The identify-person chain isn't wired up (dev CLI / degraded mode): don't pretend it succeeded.
      return { text: t('onboarding.errand.rosterUnreachable') };
    }

    // (1) Session context index: number / hint substring (the owner means one of the people they just saw).
    let ref = trimmed;
    const ord = trimmed.match(/^(\d+)$/);
    if (ord) {
      const item = this.deps.contextIndex.byOrdinal(Number(ord[1]));
      if (!item) return { text: ordinalRetryText(this.deps.contextIndex.lastBatch().length) };
      ref = item.authorPopclawId;
    } else {
      // The owner said a full natural-language sentence ("follow alixearle"),
      // with the name **embedded in the sentence** — so first check in
      // reverse (whose name appears in this sentence), then fall back to hint-substring matching.
      const lower = trimmed.toLowerCase();
      const inSentence = this.deps.contextIndex
        .recent(ERRAND_RECENT_PEOPLE)
        .filter((i) => i.authorNickname && lower.includes(i.authorNickname.toLowerCase()));
      const hits = inSentence.length > 0 ? inSentence : this.deps.contextIndex.findByHint(trimmed);
      const ids = [...new Set(hits.map((h) => h.authorPopclawId))];
      if (ids.length === 1) ref = ids[0]!;
    }

    // (2) + (3) The two local sources → lore-house (followPerson internally is the existing identify-person chain).
    const outcome = await this.deps.followPerson(ref).catch(
      (err: unknown): ErrandFollowOutcome => ({ kind: 'unavailable', reason: String(err) }),
    );
    if (outcome.kind === 'choose') return { text: errandAmbiguousText(outcome.lines) };
    if (outcome.kind === 'notFound') return { text: errandNotFoundText(outcome.ref) };
    if (outcome.kind === 'unavailable') {
      return { text: t('onboarding.errand.failed', { reason: outcome.reason }) };
    }

    this.done.push(t('onboarding.did.follow', { display: outcome.display }));
    const lines = [followedText(outcome.display, outcome.house)];
    // Verification only shows up when it **actually has a consequence**: only mentioned if the other person has an endorsement hanging off their own name, otherwise not a word is said.
    if (outcome.verifiedPlatform) {
      lines.push(verifiedNudgeText(outcome.display, outcome.verifiedPlatform));
    }
    this.deps.stateMachine.transition(popclawId, 'cadence');
    const cadence = await this.presentCadence();
    return { text: `${lines.join('\n')}\n\n${cadence.text}` };
  }

  // -------------------------------------------------------------------------
  // ⑥ cadence — set the cadence + graduate + the settling-in list
  // -------------------------------------------------------------------------

  /**
   * The hour to put in front of the owner: **this** hour, which is what they
   * are living in right now, unless it is one nobody
   * wants a paper at — then 08:00. Either way it is a proposal, not a setting:
   * the question invites a different hour and the answer overrides this.
   */
  private proposedPaperHour(): number {
    const h = Number(timeContext(Math.floor(Date.now() / 1000)).hm.slice(0, 2));
    return Number.isInteger(h) && h >= 6 && h <= 22 ? h : 8;
  }

  private async presentCadence(): Promise<{ text: string }> {
    return this.presentCard(
      briefingCard(
        buildCadenceBriefing(ownerLang(), this.proposedPaperHour()),
      ),
    );
  }

  private async advanceCadence(action: 'next' | 'skip', trimmed: string): Promise<{ text: string }> {
    const said = action === 'next' && trimmed ? trimmed : '';
    // An hour the owner named is itself a yes — nobody names a delivery time for
    // a paper they are declining.
    const namedHour = said ? readCadenceHour(said) : undefined;
    const choice = said ? (readCadenceChoice(said) ?? (namedHour === undefined ? undefined : 'daily')) : undefined;
    const hour = namedHour ?? this.proposedPaperHour();
    if (choice === 'daily') this.done.push(t('onboarding.did.paper', { at: hourLabel(hour) }));
    if (choice === 'declined') {
      // An explicit decline = never lightly nudge the morning paper again (it never appears in the status to-do list).
      this.recordGap(t('onboarding.gap.paperDeclined'));
    }
    if (choice) await this.recordCadenceChoice(choice, hour);
    return this.graduate(choice, hour);
  }

  /** Graduation copy + settling-in list material (rendered by the agent itself) → completed. */
  private async graduate(newspaper?: 'daily' | 'declined', newspaperHour?: number): Promise<{ text: string }> {
    const popclawId = this.deps.identity.popclawId;
    const nickname = await this.currentNickname();
    const sigil = deriveSigil(popclawId);
    const taste = this.discovery.tasteText();
    const tasteText = typeof taste === 'string' ? taste : await taste;
    // Straight to the owner (no presenter card, no agent in between), so it is
    // built in the owner's lane — same rule as every briefingCard above.
    const briefing = buildGraduationBriefing(
      {
        nickname,
        sigil,
        profileUrl:
          this.cachedPassport?.profileUrl ?? buildProfileUrl(nickname, sigil, this.deps.webBaseUrl),
        ...(newspaper ? { newspaper } : {}),
        ...(newspaperHour === undefined ? {} : { newspaperHour }),
        ...(tasteText ? { tasteText } : {}),
        verifiedHandles: this.cachedVerifiedHandles,
        done: this.done,
        gaps: this.gaps,
        phrasebook: phrasebook(),
        houseGuides: this.houses()
          .filter((h) => (h.guide ?? '').trim().length > 0)
          .map((h) => ({
            houseName: h.name,
            excerpt: excerptLines(h.guide ?? '', HOUSE_GUIDE_EXCERPT_LINES),
          })),
      },
      ownerLang(),
    );
    this.deps.stateMachine.transition(popclawId, 'completed');
    // Normal graduation (running all the way through / graduating directly): the resume_onboarding gap gets cleared along with it.
    await clearBailedAt(this.deps.host);
    return { text: `${renderBriefingForUser(briefing)}\n\n${channelNoticeText()}` };
  }

  /** "That's enough for now / let me look around": the whole onboarding stops here, every gap gets recorded, always possible to come back and finish. */
  private async bail(current: OnboardingStage): Promise<{ text: string }> {
    this.recordGap(t('onboarding.gap.stopped', { stage: current }));
    // bail's disk-persistence fix (R1 spec §5, a real bug in the current
    // behavior): it used to only record gaps in memory, which got lost
    // across process restarts; now it writes to config, and the
    // `resume_onboarding` gap (a nudge line + status) is driven by that.
    await writeBailedAt(this.deps.host, this.nowSeconds());
    this.deps.stateMachine.transition(this.deps.identity.popclawId, 'completed');
    return { text: t('onboarding.bail', { notice: channelNoticeText() }) };
  }

  // -------------------------------------------------------------------------
  // Read-only path (agent briefing; zero network, zero LLM, zero state change)
  // -------------------------------------------------------------------------

  async currentCardText(): Promise<string> {
    const popclawId = this.deps.identity.popclawId;
    let stage: OnboardingStage;
    try {
      stage = this.deps.stateMachine.current(popclawId);
    } catch {
      // stateMachine.current() throws when no row exists (ensureStarted not yet called).
      // First contact, and on the MCP path a weak agent relays this line
      // verbatim — so until we know the owner's language for real it goes out
      // in both (2026-08-24: a Chinese owner's very first screen, in English).
      return tFirstContact('onboarding.readonly.notStarted');
    }
    if (stage === 'idle') return tFirstContact('onboarding.readonly.notStarted');
    if (stage === 'completed') return t('onboarding.completed');
    if (stage === 'arrival') {
      const a = this.drafts().arrival;
      // The read-only path never calls suggestNames (that's an LLM call). If no candidates have been given yet, just say something in plain words first.
      if (!a) return t('onboarding.readonly.arrival');
      return renderBriefingForAgent(
        buildArrivalBriefing({
          candidates: a.candidates,
          blind: a.blind,
        }),
      );
    }
    if (stage === 'passport') {
      if (!this.cachedPassport) return t('onboarding.readonly.passport');
      return renderBriefingForAgent(this.passportBriefing());
    }
    if (stage === 'lantern' || stage === 'attune') {
      return this.discovery.currentCardText(stage);
    }
    if (stage === 'errand') {
      // The read-only path doesn't record anything (recording happens in presentErrand), but the line that should show still shows.
      const nudge = this.houseNudge();
      return renderBriefingForAgent(
        buildErrandBriefing({
          peopleLines: this.deps.contextIndex
            .lastBatch()
            .map((p, i) => `${i + 1}. ${p.authorNickname}`),
          ...(nudge ? { houseNudge: nudge.line } : {}),
        }),
      );
    }
    return renderBriefingForAgent(
      // The agent lane stays English on purpose — the directive around this
      // material is what tells the agent which language to *speak*. Only the
      // hour is threaded through.
      buildCadenceBriefing(undefined, this.proposedPaperHour()),
    );
  }

  // -------------------------------------------------------------------------
  // Housekeeping
  // -------------------------------------------------------------------------

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

  /** A house name always comes from data; if not found, fall back to the slug — the plugin never hardcodes any house name. */
  private houseName(slug: string): string {
    return this.houses().find((h) => h.slug === slug)?.name || slug || t('onboarding.house.fallbackName');
  }

  /**
   * Gap recording: the same list of gaps feeds both the settling-in list page
   * and the status to-do list. Dedup is by the rendered line, so a gap booked
   * from two places (`onboarding.gap.noTaste`: lantern's cascade skip and
   * attune's explicit skip) must go through the **same lexicon key** — two
   * different wordings would show up as two lines on the graduation list.
   */
  private recordGap(text: string): void {
    if (!this.gaps.includes(text)) this.gaps.push(text);
  }

  /**
   * The cadence choice is persisted to plugin config — an "explicit decline"
   * has to survive across process restarts, otherwise it gets nudged again
   * tomorrow. Only touches the `onboarding` section; every other config field is read-modify-written back unchanged.
   */
  private async recordCadenceChoice(choice: 'daily' | 'declined', hour?: number): Promise<void> {
    try {
      const raw = await this.deps.host.config.loadJson('plugin');
      const cfg =
        raw !== null && typeof raw === 'object' && !Array.isArray(raw)
          ? (raw as Record<string, unknown>)
          : {};
      const prev =
        cfg.onboarding !== null && typeof cfg.onboarding === 'object' && !Array.isArray(cfg.onboarding)
          ? (cfg.onboarding as Record<string, unknown>)
          : {};
      await this.deps.host.config.saveJson('plugin', {
        ...cfg,
        onboarding: {
          ...prev,
          newspaper: choice,
          // Only meaningful for 'daily'; recording it on a decline would leave a
          // stale hour behind if they later change their mind.
          ...(choice === 'daily' && hour !== undefined ? { newspaperHour: hour } : {}),
        },
      });
    } catch {
      // Failing to record this shouldn't stop the owner's graduation card from showing.
    }
  }

  private drafts(): Drafts {
    return this.deps.stateMachine.drafts(this.deps.identity.popclawId) as Drafts;
  }

  private setDrafts(drafts: Drafts): void {
    this.deps.stateMachine.setDrafts(
      this.deps.identity.popclawId,
      drafts as Record<string, unknown>,
    );
  }

  private nowSeconds(): number {
    return Math.floor(this.deps.host.clock.now().getTime() / 1000);
  }

  /**
   * The owner's calendar day, not UTC's (ADR-0045). A bare `toISOString()`
   * dates a passport issued at 06:00 in +08 to *yesterday*.
   */
  private today(): string {
    return timeContext(this.nowSeconds()).ymd;
  }

  private async presentCard(card: MessagePresentation): Promise<{ text: string }> {
    await this.deps.presenter.present(card);
    return { text: cardText(card) };
  }

  /**
   * Current name = config plugin.ranger_profile.nickname; when absent, falls
   * back to the same placeholder name bootstrap uses, `ranger-<first 6 chars of popclawId>`.
   */
  private async currentNickname(): Promise<string> {
    const raw = await this.deps.host.config.loadJson('plugin');
    const cfg =
      raw !== null && typeof raw === 'object' && !Array.isArray(raw)
        ? (raw as Record<string, unknown>)
        : {};
    const profile = cfg.ranger_profile;
    const nickname =
      profile !== null && typeof profile === 'object' && !Array.isArray(profile)
        ? (profile as Record<string, unknown>).nickname
        : undefined;
    const trimmed = typeof nickname === 'string' ? nickname.trim() : '';
    return trimmed || `ranger-${this.deps.identity.popclawId.slice(0, 6)}`;
  }
}

/**
 * Plain-words ⇄ capability mapping (settling-in list material). **Only lists
 * what has actually shipped and actually works** — the honesty-first gene: no
 * promises, not a word about anything unbuilt. Read out on the graduation
 * card, so it comes from the owner's lane (`onboarding.phrasebook`).
 */
function phrasebook(): readonly string[] {
  return t('onboarding.phrasebook').split('|');
}

/** The spine's next stop = the first non-completed target in the transition table; if none, completed. */
export function spineNext(current: OnboardingStage): OnboardingStage {
  const targets = legalNextStages[current];
  return targets.find((t) => t !== 'completed') ?? 'completed';
}

function excerptLines(text: string, lines: number): string {
  return text.trim().split('\n').slice(0, lines).join('\n').trim();
}
