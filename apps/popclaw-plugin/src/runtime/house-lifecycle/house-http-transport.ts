import { INBOX_TOKEN_HEADER } from '../../identity/read-credential.js';
import { normalizeHouseOrigin } from './control-client.js';
import { actionFetch, assertActionActive, assertHouseActionActive, type ActionGate } from './action-context.js';
import { isPrivateAddressHost, isPrivateAddressOrigin } from './private-address.js';

interface HouseHttpTransportDependencies {
  getPublicReadGate(origin: string): ActionGate;
  getHouseGate(origin: string): ActionGate;
  currentFetch(): typeof globalThis.fetch;
}

/**
 * Headers the PUBLIC read lane (`houseReadFetch`) refuses to
 * send. That lane exists BECAUSE the request identifies nobody; a caller that
 * attaches one of these has left the lane it asked for, and is told so rather
 * than quietly having the header stripped. `Headers.has` is case-insensitive,
 * so the wire casing of `INBOX_TOKEN_HEADER` does not matter here.
 */
const PUBLIC_READ_FORBIDDEN_HEADERS: readonly string[] = ['authorization', 'cookie', INBOX_TOKEN_HEADER];

/** Complete HTTP policies; authority and declaration selection stay with callers.
 * Construction captures no gate and performs no IO. Each dispatch resolves its
 * current fetch only after command, gate and request-policy checks succeed. */
export function createHouseHttpTransport(deps: HouseHttpTransportDependencies) {
  function houseReadFetch(input: string): typeof globalThis.fetch {
    const origin = normalizeHouseOrigin(input);
    return async (url, init) => {
      assertHouseActionActive(origin);
      const request = url instanceof Request ? url : null;
      const gate = deps.getPublicReadGate(origin);
      assertActionActive(gate);
      const target = new URL(request ? request.url : String(url));
      if (target.origin !== origin || target.username || target.password) throw new Error('HOUSE_AUDIENCE_MISMATCH');
      const method = String(init?.method ?? request?.method ?? 'GET').toUpperCase();
      if (method !== 'GET' && method !== 'HEAD') throw new Error('HOUSE_READ_METHOD_NOT_ALLOWED');
      // BOTH header lists, not `init ?? request`: a Request object carrying a
      // credential alongside a non-nullish `init.headers` would otherwise be
      // accepted here and silently stripped by the platform. Stripping is not
      // refusing, and a caller that asked to send one must be told it cannot.
      for (const source of [request?.headers, init?.headers]) {
        if (source === undefined || source === null) continue;
        const headers = new Headers(source);
        for (const name of PUBLIC_READ_FORBIDDEN_HEADERS) if (headers.has(name)) throw new Error('HOUSE_READ_CREDENTIAL_REFUSED');
      }
      return actionFetch(gate, deps.currentFetch())(url, {...init, method, redirect: 'error', credentials: 'omit'});
    };
  }

  /** House HTTP never follows a redirect or sends a credential to another origin. */
  function houseFetch(input: string, captured?: ActionGate): typeof globalThis.fetch {
    const origin = normalizeHouseOrigin(input);
    return async (url, init) => {
      assertHouseActionActive(origin);
      const gate = captured ?? deps.getHouseGate(origin);
      assertActionActive(gate);
      const target = new URL(url instanceof Request ? url.url : String(url));
      if (target.origin !== origin || target.username || target.password) throw new Error('HOUSE_AUDIENCE_MISMATCH');
      return actionFetch(gate, deps.currentFetch())(url, {...init, redirect: 'error'});
    };
  }

  /**
   * A caller-selected public document. Callers verify the house declaration;
   * this transport enforces only the HTTP policy. ADR-0041 permits a
   * declared `guide_url` to be relative or absolute http(s), so a house
   * at one origin may publish its guide on another. `houseFetch` refuses any
   * other origin, which is right for house HTTP and wrong for this one read.
   *
   * Everything else `houseFetch` protects is kept: the enclosing command's
   * participation and the captured gate (a paused or left house fetches
   * nothing), no user-info, `redirect: 'error'`, the same `actionFetch`.
   * On top of that, because the target is not the house: http(s) only, GET or
   * HEAD only, no `authorization` / `cookie` / inbox token in either header
   * list, and `credentials: 'omit'`. It is a plain GET of a public document;
   * nothing derived from the house rides along.
   *
   * And no private address: a literal loopback / private / link-local / CGNAT
   * / unspecified host (IPv4, IPv6, IPv4-mapped) or a `localhost` name is
   * refused (`HOUSE_DOCUMENT_ADDRESS_REFUSED`), unless the house itself is on
   * such an address (dev and test houses). DNS names that resolve to a
   * private address, and DNS rebinding, are NOT covered: nothing is resolved.
   */
  function documentFetch(input: string, captured?: ActionGate): typeof globalThis.fetch {
    const origin = normalizeHouseOrigin(input);
    const privateHouse = isPrivateAddressOrigin(origin);
    return async (url, init) => {
      assertHouseActionActive(origin);
      const gate = captured ?? deps.getHouseGate(origin);
      assertActionActive(gate);
      const request = url instanceof Request ? url : null;
      const target = new URL(request ? request.url : String(url));
      if ((target.protocol !== 'https:' && target.protocol !== 'http:') || target.username || target.password) {
        throw new Error('HOUSE_DOCUMENT_URL_REFUSED');
      }
      // Origin equality used to keep a hostile declaration off this machine and
      // its LAN; this lane must refuse that explicitly. A house that is itself
      // on a private address (a dev or test house) is exempt.
      if (!privateHouse && isPrivateAddressHost(target.hostname)) throw new Error('HOUSE_DOCUMENT_ADDRESS_REFUSED');
      const method = String(init?.method ?? request?.method ?? 'GET').toUpperCase();
      if (method !== 'GET' && method !== 'HEAD') throw new Error('HOUSE_READ_METHOD_NOT_ALLOWED');
      for (const source of [request?.headers, init?.headers]) {
        if (source === undefined || source === null) continue;
        const headers = new Headers(source);
        for (const name of PUBLIC_READ_FORBIDDEN_HEADERS) if (headers.has(name)) throw new Error('HOUSE_READ_CREDENTIAL_REFUSED');
      }
      return actionFetch(gate, deps.currentFetch())(url, {...init, method, redirect: 'error', credentials: 'omit'});
    };
  }

  return { houseReadFetch, houseFetch, documentFetch };
}
