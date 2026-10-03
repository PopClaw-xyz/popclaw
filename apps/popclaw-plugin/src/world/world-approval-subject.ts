/**
 * What one `popclaw_world_invoke` call means to the person who owns this
 * install — the first registrant of the owner-approval seam.
 *
 * It declares two things and nothing else: the bytes an approval binds, and
 * the text the owner reads. It holds no state, reserves nothing, sends
 * nothing, and is not a permission source: the seam decides whether to ask,
 * the host decides who may answer, and the answer becomes a grant elsewhere.
 *
 * The description carries the action's parameters VERBATIM, because the whole
 * claim of this dialog is that what the owner read is what gets signed. 0.1.0
 * renders no parameter by meaning: the owner approves the bytes, not an
 * interpretation of them.
 */
import { cidFromCanonical } from '@popclaw/algorithms';
import { captureWorldCommandInput } from '../commands/popclaw-world.js';
import { canonicalActionJson } from './action-receipt-journal.js';
import { NATIVE_APPROVAL_DISPLAY_BUDGET, hasInvisibleCharacter } from '../host/owner-approval.js';
import { actionParameterRefusal } from './action-declared-parameters.js';
import type { ApprovalSubject, ApprovalSubjectResult, OwnerApprovalSubjectDescriptor } from '../host/owner-approval.js';

/** The one tool this subject speaks for. */
export const WORLD_INVOKE_TOOL = 'popclaw_world_invoke';
/** `canonicalize` must be total, so a call the invoke schema rejects still has
 *  to produce a string. This one can never collide with a real canonical form:
 *  that always starts with `{`, and a leading NUL is not producible by it.
 *  Every malformed call therefore shares one subject, which is harmless
 *  because `describe` refuses them all and nothing is ever granted. */
const UNCAPTURABLE: ApprovalSubject = '\u0000WORLD_ACTION_UNCAPTURABLE';
/** Named so the tool body can say WHICH refusal it was, rather than inferring
 *  it from a missing approval. */
export const WORLD_SUBJECT_UNCAPTURABLE = 'WORLD_ACTION_INPUT_INVALID';
/** A value or a parameter key carries a character the owner cannot see.
 *
 *  BELT AND BRACES, and the belt is the array shape: the seam joins rows
 *  itself and screens each row, so a `\n` inside a value can no longer become
 *  a row at all. This check is the braces — it screens the RAW values and keys
 *  before they are composed, so a malformed value is refused HERE, by a name
 *  that says it was the action's own content, instead of surfacing as the
 *  seam's generic `APPROVAL_PROMPT_UNPRINTABLE` and leaving a reader to guess
 *  whether the frame or the payload was at fault.
 *
 *  Why a refusal and not an escape: an escaped value is no longer the value,
 *  and the whole claim of this dialog is that what the owner read is what gets
 *  signed. A house that needs multi-line values needs a dialog design, not a
 *  rendering trick. */
export const WORLD_SUBJECT_UNPRINTABLE = 'WORLD_ACTION_VALUE_UNPRINTABLE';
/**
 * The house's own `params_schema` for one action kind, or `null`/`undefined`
 * when this process cannot reach it.
 *
 * It is a LOOKUP, not a value, because `describe` runs in a `before_tool_call`
 * hook: whether a verified capability view exists at that moment is a fact
 * about the process, not about the call. It must not boot anything (ADR-0035)
 * and must not throw; an answer it cannot give is `null`, which refuses.
 *
 * NEVER derive this from the call's own parameters. Taking the permitted set
 * from the parameters is circular and closes nothing — there is a mutation
 * pinned to exactly that.
 */
export type DeclaredActionParameters = (house: string, kind: string) => unknown | Promise<unknown>;
/** Internal trusted lookup capture, not a wire schema or model-supplied object.
 * Each description owns its check; concurrent calls never share a last lookup. */
export class CapturedWorldActionParameters {
  constructor(readonly schema: unknown, readonly beforeAsk: () => string | null) {}
}
/**
 * THE ONE THING A PARAMETER ROW CARRIES THAT A FRAME ROW NEVER DOES.
 *
 * Filtering keys is necessary and not sufficient. `params` is an open object,
 * so a key named EXACTLY `house` — no leading space, nothing invisible,
 * nothing undeclared-looking if a house declares it — used to produce a row
 * byte-identical in shape to the frame's own `house:` line, carrying whatever
 * the model wrote. The frame row is emitted first, so the truth was not
 * replaced but CONTRADICTED, and the owner had no way to tell which line was
 * ours. Frame rows and parameter rows shared one `key: value` namespace, and
 * no key rule can separate two things that live in the same namespace.
 *
 * So the namespaces are separated instead. Every parameter row is prefixed
 * HERE, by this module, and the prefix is a constant: it is never read from
 * the key, never read from the value, and never conditional. A parameter
 * cannot produce a second row at all (the seam owns the join and screens every
 * line separator), so a parameter can only ever produce ONE line, and that
 * line always begins with this. No frame row ever does.
 *
 * `"> "` rather than a new invention: the peer team's dialog already reads
 * header lines from its own lexicon frame and prefixes every body line this
 * way. One convention across both dialogs is worth more than a prettier one
 * here.
 */
export const WORLD_PARAMETER_ROW_PREFIX = '> ';
/** Enough of the action's own digest that a person can match the prompt they
 *  approved to the receipt they read afterwards. It is a CORRELATION
 *  reference, never a substitute for reading the values above it, and it is
 *  derived rather than stored so both halves compute the same one with no
 *  state between them. */
const REFERENCE_CHARS = 6;

export function worldApprovalReference(subject: ApprovalSubject): string {
  return cidFromCanonical(new TextEncoder().encode(subject)).slice(0, REFERENCE_CHARS);
}

/** A string as the owner would read it; anything else in the canonical JSON
 *  the signature covers. */
function parameterValue(value: unknown): string {
  return typeof value === 'string' ? value : canonicalActionJson(value);
}

/**
 * The registrant, bound to one source of the house's declarations.
 *
 * A factory rather than a constant because the declared parameter keys are
 * not knowable at `register()` time — they live in a verified capability view
 * the gateway only has once its runtime is up. The wiring hands in the lookup;
 * this module never reaches for a runtime itself.
 */
export function createWorldInvokeApprovalSubject(
  declaredParameters: DeclaredActionParameters,
): OwnerApprovalSubjectDescriptor {
  return {
  /** This dialog is bounded by the seam's screen, not by its own composition
   *  (see `describe`), so it pins the native 496/32 budget it was measured
   *  against. Registered on an MCP root it keeps that budget and never
   *  inherits the MCP full-text one. */
  displayBudget: NATIVE_APPROVAL_DISPLAY_BUDGET,
  /** Total by contract: it is called again when the tool body consumes the
   *  answer, and a throw there would turn a granted approval into a crash
   *  instead of a refusal. Validated with the TOOL'S OWN capture, so what the
   *  owner is shown is exactly what the tool will accept. */
  canonicalize(params: unknown): ApprovalSubject {
    try { return canonicalActionJson(captureWorldCommandInput('invoke', params)); }
    catch { return UNCAPTURABLE; }
  },
  /** Pure: it reads `params` and returns text. The house, the action kind, the
   *  four parameter values whole, and one sentence saying what approving does.
   *  Nothing is shortened — an action too long for the host's prompt is
   *  refused by the seam's budget check, never truncated.
   *
   *  NAMED DEBT — THIS OWNER-FACING ENGLISH IS NOT IN THE LEXICON, and by the
   *  public-repo rule it should be, in both locales. Recorded rather than
   *  moved this round, with the reasons, so the next person decides rather
   *  than rediscovers:
   *
   *   1. The lexicon lanes (`src/lexicon/en.ts`, `src/lexicon/zh-CN.ts`) are a
   *      shared cross-module surface outside this branch's write scope, and
   *      this branch is a frozen baseline another team has already branched
   *      from. Adding keys there from here puts a conflict on a file several
   *      threads append to, for a change no reviewer classed as blocking.
   *   2. The budget arithmetic is per-locale and nobody has done the second
   *      one. The worst legal check-in measures 431 code points against the
   *      496 this module allows itself, and that 65-point headroom is pinned
   *      in a test — measured for THIS frame, in English. Translate the frame
   *      and the number changes; a check-in that fits in one language could be
   *      refused in the other with nothing pinned to catch it. Moving the copy
   *      therefore owes a second measurement and a second pinned worst case,
   *      which is a piece of work, not a rename.
   *
   *  The fix, when it is taken: four keys in both lanes (title, the `house:`
   *  row, the `action:` row, the consequence sentence), `renderCopy(ownerLang(),
   *  …)` as `src/world/world-capabilities.ts` already does it, and a
   *  worst-legal-check-in test pinned per locale. Parameter KEYS are not
   *  copy — they come from the house's own schema and must stay verbatim.
   *  Precedent, offered as context and not as a justification: the MCP dialog
   *  (`src/host/mcp-owner-authorization.ts`) hardcodes the same class of
   *  English today, so this is not a new violation class. */
  async describe(params: unknown): Promise<ApprovalSubjectResult> {
    let input;
    try { input = captureWorldCommandInput('invoke', params); }
    catch { return { kind: 'refuse', reason: WORLD_SUBJECT_UNCAPTURABLE }; }
    // RENDER ONLY DECLARED KEYS. A row is drawn for a parameter the house
    // itself named, or no dialog is drawn at all. This is what closes the
    // confusable row (PROBE-8c): a key of `" house"` paints under the genuine
    // `house:` row, and the schema profile cannot express such a name as a
    // declaration, so it can never be declared and is always refused here.
    // The lookup is asked about THIS action's own kind at THIS house; it never
    // sees the parameters, which is what keeps the permitted set from being
    // read off the call it is meant to bound.
    let schema: unknown;
    try { schema = await declaredParameters(input.house, input.kind); }
    catch { schema = null; }
    const captured = schema instanceof CapturedWorldActionParameters ? schema : null;
    if (captured) schema = captured.schema;
    const undeclared = actionParameterRefusal(schema, input.params);
    if (undeclared) return { kind: 'refuse', reason: undeclared };
    const reference = worldApprovalReference(canonicalActionJson(input));
    // Every raw key and every raw value, screened against the SEAM'S OWN class
    // before anything is composed. The house and the kind go through it too:
    // they are no more trusted than a parameter, they just come from a
    // different part of the same model-supplied call.
    const keys = Object.keys(input.params).sort();
    const values = [input.house, input.kind, ...keys, ...keys.map(key => parameterValue(input.params[key]))];
    if (values.some(hasInvisibleCharacter)) return { kind: 'refuse', reason: WORLD_SUBJECT_UNPRINTABLE };
    return {
      kind: 'ask',
      ...(captured ? { beforeAsk: captured.beforeAsk } : {}),
      title: `PopClaw world action: ${input.kind}`,
      // ONE ROW PER ARRAY ELEMENT. The seam joins them and screens each one;
      // never pre-join here, and never put a separator inside an element.
      description: [
        // THE FRAME. These three lines come from here and nowhere else, and
        // none of them is prefixed — which is what makes the prefix below a
        // reliable signal rather than decoration.
        `house: ${input.house}`,
        `action: ${input.kind}`,
        ...keys.map(key => `${WORLD_PARAMETER_ROW_PREFIX}${key}: ${parameterValue(input.params[key])}`),
        `Approving publishes these exact values to that house, where they stay public. ref ${reference}`,
      ],
    };
  },
  };
}
