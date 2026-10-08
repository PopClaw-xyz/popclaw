/**
 * One person, one address.
 *
 * `profileUrl` calls itself the single source of truth for every plugin-side
 * profile link (ADR-0032: the sigil is a PATH segment, so the link previews and
 * the server can disambiguate). Status, the MCP surface, the onboarding
 * briefing and the newspaper all went through it — and the namecard did not:
 * passport-renderer hand-built `popclaw.me/<handle>#<sigil>`, a fragment form
 * that never reaches a server, and ignored the configured web base entirely.
 * The owner was handed two different links for the same person.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { runStatusCommand } from '../../../src/commands/status.js';
import { runProfileCommand } from '../../../src/commands/profile.js';
import bs58 from 'bs58';
import { deriveSigil } from '../../../src/invite/sigil.js';
import { ownerLang, setOwnerLang } from '../../../src/lexicon/owner-language.js';
import { renderCopy } from '../../../src/lexicon/index.js';

beforeAll(() => setOwnerLang('en', 'config'));

// A real base58 popclaw_id: the by-id lane only accepts that shape.
const ID = bs58.encode(new Uint8Array(32).fill(7));
const STRANGER_ID = bs58.encode(new Uint8Array(32).fill(9));
const SIGIL = deriveSigil(ID);
const NAME = 'blackfeather_ai';

/** The profile address printed in a rendered surface, whatever else is on the line. */
function address(text: string, sigil: string = SIGIL): string {
  const hits = [...text.matchAll(/\b[a-z0-9.:-]+\/[^\s]*\/[^\s]+/g)]
    // Trailing sentence punctuation is not part of the address.
    .map((m) => m[0].replace(/[).,;:）。，]+$/, ''))
    .filter((u) => u.includes(sigil));
  expect(hits).toHaveLength(1);
  return hits[0]!;
}

function statusText(webBaseUrl: string, body: unknown, nickname = NAME): Promise<string> {
  const lines: string[] = [];
  return runStatusCommand({
    signer: { popclawId: vi.fn().mockResolvedValue(ID) },
    host: {},
    loreHouseUrl: 'http://lh.example',
    logger: { info: (msg: string) => lines.push(msg) },
    webBaseUrl,
    nickname,
    fetch: vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(body),
    }),
    lang: 'en' as const,
  } as never).then(() => lines.join('\n'));
}

function namecardText(webBaseUrl: string, body: unknown, target = `${NAME}#${SIGIL}`): Promise<string> {
  return runProfileCommand(
    { target },
    {
      loreHouseUrl: 'http://lh.example',
      webBaseUrl,
      fetch: vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => body,
        text: async () => JSON.stringify(body),
      }) as never,
    },
  ).then((r) => r.text);
}

const HOUSE_BODY = {
  popclaw_id: ID,
  sigil: SIGIL,
  house_follower_count: 3,
  profiles: [],
  card: { nickname: NAME },
};

describe('one address for one person', () => {
  it('status and the namecard print the identical profile URL', async () => {
    const status = await statusText('https://popclaw.me', { ...HOUSE_BODY, house_follower_count: 3 });
    const namecard = await namecardText('https://popclaw.me', HOUSE_BODY);

    expect(address(namecard)).toBe(address(status));
    expect(address(status)).toBe(`popclaw.me/${NAME}/${SIGIL}`);
  });

  // The `#` form is what the namecard used to build by hand. A fragment never
  // reaches the server: no link preview, no server-side disambiguation.
  it('never shows the sigil as a URL fragment', async () => {
    const namecard = await namecardText('https://popclaw.me', HOUSE_BODY);
    expect(namecard).not.toContain(`popclaw.me/${NAME}#`);
    // The human-facing form `name#sigil` is a different thing and stays.
    expect(namecard).toContain(`@${NAME}#${SIGIL}`);
  });

  // The hand-built string ignored config.web_base_url outright, so a machine
  // pointed at its own web app still told the owner to go to popclaw.me.
  it('both honour the configured web base', async () => {
    const base = 'http://localhost:8788';
    const status = await statusText(base, HOUSE_BODY);
    const namecard = await namecardText(base, HOUSE_BODY);

    expect(address(status)).toBe(`localhost:8788/${NAME}/${SIGIL}`);
    expect(address(namecard)).toBe(address(status));
  });
});

/**
 * The third builder, found while unifying the other two: the rename
 * confirmation spelled the owner's address out inside the locale string, `#`
 * fragment and hardcoded host included. Renaming is exactly the moment the
 * owner is handed their address to share.
 */
describe('the rename confirmation prints the same address', () => {
  it('uses the path form and the configured base', async () => {
    const { InMemoryHostAdapter } = await import('../../../src/host/host-adapter.in-memory.js');
    const { runPopclawNameCommand } = await import('../../../src/commands/popclaw-name.js');
    // A base58-decodable id: the rename really signs an envelope.
    const id = 'aaaaaa11bbbbbb22';
    const sigil = deriveSigil(id);
    const host = new InMemoryHostAdapter();
    let card: Record<string, unknown> | undefined;
    const {popclaw} = await import('../../../src/protocol/public-envelope-generated.js');
    const r = await runPopclawNameCommand(
      { nickname: NAME },
      {
        host,
        signer: {
          publicKey: async () => new Uint8Array(32),
          sign: async () => new Uint8Array(64),
          popclawId: async () => id,
        },
        egress: { push: async (bytes: Uint8Array) => {
          const profile = popclaw.event.EventEnvelope.decode(popclaw.identity.SignedPayload.decode(bytes).payload!).profile!;
          card = {nickname: profile.nickname, one_line_intro: profile.oneLineIntro ?? '',
            declared_at_ms: Number(profile.declaredAt) * 1000, taste_tags: [], role_persona: '',
            location_hint: '', avatar_uri: '', payout_addresses: []};
          return {status: 200};
        } },
        popclawId: id,
        clock: { now: () => new Date('2026-06-15T00:00:00Z') },
        houseOrigins: ['https://house.example'],
        fetch: async () => new Response(JSON.stringify({popclaw_id: id, sigil, profiles: [],
          house_follower_count: 0, house_post_count: 0, house_reply_received_count: 0, ...(card ? {card} : {})})),
        webBaseUrl: 'http://localhost:8788',
      } as never,
    );
    expect(r.details.public.status).toBe('confirmed');
    expect(address(r.text, sigil)).toBe(`localhost:8788/${NAME}/${sigil}`);
    expect(r.text).not.toContain(`popclaw.me/${NAME}#${sigil}`);
  });
});

/**
 * The name slot on the namecard.
 *
 * `popclaw_show_namecard` resolves the person first and then asks the by-id
 * endpoint, so the raw popclaw_id was what landed in `handle` — and nothing on
 * the by-id path ever replaced it, while the real name sat unread in the
 * response. The owner got `popclaw  @Apopqk1PAQ…#py79g0k3`, a 32-character
 * base58 string where a name belongs, and the same id inside their address.
 */
describe('the namecard shows a name, not a base58 id', () => {
  const BY_ID_BODY = {
    popclaw_id: ID,
    sigil: SIGIL,
    profiles: [{ platform: 'popclaw', handle: NAME, verified_at: '2026-05-01T00:00:00Z' }],
    card: { nickname: 'Blackfeather' },
  };

  it('uses the popclaw-native handle the house returned', async () => {
    const text = await namecardText('https://popclaw.me', BY_ID_BODY, ID);
    expect(text).toContain(`@${NAME}#${SIGIL}`);
    expect(text).not.toContain(`@${ID}#`);
    expect(address(text)).toBe(`popclaw.me/${NAME}/${SIGIL}`);
  });

  it('falls back to the namecard nickname when there is no native handle', async () => {
    const text = await namecardText(
      'https://popclaw.me',
      { ...BY_ID_BODY, profiles: [] },
      ID,
    );
    expect(text).toContain(`@Blackfeather#${SIGIL}`);
    expect(text).not.toContain(`@${ID}#`);
  });

  // Control group: with neither, there is genuinely no name to show, and the
  // id stays in the address because it is the only thing that addresses them.
  it('keeps the id when the house knows no name at all', async () => {
    const text = await namecardText(
      'https://popclaw.me',
      { ...BY_ID_BODY, profiles: [], card: null },
      ID,
    );
    expect(address(text)).toBe(`popclaw.me/${ID}/${SIGIL}`);
  });

  // The name the owner typed is not second-guessed.
  it('leaves the handle#sigil path alone', async () => {
    const text = await namecardText('https://popclaw.me', BY_ID_BODY, `typed_name#${SIGIL}`);
    expect(text).toContain(`@typed_name#${SIGIL}`);
  });
});

/**
 * The owner's own namecard on a fresh identity.
 *
 * A brand-new install is auto-named `ranger-xxxxxx`, and announce-namecard
 * deliberately publishes nothing for a placeholder name — so no house has a
 * profile_cards row for it, and the by-id read comes back 404, or 200 with an
 * empty body. For a stranger that is "no idea who that is". For the owner it is
 * the normal state of a machine that just booted, and the identity is sitting
 * right here: the card renders from it, at the same address status prints.
 */
describe("the owner's own namecard, never published to any house", () => {
  const PLACEHOLDER = 'ranger-Apopqk';
  const self = { popclawId: ID, nickname: PLACEHOLDER };

  function selfCard(houseAnswer: { status: number; body?: string }): Promise<string> {
    return runProfileCommand(
      { target: ID },
      {
        loreHouseUrl: 'http://lh.example',
        webBaseUrl: 'https://popclaw.me',
        self,
        fetch: vi.fn().mockResolvedValue({
          ok: houseAnswer.status >= 200 && houseAnswer.status < 300,
          status: houseAnswer.status,
          text: async () => houseAnswer.body ?? '',
          json: async () => JSON.parse(houseAnswer.body ?? ''),
        }) as never,
      },
    ).then((r) => r.text);
  }

  it('renders the owner at the address status prints, on a 200 with an empty body', async () => {
    const card = await selfCard({ status: 200, body: '' });
    // The same identity, seen by status: the placeholder name it was booted with.
    const status = await statusText('https://popclaw.me', {}, PLACEHOLDER);

    expect(card).toContain(`@${PLACEHOLDER}#${SIGIL}`);
    expect(address(card)).toBe(address(status));
  });

  it('renders the same card when the house answers 404', async () => {
    const card = await selfCard({ status: 404 });
    expect(card).toContain(`@${PLACEHOLDER}#${SIGIL}`);
    expect(address(card)).toBe(`popclaw.me/${PLACEHOLDER}/${SIGIL}`);
  });

  // Control group: a stranger the house has never heard of is still honestly
  // reported as unknown — the local fallback is for the owner only.
  it('still says it does not know a stranger', async () => {
    const text = await runProfileCommand(
      { target: STRANGER_ID },
      {
        loreHouseUrl: 'http://lh.example',
        webBaseUrl: 'https://popclaw.me',
        self,
        fetch: vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => '', json: async () => ({}) }) as never,
      },
    ).then((r) => r.text);
    expect(text).not.toContain(PLACEHOLDER);
    expect(text).toContain(renderCopy(ownerLang(), 'profile.notFound', { handle: STRANGER_ID, sigil: '' }));
  });
});

/**
 * A house that answers 200 with something that is not JSON at all — a captive
 * portal's `<html>…`, a proxy error page. `JSON.parse` threw a raw SyntaxError,
 * and `popclaw_show_namecard` registers without a wrapper, so that exception
 * text WAS the tool result.
 */
describe('a 200 that is not JSON', () => {
  function garbageFetch(): unknown {
    return vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => '<html>captive portal</html>',
      json: async () => JSON.parse('<html>'),
    });
  }

  it('answers with the lexicon line instead of a SyntaxError', async () => {
    const out = await runProfileCommand(
      { target: ID },
      { loreHouseUrl: 'http://lh.example', webBaseUrl: 'https://popclaw.me', fetch: garbageFetch() as never },
    );
    expect(out.text).toBe(renderCopy(ownerLang(), 'profile.notFound', { handle: ID, sigil: '' }));
    expect(out.text).not.toMatch(/SyntaxError|Unexpected token|is not valid JSON/);
  });

  it('renders the owner’s own card rather than denying them', async () => {
    const out = await runProfileCommand(
      { target: ID },
      {
        loreHouseUrl: 'http://lh.example',
        webBaseUrl: 'https://popclaw.me',
        self: { popclawId: ID, nickname: 'ranger-Apopqk' },
        fetch: garbageFetch() as never,
      },
    );
    expect(out.text).toContain(`@ranger-Apopqk#${SIGIL}`);
    expect(out.text).not.toMatch(/SyntaxError|Unexpected token/);
  });
});

// A JSON ARRAY is valid JSON and passes `typeof === 'object'`, but it is not a
// person either — reading `.popclaw_id` off it renders a card full of blanks.
describe('a 200 whose body is a JSON array', () => {
  it('is treated exactly like an empty body', async () => {
    const arrayFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => '[{"popclaw_id":"x"}]',
      json: async () => [{ popclaw_id: 'x' }],
    });
    const out = await runProfileCommand(
      { target: ID },
      { loreHouseUrl: 'http://lh.example', webBaseUrl: 'https://popclaw.me', fetch: arrayFetch as never },
    );
    expect(out.text).toBe(renderCopy(ownerLang(), 'profile.notFound', { handle: ID, sigil: '' }));
  });
});
