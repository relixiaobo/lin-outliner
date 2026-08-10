import { describe, expect, test } from 'bun:test';
import { createResilientResponsesFetch } from '../../src/main/agent/runtime/sseResilientFetch';

describe('resilient OpenAI Responses SSE fetch', () => {
  test('forwards standard responses frames byte-for-byte', async () => {
    const source = [
      ': keep-alive\r\n\r\n',
      'event: response.output_text.delta\r\n',
      'data: {"type":"response.output_text.delta","delta":"hello"}\r\n\r\n',
      'data: {"type":"response.completed","response":{"status":"completed"}}\r\n\r\n',
      'data: [DONE]\r\n\r\n',
    ].join('');

    await withMockFetch(async () => eventStreamResponse([source]), async (fetch) => {
      const response = await fetch('https://relay.example.test/v1/responses');
      expect(await response.text()).toBe(source);
    });
  });

  test('drops a relay error frame and keeps reading to response.completed', async () => {
    const secret = 'sk-0123456789abcdefghijklmnopqrstuvwxyz';
    const noise = [
      ': relay diagnostic\n',
      'event: relay.notice\n',
      'data: {"type":"relay.stream_notice",\n',
      `data: "error":{"message":"stream_read_error"},"api_key":"${secret}"}\n\n`,
    ].join('');
    const completed = 'data: {"type":"response.completed","response":{"status":"completed"}}\n\n';
    const done = 'data: [DONE]\n\n';
    const captured: Array<{ frameType: string | null; snippet: string }> = [];

    await withMockFetch(async () => eventStreamResponse([noise, completed, done]), async () => {
      const fetch = createResilientResponsesFetch({
        onNoiseFrame: (frame) => captured.push({
          frameType: frame.frameType,
          snippet: frame.snippet,
        }),
      });
      const response = await fetch('https://relay.example.test/v1/responses');

      expect(await response.text()).toBe(completed + done);
      expect(captured).toHaveLength(1);
      expect(captured[0]).toMatchObject({ frameType: 'relay.stream_notice' });
      expect(captured[0]?.snippet).toContain('stream_read_error');
      expect(captured[0]?.snippet).not.toContain(secret);
    });
  });

  test('carries the sanitized noise snippet when the stream closes without a terminal frame', async () => {
    const secret = 'sk-0123456789abcdefghijklmnopqrstuvwxyz';
    const noise = `data: {"type":"relay.notice","error":"stream_read_error","api_key":"${secret}"}\n\n`;

    await withMockFetch(async () => eventStreamResponse([noise]), async (fetch) => {
      const response = await fetch('https://relay.example.test/v1/responses');
      let message = '';
      try {
        await response.text();
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }

      expect(message).toContain('stream_read_error');
      expect(message).not.toContain(secret);
    });
  });

  test('redacts a secret-like frame type before reporting diagnostics', async () => {
    const secretType = 'sk-0123456789abcdefghijklmnopqrstuvwxyz';
    const noise = `data: {"type":"${secretType}","error":"stream_read_error"}\n\n`;
    const completed = 'data: {"type":"response.completed"}\n\n';
    const captured: Array<{ frameType: string | null; snippet: string }> = [];

    await withMockFetch(async () => eventStreamResponse([noise, completed]), async () => {
      const fetch = createResilientResponsesFetch({
        onNoiseFrame: (frame) => captured.push({
          frameType: frame.frameType,
          snippet: frame.snippet,
        }),
      });
      const response = await fetch('https://relay.example.test/v1/responses');

      expect(await response.text()).toBe(completed);
      expect(captured).toHaveLength(1);
      expect(captured[0]?.frameType).not.toContain(secretType);
      expect(captured[0]?.snippet).not.toContain(secretType);
    });
  });

  test('keeps response.failed fatal', async () => {
    const source = 'data: {"type":"response.failed","error":{"message":"upstream failed"}}\n\n';

    await withMockFetch(async () => eventStreamResponse([source]), async (fetch) => {
      const response = await fetch('https://relay.example.test/v1/responses');
      expect(await response.text()).toBe(source);
    });
  });

  test('forwards a frame whose data is not valid JSON', async () => {
    const source = 'event: relay.unknown\ndata: {not-json}\n\n';

    await withMockFetch(async () => eventStreamResponse([source]), async (fetch) => {
      const response = await fetch('https://relay.example.test/v1/responses');
      expect(await response.text()).toBe(source);
    });
  });

  test('reassembles a frame split across chunks', async () => {
    const chunks = [
      'data: {"type":"response.output_',
      'text.delta","delta":"hel',
      'lo"}\n',
      '\ndata: {"type":"response.completed"}\n',
      '\n',
    ];

    await withMockFetch(async () => eventStreamResponse(chunks), async (fetch) => {
      const response = await fetch('https://relay.example.test/v1/responses');
      expect(await response.text()).toBe(chunks.join(''));
    });
  });

  test('surfaces an idle timeout as a stream error', async () => {
    let receivedSignal: AbortSignal | null = null;
    await withMockFetch(async (_input, init) => {
      receivedSignal = init?.signal ?? null;
      const signal = receivedSignal;
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          signal?.addEventListener('abort', () => {
            controller.error(signal.reason);
          }, { once: true });
        },
      }), {
        headers: { 'content-type': 'text/event-stream' },
      });
    }, async () => {
      const fetch = createResilientResponsesFetch({ idleTimeoutMs: 10 });
      const response = await fetch('https://relay.example.test/v1/responses');

      await expect(response.text()).rejects.toThrow('stream idle timeout after 10 ms');
      expect(receivedSignal?.aborted).toBe(true);
    });
  });

  test('leaves non-event-stream responses untouched', async () => {
    const source = new Response('{"ok":true}', {
      headers: { 'content-type': 'application/json' },
    });

    await withMockFetch(async () => source, async (fetch) => {
      expect(await fetch('https://relay.example.test/v1/responses')).toBe(source);
    });
  });
});

async function withMockFetch<T>(
  mock: typeof globalThis.fetch,
  run: (fetch: ReturnType<typeof createResilientResponsesFetch>) => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = mock;
  try {
    return await run(createResilientResponsesFetch());
  } finally {
    globalThis.fetch = original;
  }
}

function eventStreamResponse(chunks: readonly string[]): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  }), {
    headers: { 'content-type': 'text/event-stream; charset=utf-8' },
  });
}
