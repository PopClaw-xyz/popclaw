import { afterEach, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ServerPushEgress } from '../../src/egress/server-push-egress.js';
import { outcomeOk } from '../../src/egress/event-egress.js';
import { LocalHostDb } from '../../src/host/local-host-db.js';
import { ensureHouseLifecycleSchema } from '../../src/runtime/house-lifecycle/participation-store.js';
import { HouseCommandBus, type HouseCommandPort } from '../../src/runtime/house-lifecycle/command-bus.js';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
async function within<T>(promise: Promise<T>, ms = 2000): Promise<T> {
  let timer!: ReturnType<typeof setTimeout>;
  try { return await Promise.race([promise, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error('fixture deadline')), ms); })]); }
  finally { clearTimeout(timer); }
}
async function fixture(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const received: Buffer[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk)); received.push(Buffer.concat(chunks)); handler(req, res);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No fixture address');
  return { origin: `http://127.0.0.1:${address.port}`, received };
}
const rawReceipt = Buffer.from([0, 255, 128, 10, 0, 13, 254, 127, 1]);

it.each([200, 409])('preserves the original JSON receipt_base64 over a real HTTP %s response', async status => {
  const s = await fixture((_req, res) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ accepted: status === 200, receipt_base64: rawReceipt.toString('base64'), elapsed: 0.5 }));
  });
  const result = await new ServerPushEgress({ baseUrl: s.origin }).push(new Uint8Array([1]));
  expect(result).toMatchObject({ status, signedActionResultBase64: rawReceipt.toString('base64') });
  expect(Buffer.from(result.signedActionResultBase64!, 'base64')).toEqual(rawReceipt);
  expect(outcomeOk({ slug: 'house', result })).toBe(false);
});

it.each([200, 409])('accepts a JSON receipt of exactly 1 MiB on HTTP %s', async status => {
  const bytes = Buffer.alloc(1024 * 1024, 143); bytes[0] = 0; bytes[bytes.length - 1] = 255;
  const s = await fixture((_req, res) => {
    res.writeHead(status, { 'content-type': 'Application/JSON; charset=utf-8' });
    res.end(JSON.stringify({ receipt_base64: bytes.toString('base64'), accepted: status === 200 }));
  });
  const result = await new ServerPushEgress({ baseUrl: s.origin }).push(new Uint8Array([1]));
  expect(Buffer.from(result.signedActionResultBase64!, 'base64').equals(bytes)).toBe(true);
  expect(result.status).toBe(status); expect(outcomeOk({ slug: 'house', result })).toBe(false);
});

it('rejects a JSON receipt decoding above 1 MiB even when its base64 length fits the outer limit', async () => {
  const s = await fixture((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ receipt_base64: Buffer.alloc(1024 * 1024 + 1).toString('base64') }));
  });
  await expect(new ServerPushEgress({ baseUrl: s.origin }).push(new Uint8Array([1])))
    .rejects.toThrow('SignedActionResult exceeds 1 MiB');
});

const maxJsonBytes = Math.ceil((1024 * 1024) / 3) * 4 + 16 * 1024;
it.each([200, 409])('rejects declared oversized HTTP %s JSON before awaiting its body', async status => {
  const closed = deferred<void>();
  const s = await fixture((_req, res) => {
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': String(maxJsonBytes + 1) });
    res.once('close', () => closed.resolve()); res.flushHeaders();
  });
  const pending = new ServerPushEgress({ baseUrl: s.origin, timeoutMs: 5000 }).push(new Uint8Array([1]));
  const result = pending.then(value => ({ value }), error => ({ error: String(error) }));
  expect(await within(result)).toMatchObject({ error: expect.stringContaining('Push JSON response exceeds limit') });
  await within(closed.promise);
});

it.each([200, 409])('rejects chunked oversized HTTP %s JSON without waiting for EOF', async status => {
  const closed = deferred<void>(); let ended = false;
  const s = await fixture((_req, res) => {
    res.writeHead(status, { 'content-type': 'application/json' }); res.flushHeaders();
    let sent = 0;
    const timer = setInterval(() => {
      const size = Math.min(64 * 1024, maxJsonBytes + 1 - sent);
      res.write(Buffer.alloc(size, 32)); sent += size;
      if (sent > maxJsonBytes) clearInterval(timer);
    }, 2);
    res.once('close', () => { clearInterval(timer); closed.resolve(); }); res.once('finish', () => { ended = true; });
  });
  const result = new ServerPushEgress({ baseUrl: s.origin, timeoutMs: 5000 }).push(new Uint8Array([1]))
    .then(value => ({ value }), error => ({ error: String(error) }));
  expect(await within(result)).toMatchObject({ error: expect.stringContaining('Push JSON response exceeds limit') });
  await within(closed.promise); expect(ended).toBe(false);
});

it('aborts a partial JSON receipt body on the original captured signal', async () => {
  const started = deferred<void>(), closed = deferred<void>(), controller = new AbortController();
  const s = await fixture((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' }); res.write('{"receipt_base64":"');
    res.once('close', () => closed.resolve()); started.resolve();
  });
  const result = new ServerPushEgress({ baseUrl: s.origin, gate: { signal: controller.signal, isActive: () => true } }).push(new Uint8Array([1]))
    .then(value => ({ value }), error => ({ error: String(error) }));
  await within(started.promise); controller.abort();
  expect(await within(result)).toHaveProperty('error'); await within(closed.promise);
});

it.each([
  [200, 'application/x-protobuf'],
  [409, 'application/x-protobuf'],
  [503, 'Application/X-Protobuf; charset=binary'],
  [307, 'APPLICATION/X-PROTOBUF; version=1'],
] as const)('preserves opaque protobuf bytes and HTTP %s without decoding (%s)', async (status, contentType) => {
  const s = await fixture((req, res) => { expect(req.url).toBe('/v1/push'); res.writeHead(status, { 'content-type': contentType }); res.end(rawReceipt); });
  const result = await new ServerPushEgress({ baseUrl: s.origin }).push(new Uint8Array([1, 2, 255]));
  expect(result).toEqual({ status, signedActionResultBase64: rawReceipt.toString('base64') });
  expect(Buffer.from(result.signedActionResultBase64!, 'base64')).toEqual(rawReceipt);
  expect(s.received).toEqual([Buffer.from([1, 2, 255])]);
});

it('retains an empty protobuf receipt as opaque bytes, without inventing an accepted event', async () => {
  const s = await fixture((_req, res) => { res.writeHead(200, { 'content-type': 'application/x-protobuf' }); res.end(); });
  expect(await new ServerPushEgress({ baseUrl: s.origin }).push(new Uint8Array([1])))
    .toEqual({ status: 200, signedActionResultBase64: '' });
});

it.each(['application/json', 'application/x-protobuf-not-really', 'application/x-protobuf, application/json'])('keeps ordinary JSON receipt behavior for media type %s', async contentType => {
  const s = await fixture((_req, res) => { res.writeHead(202, { 'content-type': contentType }); res.end(JSON.stringify({ event_id: 'event', deduplicated: false, task_id: 'task' })); });
  expect(await new ServerPushEgress({ baseUrl: s.origin }).push(new Uint8Array([1])))
    .toEqual({ status: 202, eventId: 'event', deduplicated: false, taskId: 'task' });
});

it.each([413, 503])('keeps existing HTTP %s JSON infrastructure errors', async status => {
  const s = await fixture((_req, res) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'infrastructure unavailable' })); });
  expect(await new ServerPushEgress({ baseUrl: s.origin }).push(new Uint8Array([1])))
    .toEqual({ status, detail: 'infrastructure unavailable' });
});

it('accepts exactly 1 MiB without losing any byte', async () => {
  const bytes = Buffer.alloc(1024 * 1024); for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256;
  const s = await fixture((_req, res) => { res.writeHead(200, { 'content-type': 'application/x-protobuf' }); res.end(bytes); });
  const result = await new ServerPushEgress({ baseUrl: s.origin }).push(new Uint8Array([1]));
  expect(Buffer.from(result.signedActionResultBase64!, 'base64').equals(bytes)).toBe(true);
});

it.each([200, 503])('rejects chunked HTTP %s past 1 MiB and aborts before the server ends its body', async status => {
  const closed = deferred<void>(); let ended = false;
  const s = await fixture((_req, res) => {
    res.writeHead(status, { 'content-type': 'application/x-protobuf' }); res.flushHeaders();
    let chunks = 0;
    const timer = setInterval(() => {
      if (chunks++ < 16) res.write(Buffer.alloc(64 * 1024, 255));
      else { res.write(Buffer.from([255])); clearInterval(timer); } // deliberately no res.end()
    }, 2);
    res.once('close', () => { clearInterval(timer); closed.resolve(); });
    res.once('finish', () => { ended = true; });
  });
  const pending = new ServerPushEgress({ baseUrl: s.origin, timeoutMs: 5000 }).push(new Uint8Array([1]));
  const settled = pending.then(value => ({ value }), error => ({ error: String(error) }));
  expect(await within(settled)).toMatchObject({ error: expect.stringContaining('SignedActionResult exceeds 1 MiB') });
  await within(closed.promise); expect(ended, 'reject on streamed bytes, without waiting for EOF').toBe(false);
});

it('rejects a declared oversized protobuf body before reading or waiting for any payload', async () => {
  const closed = deferred<void>();
  const s = await fixture((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/x-protobuf', 'content-length': String(1024 * 1024 + 1) });
    res.once('close', () => closed.resolve()); res.flushHeaders(); // no body and no EOF
  });
  const result = new ServerPushEgress({ baseUrl: s.origin, timeoutMs: 5000 }).push(new Uint8Array([1]))
    .then(value => ({ value }), error => ({ error: String(error) }));
  expect(await within(result)).toMatchObject({ error: expect.stringContaining('SignedActionResult exceeds 1 MiB') });
  await within(closed.promise);
});

it('does not deliver protobuf bytes when the captured gate closes while the body is streaming', async () => {
  const started = deferred<ServerResponse>(); let active = true; const controller = new AbortController();
  const s = await fixture((_req, res) => { res.writeHead(200, { 'content-type': 'application/x-protobuf' }); res.write(rawReceipt.subarray(0, 3)); started.resolve(res); });
  const pending = new ServerPushEgress({ baseUrl: s.origin, gate: { signal: controller.signal, isActive: () => active } }).push(new Uint8Array([1]));
  const result = pending.then(value => ({ value }), error => ({ error: String(error) }));
  const response = await within(started.promise); active = false; response.end(rawReceipt.subarray(3));
  expect(await within(result)).toMatchObject({ error: expect.stringContaining('HOUSE_DISABLED') });
});

it('aborts a partial protobuf body on the actual captured AbortSignal', async () => {
  const started = deferred<void>(), closed = deferred<void>(); const controller = new AbortController();
  const s = await fixture((_req, res) => { res.writeHead(200, { 'content-type': 'application/x-protobuf' }); res.write(rawReceipt.subarray(0, 3)); res.once('close', () => closed.resolve()); started.resolve(); });
  const pending = new ServerPushEgress({ baseUrl: s.origin, gate: { signal: controller.signal, isActive: () => true } }).push(new Uint8Array([1]));
  const result = pending.then(value => ({ value }), error => ({ error: String(error) }));
  await within(started.promise); controller.abort();
  expect(await within(result)).toHaveProperty('error'); await within(closed.promise);
});

it.each([200, 503])('does not deliver an HTTP %s JSON result after the same captured gate closes', async status => {
  const started = deferred<ServerResponse>(); let active = true; const controller = new AbortController();
  const s = await fixture((_req, res) => { res.writeHead(status, { 'content-type': 'application/json' }); res.write('{'); started.resolve(res); });
  const pending = new ServerPushEgress({ baseUrl: s.origin, gate: { signal: controller.signal, isActive: () => active } }).push(new Uint8Array([1]));
  const result = pending.then(value => ({ value }), error => ({ error: String(error) }));
  const response = await within(started.promise); active = false; response.end(status === 200 ? '"event_id":"late"}' : '"error":"late"}');
  expect(await within(result)).toMatchObject({ error: expect.stringContaining('HOUSE_DISABLED') });
});

it('does not count an unverified SignedActionResult as business approval even on HTTP 200', () => {
  expect(outcomeOk({ slug: 'house', result: { status: 200, signedActionResultBase64: rawReceipt.toString('base64') } })).toBe(false);
  expect(outcomeOk({ slug: 'house', result: { status: 200, signedActionResultBase64: '' } })).toBe(false);
  expect(outcomeOk({ slug: 'house', result: { status: 200, eventId: 'legacy-event' } })).toBe(true);
});

it.each([200, 409])('one bus owner retains a 1 MiB HTTP %s protobuf receipt across SQLite connections and reopen', async status => {
  const busReceipt = Buffer.alloc(1024 * 1024, 143); busReceipt[0] = 0; busReceipt[busReceipt.length - 1] = 255;
  const s = await fixture((_req, res) => { res.writeHead(status, { 'content-type': 'application/x-protobuf' }); res.end(busReceipt); });
  const root = mkdtempSync(join(tmpdir(), 'signed-action-ipc-')); cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'ipc.db'), ownerDb = new LocalHostDb(path), readerDb = new LocalHostDb(path);
  cleanups.push(() => ownerDb.close(), () => readerDb.close()); ensureHouseLifecycleSchema(ownerDb);
  ownerDb.execute("INSERT INTO house_participation(house_origin,installation_id,desired,phase,op_seq,session_id,house_revision,lease_expires_at,ack_key_hex) VALUES(?,'fixture','enabled','connected',1,'session',1,?,'pin')", [s.origin, Math.floor(Date.now() / 1000) + 60]);
  const port = { knownHouseOrigins: () => [s.origin] } as HouseCommandPort;
  let ownerExecutions = 0;
  const owner = new HouseCommandBus({ db: ownerDb, coordinator: port, authority: { captureEpoch: () => 1, isEpochCurrent: e => e === 1 }, pollMs: 2,
    executePush: (origin, bytes, context) => { ownerExecutions++; context.authorizeSend(); return new ServerPushEgress({ baseUrl: origin, gate: context }).push(bytes); } });
  const reader = new HouseCommandBus({ db: readerDb, coordinator: port, authority: { captureEpoch: () => null, isEpochCurrent: () => false }, pollMs: 2, timeoutMs: 2000,
    executePush: async () => { throw new Error('Reader must never send'); } });
  cleanups.push(() => owner.stop(), () => reader.stop()); owner.start();
  const result = await reader.push(s.origin, new Uint8Array([7, 8, 9]));
  expect(result).toMatchObject({ status, state: 'done', signedActionResultBase64: busReceipt.toString('base64') });
  expect(reader.getPushOperation(result.operationId)?.result).toEqual(result);
  expect(ownerExecutions).toBe(1); expect(s.received).toEqual([Buffer.from([7, 8, 9])]);
  await reader.stop(); await owner.stop(); readerDb.close(); ownerDb.close();
  const reopened = new LocalHostDb(path);
  try {
    const persisted = reopened.queryOne<{ result_json: string; payload_bytes: unknown }>('SELECT result_json,payload_bytes FROM house_lifecycle_commands WHERE request_id=?', [result.operationId]);
    expect(JSON.parse(persisted!.result_json)).toEqual(result); expect(persisted!.payload_bytes).toBeNull();
    expect(Buffer.from(JSON.parse(persisted!.result_json).signedActionResultBase64, 'base64').equals(busReceipt)).toBe(true);
  } finally { reopened.close(); }
});
