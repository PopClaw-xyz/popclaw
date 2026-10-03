import { expect, it, vi } from 'vitest';
import { InboxStreamClient } from '../../../src/messaging/inbox-stream-client.js';

it('drains the actual pending read-token promise before shutdown completes', async () => {
  let release!: (value: string) => void;
  const pending = new Promise<string>(resolve => { release = resolve; });
  const readToken = vi.fn(() => pending);
  const opened = vi.fn();
  const client = new InboxStreamClient({ baseUrl: 'https://a.invalid', recipientPopclawId: 'self',
    readToken, onMessage: () => {},
    eventSourceCtor: class { constructor() { opened(); } } as never });
  client.start(); await vi.waitFor(() => expect(readToken).toHaveBeenCalledOnce());
  let done = false; const stop = Promise.resolve(client.stop()).then(() => { done = true; });
  await Promise.resolve(); expect(done).toBe(false);
  release('token'); await stop;
  expect(done).toBe(true); expect(opened).not.toHaveBeenCalled();
});
