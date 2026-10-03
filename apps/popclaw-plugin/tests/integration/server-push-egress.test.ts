import { afterEach, describe, it, expect } from 'vitest';
import { createServer, Server, IncomingMessage } from 'node:http';
import { AddressInfo } from 'node:net';
import { ServerPushEgress } from '../../src/egress/server-push-egress.js';

async function collect(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

function makeMock(
  handler: (req: IncomingMessage, body: Buffer) => { status: number; body?: unknown },
): Promise<{ server: Server; url: string; received: Buffer[] }> {
  const received: Buffer[] = [];
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      const body = await collect(req);
      received.push(body);
      const out = handler(req, body);
      res.statusCode = out.status;
      if (out.body !== undefined) {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(out.body));
      } else {
        res.end();
      }
    });
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ server, url: `http://127.0.0.1:${port}`, received });
    });
  });
}

const servers: Server[] = [];
afterEach(() => {
  while (servers.length) servers.pop()!.close();
});

describe('ServerPushEgress', () => {
  it('POSTs to /v1/push with protobuf body, returns parsed 200 response', async () => {
    const { server, url, received } = await makeMock(() => ({
      status: 200,
      body: { event_id: 'deadbeef' + 'f'.repeat(56), deduplicated: false },
    }));
    servers.push(server);

    const egress = new ServerPushEgress({ baseUrl: url });
    const res = await egress.push(new Uint8Array([1, 2, 3, 4]));

    expect(res.status).toBe(200);
    expect(res.eventId).toMatch(/^deadbeef/);
    expect(res.deduplicated).toBe(false);
    expect(received[0]?.equals(Buffer.from([1, 2, 3, 4]))).toBe(true);
  });

  it('ADR-0040: surfaces task_id when lore-house accepts an InviteRequest', async () => {
    const { server, url } = await makeMock(() => ({
      status: 202,
      body: { event_id: 'abc', task_id: '8b1f0c2e-0000-4000-8000-000000000001' },
    }));
    servers.push(server);
    const res = await new ServerPushEgress({ baseUrl: url }).push(new Uint8Array([1]));
    expect(res.taskId).toBe('8b1f0c2e-0000-4000-8000-000000000001');
  });

  it('ADR-0040: no task_id in the response leaves taskId undefined (older lore-house)', async () => {
    const { server, url } = await makeMock(() => ({ status: 200, body: { event_id: 'abc' } }));
    servers.push(server);
    const res = await new ServerPushEgress({ baseUrl: url }).push(new Uint8Array([1]));
    expect(res.taskId).toBeUndefined();
  });

  it('returns bare status on non-2xx', async () => {
    const { server, url } = await makeMock(() => ({ status: 401 }));
    servers.push(server);
    const egress = new ServerPushEgress({ baseUrl: url });
    const res = await egress.push(new Uint8Array([9, 9]));
    expect(res.status).toBe(401);
    expect(res.eventId).toBeUndefined();
    expect(res.detail).toBeUndefined();
  });

  it('surfaces the lore-house error reason as detail on a 4xx JSON body', async () => {
    const { server, url } = await makeMock(() => ({
      status: 409,
      body: { error: 'already verified for x' },
    }));
    servers.push(server);
    const egress = new ServerPushEgress({ baseUrl: url });
    const res = await egress.push(new Uint8Array([7]));
    expect(res.status).toBe(409);
    expect(res.detail).toBe('already verified for x');
  });

  // undici's headersTimeout/bodyTimeout both default to 300s: a house that
  // takes the connection and then goes quiet used to hang a post for five
  // minutes. Server here accepts and never replies.
  it('gives up instead of hanging when the house accepts but never replies', async () => {
    const server = createServer(() => {
      /* swallow the request; never write a response */
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    servers.push(server);
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const egress = new ServerPushEgress({ baseUrl: url, timeoutMs: 100 });
    const started = Date.now();
    await expect(egress.push(new Uint8Array([1]))).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
