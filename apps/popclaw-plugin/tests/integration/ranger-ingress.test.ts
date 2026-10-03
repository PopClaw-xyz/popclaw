import { afterEach, describe, it, expect } from 'vitest';
import { createServer, Server, ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import { popclaw } from '@popclaw/contracts';
import { signedFixtureEnvelope } from '../helpers/signed-envelope.js';
import { InMemoryHostAdapter } from '../../src/host/host-adapter.in-memory.js';
import { SseIngress } from '../../src/ingress/sse-ingress.js';

const servers: Server[] = [];
afterEach(() => {
  while (servers.length) servers.pop()!.close();
});

async function sseMock(lines: string[]): Promise<{ server: Server; url: string }> {
  return new Promise((resolve, reject) => {
    const server = createServer((_req, res: ServerResponse) => {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
      });
      for (const line of lines) {
        res.write(line);
        if (!line.endsWith('\n\n')) res.write('\n\n');
      }
      // Keep the connection open; tests call server.close() in afterEach.
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

function frame(label: string): string {
  const bytes = popclaw.event.DiscoveryFrame.encode({ event: signedFixtureEnvelope(label) }).finish();
  return `data: ${Buffer.from(bytes).toString('base64')}\n\n`;
}

describe('SseIngress against a mock SSE server', () => {
  it('receives 3 frames, dedups a repeated one, calls handler twice', async () => {
    const { server, url } = await sseMock([frame('A'), frame('B'), frame('A')]);
    servers.push(server);

    const host = new InMemoryHostAdapter();
    const received: string[] = [];
    const ingress = new SseIngress({ baseUrl: url }, host);
    await ingress.start(({ eventId }) => {
      received.push(eventId);
    });
    await new Promise((r) => setTimeout(r, 300));
    await ingress.stop();

    expect(received).toEqual(['A', 'B'].map(label => signedFixtureEnvelope(label).eventId));
  });
});
