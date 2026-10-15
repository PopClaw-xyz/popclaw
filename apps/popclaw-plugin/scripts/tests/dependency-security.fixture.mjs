import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { auth } from '@modelcontextprotocol/sdk/client/auth.js';

// Resolve the same transitive fast-uri instance that our retained Ajv uses.
const require = createRequire(import.meta.url);
const requireAjv = createRequire(require.resolve('ajv/package.json'));
const uri = requireAjv('fast-uri');

// GHSA-hrr3-gc8f-f4qj: a scheme-relative host must be canonicalized after
// percent decoding, just like its literal spelling.
test('Ajv URI resolver canonicalizes encoded uppercase hosts', () => {
  assert.equal(uri.parse('//%41.com').host, uri.parse('//a.com').host);
  assert.equal(uri.normalize('//%41.com'), uri.normalize('//A.com'));
  assert.equal(uri.equal('//%41.com', '//a.com'), true);
  assert.equal(uri.equal('//%41.com', '//b.com'), false);
});

const trustedIssuer = 'https://trusted-auth.example';
const otherIssuer = 'https://other-auth.example';
const resource = 'https://mcp.example/mcp';

// Exercise the SDK itself with a deterministic network boundary. No credentials
// or requests leave this process. These are dependency regressions, not a claim
// that PopClaw's stdio MCP server uses the SDK's HTTP OAuth client.
function oauthFixture(issuer, clientIssuer = trustedIssuer, tokenIssuer = trustedIssuer) {
  const requests = [];
  const savedTokens = [];
  const redirects = [];
  const provider = {
    redirectUrl: 'https://client.example/callback',
    clientMetadata: { redirect_uris: ['https://client.example/callback'] },
    discoveryState: () => ({
      authorizationServerUrl: issuer,
      authorizationServerMetadata: {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        response_types_supported: ['code'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['client_secret_post'],
      },
      resourceMetadata: { resource, authorization_servers: [issuer] },
    }),
    clientInformation: () => ({
      client_id: 'test-client', client_secret: 'test-client-secret', issuer: clientIssuer,
    }),
    tokens: () => ({
      access_token: 'test-old-access', refresh_token: 'test-refresh', token_type: 'Bearer', issuer: tokenIssuer,
    }),
    saveTokens: (tokens) => { savedTokens.push(tokens); },
    saveCodeVerifier: () => {},
    redirectToAuthorization: (url) => { redirects.push(url); },
  };
  const options = {
    serverUrl: resource,
    fetchFn: async (url, init) => {
      const body = new URLSearchParams(init?.body);
      requests.push({ url: String(url), body });
      return Response.json({ access_token: 'test-new-access', token_type: 'Bearer' });
    },
  };
  return { provider, options, requests, savedTokens, redirects };
}

// GHSA-6qxp-vccf-f47h: credentials associated with one authorization server
// must never be presented to a different server selected by MCP discovery.
test('MCP OAuth rejects client credentials bound to another issuer before sending them', async () => {
  const fixture = oauthFixture(otherIssuer);
  let failure;
  try {
    await auth(fixture.provider, fixture.options);
  } catch (error) {
    failure = error;
  }
  assert.equal(fixture.requests.length, 0, 'must not send the old client secret or refresh token');
  assert.match(failure?.message ?? '', /bound to authorization server/);
});

test('MCP OAuth does not refresh using tokens bound to another issuer', async () => {
  const fixture = oauthFixture(otherIssuer, otherIssuer, trustedIssuer);
  assert.equal(await auth(fixture.provider, fixture.options), 'REDIRECT');
  assert.equal(fixture.requests.length, 0, 'must not send the old refresh token');
  assert.equal(fixture.redirects.length, 1);
});

test('MCP OAuth still refreshes for the matching issuer and saves that binding', async () => {
  const fixture = oauthFixture(trustedIssuer);
  assert.equal(await auth(fixture.provider, fixture.options), 'AUTHORIZED');
  assert.equal(fixture.requests.length, 1);
  assert.equal(fixture.requests[0].url, `${trustedIssuer}/token`);
  assert.equal(fixture.requests[0].body.get('client_secret'), 'test-client-secret');
  assert.equal(fixture.requests[0].body.get('refresh_token'), 'test-refresh');
  assert.deepEqual(fixture.savedTokens, [{
    access_token: 'test-new-access', refresh_token: 'test-refresh', token_type: 'Bearer', issuer: trustedIssuer,
  }]);
});
