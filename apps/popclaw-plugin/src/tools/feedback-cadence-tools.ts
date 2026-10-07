/**
 * `popclaw_feedback` (ADR-0042: the agent speaks to the vendor directly) and
 * `popclaw_update_cadence` (ADR-0044 §2: the language/timezone switch).
 *
 * Split out of register-tools.ts (2026-08-25).
 */

import { FeedbackSchema, UpdateCadenceSchema } from './tool-schemas.js';
import { writeCadenceDelivery } from '../cadence/cadence-loader.js';
import { ownerLang, setOwnerLang, failureText } from '../lexicon/owner-language.js';
import { renderCopy, type Lang } from '../lexicon/index.js';
import { isValidTz, setOwnerTz } from '../time/time-context.js';
import type { NameChain } from '../identity/person-name.js';
import { socialDraftBinding, socialToolFactory } from '../host/social-send-context.js';
import { runPopclawFeedbackCommand, type FeedbackDraftPlan } from '../commands/popclaw-feedback.js';
import { hostDbSlug } from '../ingress/host-slug.js';
import type { Signer } from '../identity/signer.js';
import { buildDoctorReport } from '../diagnostics/collect.js';
import { readHouseGuide } from '../world/house-handshake.js';
import type { PopclawPaths } from '../host/popclaw-paths.js';
import type { ToolsCtx } from './tools-context.js';
import { formatPerson } from '../identity/person-resolver.js';
import { deriveSigil } from '../invite/sigil.js';
import {
  draftDigest, noteDraftPreview, noteDraftToolOutput, putDraft,
  type DraftAttachmentSnapshot, type DraftSnapshot,
} from './draft-store.js';
import { loadDmAttachment } from '../messaging/dm-media.js';
import { deliverDraftPreview, draftResultText } from './draft-preview-delivery.js';
import { withDraftReview } from './draft-review.js';
import {retainSocialDraft, socialDraftToken} from './durable-social-drafts.js';
import {pinSocialSendPlan} from './draft-send-plan.js';

// Build provenance for the `[feedback/v1]` header — same esbuild `define` as
// index.ts / mcp.ts. Unbundled (tests, tsx) there is no define; say so honestly.
declare const __POPCLAW_BUILD__: string;
const POPCLAW_BUILD =
  typeof __POPCLAW_BUILD__ !== 'undefined' ? __POPCLAW_BUILD__ : 'dev (unbundled)';

/**
 * What the owner reads before a feedback letter can go anywhere: whom it is
 * addressed to, which lore-house's contact that is, and the letter itself,
 * word for word. Built once per draft and used for both the direct preview
 * and the tool result, exactly like the other draft tools' one-preview rule.
 *
 * The contact's name comes from the lore-house's own guide.md — the house is
 * the authority on who its contact is — and the sigil is derived from the id
 * that is actually being written to, so the two cannot disagree.
 */
function feedbackDraftPreview(plan: FeedbackDraftPlan, token: string, lang: Lang): string {
  const who = formatPerson(
    {
      nickname: plan.contactName ?? '',
      sigil: deriveSigil(plan.contactPopclawId),
      popclawId: plan.contactPopclawId,
    },
    lang,
  );
  const kindLabel = renderCopy(lang, plan.kind === 'bug' ? 'feedback.kindLabel.bug' : 'feedback.kindLabel.need');
  return [
    renderCopy(lang, 'feedback.draft.title', { kindLabel, who }),
    renderCopy(lang, 'feedback.draft.house', { house: plan.house }),
    ...(plan.requestedHouse ? [renderCopy(lang, 'feedback.draft.fellBack', { requested: plan.requestedHouse })] : []),
    ...(plan.attachmentPath ? [renderCopy(lang, 'feedback.draft.attach', { path: plan.attachmentPath })] : []),
    renderCopy(lang, 'feedback.draft.bodyLabel'),
    plan.body,
    '',
    `draft_id: ${token}`,
  ].join('\n');
}

/**
 * The complete letter for original-chat review: recipient, the house
 * whose contact that is, the complete text, and the health report riding
 * along — the report as BYTES, not as a path, for the reason
 * `DraftAttachmentSnapshot` gives: a path re-read at send time is not what the
 * owner approved.
 */
function feedbackSnapshot(plan: FeedbackDraftPlan, attachment?: DraftAttachmentSnapshot): DraftSnapshot {
  return {
    kind: 'feedback',
    recipientId: plan.contactPopclawId,
    recipientLabel: `${plan.contactName ?? '—'}#${deriveSigil(plan.contactPopclawId)}`,
    house: plan.house,
    body: plan.body,
    attachments: attachment ? [attachment] : [],
    preview: null,
    output: null,
  };
}

/** Feedback + cadence registrations, in their original order. */
export function registerFeedbackCadenceTools(ctx: ToolsCtx): void {
  const { api, runtime, total, deps } = ctx;

  // ADR-0042 — the agent speaks to the vendor directly. The whole point of this feature is
  // that **the agent itself** reports the wall it hit: on real hardware, 2026-07-29, the
  // owner's agent drafted the whole message but had no way to send it (only the slash
  // command existed at the time). This goes through the exact same command and the exact
  // same DM path as `/popclaw feedback`, and the receipt is relayed through word for word.
  api.registerTool(
    socialToolFactory(deps.socialSendHost, (toolCtx: unknown) => ({
    name: 'popclaw_feedback',
    description:
      "Draft product feedback only when the owner asks; never call it on your own initiative. Report errors and blockers " +
      "to the owner, not to an outside recipient. This tool drafts a private letter and returns its recipient, lore-house, " +
      "full text and draft_id; it does not send. Show that preview verbatim. A request to draft is not approval to send. " +
      "Only after the owner has read it and explicitly said to send, pass draft_id to popclaw_send_draft.\n" +
      "Use need for a missing capability and bug for broken supported behavior; for bug set attach_doctor_report: true. " +
      "Use the health report, never investigate by reading PopClaw's files. First establish whose problem it is: do what " +
      "you can; for a missing local tool or permission, tell the owner exactly what to enable (only the owner may change " +
      "host config; popclaw never changes it for them); use feedback for a genuine product gap. A letter is never a " +
      "substitute for those first two steps. This is not a question desk: follow an answer already given; never send a " +
      "second letter asking the same thing. You may also report a blocker, but never wait for a reply: there is no ticket " +
      "or SLA.\n" +
      "For a house-specific problem, set house (host or house slug); for PopClaw commands, notifications, newspaper or " +
      "protocol, omit it to address the home house. If the named house is not mounted, stop and ask which house the owner " +
      "means; never retry with house omitted, which changes the recipient. If that house declares no contact, the tool " +
      "falls back to the home contact and names the original house in the letter header and preview. An unconfirmed " +
      "destination needs a fresh draft.\n" +
      "Follow the target guide.md feedback template: goal, attempts, blocker, expected result. Scrub body: no owner name, " +
      "contact details, local paths, keys or raw chat. On failure, report the failure; never claim a letter was sent.",
    parameters: FeedbackSchema,
    execute: async (_callId: string, params: unknown) => {
      const p = params as { kind: string; body: string; house?: string; attach_doctor_report?: boolean };
      const rt = (await runtime()) as {
        boot: {
          signer: Signer;
          nickname: string;
          loreHouseUrl: string;
          loreHouseUrls: readonly string[];
        };
        egress: unknown;
        inboxStore: { houseOf(id: string): string | undefined };
        guideClient: { fetchGuideText(): Promise<string | null> };
        paths: PopclawPaths;
        socialLog?: unknown;
        nameOf?: NameChain;
      };
      // attach_doctor_report: the tool schema has no with-text key — this
      // path cannot reach the owner's verbatim text at the type level (final
      // doc §3 decision 2); always withText:false.
      let attachmentPath: string | undefined;
      // The report's own bytes, read once, here: what the snapshot digests and
      // what actually goes out are then the same array, not the same path.
      let attachment: DraftAttachmentSnapshot | undefined;
      if (p.attach_doctor_report === true) {
        try {
          const report = await buildDoctorReport(rt, POPCLAW_BUILD, total, { withText: false });
          attachmentPath = report.path;
          const loaded = loadDmAttachment(report.path);
          if (!loaded.ok) return { type: 'text' as const, text: loaded.text };
          attachment = { name: loaded.name, digest: draftDigest(loaded.bytes), mime: loaded.mime, bytes: loaded.bytes };
        } catch (err) {
          return { type: 'text' as const, text: renderCopy(ownerLang(), 'feedback.doctorReportFailed', { err: String(err) }) };
        }
      }
      const reply = await runPopclawFeedbackCommand(
        {
          positional: [String(p.kind ?? ''), String(p.body ?? '')],
          ...(p.house ? { flags: { house: String(p.house) } } : {}),
        },
        {
          signer: rt.boot.signer,
          egress: rt.egress,
          nickname: rt.boot.nickname,
          houseOfRecipient: (id: string) => rt.inboxStore.houseOf(id),
          socialLog: rt.socialLog,
          nameOf: rt.nameOf,
          fetchGuide: () => rt.guideClient.fetchGuideText(),
          houseSlug: hostDbSlug(rt.boot.loreHouseUrl),
          // house filled in with another house → the contact is taken from that house's guide text cached to disk (ADR-0041 handshake cache).
          readHouseGuide: (slug: string) => readHouseGuide(rt.paths, slug),
          knownHouseSlugs: rt.boot.loreHouseUrls.map(hostDbSlug),
          buildStamp: POPCLAW_BUILD,
          ...(attachmentPath ? { attachmentPath } : {}),
          // The report's bytes travel with the deps, so the parked send uses
          // what the owner approved rather than whatever is at that path when
          // they confirm.
          ...(attachment ? { media: { bytes: attachment.bytes, mime: attachment.mime, name: attachment.name } } : {}),
          // The gate. The agent never sends: the finished letter is parked
          // behind a draft_id and the owner confirms it through
          // popclaw_send_draft, the same door every other outbound private
          // message goes through. The parked closure carries its own
          // recipient and house, so confirming one draft can only ever send
          // that one letter to that one contact.
          draftDm: async (plan, send) => {
            const token = await socialDraftToken(deps, 'message');
            // A letter is parked under the `message` prefix because it is an
            // outbound DM and must clear the DM door, but what the owner is
            // asked to approve is a letter — so the snapshot says so, and it
            // carries the same recipient, house and complete text the preview
            // below shows; the id is only an internal lookup handle.
            putDraft(token, send, {...feedbackSnapshot(plan, attachment), binding: socialDraftBinding(deps.socialSendHost, toolCtx),
              ...(deps.durableSocialDrafts ? {sendPlan: {...pinSocialSendPlan(await runtime(), plan.house),
                person: {popclawId: plan.contactPopclawId, nickname: plan.contactName ?? '', sigil: deriveSigil(plan.contactPopclawId)},
                receiptPrefix: plan.receiptPrefix, receiptSuffix: plan.receiptSuffix}} : {})});
            const preview = feedbackDraftPreview(plan, token, ownerLang());
            const outcome = await deliverDraftPreview(toolCtx, preview);
            noteDraftPreview(token, preview, outcome.status);
            // The letter as the host will render it in its own transcript:
            // this text is what `popclaw_feedback` returns, unchanged
            // (popclaw-feedback.ts hands a draftDm result straight back).
            const text = withDraftReview(token, draftResultText(preview, outcome), deps.draftReviewFiles);
            noteDraftToolOutput(token, text);
            await retainSocialDraft(deps, token);
            return { text };
          },
          // react is not wired in: kind is a bug|need enum, so a typed tool can never reach the deprecated up/down alias.
        } as Parameters<typeof runPopclawFeedbackCommand>[1],
      );
      return { type: 'text' as const, text: reply.text };
    },
    }), deps.getHostedSocialInvocation, deps.getLocalSocialScope),
    { name: 'popclaw_feedback' },
  );

  // ADR-0044 §2: the empty shell was deleted; this is its return under
  // criterion 1 (the owner says it out loud: "speak English to me" / "I'm in
  // Berlin now"), registered with the one-line description that tier carries.
  // Decision 7 of the i18n doc: there is deliberately NO `/popclaw language`
  // command — this tool IS the language switch.
  api.registerTool({
    name: 'popclaw_update_cadence',
    description:
      'Owner asks to change how popclaw talks to them — primary_language (BCP-47) or timezone (IANA). Writes cadence.json; takes effect at once.',
    parameters: UpdateCadenceSchema,
    execute: async (_callId: string, params: unknown) => {
      const p = params as { primary_language?: unknown; timezone?: unknown };
      const lang = typeof p.primary_language === 'string' ? p.primary_language.trim() : '';
      const tz = typeof p.timezone === 'string' ? p.timezone.trim() : '';
      if (lang === '' && tz === '') {
        return { type: 'text' as const, text: renderCopy(ownerLang(), 'cadence.update.nothing') };
      }
      if (tz !== '' && !isValidTz(tz)) {
        return { type: 'text' as const, text: renderCopy(ownerLang(), 'cadence.update.badTz', { tz }) };
      }
      const patch: Record<string, string> = {
        ...(lang !== '' ? { primaryLanguage: lang } : {}),
        ...(tz !== '' ? { timezone: tz } : {}),
      };
      try {
        const rt = (await runtime()) as { paths: PopclawPaths };
        writeCadenceDelivery(rt.paths.cadenceDir(), patch);
      } catch (err) {
        return { type: 'text' as const, text: failureText('popclaw_update_cadence', err) };
      }
      // Only after the write sticks — the register must not disagree with disk.
      if (lang !== '') setOwnerLang(lang);
      if (tz !== '') setOwnerTz(tz);
      // The receipt announcing the new language must itself be in the new
      // language — setOwnerLang/setOwnerTz above already took effect, so
      // ownerLang() here is the language the owner just asked for (ledger #010).
      const l = ownerLang();
      const changed = [
        lang !== '' ? renderCopy(l, 'cadence.update.langPart', { value: lang }) : '',
        tz !== '' ? renderCopy(l, 'cadence.update.tzPart', { value: tz }) : '',
      ]
        .filter((s) => s !== '')
        .join(renderCopy(l, 'cadence.update.join'));
      return { type: 'text' as const, text: renderCopy(l, 'cadence.update.ok', { changed }) };
    },
  });
}
