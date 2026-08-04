import type { ThreadResourceReference } from '../../../core/agent/protocol';
import {
  MAX_TOOL_PAYLOAD_IMAGE_BYTES,
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
  readonly input: ToolOutputImageAdmissionInput;
  readonly admission: ToolOutputImageAdmission;
}

interface ToolCallAdmissionState {
  acceptedImages: number;
  acceptedBytes: number;
  tail: Promise<void>;
  readonly producerAdmissions: Map<number, Promise<RecordedAdmission>>;
  readonly normalizerAdmissions: Map<number, Promise<RecordedAdmission>>;
  readonly acceptedProducerAdmissions: RecordedAdmission[];
}

export function createToolOutputImageAdmission(
  persistOutputImage: (
    dataBase64: string,
    mimeType: string,
  ) => Promise<ThreadResourceReference>,
): (input: ToolOutputImageAdmissionInput) => Promise<ToolOutputImageAdmission> {
  const calls = new Map<string, ToolCallAdmissionState>();

  return async (input) => {
    const state = calls.get(input.toolCallId) ?? createCallState();
    calls.set(input.toolCallId, state);
    if (input.role === 'normalizer') {
      // Refused producer images are absent from result content, so normalizer
      // indexes address the compacted sequence of accepted producer images.
      const produced = state.acceptedProducerAdmissions[input.imageIndex];
      if (produced && sameImage(produced, input)) {
        return repeatAdmission(produced, persistOutputImage);
      }
    }

    const admissions = input.role === 'producer'
      ? state.producerAdmissions
      : state.normalizerAdmissions;
    const existing = admissions.get(input.imageIndex);
    if (existing) {
      return repeatAdmission(await existing, persistOutputImage);
    }

    const pending = state.tail.then(async (): Promise<RecordedAdmission> => {
      const admission = await admitFirstImage(state, input, persistOutputImage);
      const recorded = { input, admission };
      if (input.role === 'producer' && admission.ok) {
        state.acceptedProducerAdmissions.push(recorded);
      }
      return recorded;
    });
    admissions.set(input.imageIndex, pending);
    state.tail = pending.then(() => undefined, () => undefined);
    return (await pending).admission;
  };
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

async function repeatAdmission(
  recorded: RecordedAdmission,
  persistOutputImage: (
    dataBase64: string,
    mimeType: string,
  ) => Promise<ThreadResourceReference>,
): Promise<ToolOutputImageAdmission> {
  if (!recorded.admission.ok) return recorded.admission;
  const accepted = recorded.admission;

  // The producer writes before returning its result, then the normalizer reaches
  // the same bytes. This second content-addressed write reuses the stored ref and
  // cannot double-charge the call budget or create a second resource.
  const ref = await persistOutputImage(
    recorded.input.dataBase64,
    accepted.mimeType,
  ).catch((error: unknown) => {
    if (isThreadResourceQuotaError(error)) return accepted.ref;
    throw error;
  });
  return { ...accepted, ref };
}

function sameImage(recorded: RecordedAdmission, input: ToolOutputImageAdmissionInput): boolean {
  return recorded.admission.ok
    && recorded.input.dataBase64 === input.dataBase64
    && recorded.admission.mimeType === dynamicImageMimeType(input.mimeType);
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
    if (isThreadResourceQuotaError(error)) return null;
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

function isThreadResourceQuotaError(error: unknown): boolean {
  return error instanceof Error && /\bquota\b/iu.test(error.message);
}

export const TOOL_OUTPUT_IMAGE_LIMITS = {
  maxImages: MAX_PERSISTED_TOOL_OUTPUT_IMAGES,
  maxImageBytes: MAX_TOOL_PAYLOAD_IMAGE_BYTES,
  maxCallBytes: MAX_PERSISTED_TOOL_OUTPUT_IMAGE_BYTES,
} as const;
