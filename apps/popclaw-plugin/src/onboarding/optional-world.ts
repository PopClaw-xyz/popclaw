import { renderCopy, type Lang } from '../lexicon/index.js';
/** Recommendation only. Owner selection uses the ordinary House join tool. */
export function optionalWorldOffer(lang: Lang): string {
  return renderCopy(lang, 'onboarding.optionalWorld');
}
