/**
 * Which parameter keys one world action is ALLOWED TO HAVE, read from the
 * house's own declaration of that action — and nothing else.
 *
 * ## Why this exists
 *
 * The owner-approval dialog draws one `key: value` row per parameter, under
 * two frame rows it draws itself (`house:` and `action:`). Review demonstrated
 * (PROBE-8c) that a parameter key of `" house"` — a leading SPACE — sorts
 * first and paints a row an owner cannot reliably tell apart from the genuine
 * `house:` row, with a value the model wrote. The owner then approves against
 * a line the model authored. That is not a permissions bug: the consent is
 * genuine, so nothing downstream can detect it. It is the same family as the
 * newline injection one commit earlier.
 *
 * A plain space cannot join the invisible-character class — values need
 * spaces. The previous round therefore left this open, reasoning that bounding
 * key SHAPE is a house-contract question. That reasoning is half right: the
 * house contract must not change, and it does not need to. **We simply must
 * not display something we were never told exists.**
 *
 * ## The two rules that are the whole point
 *
 *  1. DECLARED MEANS DECLARED BY THE ACTION'S SCHEMA — the `params_schema` the
 *     house published in its manifest and this install verified — NEVER
 *     derived from the call's own parameters. Taking the permitted set from
 *     the parameters is circular and closes nothing.
 *  2. COMPARISON IS EXACT CODE-POINT EQUALITY. No trim, no case fold, no
 *     Unicode normalization, no "helpful" tidy-up of any kind. Folding is
 *     precisely what turns `" house"` back into `house` and then renders it.
 *     There is a mutation pinned to each of these two.
 *
 * A key that cannot be reached is a key that cannot be rendered: the schema
 * profile bounds every DECLARED property name to
 * `^[A-Za-z_][A-Za-z0-9_]{0,63}$` (`protocol/.../schema-profile.schema.json`),
 * so a name carrying a space is not expressible as a declaration at all. The
 * hole was never that a house could declare one — it is that a house's schema
 * need not say `additionalProperties: false`, so an UNDECLARED key rode
 * through schema validation and into the dialog.
 *
 * ## An unknown schema is not an empty constraint
 *
 * If the declared set cannot be determined, this refuses by name rather than
 * falling back to rendering everything. Rendering what we could not check is
 * the hole restated with an extra step.
 *
 * Both the display and the execution path call this, with the SAME names, so
 * "what the owner saw" and "what ran" cannot disagree about it.
 */

/** A parameter key this action's schema does not declare. */
export const WORLD_ACTION_PARAM_UNDECLARED = 'WORLD_ACTION_PARAM_UNDECLARED';
/** The declared set could not be determined, so nothing may be shown or sent. */
export const WORLD_ACTION_SCHEMA_UNAVAILABLE = 'WORLD_ACTION_SCHEMA_UNAVAILABLE';

/** The profile's own visit bound (`validateProfileGrammar`, json-profile.ts:167). */
const MAX_DEPTH = 16;
const REF = /^#\/\$defs\/([A-Za-z_][A-Za-z0-9_]{0,63})$/;

function plain(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

/**
 * Every property name this schema declares for the parameters object ITSELF,
 * or `null` when that cannot be determined.
 *
 * Root-level composition only: `allOf` / `anyOf` / `oneOf` branches and
 * `$ref`s into the root `$defs` describe the same object, so their property
 * names are declarations of the same keys. `items` and the schemas UNDER
 * `properties` describe values, not top-level keys, and are deliberately not
 * descended into — a nested object's field named `house` does not make
 * `house` a legal top-level parameter.
 *
 * A schema that declares no property at all yields an EMPTY set, not `null`:
 * a house that named no parameter has told us about no parameter, and every
 * key is then undeclared. That is a determinable answer, and the refusal it
 * produces says so.
 */
export function declaredParameterKeys(schema: unknown): ReadonlySet<string> | null {
  const root = plain(schema);
  if (!root) return null;
  const defs = plain(root['$defs']) ?? {};
  const keys = new Set<string>();
  return collect(root, defs, keys, 0) ? keys : null;
}

function collect(node: Record<string, unknown>, defs: Record<string, unknown>,
  keys: Set<string>, depth: number): boolean {
  if (depth > MAX_DEPTH) return false;
  if (node['$ref'] !== undefined) {
    const ref = node['$ref'];
    if (typeof ref !== 'string') return false;
    const name = REF.exec(ref)?.[1];
    const target = name === undefined ? null : plain(defs[name]);
    if (!target || !collect(target, defs, keys, depth + 1)) return false;
  }
  if (node['properties'] !== undefined) {
    const properties = plain(node['properties']);
    if (!properties) return false;
    // VERBATIM. `Object.keys` gives the declared names exactly as the house
    // wrote them; anything applied here would be applied to one side of the
    // comparison only, which is how a fold reintroduces the hole.
    for (const key of Object.keys(properties)) keys.add(key);
  }
  for (const word of ['allOf', 'anyOf', 'oneOf'] as const) {
    const branches = node[word];
    if (branches === undefined) continue;
    if (!Array.isArray(branches)) return false;
    for (const branch of branches) {
      const child = plain(branch);
      if (!child || !collect(child, defs, keys, depth + 1)) return false;
    }
  }
  return true;
}

/**
 * The named refusal this call earns, or `null` when every key it carries was
 * declared. The only comparison is `Set.has` on the raw key — exact code
 * points, both sides untouched.
 */
export function actionParameterRefusal(schema: unknown, params: unknown): string | null {
  const declared = declaredParameterKeys(schema);
  if (!declared) return WORLD_ACTION_SCHEMA_UNAVAILABLE;
  const carried = plain(params);
  if (!carried) return WORLD_ACTION_SCHEMA_UNAVAILABLE;
  for (const key of Object.keys(carried)) if (!declared.has(key)) return WORLD_ACTION_PARAM_UNDECLARED;
  return null;
}
