import type { FetchFunction } from '@earendil-works/pi-ai';
import { MAX_TURN_DIAGNOSTICS_STREAM_NOISE_FRAMES } from '../../../core/agent/protocol';
import { redactSecretLikeTelemetry } from '../capabilities/agentSecretRedaction';

export const RESPONSES_STREAM_IDLE_TIMEOUT_MS = 300_000;

const MAX_NOISE_FRAME_SNIPPET_CHARS = 2_000;
const MAX_NOISE_FRAME_TYPE_CODE_POINTS = 64;
const TERMINAL_RESPONSE_TYPES = new Set([
  'response.completed',
  'response.failed',
  'response.incomplete',
]);

export interface ResponsesStreamNoiseFrame {
  readonly arrivedAt: number;
  readonly frameType: string | null;
  readonly snippet: string;
}

export interface ResilientResponsesFetchOptions {
  readonly idleTimeoutMs?: number;
  readonly onNoiseFrame?: (frame: ResponsesStreamNoiseFrame) => void | Promise<void>;
}

interface ParsedFrame {
  readonly terminal: boolean;
  readonly noise: {
    readonly value: unknown;
  } | null;
}

export function createResilientResponsesFetch(
  options: ResilientResponsesFetchOptions = {},
): FetchFunction {
  const idleTimeoutMs = normalizeIdleTimeout(options.idleTimeoutMs);
  return async (input, init) => {
    const idleAbort = new AbortController();
    const upstreamSignal = init?.signal
      ?? (input instanceof Request ? input.signal : undefined);
    const signal = upstreamSignal
      ? AbortSignal.any([upstreamSignal, idleAbort.signal])
      : idleAbort.signal;
    const response = await globalThis.fetch(input, { ...init, signal });
    if (!isEventStream(response) || !response.body) return response;

    let buffer: Uint8Array<ArrayBufferLike> = new Uint8Array();
    let firstNoiseSnippet: string | null = null;
    let reportedNoiseFrameCount = 0;
    let sawTerminalFrame = false;
    let lastChunkAt = Date.now();
    let streamController: TransformStreamDefaultController<Uint8Array> | null = null;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;

    const clearIdleTimer = () => {
      if (idleTimer === null) return;
      clearTimeout(idleTimer);
      idleTimer = null;
    };
    const resetIdleTimer = () => {
      clearIdleTimer();
      idleTimer = setTimeout(() => {
        const suffix = firstNoiseSnippet ? ` First sanitized frame: ${firstNoiseSnippet}` : '';
        const error = new Error(`OpenAI Responses stream idle timeout after ${idleTimeoutMs} ms.${suffix}`);
        idleAbort.abort(error);
        try {
          streamController?.error(error);
        } catch {
          // The stream may have settled between the timer firing and error delivery.
        }
      }, idleTimeoutMs);
    };
    const forwardOrReportFrame = async (
      frame: Uint8Array,
      arrivedAt: number,
      controller: TransformStreamDefaultController<Uint8Array>,
    ) => {
      const parsed = parseFrame(frame);
      sawTerminalFrame ||= parsed.terminal;
      if (!parsed.noise) {
        controller.enqueue(frame);
        return;
      }
      if (reportedNoiseFrameCount >= MAX_TURN_DIAGNOSTICS_STREAM_NOISE_FRAMES) return;
      reportedNoiseFrameCount += 1;
      const frameType = await sanitizedFrameType(parsed.noise.value);
      const snippet = await sanitizedNoiseSnippet(parsed.noise.value);
      firstNoiseSnippet ??= snippet;
      try {
        await options.onNoiseFrame?.({
          arrivedAt,
          frameType,
          snippet,
        });
      } catch {
        // Inspection-only reporting must never change provider stream behavior.
      }
    };

    const transform = new TransformStream<Uint8Array, Uint8Array>({
      start(controller) {
        streamController = controller;
        resetIdleTimer();
      },
      async transform(chunk, controller) {
        resetIdleTimer();
        lastChunkAt = Date.now();
        buffer = concatenateBytes(buffer, chunk);
        let boundary = frameBoundary(buffer);
        while (boundary !== null) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary);
          await forwardOrReportFrame(frame, lastChunkAt, controller);
          boundary = frameBoundary(buffer);
        }
      },
      async flush(controller) {
        clearIdleTimer();
        if (buffer.byteLength > 0) {
          await forwardOrReportFrame(buffer, lastChunkAt, controller);
          buffer = new Uint8Array();
        }
        if (firstNoiseSnippet && !sawTerminalFrame) {
          throw new Error(
            `OpenAI Responses stream ended after a sanitized relay error frame: ${firstNoiseSnippet}`,
          );
        }
      },
    });
    const piping = response.body.pipeTo(transform.writable);
    void piping.catch(() => undefined).finally(clearIdleTimer);
    const body = transform.readable;

    const headers = new Headers(response.headers);
    headers.delete('content-length');
    return new Response(body, {
      headers,
      status: response.status,
      statusText: response.statusText,
    });
  };
}

function isEventStream(response: Response): boolean {
  return response.headers.get('content-type')
    ?.split(';', 1)[0]
    ?.trim()
    .toLowerCase() === 'text/event-stream';
}

function parseFrame(frame: Uint8Array): ParsedFrame {
  const lines = new TextDecoder().decode(frame).split(/\r\n|\r|\n/);
  const dataLines: string[] = [];
  for (const line of lines) {
    if (line === 'data') {
      dataLines.push('');
    } else if (line.startsWith('data:')) {
      const value = line.slice(5);
      dataLines.push(value.startsWith(' ') ? value.slice(1) : value);
    }
  }
  if (dataLines.length === 0) return { terminal: false, noise: null };
  const data = dataLines.join('\n');
  if (data.trim() === '[DONE]') return { terminal: false, noise: null };
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    return { terminal: false, noise: null };
  }
  if (!isRecord(value)) return { terminal: false, noise: null };
  const frameType = typeof value.type === 'string' ? value.type : null;
  const terminal = frameType !== null && TERMINAL_RESPONSE_TYPES.has(frameType);
  return {
    terminal,
    noise: hasNonEmptyError(value.error) && !terminal
      ? { value }
      : null,
  };
}

function frameBoundary(buffer: Uint8Array): number | null {
  for (let index = 0; index < buffer.byteLength; index += 1) {
    const firstLength = lineEndingLength(buffer, index);
    if (firstLength === 0) continue;
    const secondLength = lineEndingLength(buffer, index + firstLength);
    if (secondLength > 0) return index + firstLength + secondLength;
  }
  return null;
}

function lineEndingLength(buffer: Uint8Array, index: number): number {
  if (buffer[index] === 0x0a) return 1;
  if (buffer[index] !== 0x0d) return 0;
  return buffer[index + 1] === 0x0a ? 2 : 1;
}

function concatenateBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  if (left.byteLength === 0) return right.slice();
  const output = new Uint8Array(left.byteLength + right.byteLength);
  output.set(left);
  output.set(right, left.byteLength);
  return output;
}

function boundedSnippet(value: string): string {
  if (value.length <= MAX_NOISE_FRAME_SNIPPET_CHARS) return value;
  return `${value.slice(0, MAX_NOISE_FRAME_SNIPPET_CHARS)}...[truncated]`;
}

async function sanitizedNoiseSnippet(value: unknown): Promise<string> {
  const redacted = await redactSecretLikeTelemetry(value);
  return boundedSnippet(JSON.stringify(redacted.value));
}

async function sanitizedFrameType(value: unknown): Promise<string | null> {
  if (!isRecord(value) || typeof value.type !== 'string') return null;
  return boundedFrameType((await redactSecretLikeTelemetry(value.type)).value);
}

function boundedFrameType(value: string | null): string | null {
  if (value === null) return null;
  const bounded = Array.from(value.trim()).slice(0, MAX_NOISE_FRAME_TYPE_CODE_POINTS).join('');
  return bounded || null;
}

function hasNonEmptyError(value: unknown): boolean {
  if (value === null || value === undefined || value === false) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (isRecord(value)) return Object.keys(value).length > 0;
  return Boolean(value);
}

function normalizeIdleTimeout(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return RESPONSES_STREAM_IDLE_TIMEOUT_MS;
  return Math.max(1, Math.floor(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
