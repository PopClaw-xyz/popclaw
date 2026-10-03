import { describe, it, expect } from 'vitest';
import EventSource from 'eventsource';
import { popclaw } from '@popclaw/contracts';
import { signedFixtureEnvelope } from '../helpers/signed-envelope.js';
import { InMemoryHostAdapter } from '../../src/host/host-adapter.in-memory.js';
import { SseIngress } from '../../src/ingress/sse-ingress.js';

class FakeEventSource {
  static lastInstance: FakeEventSource | null = null;
  /** How many streams have ever been opened — a leak/storm is a count, not a shape. */
  static opened = 0;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  readonly url: string;
  closed = false;
  constructor(url: string) {
    this.url = url;
    FakeEventSource.lastInstance = this;
    FakeEventSource.opened++;
  }
  close(): void {
    this.closed = true;
  }
  emit(frameBytes: Uint8Array): void {
    const b64 = btoa(String.fromCharCode(...frameBytes));
    this.onmessage?.({ data: b64 });
  }
  failover(): void {
    this.onerror?.(new Error('simulated'));
  }
}

function encodeFrame(label: string): Uint8Array {
  return popclaw.event.DiscoveryFrame.encode({ event: signedFixtureEnvelope(label) }).finish();
}

describe('SseIngress', () => {
  it('decodes base64 DiscoveryFrame and calls handler once per event', async () => {
    const host = new InMemoryHostAdapter();
    const received: string[] = [];
    const ingress = new SseIngress(
      {
        baseUrl: 'http://test.local',
        eventSourceCtor: FakeEventSource as unknown as typeof EventSource,
      },
      host,
    );
    await ingress.start(({ eventId }) => {
      received.push(eventId);
    });
    const es = FakeEventSource.lastInstance!;
    es.emit(encodeFrame('A'));
    es.emit(encodeFrame('B'));
    es.emit(encodeFrame('A')); // duplicate, dropped
    await new Promise((r) => setTimeout(r, 10));
    expect(received).toEqual(['A', 'B'].map(label => signedFixtureEnvelope(label).eventId));
    await ingress.stop();
  });

  it('onerror schedules a reconnect; timer flush triggers a new EventSource', async () => {
    const host = new InMemoryHostAdapter();
    const ingress = new SseIngress(
      {
        baseUrl: 'http://test.local',
        baseBackoffMs: 100,
        eventSourceCtor: FakeEventSource as unknown as typeof EventSource,
      },
      host,
    );
    await ingress.start(() => {});
    const first = FakeEventSource.lastInstance;
    first?.failover();
    host.timer.flush(10_000);
    const second = FakeEventSource.lastInstance;
    expect(second).not.toBe(first);
    await ingress.stop();
  });

  it('onerror closes the errored EventSource (else eventsource revives it → leak)', async () => {
    const host = new InMemoryHostAdapter();
    const ingress = new SseIngress(
      {
        baseUrl: 'http://test.local',
        baseBackoffMs: 100,
        eventSourceCtor: FakeEventSource as unknown as typeof EventSource,
      },
      host,
    );
    await ingress.start(() => {});
    const first = FakeEventSource.lastInstance!;
    first.failover();
    // Closed at error time, not at reconnect time: `eventsource` retries on its
    // own 1s after the error, so anything still open by then is an orphan.
    expect(first.closed).toBe(true);
    host.timer.flush(10_000);
    expect(FakeEventSource.lastInstance).not.toBe(first);
    await ingress.stop();
  });

  it('repeated onerror on one stream still yields exactly one reconnect', async () => {
    const host = new InMemoryHostAdapter();
    const ingress = new SseIngress(
      {
        baseUrl: 'http://test.local',
        baseBackoffMs: 100,
        eventSourceCtor: FakeEventSource as unknown as typeof EventSource,
      },
      host,
    );
    await ingress.start(() => {});
    const opened = FakeEventSource.opened;
    const first = FakeEventSource.lastInstance!;
    first.failover();
    first.failover();
    first.failover();
    host.timer.flush(10_000);
    expect(FakeEventSource.opened - opened).toBe(1);
    await ingress.stop();
  });

  it('silence watchdog fires after budget, forces reconnect', async () => {
    const host = new InMemoryHostAdapter();
    const ingress = new SseIngress(
      {
        baseUrl: 'http://test.local',
        silenceBudgetMs: 500,
        baseBackoffMs: 100,
        eventSourceCtor: FakeEventSource as unknown as typeof EventSource,
      },
      host,
    );
    await ingress.start(() => {});
    const first = FakeEventSource.lastInstance;
    host.timer.flush(600);
    host.timer.flush(10_000);
    const second = FakeEventSource.lastInstance;
    expect(second).not.toBe(first);
    expect(first?.closed).toBe(true);
    await ingress.stop();
  });
});
