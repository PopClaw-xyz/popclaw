/** Complete local collection → immutable candidate ledger → bounded reading pages. */
import { retainPublicMaterialBasis, publicCoverageText } from './public-material-source.js';
import { buildCandidatePage, candidateOrder } from './build-candidate-page.js';
import { pageBudgetDecision, pageBudgetLogLine, pageBudgetNow } from './host-budget.js';
import type { IssueData } from './issue.js';
import { putIssue } from './issue-store.js';
import { beginReading, previewReading } from './reading-page.js';
import type { NewspaperStyle } from './newspaper-style.js';
import { ownerLangTag } from '../lexicon/owner-language.js';
import { collectNewspaperMaterials, type MaterialSources } from './collect-materials.js';
import { weightedChars } from './reading-weight.js';
export { weightedChars } from './reading-weight.js';

export type { NewspaperBond } from './collect-materials.js';
export const PICK_FLOOR = 15;
export const PICK_SUGGESTED_MIN = 20;
export const PICK_SUGGESTED_MAX = 40;
/** Retained exports for existing assemblies; neither is an enforced content ceiling. */
export const PICK_RUNAWAY = Number.POSITIVE_INFINITY;
export const PER_AUTHOR_MAX = Number.POSITIVE_INFINITY;

export interface GatherDeps extends MaterialSources {
  validateMaterials?: (issue: IssueData) => void;
  readContentRules: () => string;
  readStyle?: () => NewspaperStyle;
  tasteText?: string;
  bondLines?: readonly string[];
  manifestDir?: string;
  sessionKey?: string;
  log?: (m: string) => void;
}

export type GatherResult =
  | { kind: 'empty'; message: string }
  | { kind: 'candidates'; payload: string; candidateToken: string };

export function gatherNewspaperMaterials(deps: GatherDeps, opts: { hours?: number } = {}): GatherResult {
  const collected = collectNewspaperMaterials(deps, opts);
  const coverage = deps.publicBatch ? publicCoverageText(deps.publicBatch.coverage) : '';
  if (collected.kind === 'empty') return coverage ? { ...collected, message: coverage } : collected;
  const { candidateToken, lang, draft } = collected;
  let stored: IssueData = { ...draft, language: deps.language ?? ownerLangTag(), pulse: candidateOrder(draft.pulse, lang) };
  if (deps.publicBatch) stored = retainPublicMaterialBasis({ ...stored, publicCoverage: deps.publicBatch.coverage }, deps.publicBatch.references);
  const page = buildCandidatePage(stored, {
    tasteText: deps.tasteText ?? '', bondLines: deps.bondLines ?? [], publishToken: candidateToken,
    suggestMin: PICK_SUGGESTED_MIN, suggestMax: PICK_SUGGESTED_MAX, floor: PICK_FLOOR,
    perAuthorMax: PER_AUTHOR_MAX, budget: pageBudgetNow(deps.sessionKey), dayTotal: draft.totalCount,
    overBudget: false, sessionKey: deps.sessionKey,
  });
  const text = coverage ? `${coverage}\n\n${page}` : page;
  deps.log?.(pageBudgetLogLine('candidate', pageBudgetDecision(deps.sessionKey), weightedChars(previewReading(candidateToken, text, deps)), 0, stored.pulse.length));
  stored = { ...stored, language: deps.language ?? ownerLangTag() };
  deps.validateMaterials?.(stored);
  // Number once and persist everything before returning any part of it.
  putIssue(candidateToken, stored, deps.manifestDir, deps.sessionKey);
  const payload = beginReading(candidateToken, text, deps);
  return { kind: 'candidates', payload, candidateToken };
}
