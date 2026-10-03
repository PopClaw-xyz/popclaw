/**
 * Standalone rename / profile-name command. Works any time (inside or outside
 * onboarding): persist nickname (source=owner) → sign Profile → push to
 * lore-house, re-issuing the namecard. Mirrors the orchestrator's issueNamecard
 * write path but is reachable as its own /popclaw name <name> command + tool,
 * so the owner is never trapped with an auto/placeholder name.
 */
import type { HostAdapter } from '../host/host-adapter.js';
import type { Signer } from '../identity/signer.js';
import { broadcastAll, type EventEgress, type PushResult } from '../egress/event-egress.js';
import { persistNickname, isPlaceholderNickname, nicknameProblem } from '../onboarding/identity-writer.js';
import {
  loadMyNamecard,
  bumpNamecardDeclaredAt,
  signMyNamecard,
} from '../messaging/my-namecard.js';
import { captureNamecardWritePlan, guardNamecardWritePlan } from '../messaging/namecard-write-guard.js';
import { deriveSigil } from '../invite/sigil.js';
import { profileLinkText } from '../lshow/sources/web-fallback.js';
import { renderCopy } from '../lexicon/index.js';
import { ownerLang } from '../lexicon/owner-language.js';

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

export async function runPopclawNameCommand(
  args: { nickname: string },
  deps: PopclawNameDeps,
): Promise<{ text: string }> {
  const lang = ownerLang();
  const nickname = (args.nickname ?? '').trim();
  if (!nickname) {
    return { text: renderCopy(lang, 'name.usage') };
  }
  if (isPlaceholderNickname(nickname)) {
    return { text: renderCopy(lang, 'name.placeholderRejected') };
  }
  if (/^\d+$/.test(nickname)) {
    return { text: renderCopy(lang, 'name.digitsRejected') };
  }
  // The same shared rule the onboarding path applies (the config schema caps a
  // nickname at 32 UTF-16 units and is parsed on every boot). Refuse before
  // anything is persisted, timestamped, signed or pushed; never truncate.
  if (nicknameProblem(nickname) === 'tooLong') {
    return { text: renderCopy(lang, 'name.tooLongRejected') };
  }
  // Capture before any command work yields; houses joined later belong to
  // the next write. The per-house channels still check authority at send.
  const plan = captureNamecardWritePlan(deps.egress, deps.houseOrigins);
  await persistNickname(deps.host, nickname, 'owner');
  const now = () => Math.floor(deps.clock.now().getTime() / 1000);
  await bumpNamecardDeclaredAt(deps.host, now);
  const card = await loadMyNamecard({ host: deps.host, now });
  if (!card) {
    // Unreachable in practice: persistNickname just wrote a real, non-placeholder
    // name — but stay honest instead of crashing if it ever weren't.
    return { text: renderCopy(lang, 'name.cardBuildFailed', { nickname }) };
  }
  const signed = await signMyNamecard(deps.signer, card);
  // One plan for this command: the guard reads exactly the houses the
  // broadcast below may reach, and the broadcast reaches no other.
  const gate = await guardNamecardWritePlan(plan, {
    popclawId: deps.popclawId,
    fetch: deps.fetch,
  });
  if (!gate.ok) {
    // Fail closed: the local nickname is already persisted; the house row is
    // NOT overwritten. Nothing is lost either way — say exactly that.
    return {
      text: renderCopy(lang, gate.kind === 'unowned' ? 'name.writeBlocked.unowned' : 'name.writeBlocked.unreadable', {
        nickname,
        house: gate.house,
        ...(gate.kind === 'unowned' ? { fields: gate.detail } : { detail: gate.detail }),
      }),
    };
  }
  let push: PushResult;
  try {
    // Spec B slice 3: the namecard is a public artifact, pushed once to each
    // house — without broadcasting, the owner would be a ghost id on the
    // second house: resolve returns empty, profile 404s. The receipt taken
    // is the primary house's.
    push = await broadcastAll(plan.egress, signed.signedPayloadBytes);
  } catch {
    return { text: renderCopy(lang, 'name.savedPushOffline', { nickname }) };
  }
  if (push.status < 200 || push.status >= 300) {
    return { text: renderCopy(lang, 'name.savedPushFailed', { nickname, status: String(push.status) }) };
  }
  const sigil = deriveSigil(deps.popclawId);
  const url = profileLinkText(nickname, sigil, deps.webBaseUrl);
  return { text: renderCopy(lang, 'name.updated', { nickname, sigil, url }) };
}
