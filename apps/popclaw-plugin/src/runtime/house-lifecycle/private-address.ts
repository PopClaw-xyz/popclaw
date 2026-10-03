/**
 * Is this URL hostname a literal that names this machine or its local
 * network? Used by `HouseRuntime.documentFetch`, the one house-driven lane
 * that may leave the house's origin: a declared document must not become a
 * way for a house to make the owner's machine read its own LAN or localhost.
 *
 * Takes a hostname exactly as the WHATWG URL parser serialises it, which has
 * already canonicalised the tricky spellings (`2130706433`, `0x7f.1` →
 * `127.0.0.1`; `[::ffff:127.0.0.1]` → `[::ffff:7f00:1]`; lower case).
 *
 * Literals and `localhost` names only. A DNS name that RESOLVES to a private
 * address, and DNS rebinding, are out of scope: this check never resolves.
 */
export function isPrivateAddressHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host.startsWith('[') && host.endsWith(']')) {
    const groups = ipv6Groups(host.slice(1, -1));
    return groups === null ? false : isPrivateIpv6(groups);
  }
  const v4 = ipv4Octets(host);
  return v4 !== null && isPrivateIpv4(v4);
}

/** Origin form of the same check — the exemption for dev and test houses. */
export function isPrivateAddressOrigin(origin: string): boolean {
  try {
    return isPrivateAddressHost(new URL(origin).hostname);
  } catch {
    return false;
  }
}

function ipv4Octets(host: string): number[] | null {
  const parts = host.split('.');
  if (parts.length !== 4 || !parts.every(p => /^\d{1,3}$/.test(p))) return null;
  const octets = parts.map(Number);
  return octets.every(o => o <= 255) ? octets : null;
}

function isPrivateIpv4([a, b]: number[]): boolean {
  return a === 0 // "this network", 0.0.0.0 included
    || a === 127 // loopback
    || a === 10 // private
    || (a === 172 && b! >= 16 && b! <= 31) // private
    || (a === 192 && b === 168) // private
    || (a === 169 && b === 254) // link-local, cloud metadata
    || (a === 100 && b! >= 64 && b! <= 127); // CGNAT
}

/** Eight 16-bit groups, or null. Accepts the parser's canonical form only (no zone id). */
function ipv6Groups(literal: string): number[] | null {
  const halves = literal.split('::');
  if (halves.length > 2) return null;
  const parse = (s: string) => (s === '' ? [] : s.split(':').map(g => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN)));
  const head = parse(halves[0]!), tail = halves.length === 2 ? parse(halves[1]!) : [];
  if ([...head, ...tail].some(Number.isNaN)) return null;
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  return [...head, ...Array<number>(halves.length === 2 ? missing : 0).fill(0), ...tail];
}

function isPrivateIpv6(g: number[]): boolean {
  const zeroPrefix = g.slice(0, 5).every(x => x === 0);
  if (zeroPrefix && g[5] === 0 && g[6] === 0 && (g[7] === 0 || g[7] === 1)) return true; // :: and ::1
  if (zeroPrefix && g[5] === 0xffff) { // IPv4-mapped
    return isPrivateIpv4([g[6]! >> 8, g[6]! & 0xff, g[7]! >> 8, g[7]! & 0xff]);
  }
  return (g[0]! & 0xffc0) === 0xfe80 // link-local fe80::/10
    || (g[0]! & 0xfe00) === 0xfc00; // unique local fc00::/7
}
