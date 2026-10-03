/**
 * The bond-book / proposal tools that predate the NL surface ("stubs for Plan
 * B" in the original spec) plus the mute switch. Two registrars, because the
 * write-class block sits between the two groups and registration order is
 * observable.
 *
 * Split out of register-tools.ts (2026-08-25).
 */

import {
  EmptySchema,
  FindBondsSchema,
  ShowBondsSchema,
  ShowDreamReviewSchema,
  SetBondTierSchema,
  SetRemarkNameSchema,
  DecideBondTierProposalSchema,
  MuteNoticesSchema,
} from './tool-schemas.js';
import { ownerLang, failureText } from '../lexicon/owner-language.js';
import { renderCopy } from '../lexicon/index.js';
import { runBondCommand } from '../commands/popclaw-bond.js';
import type { NameChain } from '../identity/person-name.js';
import { displayNamed } from '../identity/person-name.js';
import { runPopclawReviewCommand } from '../commands/popclaw-review.js';
import { BOND_TIERS, tierLabel, type BondTier } from '../bonds/bond-tier.js';
import type { BondsStore } from '../bonds/bonds-store.js';
import type { ProposalsStore } from '../bonds/proposals-store.js';
import { findBonds } from '../bonds/find-bonds.js';
import type { LLMCompleteFn } from '../recommend/score-against-taste.js';
import type { HostAdapter } from '../host/host-adapter.js';
import { muteNudge } from '../onboarding/nudge.js';
import { type ToolsCtx } from './tools-context.js';
import { ownerPopclawId, resolvePersonRef } from './person-sources.js';

/** The first stub block — registered between the read-class and write-class tools. */
export function registerStubTools(ctx: ToolsCtx): void {
  const { api, runtime, deps } = ctx;

  // === STUBS for Plan B ===

  api.registerTool({
    name: 'popclaw_show_bonds',
    description:
      'Call this tool when the owner says "my bond book", "who do I know", "how are my relationships". ' +
      "Show the user's bond book — relationship bonds by tier " +
      '(refused/blocked/stranger/acquaintance/friend/close friend/closest friend) with follow state. ' +
      'If the tool fails, tell the owner it failed — never make up a result.',
    parameters: ShowBondsSchema,
    execute: async (_callId: string, params: unknown) => {
      try {
        const p = params as { min_tier?: string; limit?: number };
        // min_tier is honoured only when it names a real tier; an invalid value
        // is ignored (no throw) so a fuzzy agent guess never breaks the listing.
        const minTier =
          typeof p.min_tier === 'string' && (BOND_TIERS as readonly string[]).includes(p.min_tier)
            ? (p.min_tier as BondTier)
            : undefined;
        const limit =
          typeof p.limit === 'number' && p.limit > 0 ? Math.floor(p.limit) : undefined;
        const rt = (await runtime()) as { bondsStore: unknown; nameOf?: NameChain };
        const reply = await runBondCommand(
          { positional: ['list'], minTier, limit },
          { bondsStore: rt.bondsStore, nameOf: rt.nameOf } as Parameters<typeof runBondCommand>[1],
        );
        return { type: 'text' as const, text: reply.text };
      } catch (err) {
        return { type: 'text' as const, text: failureText('popclaw_show_bonds', err) };
      }
    },
  });

  api.registerTool({
    name: 'popclaw_find_bonds',
    description:
      "Find people in the local bond book by natural language and summarise how they are doing. Candidate names, IDs, " +
      "tags, descriptions and recent activity are passed to the configured model; this is not guaranteed to be local-only " +
      "computation. Use when the owner asks \"how have my business partners / investors / that sort of friend been doing " +
      "lately\". Read-only — execute directly.",
    parameters: FindBondsSchema,
    execute: async (_callId: string, params: unknown) => {
      try {
        const p = params as { query?: unknown };
        const query = typeof p.query === 'string' ? p.query.trim() : '';
        if (!query) return { type: 'text' as const, text: renderCopy(ownerLang(), 'find.emptyQuery') };
        const rt = (await runtime()) as { bondsStore: BondsStore; llmComplete: LLMCompleteFn };
        const text = await findBonds({ bondsStore: rt.bondsStore, llmComplete: rt.llmComplete }, query);
        return { type: 'text' as const, text };
      } catch (err) {
        return { type: 'text' as const, text: failureText('popclaw_find_bonds', err) };
      }
    },
  });

  api.registerTool({
    name: 'popclaw_set_bond_tier',
    description:
      'Call when the owner says "block him", "make her a friend", "stop showing me his stuff": set someone\'s bond tier to' +
      ' friend|close|blocked|reject|acquaintance (manual override, lightweight and reversible — execute directly, no confirmation needed).',
    parameters: SetBondTierSchema,
    execute: async (_callId: string, params: unknown) => {
      try {
        const p = params as { popclaw_id: string; tier: string };
        // Validate the tier and set it directly on the store — do NOT route
        // through a tier→verb map: the `add` verb maps back to 'friend', so
        // requesting 'acquaintance' would silently become 'friend' (C1).
        if (!(BOND_TIERS as readonly string[]).includes(p.tier)) {
          return {
            type: 'text' as const,
            text: `⚠️ unknown tier "${p.tier}" — use friend|close|blocked|reject|acquaintance`,
          };
        }
        // A tier is a judgement about somebody else. This tool takes a raw
        // popclaw_id, so it never needed the resolver — but the owner's own id
        // is on screen in every status report, and a bond row about oneself is
        // a relation the bond book must not hold.
        const owner = await ownerPopclawId(deps);
        if (owner && p.popclaw_id === owner) {
          return { type: 'text' as const, text: renderCopy(ownerLang(), 'person.thatIsYou') };
        }
        const rt = (await runtime()) as {
          bondsStore: BondsStore;
          nameOf?: NameChain;
          proposalsStore?: Pick<ProposalsStore, 'settlePendingForManualTier'>;
        };
        const bond = rt.bondsStore.setTier(p.popclaw_id, p.tier as BondTier, 'manual');
        // A manual tier move settles that person's pending proposals: the
        // owner answered the tier question by hand — no stale suggestion may
        // resurface later. Best-effort by
        // design: the tier HAS moved, so a settle that fails must not turn an
        // honest success receipt into a lie (the settle is idempotent and
        // retries on the next manual move).
        try {
          rt.proposalsStore?.settlePendingForManualTier(p.popclaw_id, p.tier as BondTier);
        } catch {
          // swallowed on purpose — see above
        }
        const lang = ownerLang();
        return {
          type: 'text' as const,
          text: renderCopy(lang, 'bond.tierSet', {
            who: displayNamed(p.popclaw_id, rt.nameOf),
            tier: tierLabel(bond.tier, lang),
          }),
        };
      } catch (err) {
        return { type: 'text' as const, text: failureText('popclaw_set_bond_tier', err) };
      }
    },
  });

  api.registerTool({
    name: 'popclaw_set_remark_name',
    description:
      "Give someone an alias — the owner's own way of calling them. Call when the owner says " +
      '"call him XX from now on" / "note him down as XX" / "rename him to XX" / "stop calling him that". ' +
      'Once an alias is set, everywhere popclaw mentions him uses it (overriding the name he gave himself), ' +
      'just like a contact alias in a messaging app. ' +
      'Pass an empty string as remark_name = clear the alias, and the name falls back to the one he gave himself. ' +
      'Lightweight and reversible — execute directly without confirmation. ' +
      'An alias is purely local and is never sent out for anyone else to see.',
    parameters: SetRemarkNameSchema,
    execute: async (_callId: string, params: unknown) => {
      try {
        const p = params as { person: string; remark_name: string };
        const rt = (await runtime()) as { bondsStore: BondsStore; nameOf?: NameChain };
        const reply = await runBondCommand(
          // An empty alias = clear it (same criterion as on the command side: no name given means clear it).
          { positional: ['remark', p.person, ...(p.remark_name ? [p.remark_name] : [])] },
          {
            bondsStore: rt.bondsStore,
            nameOf: rt.nameOf,
            // The owner is taken out inside runBondCommand, after the id is
            // known — a guard in this callback was bypassed by the full-id
            // lane, which skips resolution entirely (popclaw-bond.ts runRemark).
            ownPopclawId: await ownerPopclawId(deps),
            resolvePerson: (ref) => resolvePersonRef(ref, deps),
          },
        );
        return { type: 'text' as const, text: reply.text };
      } catch (err) {
        return { type: 'text' as const, text: failureText('popclaw_set_remark_name', err) };
      }
    },
  });

  api.registerTool({
    name: 'popclaw_show_dream_review',
    description: 'Show the morning dream-time relationship review card.',
    parameters: ShowDreamReviewSchema,
    execute: async () => {
      try {
        const rt = (await runtime()) as {
          bondsStore: BondsStore;
          proposalsStore: ProposalsStore;
          nameOf?: NameChain;
          /** Present on the gateway root only — the MCP bridge runs no doorbell legs. */
          pendingFollows?: { listPending(): Array<{ display_name: string }> };
        };
        const reply = await runPopclawReviewCommand(
          { positional: [] },
          {
            bondsStore: rt.bondsStore,
            proposalsStore: rt.proposalsStore,
            ...(rt.nameOf ? { nameOf: rt.nameOf } : {}),
            // Doorbell §6.5 morning-card double insurance, filled in only
            // where the store is reachable.
            ...(rt.pendingFollows ? { pendingFollows: rt.pendingFollows } : {}),
          },
        );
        return { type: 'text' as const, text: reply.text };
      } catch (err) {
        return { type: 'text' as const, text: failureText('popclaw_show_dream_review', err) };
      }
    },
  });

  api.registerTool({
    name: 'popclaw_list_pending_proposals',
    description: 'List ring upgrade/downgrade and cadence-change proposals waiting for user decision.',
    parameters: EmptySchema,
    execute: async () => {
      try {
        const rt = (await runtime()) as { proposalsStore: ProposalsStore; nameOf?: NameChain };
        const pending = rt.proposalsStore.listPending();
        const lang = ownerLang();
        if (pending.length === 0) {
          return { type: 'text' as const, text: renderCopy(lang, 'bond.proposal.pendingEmpty') };
        }
        const lines = pending.map((p, i) => {
          const from = tierLabel(p.fromTier, lang) ?? p.fromTier;
          const to = tierLabel(p.toTier, lang) ?? p.toTier;
          return renderCopy(lang, 'bond.proposal.pendingLine', {
            n: String(i + 1),
            // The name chain ("name#sigil"), same rule as the review card and
            // the notification lines — a bare id prefix never reaches the screen.
            who: displayNamed(p.popclawId, rt.nameOf),
            from,
            to,
            rationale: p.rationale,
          });
        });
        return {
          type: 'text' as const,
          text:
            renderCopy(lang, 'bond.proposal.pendingHeader', { count: String(pending.length) }) +
            `\n${lines.join('\n')}\n\n` +
            renderCopy(lang, 'bond.proposal.pendingFooter'),
        };
      } catch (err) {
        return { type: 'text' as const, text: failureText('popclaw_list_pending_proposals', err) };
      }
    },
  });

}

/** The second stub block — registered after the write-class tools. */
export function registerMoreStubTools(ctx: ToolsCtx): void {
  const { api, runtime } = ctx;

  // === MORE STUBS for Plan B ===

  api.registerTool({
    name: 'popclaw_decide_bond_tier_proposal',
    description:
      'Call once a bond-tier proposal has been put to the owner and he says "accept / reject / let it wait": ' +
      'apply accept|reject|defer to that pending proposal.',
    parameters: DecideBondTierProposalSchema,
    execute: async (_callId: string, params: unknown) => {
      try {
        const p = params as { popclaw_id: string; decision: 'accept' | 'reject' | 'defer' };
        const rt = (await runtime()) as { bondsStore: BondsStore; proposalsStore: ProposalsStore; nameOf?: NameChain };
        // Find the first pending proposal for this popclaw_id
        const pending = rt.proposalsStore.listPending();
        const target = pending.find((pr) => pr.popclawId === p.popclaw_id);
        const lang = ownerLang();
        if (!target) {
          return {
            type: 'text' as const,
            text: renderCopy(lang, 'bond.proposal.notFound', {
              who: displayNamed(p.popclaw_id, rt.nameOf),
            }),
          };
        }
        const decisionMap: Record<'accept' | 'reject' | 'defer', 'accepted' | 'rejected' | 'deferred'> = {
          accept: 'accepted',
          reject: 'rejected',
          defer: 'deferred',
        };
        rt.proposalsStore.decide(target.id, decisionMap[p.decision]);
        if (p.decision === 'accept') {
          rt.bondsStore.setTier(target.popclawId, target.toTier, 'manual');
          return {
            type: 'text' as const,
            text: renderCopy(lang, 'bond.proposal.accepted', {
              who: displayNamed(target.popclawId, rt.nameOf),
              tier: tierLabel(target.toTier, lang),
            }),
          };
        }
        if (p.decision === 'reject') {
          return {
            type: 'text' as const,
            text: renderCopy(lang, 'bond.proposal.rejected', { tier: tierLabel(target.fromTier, lang) }),
          };
        }
        return { type: 'text' as const, text: renderCopy(lang, 'bond.proposal.deferred') };
      } catch (err) {
        return { type: 'text' as const, text: failureText('popclaw_decide_bond_tier_proposal', err) };
      }
    },
  });

  // popclaw_update_cadence's empty shell was removed by ADR-0044 ①; S1 already gave it a
  // real implementation (primary_language / timezone), registered further down in this
  // file — don't add another one up here.
  api.registerTool({
    name: 'popclaw_mute_notices',
    description:
      'Silence the settling-in nudge — call this when the owner says something like ' +
      "\"drop it\" or \"stop reminding me\". scope='all' silences every nudge for good (maps to muted:[\"*\"]); " +
      "a specific gap key (e.g. 'no_follows') silences just that one.",
    parameters: MuteNoticesSchema,
    execute: async (_callId: string, params: unknown) => {
      const { scope } = params as { scope: string };
      try {
        const rt = (await runtime()) as { host: HostAdapter };
        await muteNudge(rt.host, scope);
        return {
          type: 'text' as const,
          text: renderCopy(ownerLang(), scope === 'all' ? 'bond.mute.all' : 'bond.mute.one'),
        };
      } catch (err) {
        return { type: 'text' as const, text: failureText('popclaw_mute_notices', err) };
      }
    },
  });

}
