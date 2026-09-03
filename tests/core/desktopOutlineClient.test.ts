import { describe, expect, test } from 'bun:test';
import { DesktopOutlineClient, type DesktopOutlineTransportClient } from '../../src/main/outlineClient';
import {
  decodeOutlineDesktopId,
  decodeOutlineDesktopRequest,
  decodeOutlineDesktopSubscription,
} from '../../src/main/outlineClient/protocol';
import type {
  OutlineResponse,
  OutlineStreamRecord,
  WatchRequest,
} from '../../src/outline/contract/schemas';

describe('desktop Outline client', () => {
  test('decodes the narrow renderer-owned identifiers without accepting transport details', () => {
    expect(decodeOutlineDesktopRequest({
      requestId: 'request:1',
      command: 'get',
      input: { selector: { by: 'alias', alias: 'today' } },
    })).toEqual({
      requestId: 'request:1',
      command: 'get',
      input: { selector: { by: 'alias', alias: 'today' } },
    });
    expect(decodeOutlineDesktopSubscription({ subscriptionId: 'watch:1', input: {} }))
      .toEqual({ subscriptionId: 'watch:1', input: {} });
    expect(decodeOutlineDesktopId('request:1')).toBe('request:1');
    expect(() => decodeOutlineDesktopRequest({
      requestId: '../runtime.json',
      command: 'get',
      input: {},
      socketPath: '/tmp/private.sock',
    })).toThrow('Invalid desktop Outline request');
    expect(() => decodeOutlineDesktopId('request/1')).toThrow('Invalid desktop Outline request identifier');
  });

  test('limits generic renderer requests to desktop-safe Outline capabilities', () => {
    expect(decodeOutlineDesktopRequest({
      requestId: 'request:bytes',
      command: 'asset ingest',
      input: { source: 'bytes', data: 'YQ==' },
    })).toMatchObject({ command: 'asset ingest', input: { source: 'bytes' } });

    for (const request of [
      { command: 'asset ingest', input: { source: 'path', path: '/private/data' } },
      { command: 'asset ingest', input: { source: 'stdin' } },
      { command: 'asset export', input: { assetId: 'asset:private' } },
      { command: 'export', input: { selector: { by: 'alias', alias: 'today' } } },
      { command: 'history', input: {} },
      { command: 'status', input: {} },
    ]) {
      expect(() => decodeOutlineDesktopRequest({
        requestId: 'request:blocked',
        ...request,
      })).toThrow(/unavailable to the desktop renderer|only from bytes/);
    }
  });

  test('shares one transport across an open watch and concurrent requests', async () => {
    let connectCount = 0;
    const transport = new FakeTransport();
    const client = new DesktopOutlineClient({
      connect: async () => {
        connectCount += 1;
        return transport;
      },
    });
    const records: OutlineStreamRecord[] = [];

    client.subscribe(7, 'watch:1', {}, (record) => records.push(record));
    const [first, second] = await Promise.all([
      client.request(7, 'request:1', 'status', {}),
      client.request(7, 'request:2', 'status', {}),
    ]);

    await waitFor(() => records.length === 1);
    expect(connectCount).toBe(1);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(records[0]?.type).toBe('hello');

    client.cancel(8, 'watch:1');
    expect(transport.watchAborted).toBe(false);
    client.cancel(7, 'watch:1');
    await waitFor(() => transport.watchAborted);
    client.close();
    expect(transport.closed).toBe(true);
  });

  test('keeps Runtime error envelopes structured instead of rejecting IPC', async () => {
    const response = {
      protocolVersion: 1,
      requestId: 'runtime:1',
      command: 'get',
      ok: false,
      error: {
        code: 'not_found',
        category: 'selection',
        message: 'Selector did not resolve to a Node.',
        retryable: false,
      },
    } as unknown as OutlineResponse;
    const transport = new FakeTransport(response);
    const client = new DesktopOutlineClient({ connect: async () => transport });

    await expect(client.request(1, 'request:1', 'get', {})).resolves.toEqual(response);
    client.close();
  });
});

class FakeTransport implements DesktopOutlineTransportClient {
  closed = false;
  watchAborted = false;

  constructor(private readonly response: OutlineResponse = successResponse()) {}

  async requestResponse(): Promise<OutlineResponse> {
    return this.response;
  }

  async *watchSubscription(_input: WatchRequest, signal?: AbortSignal): AsyncGenerator<OutlineStreamRecord> {
    yield {
      protocolVersion: 1,
      requestId: 'runtime:watch',
      sequence: 0,
      type: 'hello',
    };
    await new Promise<void>((resolve) => {
      if (signal?.aborted) {
        this.watchAborted = true;
        resolve();
        return;
      }
      signal?.addEventListener('abort', () => {
        this.watchAborted = true;
        resolve();
      }, { once: true });
    });
  }

  close(): void {
    this.closed = true;
  }
}

function successResponse(): OutlineResponse {
  return {
    protocolVersion: 1,
    requestId: 'runtime:1',
    command: 'status',
    ok: true,
    revision: 0,
    data: { running: true },
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for desktop Outline client state.');
}
