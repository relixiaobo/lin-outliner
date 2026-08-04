import { createHash } from 'node:crypto';
import type { ThreadResourceReference } from '../../../core/agent/protocol';
import {
  MAX_TOOL_PAYLOAD_IMAGE_BYTES,
  ThreadResourceQuotaError,
  measureToolPayloadImage,
} from '../persistence/ToolPayloadStore';

export const MAX_PERSISTED_TOOL_OUTPUT_IMAGES = 16;
export const MAX_PERSISTED_TOOL_OUTPUT_IMAGE_BYTES = 20 * 1024 * 1024;

export type ToolOutputImageOmissionReason =
  | 'countLimit'
  | 'invalidBase64'
  | 'invalidMimeType'
  | 'imageByteLimit'
  | 'callByteLimit'
  | 'quotaExceeded';

export interface ToolOutputImageAdmissionInput {
  readonly toolCallId: string;
  readonly imageIndex: number;
  readonly role: 'producer' | 'normalizer';
  readonly dataBase64: string;
  readonly mimeType: unknown;
}

export type ToolOutputImageAdmission =
  | {
      readonly ok: true;
      readonly ref: ThreadResourceReference;
      readonly byteLength: number;
      readonly mimeType: string;
    }
  | {
      readonly ok: false;
      readonly reason: ToolOutputImageOmissionReason;
    };

interface RecordedAdmission {
  readonly admission: ToolOutputImageAdmission;
  readonly fingerprint: string | null;
}

interface ToolCallAdmissionState {
  acceptedImages: number;
  acceptedBytes: number;
  tail: Promise<void>;
  readonly producerAdmissions: Map<number, Promise<RecordedAdmission>>;
  readonly normalizerAdmissions: Map<number, Promise<RecordedAdmission>>;
  readonly acceptedProducerAdmissions: RecordedAdmission[];
}

export interface ToolOutputImageAdmissionHandler {
  (input: ToolOutputImageAdmissionInput): Promise<ToolOutputImageAdmission>;
  release?(toolCallId: string): void;
}

export function createToolOutputImageAdmission(
  persistOutputImage: (
    dataBase64: string,
    mimeType: string,
  ) => Promise<ThreadResourceReference>,
): ToolOutputImageAdmissionHandler {
  const calls = new Map<string, ToolCallAdmissionState>();

  const admit: ToolOutputImageAdmissionHandler = async (input) => {
    const state = calls.get(input.toolCallId) ?? createCallState();
    calls.set(input.toolCallId, state);
    if (input.role === 'normalizer') {
      // Refused producer images are absent from result content, so normalizer
      // indexes address the compacted sequence of accepted producer images.
      const produced = state.acceptedProducerAdmissions[input.imageIndex];
      if (produced && sameImage(produced, input)) {
        return produced.admission;
      }
    }

    const admissions = input.role === 'producer'
      ? state.producerAdmissions
      : state.normalizerAdmissions;
    const existing = admissions.get(input.imageIndex);
    if (existing) {
      return (await existing).admission;
    }

    const pending = state.tail.then(async (): Promise<RecordedAdmission> => {
      const admission = await admitFirstImage(state, input, persistOutputImage);
      const recorded = {
        admission,
        fingerprint: admission.ok ? imageFingerprint(input.dataBase64) : null,
      };
      if (input.role === 'producer' && admission.ok) {
        state.acceptedProducerAdmissions.push(recorded);
      }
      return recorded;
    });
    admissions.set(input.imageIndex, pending);
    state.tail = pending.then(() => undefined, () => undefined);
    return (await pending).admission;
  };
  admit.release = (toolCallId) => {
    calls.delete(toolCallId);
  };
  return admit;
}

function createCallState(): ToolCallAdmissionState {
  return {
    acceptedImages: 0,
    acceptedBytes: 0,
    tail: Promise.resolve(),
    producerAdmissions: new Map(),
    normalizerAdmissions: new Map(),
    acceptedProducerAdmissions: [],
  };
}

function sameImage(recorded: RecordedAdmission, input: ToolOutputImageAdmissionInput): boolean {
  return recorded.admission.ok
    && recorded.admission.mimeType === dynamicImageMimeType(input.mimeType)
    && recorded.fingerprint === imageFingerprint(input.dataBase64);
}

function imageFingerprint(dataBase64: string): string {
  return createHash('sha256').update(dataBase64, 'base64').digest('hex');
}

async function admitFirstImage(
  state: ToolCallAdmissionState,
  input: ToolOutputImageAdmissionInput,
  persistOutputImage: (
    dataBase64: string,
    mimeType: string,
  ) => Promise<ThreadResourceReference>,
): Promise<ToolOutputImageAdmission> {
  if (state.acceptedImages >= MAX_PERSISTED_TOOL_OUTPUT_IMAGES) {
    return { ok: false, reason: 'countLimit' };
  }
  const measurement = measureToolPayloadImage(input.dataBase64);
  if (!measurement.ok) return { ok: false, reason: measurement.reason };
  if (state.acceptedBytes + measurement.byteLength > MAX_PERSISTED_TOOL_OUTPUT_IMAGE_BYTES) {
    return { ok: false, reason: 'callByteLimit' };
  }
  const mimeType = dynamicImageMimeType(input.mimeType);
  if (!mimeType) return { ok: false, reason: 'invalidMimeType' };

  const ref = await persistOutputImage(input.dataBase64, mimeType).catch((error: unknown) => {
    if (error instanceof ThreadResourceQuotaError) return null;
    throw error;
  });
  if (!ref) return { ok: false, reason: 'quotaExceeded' };

  state.acceptedImages += 1;
  state.acceptedBytes += measurement.byteLength;
  return { ok: true, ref, byteLength: measurement.byteLength, mimeType };
}

function dynamicImageMimeType(value: unknown): string | null {
  if (value === undefined) return 'image/png';
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  return /^image\/[a-z0-9][a-z0-9.+-]*$/u.test(normalized) ? normalized : null;
}

export const TOOL_OUTPUT_IMAGE_LIMITS = {
  maxImages: MAX_PERSISTED_TOOL_OUTPUT_IMAGES,
  maxImageBytes: MAX_TOOL_PAYLOAD_IMAGE_BYTES,
  maxCallBytes: MAX_PERSISTED_TOOL_OUTPUT_IMAGE_BYTES,
} as const;
