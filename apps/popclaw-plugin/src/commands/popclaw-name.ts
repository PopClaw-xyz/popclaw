/**
 * Standalone rename / profile-name command. Works any time (inside or outside
 * onboarding): persist nickname (source=owner) → sign Profile → push to
 * lore-house, re-issuing the namecard. Mirrors the orchestrator's issueNamecard
 * write path but is reachable as its own /popclaw name <name> command + tool,
 * so the owner is never trapped with an auto/placeholder name.
 */
import type { HostAdapter } from '../host/host-adapter.js';
import type { Signer } from '../identity/signer.js';
import { broadcastAll, type EventEgress, type HouseBroadcastOutcome, type PushResult } from '../egress/event-egress.js';
import { isPlaceholderNickname, nicknameProblem } from '../onboarding/identity-writer.js';
import { persistMyNamecardUpdate, signMyNamecard, type MyNamecard } from '../messaging/my-namecard.js';
import { captureNamecardWritePlan, guardNamecardWritePlan, readHouseProfileEvidence, type NamecardWritePlan } from '../messaging/namecard-write-guard.js';
import { deriveSigil } from '../invite/sigil.js';
import { profileLinkText } from '../lshow/sources/web-fallback.js';
import { renderCopy } from '../lexicon/index.js';
import { ownerLang } from '../lexicon/owner-language.js';
import { hostDbSlug } from '../ingress/host-slug.js';
import { HousePushError } from '../runtime/house-lifecycle/house-runtime.js';
import type { CommandPushResult } from '../runtime/house-lifecycle/command-bus.js';

export interface PopclawNameDeps {
  host: HostAdapter;
  signer: Signer;
  egress: EventEgress;
  popclawId: string;
  clock: { now(): Date };
  /** The configured houses. A re-issued namecard is a whole-row upsert
   *  (ADR-0008), so the write is blocked unless the existing profile row on
   *  every house it will land on is provably safe to re-emit. Those houses are
   *  the write plan captured from `egress` (which may hold houses joined after
   *  boot); this list supplies targets only for an egress that cannot gain
   *  houses — see namecard-write-guard.ts. */
  houseOrigins: readonly string[];
  /** The configured web base. The confirmation prints the owner's address, and
   *  it has to be the SAME address status and the namecard print (ADR-0032) —
   *  this copy used to build a `#` fragment of its own. Omitted → the default. */
  webBaseUrl?: string | null;
  fetch?: typeof globalThis.fetch;
}

export interface NamecardHouseUpdate {
  readonly house: string;
  readonly publication: 'accepted' | 'rejected' | 'unknown' | 'not-attempted';
  readonly confirmation: 'matched' | 'mismatched' | 'unreadable' | 'not-attempted';
  readonly status?: number;
  /** Original typed receipt, including durable operation and outbound evidence. */
  readonly receipt?: PushResult | CommandPushResult;
  readonly detail?: string;
  readonly observed?: {readonly nickname: string; readonly oneLineIntro: string; readonly declaredAtMs: number};
}

export interface NamecardUpdateDetails {
  readonly local: {readonly status: 'saved' | 'failed' | 'unchanged'; readonly card?: MyNamecard; readonly detail?: string};
  readonly public: {readonly status: 'confirmed' | 'partial' | 'failed' | 'unknown' | 'blocked' | 'not-attempted'; readonly houses: readonly NamecardHouseUpdate[]};
}
export interface NamecardUpdateResult {
  readonly text: string;
  readonly details: NamecardUpdateDetails;
  readonly isError?: true;
}

function failure(text: string, detail?: string): NamecardUpdateResult {
  return {text, isError: true, details: {local: {status: 'unchanged', ...(detail ? {detail} : {})},
    public: {status: 'not-attempted', houses: []}}};
}

/** Existing rename API; biography uses the same persistence, signing and publication path. */
export async function runPopclawNameCommand(
  args: { nickname: string },
  deps: PopclawNameDeps,
): Promise<NamecardUpdateResult> {
  const lang = ownerLang();
  const nickname = typeof args.nickname === 'string' ? args.nickname.trim() : '';
  if (!nickname) return failure(renderCopy(lang, 'name.usage'));
  if (isPlaceholderNickname(nickname)) return failure(renderCopy(lang, 'name.placeholderRejected'));
  if (/^\d+$/.test(nickname)) return failure(renderCopy(lang, 'name.digitsRejected'));
  if (nicknameProblem(nickname) === 'tooLong') return failure(renderCopy(lang, 'name.tooLongRejected'));
  return runNamecardUpdate({nickname}, deps);
}

/** An explicit owner request to edit the base public Profile, independent of World extensions. */
export async function runPopclawBioCommand(
  args: { bio: string },
  deps: PopclawNameDeps,
): Promise<NamecardUpdateResult> {
  if (typeof args.bio !== 'string') return failure(renderCopy(ownerLang(), 'namecard.bioInvalid'));
  // Preserve the owner's exact content. Empty string is a deliberate clear.
  return runNamecardUpdate({oneLineIntro: args.bio}, deps);
}

function errorDetail(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

function isHttpStatus(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599;
}

/** Collect evidence without assuming an exception is a network failure. */
async function publishNamecard(plan: NamecardWritePlan, bytes: Uint8Array): Promise<readonly HouseBroadcastOutcome[]> {
  if (plan.egress.broadcastEach) {
    try { return await plan.egress.broadcastEach(bytes); }
    catch (error) { return plan.houses.map(target => ({slug: target.slug ?? hostDbSlug(target.origin!), error})); }
  }
  // A legacy aggregate receipt can describe only home. Never invent secondary receipts.
  const home = plan.houses[0]!;
  const slug = home.slug ?? hostDbSlug(home.origin!);
  try { return [{slug, result: await broadcastAll(plan.egress, bytes)}]; }
  catch (error) { return [{slug, error}]; }
}

async function runNamecardUpdate(
  update: {readonly nickname?: string; readonly oneLineIntro?: string},
  deps: PopclawNameDeps,
): Promise<NamecardUpdateResult> {
  const lang = ownerLang();
  // Freeze targets before the first await; every guard read and send uses this plan.
  const plan = captureNamecardWritePlan(deps.egress, deps.houseOrigins);
  let card: MyNamecard | null;
  try {
    card = await persistMyNamecardUpdate(deps.host, update, () => Math.floor(deps.clock.now().getTime() / 1000));
  } catch (err) {
    const detail = errorDetail(err);
    return {text: renderCopy(lang, 'namecard.localFailed', {detail}), isError: true,
      details: {local: {status: 'failed', detail}, public: {status: 'not-attempted', houses: []}}};
  }
  if (!card) return failure(renderCopy(lang, 'namecard.nameRequired'));
  const local = {status: 'saved' as const, card};
  const savedText = renderCopy(lang, 'namecard.localSaved', {nickname: card.nickname});
  if (!plan.houses.length) return {text: `${savedText}\n${renderCopy(lang, 'namecard.noHouses')}`, isError: true,
    details: {local, public: {status: 'not-attempted', houses: []}}};
  const gate = await guardNamecardWritePlan(plan, {
    popclawId: deps.popclawId, fetch: deps.fetch, oneLineIntro: card.oneLineIntro,
    // This field-specific authorization comes from the explicit set_bio request.
    allowIntroReplacement: update.oneLineIntro !== undefined,
  });
  if (!gate.ok) {
    const houses = plan.houses.map(({house}) => ({house, publication: 'not-attempted' as const,
      confirmation: 'not-attempted' as const, ...(house === gate.house ? {detail: `${gate.kind}: ${gate.detail}`} : {})}));
    return {text: `${savedText}\n${renderCopy(lang, 'namecard.blocked', {house: gate.house, detail: gate.detail})}`,
      isError: true, details: {local, public: {status: 'blocked', houses}}};
  }
  let outcomes: readonly HouseBroadcastOutcome[];
  try {
    const signed = await signMyNamecard(deps.signer, card);
    outcomes = await publishNamecard(plan, signed.signedPayloadBytes);
  } catch (err) {
    const detail = errorDetail(err);
    return {text: `${savedText}\n${renderCopy(lang, 'namecard.signFailed', {detail})}`, isError: true,
      details: {local, public: {status: 'failed', houses: plan.houses.map(({house})=>({house,
        publication: 'not-attempted', confirmation: 'not-attempted', detail}))}}};
  }
  const houses: NamecardHouseUpdate[] = await Promise.all(plan.houses.map(async target => {
    const slug = target.slug ?? hostDbSlug(target.origin!);
    const receipts = outcomes.filter(outcome => outcome.slug === slug);
    const receipt = receipts.length === 1 ? receipts[0] : undefined;
    // HouseRuntime throws refused/unknown typed receipts; MultiHouseEgress
    // preserves that wrapper under error rather than result. Do not lose the
    // durable operation or outbound evidence when reducing publication status.
    const result = receipt?.result ?? (receipt?.error instanceof HousePushError ? receipt.error.result : undefined);
    const status = result?.status;
    const rejected = isHttpStatus(status) && (status < 200 || status >= 300);
    const accepted = isHttpStatus(status) && status >= 200 && status < 300 && result?.signedActionResultBase64 === undefined;
    const publication = rejected ? 'rejected' as const : accepted ? 'accepted' as const : 'unknown' as const;
    const detail = result?.detail ?? (receipt?.error !== undefined ? errorDetail(receipt.error)
      : result?.signedActionResultBase64 !== undefined ? 'Signed action receipt has not been verified'
      : !receipt ? 'Missing or duplicate per-House receipt' : undefined);
    const evidence = await readHouseProfileEvidence(target.origin!, deps.popclawId, {
      fetch: deps.fetch, oneLineIntro: card.oneLineIntro,
    });
    const observed = evidence.status === 'clean-card' ? {nickname: evidence.nickname,
      oneLineIntro: evidence.oneLineIntro, declaredAtMs: evidence.declaredAtMs} : undefined;
    const confirmation = evidence.status === 'blocked' ? 'unreadable' as const
      : evidence.status === 'clean-card' && evidence.nickname === card.nickname &&
        evidence.oneLineIntro === (card.oneLineIntro ?? '') && evidence.declaredAtMs === card.declaredAt * 1000
        ? 'matched' as const : 'mismatched' as const;
    return {house: target.house, publication, confirmation, ...(status === undefined ? {} : {status}),
      ...(result === undefined ? {} : {receipt: result}),
      ...(detail === undefined && evidence.status !== 'blocked' ? {} : {detail: [detail,
        evidence.status === 'blocked' ? evidence.detail : undefined].filter(Boolean).join('; ')}),
      ...(observed ? {observed} : {})};
  }));
  const confirmed = houses.filter(house => house.confirmation === 'matched' && house.publication !== 'rejected').length;
  const status = confirmed === houses.length ? 'confirmed' as const : confirmed > 0 ? 'partial' as const
    : houses.every(house => house.publication === 'rejected') ? 'failed' as const : 'unknown' as const;
  const sigil = deriveSigil(deps.popclawId);
  const summary = renderCopy(lang, `namecard.public.${status}`, {
    nickname: card.nickname, sigil, url: profileLinkText(card.nickname, sigil, deps.webBaseUrl),
  });
  const lines = houses.map(house => renderCopy(lang, 'namecard.houseResult', {house: house.house,
    publication: renderCopy(lang, `namecard.publication.${house.publication}`),
    confirmation: renderCopy(lang, `namecard.confirmation.${house.confirmation}`),
    detail: [isHttpStatus(house.status)
      ? `HTTP ${house.status}` : '', house.detail ?? ''].filter(Boolean).join('; ')}));
  return {text: [savedText, summary, ...lines].join('\n'), details: {local, public: {status, houses}},
    ...(status === 'confirmed' ? {} : {isError: true as const})};
}
