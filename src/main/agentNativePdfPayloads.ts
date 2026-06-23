import type { Model } from '@earendil-works/pi-ai';
import type { AgentPayloadRef } from '../core/agentEventLog';

const NATIVE_PDF_MARKER_START = '<tenon-native-pdf>';
const NATIVE_PDF_MARKER_END = '</tenon-native-pdf>';
const NATIVE_PDF_APIS = new Set(['openai-responses', 'azure-openai-responses', 'openai-codex-responses']);

interface NativePdfMarker {
  payload: AgentPayloadRef;
  filename: string;
  label?: string;
}

interface ResponsesContentPart {
  type: string;
  text?: string;
  filename?: string;
  file_data?: string;
  [key: string]: unknown;
}

export function modelSupportsNativePdfPayloads(model: Pick<Model<any>, 'api'>): boolean {
  return NATIVE_PDF_APIS.has(String(model.api));
}

export function nativePdfPayloadRuntimeText(input: {
  payload: AgentPayloadRef;
  filename: string;
  label?: string;
}): string {
  const marker = JSON.stringify(input);
  const label = input.label ?? input.filename;
  return [
    `PDF document attached: ${label}`,
    `${NATIVE_PDF_MARKER_START}${marker}${NATIVE_PDF_MARKER_END}`,
  ].join('\n');
}

export async function attachNativePdfPayloadsToOpenAIResponsesPayload(
  payload: unknown,
  readPayload: (payload: AgentPayloadRef) => Promise<Buffer>,
): Promise<unknown | undefined> {
  if (!isRecord(payload) || !Array.isArray(payload.input)) return undefined;

  let changed = false;
  const input = [];
  for (const item of payload.input) {
    const nextItem = await attachNativePdfPayloadsToResponsesInputItem(item, readPayload);
    input.push(nextItem.value);
    changed ||= nextItem.changed;
  }

  return changed ? { ...payload, input } : undefined;
}

async function attachNativePdfPayloadsToResponsesInputItem(
  item: unknown,
  readPayload: (payload: AgentPayloadRef) => Promise<Buffer>,
): Promise<{ value: unknown; changed: boolean }> {
  if (!isRecord(item)) return { value: item, changed: false };

  if (item.type === 'function_call_output') {
    const output = await attachNativePdfPayloadsToResponsesOutput(item.output, readPayload);
    return output.changed
      ? { value: { ...item, output: output.value }, changed: true }
      : { value: item, changed: false };
  }

  if (Array.isArray(item.content)) {
    const content = await attachNativePdfPayloadsToResponsesContent(item.content, readPayload);
    return content.changed
      ? { value: { ...item, content: content.value }, changed: true }
      : { value: item, changed: false };
  }

  if (typeof item.content === 'string') {
    const content = await responsesContentFromNativePdfMarkers(item.content, readPayload);
    return content.changed
      ? { value: { ...item, content: content.value }, changed: true }
      : { value: item, changed: false };
  }

  return { value: item, changed: false };
}

async function attachNativePdfPayloadsToResponsesOutput(
  output: unknown,
  readPayload: (payload: AgentPayloadRef) => Promise<Buffer>,
): Promise<{ value: unknown; changed: boolean }> {
  if (typeof output === 'string') return responsesContentFromNativePdfMarkers(output, readPayload);
  if (Array.isArray(output)) return attachNativePdfPayloadsToResponsesContent(output, readPayload);
  return { value: output, changed: false };
}

async function attachNativePdfPayloadsToResponsesContent(
  content: unknown[],
  readPayload: (payload: AgentPayloadRef) => Promise<Buffer>,
): Promise<{ value: ResponsesContentPart[]; changed: boolean }> {
  let changed = false;
  const next: ResponsesContentPart[] = [];
  for (const part of content) {
    if (isRecord(part) && part.type === 'input_text' && typeof part.text === 'string') {
      const replacement = await responsesContentFromNativePdfMarkers(part.text, readPayload);
      if (replacement.changed) {
        next.push(...replacement.value);
        changed = true;
        continue;
      }
    }
    next.push(part as ResponsesContentPart);
  }
  return { value: next, changed };
}

async function responsesContentFromNativePdfMarkers(
  text: string,
  readPayload: (payload: AgentPayloadRef) => Promise<Buffer>,
): Promise<{ value: ResponsesContentPart[]; changed: boolean }> {
  const markers = [...findNativePdfMarkers(text)];
  if (markers.length === 0) return { value: [{ type: 'input_text', text }], changed: false };

  const parts: ResponsesContentPart[] = [];
  let cursor = 0;
  let changed = false;
  for (const marker of markers) {
    const before = text.slice(cursor, marker.start);
    if (before) parts.push({ type: 'input_text', text: before });
    cursor = marker.end;

    const parsed = parseNativePdfMarker(marker.body);
    if (!parsed) {
      parts.push({ type: 'input_text', text: text.slice(marker.start, marker.end) });
      continue;
    }

    try {
      const bytes = await readPayload(parsed.payload);
      parts.push({
        type: 'input_file',
        filename: parsed.filename,
        file_data: `data:application/pdf;base64,${bytes.toString('base64')}`,
      });
      changed = true;
    } catch {
      parts.push({
        type: 'input_text',
        text: `[PDF payload unavailable: ${parsed.filename}]`,
      });
      changed = true;
    }
  }

  const after = text.slice(cursor);
  if (after) parts.push({ type: 'input_text', text: after });
  return { value: parts.length > 0 ? parts : [{ type: 'input_text', text: '' }], changed };
}

function* findNativePdfMarkers(text: string): Generator<{ start: number; end: number; body: string }> {
  let searchFrom = 0;
  while (searchFrom < text.length) {
    const start = text.indexOf(NATIVE_PDF_MARKER_START, searchFrom);
    if (start < 0) return;
    const bodyStart = start + NATIVE_PDF_MARKER_START.length;
    const endStart = text.indexOf(NATIVE_PDF_MARKER_END, bodyStart);
    if (endStart < 0) return;
    const end = endStart + NATIVE_PDF_MARKER_END.length;
    yield { start, end, body: text.slice(bodyStart, endStart) };
    searchFrom = end;
  }
}

function parseNativePdfMarker(body: string): NativePdfMarker | null {
  try {
    const parsed = JSON.parse(body) as unknown;
    if (!isRecord(parsed) || !isPayloadRef(parsed.payload)) return null;
    const filename = typeof parsed.filename === 'string' && parsed.filename.trim()
      ? parsed.filename.trim()
      : `${parsed.payload.id}.pdf`;
    return {
      payload: parsed.payload,
      filename,
      ...(typeof parsed.label === 'string' && parsed.label ? { label: parsed.label } : {}),
    };
  } catch {
    return null;
  }
}

function isPayloadRef(value: unknown): value is AgentPayloadRef {
  return isRecord(value)
    && value.kind === 'payload_ref'
    && value.storage === 'file'
    && value.mimeType === 'application/pdf'
    && typeof value.id === 'string'
    && typeof value.byteLength === 'number'
    && typeof value.sha256 === 'string';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
