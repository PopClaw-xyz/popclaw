/**
 * Three refusals, three different things to tell the owner.
 *
 * The reference house that exposed this declares NO `read_auth` block at all
 * and DOES declare a `house_session` board. The resolver refused it correctly,
 * by name — and then the owner was shown "the read authentication scheme it
 * currently uses is not supported", which sends them to check the house's
 * version when the actual next step is to log in to that house.
 *
 * The code that refuses is not what changed. What changed is that the sentence
 * now reads the one extra fact the verified declaration already carried:
 * whether the house has a login session lane. Same refusal, same wire, a true
 * sentence instead of a borrowed one.
 */
import { describe, expect, it } from 'vitest';
import { readAuthRefusalMessage } from '../../../src/identity/read-authority.js';
import { LANGS } from '../../../src/lexicon/index.js';

const ORIGIN = 'http://127.0.0.1:8113';

/** The house has a `house_session` board in the manifest its pin verified. */
const SESSION_LANE = true;
/** It has neither that nor a read scheme — it offers no identity read at all. */
const NOTHING = false;

describe('what a read refusal tells the owner', () => {
  it('sends a session-only house to the login it actually needs', () => {
    const line = readAuthRefusalMessage('READ_AUTH_NOT_DECLARED', ORIGIN, 'en', SESSION_LANE);

    expect(line).toContain('login session');
    expect(line).toContain('/popclaw login');
    // The sentence this replaced. It was not a smaller version of the truth —
    // it named a scheme the house never claimed to have.
    expect(line).not.toContain('is not supported');
  });

  it('says a house that declared nothing at all offers no identity read', () => {
    const line = readAuthRefusalMessage('READ_AUTH_NOT_DECLARED', ORIGIN, 'en', NOTHING);

    expect(line).toContain('no way to read');
    // Nothing to log in to, so pointing at a login would be the same wrong
    // instruction in the other direction.
    expect(line).not.toContain('/popclaw login');
    expect(line).not.toContain('is not supported');
  });

  it('keeps "this build does not speak that scheme" for the house that named one', () => {
    const line = readAuthRefusalMessage('READ_AUTH_SCHEME_UNSUPPORTED', ORIGIN, 'en', NOTHING);

    expect(line).toContain('The read authentication scheme');
    expect(line).toContain('is not supported');
  });

  it('keeps the untrusted sentence, session board or not', () => {
    // A blocked or missing pin is answered before any declaration is read, so
    // a session board cannot soften it — and must not.
    for (const lane of [SESSION_LANE, NOTHING]) {
      expect(readAuthRefusalMessage('READ_AUTH_HOUSE_NOT_TRUSTED', ORIGIN, 'en', lane)).toContain(
        'has no verified binding on this machine',
      );
    }
  });

  it('gives three distinct sentences in every language', () => {
    // The whole defect was two states sharing one sentence. A lane that
    // translates only two of the three would reintroduce it quietly.
    for (const lang of LANGS) {
      const sentences = [
        readAuthRefusalMessage('READ_AUTH_NOT_DECLARED', ORIGIN, lang, SESSION_LANE),
        readAuthRefusalMessage('READ_AUTH_NOT_DECLARED', ORIGIN, lang, NOTHING),
        readAuthRefusalMessage('READ_AUTH_SCHEME_UNSUPPORTED', ORIGIN, lang, NOTHING),
      ];
      expect(new Set(sentences).size, `${lang}: three states must not share a sentence`).toBe(3);
      for (const s of sentences) expect(s, `${lang}`).toContain(ORIGIN);
    }
  });

  it('names the session lane only when the house declared one', () => {
    // The guard, stated directly: the discrimination is `session_board`, not
    // the refusal code. A message function that ignores it passes every test
    // above except this one and the first two.
    for (const lang of LANGS) {
      expect(
        readAuthRefusalMessage('READ_AUTH_NOT_DECLARED', ORIGIN, lang, SESSION_LANE),
      ).not.toBe(readAuthRefusalMessage('READ_AUTH_NOT_DECLARED', ORIGIN, lang, NOTHING));
    }
  });
});
