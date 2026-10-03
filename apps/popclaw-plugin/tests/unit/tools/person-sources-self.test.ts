/**
 * The owner has to be resolvable at the tool boundary too.
 *
 * `personSourcesFrom` grew a `self` source; this pins that the tools actually
 * pass it, on a runtime that carries nothing but `boot`. The acceptance run
 * asked "show my namecard" on a fresh identity and got back "No idea who
 * ranger-… is" — the identity this machine owns was not a source.
 */
import { describe, it, expect, vi } from 'vitest';
import bs58 from 'bs58';
import { deriveSigil } from '../../../src/invite/sigil.js';
import { buildPersonSources, resolvePersonRef } from '../../../src/tools/person-sources.js';
import { registerPopclawTools } from '../../../src/tools/register-tools.js';
import { resolvePerson } from '../../../src/identity/person-resolver.js';
import type { RegisterToolsDeps } from '../../../src/tools/tools-context.js';

const ID = bs58.encode(new Uint8Array(32).fill(11));
const SIGIL = deriveSigil(ID);
const NAME = 'ranger-Apopqk';

/** A runtime that has nothing but an identity — a machine that just booted. */
function depsWithSelf(nickname = NAME): { deps: RegisterToolsDeps; house: ReturnType<typeof vi.fn> } {
  const house = vi.fn(async () => []);
  const deps = {
    runtime: vi.fn(async () => ({ boot: { popclawId: ID, nickname } })),
    getWorldDeps: vi.fn(async () => ({ resolveClient: { resolve: house } })),
  } as unknown as RegisterToolsDeps;
  return { deps, house };
}

describe('buildPersonSources — the owner is a local source', () => {
  it('resolves the owner by name, name#sigil and full id without asking any house', async () => {
    for (const ref of [NAME, `${NAME}#${SIGIL}`, ID]) {
      const { deps, house } = depsWithSelf();
      const r = await resolvePersonRef(ref, deps);
      expect(r).toMatchObject({ kind: 'resolved', popclawId: ID, sigil: SIGIL });
      expect(house).not.toHaveBeenCalled();
    }
  });

  // Control group: the same three refs against a runtime with no identity are
  // exactly what the acceptance run saw.
  it('is a miss when the runtime carries no identity', async () => {
    const house = vi.fn(async () => []);
    const deps = {
      runtime: vi.fn(async () => ({})),
      getWorldDeps: vi.fn(async () => ({ resolveClient: { resolve: house } })),
    } as unknown as RegisterToolsDeps;
    expect(await resolvePersonRef(NAME, deps)).toMatchObject({ kind: 'notFound' });
    expect(house).toHaveBeenCalled();
  });

  // A placeholder name is still a name: nothing filters `ranger-xxxxxx` out of
  // the source, because that is precisely the identity no house can name.
  it('keeps an unnamed identity addressable by sigil and id', async () => {
    const { deps } = depsWithSelf('');
    const sources = await buildPersonSources(deps);
    expect(await resolvePerson(`#${SIGIL}`, sources)).toMatchObject({ kind: 'resolved', popclawId: ID });
    expect(await resolvePerson(ID, sources)).toMatchObject({ kind: 'resolved', popclawId: ID });
  });
});

/**
 * End to end through the tool the owner actually reaches: "show my namecard"
 * with their own name, on an identity no house has ever heard of. Both halves
 * had to be true at once — the name had to resolve locally, and the card had to
 * render without a house row.
 */
describe('popclaw_show_namecard on the owner themselves', () => {
  it('renders the owner from local identity data alone', async () => {
    const tools: Array<{ name: string; execute: (id: string, p: unknown) => Promise<{ text: string }> }> = [];
    const api = {
      registerTool: (tool: unknown) => {
        const t = (typeof tool === 'function' ? (tool as (c: unknown) => unknown)({}) : tool) as
          { name?: string; execute?: unknown };
        if (t?.name && typeof t.execute === 'function') tools.push(t as never);
      },
    } as Parameters<typeof registerPopclawTools>[0]['api'];
    // The house answers 200 with an empty body: the conformant "never seen this
    // identity". It must not be the end of the story for the owner.
    const houseFetch = vi.fn(async () => ({ ok: true, status: 200, text: async () => '', json: async () => ({}) }));
    vi.stubGlobal('fetch', houseFetch);
    registerPopclawTools({
      api,
      runtime: (async () => ({
        boot: { popclawId: ID, nickname: NAME, loreHouseUrl: 'http://lh.example', webBaseUrl: 'https://popclaw.me' },
      })) as unknown as Parameters<typeof registerPopclawTools>[0]['runtime'],
    });
    const tool = tools.find((t) => t.name === 'popclaw_show_namecard')!;

    const out = await tool.execute('c1', { person: NAME });
    vi.unstubAllGlobals();

    expect(out.text).toContain(`@${NAME}#${SIGIL}`);
    expect(out.text).toContain(`popclaw.me/${NAME}/${SIGIL}`);
    expect(out.text).not.toContain('No idea who');
  });
});
