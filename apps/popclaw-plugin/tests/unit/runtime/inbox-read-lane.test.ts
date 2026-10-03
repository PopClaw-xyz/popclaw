/**
 * Which credential the inbox stream carries — and, above all, what a REFUSAL
 * is allowed to do.
 *
 * The rule was `row.session_id ? row.inbox_read_token : selfSigned()`, which
 * reads the LOCAL state to answer a question only the house can answer. That
 * was fixed by letting the declaration pick the lane. What the fix left behind
 * is the subject of this file: `if (row.session_id)` still ran on EVERY
 * refusal, so a missing pin, a BLOCKED pin and a scheme this build cannot
 * speak all rerouted the read onto whatever session token this machine
 * happened to remember. The client was overriding its own refusal.
 *
 * Failure is not protocol negotiation. Both lanes are now selected positively:
 * the identity lane by a granted credential, the session lane by the house's
 * VERIFIED manifest having carried a `house_session` board plus a live session.
 * Neither is ever reached because the other one failed.
 */
import { describe, expect, it } from 'vitest';
import { chooseInboxReadToken } from '../../../src/runtime/house-lifecycle/house-runtime.js';
import { INBOX_TOKEN_HEADER } from '../../../src/identity/read-credential.js';
import type { ReadCredentialOutcome } from '../../../src/identity/read-authority.js';

const granted: ReadCredentialOutcome = {
  ok: true,
  headers: { [INBOX_TOKEN_HEADER]: 'v2.identity.1700000000.signature' },
};
const notTrusted: ReadCredentialOutcome = {
  ok: false,
  refusal: 'READ_AUTH_HOUSE_NOT_TRUSTED',
  message: 'this house is not currently trusted',
};
const notDeclared: ReadCredentialOutcome = {
  ok: false,
  refusal: 'READ_AUTH_NOT_DECLARED',
  message: 'this house does not do identity reads',
};
const unknownScheme: ReadCredentialOutcome = {
  ok: false,
  refusal: 'READ_AUTH_SCHEME_UNSUPPORTED',
  message: 'this house named a scheme this build does not speak',
};

/** Every way the resolver can say no. Each one must behave the same way. */
const REFUSALS = [
  ['READ_AUTH_HOUSE_NOT_TRUSTED', notTrusted],
  ['READ_AUTH_NOT_DECLARED', notDeclared],
  ['READ_AUTH_SCHEME_UNSUPPORTED', unknownScheme],
] as const;

const withSession = { session_id: 'session-1', inbox_read_token: 'house-issued-session-token' };
const noSession = { session_id: '', inbox_read_token: '' };

/** The house declared a `house_session` board in the manifest we verified. */
const DECLARED = true;
/** It did not — so nothing here says this house does session reads. */
const UNDECLARED = false;

describe('choosing the inbox stream credential', () => {
  it('prefers a positively declared session but never infers one from a remembered session alone', () => {
    expect(chooseInboxReadToken(withSession, granted, DECLARED)).toBe('house-issued-session-token');
    expect(chooseInboxReadToken(withSession, granted, UNDECLARED)).toBe('v2.identity.1700000000.signature');
  });

  for (const [name, refusal] of REFUSALS) {
    it(`refuses ${name} by name instead of rerouting it onto a remembered session`, () => {
      // The whole point. A leftover row is not a declaration, so with no
      // positive selection every refusal stays a refusal — including the one
      // that says this house's pin is missing or BLOCKED, which is precisely
      // the read that must not go out under any credential at all.
      expect(() => chooseInboxReadToken(withSession, refusal, UNDECLARED)).toThrow(name);
    });

    it(`refuses ${name} when there is no session either`, () => {
      // There is no third lane. The old self-signed shape lived here, and its
      // absence is the point: the reason reaches whoever is looking instead of
      // an inbox that simply never delivers anything.
      expect(() => chooseInboxReadToken(noSession, refusal, DECLARED)).toThrow(name);
      expect(() => chooseInboxReadToken(noSession, refusal, UNDECLARED)).toThrow(name);
    });

    it(`takes the session lane for ${name} only when the house declared one`, () => {
      // The legitimate case this fix must not break: the reference Ranger Map
      // serves a `house_session` board, issues the read token inside an ACK
      // signed by the key its pin names, and reads DMs that way. It keeps
      // doing so — selected by that board, not by the refusal above it.
      expect(chooseInboxReadToken(withSession, refusal, DECLARED)).toBe('house-issued-session-token');
    });
  }

  it('carries the owner-facing half of the refusal with the code', () => {
    expect(() => chooseInboxReadToken(noSession, notDeclared, UNDECLARED)).toThrow(/does not do identity reads/);
  });

  it('fails the session lane rather than signing something itself', () => {
    // The pre-existing constraint, kept: a session whose token is gone has
    // been revoked or has not arrived, and a self-signed substitute is how a
    // revoked session goes on reading.
    expect(() =>
      chooseInboxReadToken({ session_id: 'session-1', inbox_read_token: '' }, notDeclared, DECLARED),
    ).toThrow('HOUSE_SESSION_READ_TOKEN_MISSING');
    expect(() =>
      chooseInboxReadToken({ session_id: 'session-1', inbox_read_token: '' }, granted, DECLARED),
    ).toThrow('HOUSE_SESSION_READ_TOKEN_MISSING');
  });
});
