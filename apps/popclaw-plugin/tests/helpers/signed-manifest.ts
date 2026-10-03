/**
 * A house manifest with a real binding proof over it.
 *
 * Every path that establishes trust in a house starts by verifying that the
 * bytes it was served are bound to a key — so a test that cannot mint such a
 * response cannot reach any of them, and until now none did. That is why
 * `confirmHouseTrustForSession` had no test at all.
 *
 * The recipe here is not guessed. It was checked against a running Rust house
 * on 2026-09-17: that house's real header, over its real body, verifies under
 * `verifyManifestProof`, and flipping one byte of the body is refused. What
 * this mints has the same shape, so a fixture passing here is evidence about
 * the protocol rather than about agreement between two copies of one idea.
 */
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { popclaw } from '@popclaw/contracts';
import { cidFromCanonical } from '@popclaw/algorithms';

/** Must match `house-binding.ts`; the signature is over this prefix + core. */
const PROOF_DOMAIN = 'POPCLAW_WORLD_MANIFEST_PROOF_V1';

export interface MintedHouse {
  readonly origin: string;
  /** base58, exactly as it appears in `HouseBinding.house_key`. */
  readonly houseKey: string;
  readonly incarnation: string;
  readonly bodyBytes: Uint8Array;
  readonly proofHeader: string;
  /** Serves this manifest, and 404s everything else. */
  fetch(input: unknown): Promise<Response>;
}

export function mintHouse(opts: {
  readonly origin: string;
  readonly seed?: number;
  readonly incarnation?: string;
  /** Extra manifest fields — `relations: { ordered: 1 }` to declare support. */
  readonly manifest?: Record<string, unknown>;
  /** Sign with a DIFFERENT key than the one the proof names. */
  readonly signWith?: Uint8Array;
  readonly signedAt?: number;
}): MintedHouse {
  const kp = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(opts.seed ?? 7));
  const houseKey = bs58.encode(kp.publicKey);
  const incarnation = opts.incarnation ?? '1';
  const body = JSON.stringify({
    house: { name: 'Fixture House', slug: 'fixture' },
    core_primitives: { follow: true, profile: true, directed_delivery: true },
    ...(opts.manifest ?? {}),
  });
  const bodyBytes = new TextEncoder().encode(body);

  // Over the bytes SERVED. Re-encoding and hashing that would prove something
  // about the test's own serializer instead.
  const manifestDigest = cidFromCanonical(bodyBytes);
  const house = { origin: opts.origin, houseKey, incarnation };
  const signedAt = opts.signedAt ?? 0;
  // `signed_at` is elided at zero like every other canonical core in this
  // protocol — writing it would make these bytes longer than the verifier
  // rebuilds and fail a signature that is perfectly good.
  const core = popclaw.world.ManifestProof.encode({
    house, manifestDigest, ...(signedAt === 0 ? {} : { signedAt }),
  }).finish();
  const prefix = new TextEncoder().encode(PROOF_DOMAIN);
  const signing = new Uint8Array(prefix.length + core.length);
  signing.set(prefix);
  signing.set(core, prefix.length);

  const authoritySignature = nacl.sign.detached(signing, opts.signWith ?? kp.secretKey);
  const proofHeader = Buffer.from(
    popclaw.world.ManifestProof.encode({
      house, manifestDigest, ...(signedAt === 0 ? {} : { signedAt }), authoritySignature,
    }).finish(),
  ).toString('base64');

  return {
    origin: opts.origin, houseKey, incarnation, bodyBytes, proofHeader,
    fetch: async (input: unknown) => {
      const url = String(typeof input === 'string' ? input : (input as { url?: string }).url ?? input);
      if (!url.startsWith(opts.origin)) return new Response('', { status: 404 });
      return new Response(body, {
        status: 200,
        headers: { 'content-type': 'application/json', 'X-Popclaw-Manifest-Proof': proofHeader },
      });
    },
  };
}
