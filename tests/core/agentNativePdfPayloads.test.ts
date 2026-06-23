import { describe, expect, test } from 'bun:test';
import type { AgentPayloadRef } from '../../src/core/agentEventLog';
import {
  attachNativePdfPayloadsToOpenAIResponsesPayload,
  modelSupportsNativePdfPayloads,
  nativePdfPayloadRuntimeText,
} from '../../src/main/agentNativePdfPayloads';

function pdfPayloadRef(): AgentPayloadRef {
  return {
    kind: 'payload_ref',
    id: 'payload-pdf',
    storage: 'file',
    mimeType: 'application/pdf',
    byteLength: 8,
    sha256: 'sha256',
    scope: { type: 'conversation', conversationId: 'conversation-1' },
    role: 'source',
    summary: 'sample.pdf',
  };
}

describe('native PDF payloads', () => {
  test('model support is limited to OpenAI Responses APIs', () => {
    expect(modelSupportsNativePdfPayloads({ api: 'openai-responses' } as any)).toBe(true);
    expect(modelSupportsNativePdfPayloads({ api: 'azure-openai-responses' } as any)).toBe(true);
    expect(modelSupportsNativePdfPayloads({ api: 'anthropic-messages' } as any)).toBe(false);
  });

  test('rewrites native PDF markers into OpenAI Responses input_file parts', async () => {
    const payloadRef = pdfPayloadRef();
    const marker = nativePdfPayloadRuntimeText({
      payload: payloadRef,
      filename: 'sample.pdf',
      label: 'PDF file read: sample.pdf (8 B)',
    });

    const transformed = await attachNativePdfPayloadsToOpenAIResponsesPayload({
      input: [{
        type: 'function_call_output',
        call_id: 'call-1',
        output: `file_read result\n${marker}\nready`,
      }],
    }, async (payload) => {
      expect(payload.id).toBe(payloadRef.id);
      return Buffer.from('%PDF-1.4');
    }) as {
      input: Array<{ output: Array<{ type: string; text?: string; filename?: string; file_data?: string }> }>;
    };

    const output = transformed.input[0]!.output;
    expect(output[0]).toEqual({ type: 'input_text', text: 'file_read result\nPDF document attached: PDF file read: sample.pdf (8 B)\n' });
    expect(output[1]).toEqual({
      type: 'input_file',
      filename: 'sample.pdf',
      file_data: `data:application/pdf;base64,${Buffer.from('%PDF-1.4').toString('base64')}`,
    });
    expect(output[2]).toEqual({ type: 'input_text', text: '\nready' });
  });
});
