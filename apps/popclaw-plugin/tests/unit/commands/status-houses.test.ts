/**
 * Status says which houses are trusted, and why a read there was refused.
 *
 * Pinning now happens on its own, which is exactly why it has to be visible:
 * the owner never typed the command that created the trust, so nothing else
 * in their session would ever mention it — and "the follower list is empty"
 * looks identical whether nobody follows you or the house was never trusted.
 * The refusal wording is the resolver's own (`read.auth.*`), not a second
 * sentence written here that could drift away from what actually happened.
 */
import { describe, it, expect, vi } from 'vitest';
import { runStatusCommand } from '../../../src/commands/status.js';
import { LocalHostDb } from '../../../src/host/local-host-db.js';
import { runMigrations } from '../../../src/host/migrations.js';
import { establishTrust } from '../../../src/world/house-binding-pin.js';
import { READ_CREDENTIAL_SCHEME } from '../../../src/identity/read-credential.js';
import { declareReadAuth, manifestDeclaring, SESSION_BOARD } from '../../helpers/read-authority.js';
import { ensureHouseLifecycleSchema } from '../../../src/runtime/house-lifecycle/participation-store.js';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATIONS = resolve(dirname(fileURLToPath(import.meta.url)), '../../../migrations');
const ID = 'HafABCDEFGHIJKLMNOPqrstuvwxyz12';
const PINNED = 'https://home.example';
const UNPINNED = 'https://second.example';

// `false` (distinct from the default arg being merely omitted, which JS
// resolves the same as an explicit `undefined`) means "the house never
// declared anything at all" — no read_auth projection lands in the db.
function fixture(
  overrides: Record<string, unknown> = {},
  declares: readonly string[] | undefined | false = [READ_CREDENTIAL_SCHEME],
  /** Extra manifest blocks, e.g. the `house_session` board of a session-only house. */
  extraManifest: Record<string, unknown> = {},
) {
  const db = new LocalHostDb(':memory:');
  runMigrations(db, MIGRATIONS);
  establishTrust(db, { origin: PINNED, houseKey: 'house-key-one', incarnation: 'inc-1' }, 'configured', () => 1);
  if (declares !== false) {
    declareReadAuth(db, PINNED, 'house-key-one', manifestDeclaring(declares, extraManifest));
  } else if (Object.keys(extraManifest).length > 0) {
    // A house can declare a session board and no `read_auth` at all — the
    // reference server does exactly that, and it is the whole subject below.
    declareReadAuth(db, PINNED, 'house-key-one', manifestDeclaring(undefined, extraManifest));
  }
  const lines: string[] = [];
  const deps = {
    signer: { popclawId: vi.fn().mockResolvedValue(ID) } as never,
    host: { db, config: { loadJson: vi.fn().mockResolvedValue(null) } } as never,
    loreHouseUrl: PINNED,
    fetch: vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => '{}' }) as never,
    logger: { info: (msg: string) => lines.push(msg) },
    webBaseUrl: 'https://popclaw.me',
    nickname: 'blackfeather_ai',
    lang: 'en' as const,
    configuredHouses: [PINNED, UNPINNED],
    ...overrides,
  };
  return { db, deps, lines };
}

describe('status — the configured houses', () => {
  it('marks a trusted house and names the refusal for one that is not', async () => {
    const { db, deps, lines } = fixture();
    await runStatusCommand(deps as never);
    const text = lines.join('\n');

    expect(text).toContain('🏠 home.example ✅');
    expect(text).toContain('🏠 second.example ⚠️');
    // The resolver's own wording, so the reason cannot drift from the code
    // that refuses.
    expect(text).toContain(`${UNPINNED} has no verified binding on this machine`);
    expect(text).not.toContain(`${PINNED} has no verified binding`);
    db.close();
  });

  it('does not tick a house whose declared scheme is unsupported', async () => {
    // The pin is good, but the read decision for this house is still a
    // refusal — a ✅ directly above "reads … are refused there" told the
    // owner the opposite of what was true.
    const { db, deps, lines } = fixture({ configuredHouses: [PINNED] }, ['house-session-v2']);
    await runStatusCommand(deps as never);
    const text = lines.join('\n');

    expect(text).toContain('🏠 home.example ⚠️');
    expect(text).not.toContain('🏠 home.example ✅');
    expect(text).toContain('The read authentication scheme');
    db.close();
  });

  it('does not tick a house that declared no read authority at all', async () => {
    const { db, deps, lines } = fixture({ configuredHouses: [PINNED] }, false);
    await runStatusCommand(deps as never);
    const text = lines.join('\n');

    expect(text).toContain('🏠 home.example ⚠️');
    expect(text).not.toContain('🏠 home.example ✅');
    // A house that named no scheme is not a house whose scheme we cannot
    // speak. It offers no identity read at all, and there is nothing the
    // owner can do about it — least of all check that house's version.
    expect(text).toContain('offers no way to read');
    expect(text).not.toContain('The read authentication scheme');
    expect(text).not.toContain('/popclaw login');
    db.close();
  });

  it('does not call a trusted house untrusted because of how it was configured', async () => {
    // The pin is filed under the canonical origin; `lore_houses` holds what
    // the owner typed. A readout that compares them raw tells the owner their
    // house is untrusted and their reads are refused, on a house that is
    // trusted and reading fine — the exact confusion this block exists to end.
    const { db, deps, lines } = fixture({ configuredHouses: [`${PINNED}/`, 'https://Home.Example'] });
    await runStatusCommand(deps as never);
    const text = lines.join('\n');

    expect(text).toContain('🏠 home.example ✅');
    expect(text).not.toContain('⚠️');
    expect(text).not.toContain('has no verified binding');
    db.close();
  });

  it('does not tick a house whose pin is BLOCKED', async () => {
    // A block keeps the row on purpose — there has to be something left to
    // compare against when someone comes to resolve it. But "a binding was
    // saved here" is not "currently trusted and readable": the read path
    // refuses this house, and a ✅ told the owner the opposite.
    const { db, deps, lines } = fixture({ configuredHouses: [PINNED] });
    db.execute('UPDATE house_binding_pin SET blocked_reason = ? WHERE origin = ?', ['key changed', PINNED]);
    await runStatusCommand(deps as never);
    const text = lines.join('\n');

    expect(text).toContain('🏠 home.example ⚠️');
    expect(text).not.toContain('🏠 home.example ✅');
    expect(text).toContain(`${PINNED} has no verified binding on this machine`);
    db.close();
  });

  it('says nothing at all when the caller does not wire the houses in', async () => {
    const { db, deps, lines } = fixture({ configuredHouses: undefined });
    await runStatusCommand(deps as never);

    expect(lines.join('\n')).not.toContain('🏠');
    db.close();
  });
});

/**
 * A house that identifies readers by a login session and by nothing else.
 *
 * This is the reference server, and it is not a broken v2 house: it declares
 * no `read_auth` at all, declares a `house_session` board, serves an
 * authenticated inbox stream to the token that session issues, and has no
 * relation routes whatsoever. One tick cannot be right for it in both
 * directions, so the line is per KIND of read — and it is read from the same
 * two places the read path reads (the verified declaration, the participation
 * row), never from the network.
 */
describe('status — a house that only does login sessions', () => {
  const sessionOnly = (overrides: Record<string, unknown> = {}) =>
    fixture({ configuredHouses: [PINNED], ...overrides }, false, { house_session: SESSION_BOARD });

  /** The row a completed login leaves behind. `token: ''` is a session whose
   *  read token was revoked or never arrived — the read path FAILS on it. */
  function login(db: LocalHostDb, session: string, token: string, leaseExpiresAt = 2_000_000_000): void {
    ensureHouseLifecycleSchema(db);
    db.execute(
      `INSERT INTO house_participation
         (house_origin, installation_id, op_seq, desired, phase, session_id, lease_expires_at, inbox_read_token, updated_at)
       VALUES (?, 'installation', 1, 'enabled', 'connected', ?, ?, ?, 1)`,
      [PINNED, session, leaseExpiresAt, token],
    );
  }

  it('sends the owner to log in when there is no session yet', async () => {
    const { db, deps, lines } = sessionOnly();
    await runStatusCommand(deps as never);
    const text = lines.join('\n');

    // ⚠️ is right here: nothing identity-bearing can be read yet. What was
    // wrong is the sentence under it.
    expect(text).toContain('🏠 home.example ⚠️');
    expect(text).toContain('login session');
    expect(text).toContain('/popclaw login');
    expect(text).not.toContain('The read authentication scheme');
    db.close();
  });

  it('says logged in, private messages readable, relations closed — all three', async () => {
    const { db, deps, lines } = sessionOnly();
    login(db, 'sess-09b037259fe2a6b', 'itk-b590a51d.1789876157.my7vkmNf');
    await runStatusCommand(deps as never);
    const text = lines.join('\n');

    expect(text).toContain('🏠 home.example ✅');
    expect(text).not.toContain('🏠 home.example ⚠️');
    // ① logged in ② private messages readable ③ the relation side is closed,
    // and the owner must not read an empty follower list as "nobody".
    expect(text).toContain('You are logged in to');
    expect(text).toContain('Private messages there are readable');
    expect(text).toContain('follower list');
    expect(text).toContain('says nothing about who follows you');
    // The sentence that was still on screen while the stream was returning
    // 200 to a request that said exactly who was asking.
    expect(text).not.toContain('reads that must say who is asking are refused there');
    expect(text).not.toContain('The read authentication scheme');
    db.close();
  });

  it('does not tell the owner mail there can never reach them', async () => {
    // The retracted inference. The notification gate is the LOCAL, per-person
    // union of who the owner follows across every house — a house with no
    // relation lane of its own does not make its mail permanently silent, and
    // copy that said so would be wrong in a way the owner cannot check.
    const { db, deps, lines } = sessionOnly();
    login(db, 'sess-09b037259fe2a6b', 'itk-b590a51d.1789876157.my7vkmNf');
    await runStatusCommand(deps as never);
    const text = lines.join('\n');

    expect(text).toContain('anyone you already follow on another house is still recognised from your own follow list');
    expect(text).not.toMatch(/never (notify|be notified|reach)/i);
    db.close();
  });

  it('does not call the inbox readable on a session that holds no read token', async () => {
    // `chooseInboxReadToken` throws HOUSE_SESSION_READ_TOKEN_MISSING here, so
    // a ✅ would promise a read that fails. Status reads the same two columns.
    const { db, deps, lines } = sessionOnly();
    login(db, 'sess-09b037259fe2a6b', '');
    await runStatusCommand(deps as never);
    const text = lines.join('\n');

    expect(text).toContain('🏠 home.example ⚠️');
    expect(text).not.toContain('🏠 home.example ✅');
    expect(text).toContain('/popclaw login');
    db.close();
  });

  it('reports the inbox as readable while the read path would still send the token', async () => {
    // A lease that has passed. The read path does NOT consult it — it sends
    // the token it holds — so status must not report the opposite of what
    // this client is about to do. Status is a readout, not a second policy.
    const { db, deps, lines } = sessionOnly();
    login(db, 'sess-09b037259fe2a6b', 'itk-b590a51d.1789876157.my7vkmNf', 1);
    await runStatusCommand(deps as never);
    const text = lines.join('\n');

    expect(text).toContain('🏠 home.example ✅');
    expect(text).toContain('Private messages there are readable');
    db.close();
  });

  it('does not tick a BLOCKED pin because a session row is lying around', async () => {
    // The refusal a blocked pin produces is answered before any declaration
    // is read, so there is no session lane to find — and a remembered session
    // must never resurrect the house the pin just stopped trusting.
    const { db, deps, lines } = sessionOnly();
    login(db, 'sess-09b037259fe2a6b', 'itk-b590a51d.1789876157.my7vkmNf');
    db.execute('UPDATE house_binding_pin SET blocked_reason = ? WHERE origin = ?', ['key changed', PINNED]);
    await runStatusCommand(deps as never);
    const text = lines.join('\n');

    expect(text).toContain('🏠 home.example ⚠️');
    expect(text).not.toContain('🏠 home.example ✅');
    expect(text).toContain(`${PINNED} has no verified binding on this machine`);
    expect(text).not.toContain('Private messages there are readable');
    db.close();
  });

  it('leaves a v2 house alone even when it also serves sessions', async () => {
    // The control group. A house that declares the scheme this build signs is
    // ticked on the credential, with no extra line — whatever else it offers.
    const { db, deps, lines } = fixture({ configuredHouses: [PINNED] }, [READ_CREDENTIAL_SCHEME], {
      house_session: SESSION_BOARD,
    });
    await runStatusCommand(deps as never);
    const text = lines.join('\n');

    expect(text).toContain('🏠 home.example ✅');
    expect(text).not.toContain('Private messages there are readable');
    expect(text).not.toContain('/popclaw login');
    db.close();
  });
});

/**
 * A house joined with `popclaw_house_login` exists only in `house_participation`
 * — nothing writes it back into `config.lore_houses`. Status enumerated the
 * config alone, so the owner was told a house they are demonstrably logged into
 * does not exist, and a restart did not fix it because the config still listed
 * one house. `house-runtime.ts` already treats participation as the wider truth
 * when it decides which houses to mount; the status readout has to agree.
 */
describe('status — houses joined at runtime', () => {
  const JOINED = 'https://joined.example';

  /** The row a completed login leaves behind, for any origin. */
  function participate(
    db: LocalHostDb,
    origin: string,
    desired: 'enabled' | 'disabled',
    session = 'sess-09b037259fe2a6b',
    token = 'itk-b590a51d.1789876157.my7vkmNf',
  ): void {
    ensureHouseLifecycleSchema(db);
    db.execute(
      `INSERT INTO house_participation
         (house_origin, installation_id, op_seq, desired, phase, session_id, lease_expires_at, inbox_read_token, updated_at)
       VALUES (?, 'installation', 1, ?, 'connected', ?, 2000000000, ?, 1)`,
      [origin, desired, session, token],
    );
  }

  /** A joined house that declares a session board and nothing else. */
  function joinable(db: LocalHostDb): void {
    establishTrust(db, { origin: JOINED, houseKey: 'house-key-two', incarnation: 'inc-2' }, 'configured', () => 1);
    declareReadAuth(db, JOINED, 'house-key-two', manifestDeclaring(undefined, { house_session: SESSION_BOARD }));
  }

  it('lists a login-joined house that the config has never heard of', async () => {
    const { db, deps, lines } = fixture({ configuredHouses: [PINNED] });
    joinable(db);
    participate(db, JOINED, 'enabled');
    await runStatusCommand(deps as never);
    const text = lines.join('\n');

    expect(text).toContain('🏠 home.example ✅');
    expect(text).toContain('🏠 joined.example ✅');
    expect(text).toContain(`You are logged in to ${JOINED}`);
    db.close();
  });

  it('drops the house again once it has been left', async () => {
    // The control group for the test above: same fixture, same row, only
    // `desired` differs — a leave must not leave a house on screen claiming a
    // login that is over.
    const { db, deps, lines } = fixture({ configuredHouses: [PINNED] });
    joinable(db);
    participate(db, JOINED, 'disabled');
    await runStatusCommand(deps as never);
    const text = lines.join('\n');

    expect(text).toContain('🏠 home.example ✅');
    expect(text).not.toContain('joined.example');
    expect(text).not.toContain(`You are logged in to ${JOINED}`);
    db.close();
  });

  it('does not list a configured house twice when it is also a participation row', async () => {
    // The two sources spell the same house differently: the config carries a
    // trailing slash, the participation row is canonical. Dedupe is by the
    // canonical origin, so this is one house, listed once, in config order.
    const { db, deps, lines } = fixture({ configuredHouses: [`${PINNED}/`, UNPINNED] });
    participate(db, PINNED, 'enabled');
    await runStatusCommand(deps as never);
    const text = lines.join('\n');

    expect(text.match(/🏠 home\.example/g) ?? []).toHaveLength(1);
    // Config order is kept: the configured houses come first, in their order.
    expect(text.indexOf('home.example')).toBeLessThan(text.indexOf('second.example'));
    db.close();
  });
});
