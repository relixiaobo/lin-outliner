import type {
  OutlineResponse,
  OutlineStreamRecord,
  WatchRequest,
} from '../../outline/contract/schemas';

export const OUTLINE_DESKTOP_REQUEST_CHANNEL = 'outline:request';
export const OUTLINE_DESKTOP_CANCEL_CHANNEL = 'outline:cancel';
export const OUTLINE_DESKTOP_SUBSCRIBE_CHANNEL = 'outline:subscribe';
export const OUTLINE_DESKTOP_UNSUBSCRIBE_CHANNEL = 'outline:unsubscribe';
export const OUTLINE_DESKTOP_STREAM_CHANNEL = 'outline:stream';

export interface OutlineDesktopRequest {
  readonly requestId: string;
  readonly command: string;
  readonly input: unknown;
}

export interface OutlineDesktopSubscription {
  readonly subscriptionId: string;
  readonly input: WatchRequest;
}

export interface OutlineDesktopStreamMessage {
  readonly subscriptionId: string;
  readonly record: OutlineStreamRecord;
}

export type OutlineDesktopResponse = OutlineResponse;

export function decodeOutlineDesktopRequest(value: unknown): OutlineDesktopRequest {
  if (!isRecord(value)
    || !validDesktopId(value.requestId)
    || typeof value.command !== 'string'
    || value.command.length < 1
    || value.command.length > 128
    || !Object.hasOwn(value, 'input')) {
    throw new Error('Invalid desktop Outline request.');
  }
  return {
    requestId: value.requestId,
    command: value.command,
    input: value.input,
  };
}

export function decodeOutlineDesktopSubscription(value: unknown): OutlineDesktopSubscription {
  if (!isRecord(value) || !validDesktopId(value.subscriptionId) || !isRecord(value.input)) {
    throw new Error('Invalid desktop Outline subscription.');
  }
  return {
    subscriptionId: value.subscriptionId,
    input: value.input as unknown as WatchRequest,
  };
}

export function decodeOutlineDesktopId(value: unknown): string {
  if (!validDesktopId(value)) throw new Error('Invalid desktop Outline request identifier.');
  return value;
}

function validDesktopId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length >= 1
    && value.length <= 256
    && /^[A-Za-z0-9:._-]+$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
