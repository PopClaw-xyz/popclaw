import { decodeEnvelope, canonicalizeEnvelope } from '../protocol/public-envelope.js';
import { executionDbFor } from '../ingress/world-feed-store.js';
import type { Signer } from '../identity/signer.js';
import { runPopclawMessageCommand, type PopclawMessageDeps } from '../commands/popclaw-message.js';
import { HousePushError, type HouseRuntime, type HouseSessionCommandContext } from './house-lifecycle/house-runtime.js';
import type { HouseGate } from './house-lifecycle/manager.js';
import type { ParticipationInvocation } from '../world/world-participation.js';
import { createWorldEffectAuthority, type WorldEffectAuthorityOptions, type WorldEffectAuthority } from './world-effect-authority.js';
import { popclaw } from '@popclaw/contracts';
import { cidFromCanonical } from '@popclaw/algorithms';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { hostDbSlug } from '../ingress/host-slug.js';
import { worldPublicKey } from '../world/action-wire.js';
import { actionSigner, withAction } from './house-lifecycle/action-context.js';
import { parseWorldJson } from '../world/json-profile.js';
import type { CommandPushResult, PushExecutionContext } from './house-lifecycle/command-bus.js';
import type { HousePushEffectReference } from './house-lifecycle/push-effect.js';

export type WorldDirectDmReference = Extract<HousePushEffectReference, { kind: 'world_direct_dm' }>;
export interface WorldDirectDmInput {
  reservationId: string; jobId: string; invocation: ParticipationInvocation;
  recipient: string; text: string; replyToEventId?: string;
}
export interface WorldDirectDmView {
  reservationId: string; jobId: string; eventId?: string;
  state: 'unknown' | 'accepted' | 'rejected' | 'cancel_pending'; code: string;
  operationId?: string; transportStatus?: number;
}
export interface WorldDirectDmOptions extends Omit<WorldEffectAuthorityOptions, 'reservationId' | 'jobId' | 'invocation'> {
  houses: HouseRuntime; gate: HouseGate; signer: Signer; nickname: string;
  resolveRecipient?: PopclawMessageDeps['resolveRecipient'];
  verifyRecipient?: PopclawMessageDeps['verifyRecipient'];
}

interface Row {
  reservation_id: string; job_id: string; input_json: string; session_json: string;
  recipient_id: string | null; event_id: string | null; signed_bytes: Uint8Array | null; signed_digest: string | null;
  dispatch_intent: number; cancel_pending: number; state: 'unknown' | 'accepted' | 'rejected'; code: string;
  operation_id: string | null; transport_status: number | null;
}
type Session = Pick<HouseSessionCommandContext, 'sessionId' | 'fence' | 'installationId' | 'leaseExpiresAt'> & { generation: number };
type CapturedInput = WorldDirectDmInput & { nickname: string };
const utf8 = new TextEncoder();
function fail(code: string): never { throw new Error(code); }
function identifier(value: unknown): value is string { return typeof value === 'string' && /^[A-Za-z0-9_./:-]{1,128}$/.test(value); }
function digest(value: unknown): value is string { return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value); }
function validUnicode(value: string): boolean { return new TextDecoder().decode(utf8.encode(value)) === value; }
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Object.getOwnPropertySymbols(value).length) fail('DM_INPUT_INVALID');
  const entries = Object.entries(Object.getOwnPropertyDescriptors(value));
  if (entries.some(([key, descriptor]) => !keys.includes(key) || !descriptor.enumerable || !('value' in descriptor))) fail('DM_INPUT_INVALID');
  return Object.fromEntries(entries.map(([key, descriptor]) => [key, descriptor.value as unknown]));
}
/** No flags, attachments, local paths or routing overrides enter this surface. */
function capture(value: WorldDirectDmInput, nickname: string): CapturedInput {
  const input = object(value, ['reservationId', 'jobId', 'invocation', 'recipient', 'text', 'replyToEventId']);
  const inv = object(input.invocation, ['opportunityId', 'kind', 'channel', 'message', 'contextValidUntil', 'expectedCapabilityRevision']);
  if (typeof input.reservationId !== 'string' || !input.reservationId.length || input.reservationId.length > 4096 || !identifier(input.jobId)
    || typeof input.recipient !== 'string' || !input.recipient.trim() || utf8.encode(input.recipient).length > 512
    || !validUnicode(input.recipient) || typeof input.text !== 'string' || !input.text.trim() || utf8.encode(input.text).length > 65536 || !validUnicode(input.text)
    || (input.replyToEventId !== undefined && !digest(input.replyToEventId)) || !identifier(inv.opportunityId)
    || inv.kind !== 'direct_message' || inv.channel !== 'direct_message' || inv.message !== true
    || typeof inv.contextValidUntil !== 'string' || !digest(inv.expectedCapabilityRevision)
    || typeof nickname !== 'string' || !nickname.trim() || utf8.encode(nickname).length > 512 || !validUnicode(nickname)) fail('DM_INPUT_INVALID');
  return { reservationId: input.reservationId, jobId: input.jobId, recipient: input.recipient, text: input.text,
    invocation: { opportunityId: inv.opportunityId, kind: 'direct_message', channel: 'direct_message', message: true,
      contextValidUntil: inv.contextValidUntil, expectedCapabilityRevision: inv.expectedCapabilityRevision },
    ...(input.replyToEventId === undefined ? {} : { replyToEventId: input.replyToEventId as string }), nickname };
}
function savedSession(session: HouseSessionCommandContext): Session {
  return { sessionId: session.sessionId, fence: session.fence, installationId: session.installationId,
    leaseExpiresAt: session.leaseExpiresAt, generation: session.gate.generation };
}
function view(row: Row): WorldDirectDmView {
  return { reservationId: row.reservation_id, jobId: row.job_id, state: row.cancel_pending ? 'cancel_pending' : row.state,
    code: row.cancel_pending ? 'DM_CANCEL_PENDING' : row.code, ...(row.event_id ? { eventId: row.event_id } : {}),
    ...(row.operation_id ? { operationId: row.operation_id } : {}), ...(row.transport_status === null ? {} : { transportStatus: row.transport_status }) };
}

/** Durable one-attempt adapter. The command owns recipient/encryption/signing
 * semantics; this class adds authority and a journal around that exact path.
 * There is intentionally no resend method or server-side DM status fiction. */
export function createWorldDirectDm(options: WorldDirectDmOptions) {
  const { db, houses, actorId, participationId, policy, signer, gate: resourceGate } = options;
  const house = structuredClone(options.house), slug = hostDbSlug(house.origin!), nickname = options.nickname;
  const binding = JSON.stringify([house.origin, house.houseKey, house.incarnation, actorId, participationId]);
  policy.assertBinding(db, house, actorId, participationId); options.readiness.assertBinding(db, house, actorId);
  if (resourceGate.origin !== house.origin || houses.originForSlug(slug) !== house.origin) fail('DM_HOUSE_MISMATCH');
  const stoppedSignal = new AbortController(), tasks = new Set<Promise<WorldDirectDmView>>(), owned = new Set<string>();
  let stopped = false;
  db.execute(`CREATE TABLE IF NOT EXISTS world_direct_dm_attempts (
    binding TEXT NOT NULL, reservation_id TEXT NOT NULL, job_id TEXT NOT NULL, input_json TEXT NOT NULL, session_json TEXT NOT NULL,
    recipient_id TEXT, event_id TEXT, signed_bytes BLOB, signed_digest TEXT, dispatch_intent INTEGER NOT NULL DEFAULT 0,
    cancel_pending INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL, code TEXT NOT NULL, operation_id TEXT, transport_status INTEGER,
    PRIMARY KEY(binding,reservation_id), UNIQUE(binding,event_id))`);
  const open = () => { if (stopped) fail('DM_ADAPTER_STOPPED'); };
  const rowFor = (id: string): Row => {
    const row = db.queryOne<Row>('SELECT * FROM world_direct_dm_attempts WHERE binding=? AND reservation_id=?', [binding, id]);
    if (!row) fail('DM_ATTEMPT_UNKNOWN'); return row;
  };
  const authorityFor = (input: CapturedInput) => createWorldEffectAuthority({ ...options, house,
    reservationId: input.reservationId, jobId: input.jobId, invocation: input.invocation });
  const gateFor = (session: HouseSessionCommandContext) => ({ origin: house.origin!,
    signal: AbortSignal.any([resourceGate.signal, session.gate.signal, stoppedSignal.signal]),
    isActive: () => !stopped && !resourceGate.signal.aborted && resourceGate.isActive() && !session.gate.signal.aborted && session.gate.isActive() });
  const checkSession = (session: HouseSessionCommandContext, saved: Session) => {
    if (session.sessionId !== saved.sessionId || session.fence !== saved.fence || session.installationId !== saved.installationId
      || session.gate.generation !== saved.generation || options.now() >= saved.leaseExpiresAt) fail('DM_SESSION_CHANGED');
  };
  const checkFor = (input: CapturedInput, session: HouseSessionCommandContext, authority: WorldEffectAuthority) => {
    const gate = gateFor(session);
    return () => {
      open(); if (gate.signal.aborted || !gate.isActive()) fail('DM_GATE_CLOSED');
      if (houses.originForSlug(slug) !== house.origin) fail('DM_HOUSE_MISMATCH');
      const row = rowFor(input.reservationId);
      if (row.cancel_pending) fail('DM_CANCEL_PENDING');
      if (row.input_json !== JSON.stringify(input) || row.job_id !== input.jobId) fail('DM_INPUT_CONFLICT');
      checkSession(session, JSON.parse(row.session_json) as Session);
      authority.check(row.event_id ?? undefined);
    };
  };
  const recordReceipt = (id: string, receipt: unknown) => {
    const value = receipt as Partial<CommandPushResult> | null;
    if (!value || !Number.isInteger(value.status) || value.status! < 0 || value.status! > 599) fail('DM_RECEIPT_INVALID');
    if (value.operationId !== undefined && !identifier(value.operationId)) fail('DM_RECEIPT_INVALID');
    db.transaction(tx => {
      const row = rowFor(id);
      if (row.operation_id && value.operationId && row.operation_id !== value.operationId) fail('DM_OPERATION_CONFLICT');
      const status = value.status!, accepted = status >= 200 && status < 300;
      tx.execute(`UPDATE world_direct_dm_attempts SET operation_id=COALESCE(operation_id,?),transport_status=?,state=?,code=?
        WHERE binding=? AND reservation_id=?`, [value.operationId ?? null, status, accepted ? 'accepted' : status === 0 ? 'unknown' : 'rejected',
        accepted ? 'HOUSE_TRANSPORT_ACCEPTED' : status === 0 ? 'DM_TRANSPORT_UNKNOWN' : 'HOUSE_TRANSPORT_REJECTED', binding, id]);
    });
  };
  const decodeSigned = (bytes: Uint8Array, input: CapturedInput, recipientId: string) => {
    const payload = popclaw.identity.SignedPayload.decode(bytes), env = decodeEnvelope(payload.payload), dm = env.directMessage;
    if (!dm || env.actor?.popclawId !== actorId || env.actor.nickname !== input.nickname || env.lorehouse !== ''
      || dm.fromPopclawId !== actorId || dm.toPopclawId !== recipientId || env.prevEventId !== (input.replyToEventId ?? '')
      || dm.nonce?.length !== 24 || !dm.ciphertext?.length || dm.mediaCiphertext?.length || dm.mediaNonce?.length
      || bs58.encode(payload.signerPubkey) !== actorId || env.eventId !== cidFromCanonical(canonicalizeEnvelope(env))
      || !nacl.sign.detached.verify(payload.payload, payload.signature, payload.signerPubkey)
      || !nacl.sign.detached.verify(canonicalizeEnvelope(env), env.signature, worldPublicKey(actorId))) fail('DM_SIGNED_BINDING_MISMATCH');
    return env;
  };
  const perform = async (input: CapturedInput, session: HouseSessionCommandContext, authority: WorldEffectAuthority): Promise<WorldDirectDmView> => {
    const check = checkFor(input, session, authority), gate = gateFor(session);
    let privateError: unknown;
    try {
      check();
      const store = await houses.storeForCommand(house.origin!); check();
      if (executionDbFor(store) !== db || store.baseUrl !== house.origin || store.slug !== slug) fail('DM_DATABASE_MISMATCH');
      const guarded = new Proxy(actionSigner(signer), { get(target, property) {
        if (!['popclawId', 'publicKey', 'sign', 'sealDm'].includes(String(property))) return () => fail('DM_SIGNER_METHOD_FORBIDDEN');
        const method = Reflect.get(target, property, target) as (...args: unknown[]) => unknown;
        return (...args: unknown[]) => {
          try {
            check();
            if (property === 'sealDm' && (args[0] !== input.text.trim() || args[1] !== rowFor(input.reservationId).recipient_id)) fail('DM_RECIPIENT_MISMATCH');
            const callArgs = property === 'sign' ? [new Uint8Array(args[0] as Uint8Array)] : args;
            const result = method.apply(target, callArgs);
            const after = (value: unknown) => {
              check();
              if ((property === 'popclawId' && value !== actorId) || (property === 'publicKey' && bs58.encode(value as Uint8Array) !== actorId)) fail('DM_SIGNER_MISMATCH');
              return value;
            };
            return property === 'sealDm' ? after(result) : Promise.resolve(result).then(after).catch(error => { privateError = error; throw error; });
          } catch (error) { privateError = error; throw error; }
        };
      } }) as Signer;
      const chooseRecipient = (recipientId: string) => {
        check(); worldPublicKey(recipientId); if (recipientId === actorId) fail('DM_SELF_RECIPIENT');
        const row = rowFor(input.reservationId);
        if (row.recipient_id && row.recipient_id !== recipientId) fail('DM_RECIPIENT_MISMATCH');
        db.execute('UPDATE world_direct_dm_attempts SET recipient_id=? WHERE binding=? AND reservation_id=?', [recipientId, binding, input.reservationId]);
        return slug;
      };
      const result = await withAction(gate, () => runPopclawMessageCommand({ positional: [input.recipient, input.text] }, {
        signer: guarded, nickname: input.nickname, replyToEventId: input.replyToEventId, houseOfRecipient: chooseRecipient,
        ...(options.resolveRecipient ? { resolveRecipient: async (ref: string) => {
          check(); const result = structuredClone(await options.resolveRecipient!(ref)); check();
          if (result.kind === 'resolved') chooseRecipient(result.popclawId);
          return result;
        } } : {}),
        ...(options.verifyRecipient ? { verifyRecipient: async (id: string, target?: string) => {
          check(); if (target !== slug || id !== rowFor(input.reservationId).recipient_id) fail('DM_HOUSE_MISMATCH');
          const result = structuredClone(await options.verifyRecipient!(id, slug)); check(); return result;
        } } : {}),
        egress: {
          push: async () => fail('DM_EXPLICIT_HOUSE_REQUIRED'),
          pushTo: async (target, bytes) => {
            const signed = new Uint8Array(bytes); check(); if (target !== slug) fail('DM_HOUSE_MISMATCH');
            const row = rowFor(input.reservationId); if (!row.recipient_id) fail('DM_RECIPIENT_MISMATCH');
            const env = decodeSigned(signed, input, row.recipient_id);
            db.transaction(tx => {
              check();
              if (rowFor(input.reservationId).signed_bytes) fail('DM_ALREADY_SIGNED');
              authority.record(tx, env.eventId);
              tx.execute('UPDATE world_direct_dm_attempts SET event_id=?,signed_bytes=?,signed_digest=? WHERE binding=? AND reservation_id=?',
                [env.eventId, signed, cidFromCanonical(signed), binding, input.reservationId]);
              check();
            });
            check();
            db.transaction(tx => {
              check();
              if (rowFor(input.reservationId).dispatch_intent) fail('DM_ALREADY_DISPATCHED');
              tx.execute('UPDATE world_direct_dm_attempts SET dispatch_intent=1,code=? WHERE binding=? AND reservation_id=?', ['DM_TRANSPORT_UNKNOWN', binding, input.reservationId]);
            });
            const ref: WorldDirectDmReference = { version: 1, kind: 'world_direct_dm', requestId: env.eventId,
              participationId, reservationId: input.reservationId, jobId: input.jobId };
            let receipt: unknown;
            try {
              check();
              receipt = await houses.withPushEffect(house.origin!, ref, () => houses.egress.pushTo(slug, new Uint8Array(signed)));
            } catch (error) {
              // A real bus operation ID/receipt is control evidence even after
              // cancellation. Persist it before rechecking business authority.
              if (error instanceof HousePushError) recordReceipt(input.reservationId, error.result);
              check(); throw error;
            }
            recordReceipt(input.reservationId, receipt); check(); return receipt;
          },
        },
      }));
      check();
      if (privateError) throw privateError;
      if (!result.eventId) fail('DM_RECIPIENT_NOT_SENT');
    } catch (error) {
      const row = rowFor(input.reservationId);
      // Signed transport evidence is immutable with respect to a later local
      // fence. Pre-dispatch errors become an inert local failure, never retry.
      if (!row.dispatch_intent) db.execute('UPDATE world_direct_dm_attempts SET state=?,code=? WHERE binding=? AND reservation_id=?',
        ['rejected', error instanceof Error && /^[A-Z][A-Z0-9_]{0,127}$/.test(error.message) ? error.message : 'DM_PREPARATION_FAILED', binding, input.reservationId]);
    }
    return view(rowFor(input.reservationId));
  };
  return {
    send(input: WorldDirectDmInput): Promise<WorldDirectDmView> {
      try {
        open(); const captured = capture(input, nickname), exact = JSON.stringify(captured);
        const old = db.queryOne<Row>('SELECT * FROM world_direct_dm_attempts WHERE binding=? AND reservation_id=?', [binding, captured.reservationId]);
        if (old) { if (old.input_json !== exact) fail('DM_INPUT_CONFLICT'); return Promise.resolve(view(old)); }
        const session = houses.captureSessionCommandContext(house.origin!), authority = authorityFor(captured);
        const gate = gateFor(session); if (gate.signal.aborted || !gate.isActive()) fail('DM_GATE_CLOSED');
        if (authority.check().requestId) fail('DM_RESERVATION_ALREADY_LINKED');
        db.transaction(tx => {
          authority.check();
          tx.execute(`INSERT INTO world_direct_dm_attempts(binding,reservation_id,job_id,input_json,session_json,state,code)
            VALUES(?,?,?,?,?,'unknown','DM_PREPARATION_UNKNOWN')`, [binding, captured.reservationId, captured.jobId, exact, JSON.stringify(savedSession(session))]);
        });
        owned.add(captured.reservationId);
        const task = houses.runCommand(() => perform(captured, session, authority));
        tasks.add(task); void task.then(() => tasks.delete(task), () => tasks.delete(task)); return task;
      } catch (error) { return Promise.reject(error); }
    },
    view(reservationId: string): WorldDirectDmView { open(); return view(rowFor(reservationId)); },
    async reconcile(reservationId: string): Promise<WorldDirectDmView> {
      open(); const row = rowFor(reservationId);
      if (row.operation_id && row.state === 'unknown') {
        const operation = houses.getPushOperation(row.operation_id);
        if (operation?.result) recordReceipt(reservationId, operation.result);
      }
      return view(rowFor(reservationId));
    },
    async authorizePersisted(ref: WorldDirectDmReference, bytes: Uint8Array, context: PushExecutionContext): Promise<() => void> {
      open();
      const reference = object(ref, ['version', 'kind', 'requestId', 'participationId', 'reservationId', 'jobId']);
      const raw = new Uint8Array(bytes);
      if (reference.version !== 1 || reference.kind !== 'world_direct_dm' || reference.participationId !== participationId
        || !digest(reference.requestId) || typeof reference.reservationId !== 'string' || !identifier(reference.jobId)) fail('DM_EFFECT_REFERENCE_INVALID');
      const row = rowFor(reference.reservationId);
      // A bounded 64 KiB string may expand sixfold as escaped JSON (e.g. NUL).
      // Recovery accepts every JSON representation this input capture writes.
      const parsed = parseWorldJson(utf8.encode(row.input_json), 524288, 8) as CapturedInput;
      const { nickname: storedNickname, ...storedInput } = parsed;
      const captured = capture(storedInput, storedNickname), session = houses.captureSessionCommandContext(house.origin!), authority = authorityFor(captured);
      const check = checkFor(captured, session, authority);
      const operationId = context.operationId;
      if (!identifier(operationId)) fail('DM_EFFECT_REFERENCE_INVALID');
      const beforeClaim = () => {
        context.authorizeSend();
        check(); const current = rowFor(reference.reservationId as string);
        const originalSession = JSON.parse(current.session_json) as Session;
        if (context.signal.aborted || !context.isActive() || context.operationId !== operationId
          || context.sessionId !== originalSession.sessionId || String(context.houseRevision) !== originalSession.fence
          || context.installationId !== originalSession.installationId || context.opSeq !== originalSession.generation
          || context.ackKeyHex.toLowerCase() !== Buffer.from(worldPublicKey(house.houseKey)).toString('hex')) fail('DM_SESSION_CHANGED');
        if (current.event_id !== reference.requestId || current.job_id !== reference.jobId || !current.dispatch_intent || !current.signed_bytes
          || current.state !== 'unknown' || (current.operation_id && current.operation_id !== operationId)
          || !current.recipient_id || current.signed_digest !== cidFromCanonical(raw) || cidFromCanonical(current.signed_bytes) !== current.signed_digest
          || raw.length !== current.signed_bytes.length || raw.some((value, index) => value !== current.signed_bytes![index])) fail('DM_EFFECT_JOURNAL_MISMATCH');
        decodeSigned(raw, captured, current.recipient_id);
      };
      beforeClaim();
      const store = await houses.storeForCommand(house.origin!); beforeClaim();
      if (executionDbFor(store) !== db || store.baseUrl !== house.origin || store.slug !== slug) fail('DM_DATABASE_MISMATCH');
      const guard = () => {
        beforeClaim();
        if (rowFor(reference.reservationId as string).operation_id !== operationId) fail('DM_OPERATION_CONFLICT');
      };
      db.transaction(tx => {
        beforeClaim();
        tx.execute('UPDATE world_direct_dm_attempts SET operation_id=COALESCE(operation_id,?) WHERE binding=? AND reservation_id=?',
          [operationId, binding, reference.reservationId as string]);
        guard(); context.authorizeSend();
      });
      return guard;
    },
    cancel(reservationId: string): void {
      open(); rowFor(reservationId);
      db.execute('UPDATE world_direct_dm_attempts SET cancel_pending=1 WHERE binding=? AND reservation_id=?', [binding, reservationId]);
    },
    stop(): void {
      if (stopped) return; stopped = true; stoppedSignal.abort();
      db.transaction(tx => { for (const id of owned) tx.execute("UPDATE world_direct_dm_attempts SET cancel_pending=1 WHERE binding=? AND reservation_id=? AND state='unknown'", [binding, id]); });
    },
    async whenIdle(): Promise<void> { await Promise.allSettled([...tasks]); },
  };
}
