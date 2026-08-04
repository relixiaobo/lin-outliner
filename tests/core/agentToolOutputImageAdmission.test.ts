import { describe, expect, test } from 'bun:test';
import {
  MAX_TOOL_PAYLOAD_IMAGE_BASE64_CHARS,
  ThreadResourceQuotaError,
} from '../../src/main/agent/persistence/ToolPayloadStore';
import {
  MAX_PERSISTED_TOOL_OUTPUT_IMAGES,
  createToolOutputImageAdmission,
} from '../../src/main/agent/runtime/ToolOutputImageAdmission';

const SMALL_IMAGE_BASE64 = Buffer.from('small-image').toString('base64');

describe('tool output image admission', () => {
  test('reuses a persisted verdict without charging or writing twice', async () => {
    let writes = 0;
    const admit = createToolOutputImageAdmission(async (dataBase64, mimeType) => {
      writes += 1;
      return imageRef(dataBase64, mimeType);
    });

    const first = await admit(imageInput('call-1', 0, 'producer'));
    const repeated = await admit(imageInput('call-1', 0, 'normalizer'));
    expect(first).toEqual(repeated);

    for (let index = 1; index < MAX_PERSISTED_TOOL_OUTPUT_IMAGES; index += 1) {
      expect(await admit(imageInput('call-1', index))).toMatchObject({ ok: true });
    }
    expect(await admit(imageInput('call-1', MAX_PERSISTED_TOOL_OUTPUT_IMAGES))).toEqual({
      ok: false,
      reason: 'countLimit',
    });
    expect(writes).toBe(MAX_PERSISTED_TOOL_OUTPUT_IMAGES);
  });

  test('maps compacted normalizer indexes to accepted producer images', async () => {
    let writes = 0;
    const admit = createToolOutputImageAdmission(async (dataBase64, mimeType) => {
      writes += 1;
      return imageRef(dataBase64, mimeType);
    });
    const acceptedBase64 = Buffer.from('accepted-image').toString('base64');

    expect(await admit({
      ...imageInput('call-with-gap', 0, 'producer'),
      dataBase64: '***',
    })).toEqual({ ok: false, reason: 'invalidBase64' });
    const produced = await admit({
      ...imageInput('call-with-gap', 1, 'producer'),
      dataBase64: acceptedBase64,
    });
    const normalized = await admit({
      ...imageInput('call-with-gap', 0, 'normalizer'),
      dataBase64: acceptedBase64,
    });

    expect(normalized).toEqual(produced);
    expect(writes).toBe(1);
  });

  test('records base64, byte, MIME, and quota refusals per image', async () => {
    const admitted = createToolOutputImageAdmission(async (dataBase64, mimeType) => (
      imageRef(dataBase64, mimeType)
    ));
    expect(await admitted({
      ...imageInput('invalid-base64', 0),
      dataBase64: '***',
    })).toEqual({ ok: false, reason: 'invalidBase64' });
    expect(await admitted({
      ...imageInput('too-large', 0),
      dataBase64: 'A'.repeat(MAX_TOOL_PAYLOAD_IMAGE_BASE64_CHARS + 1),
    })).toEqual({ ok: false, reason: 'imageByteLimit' });
    expect(await admitted({
      ...imageInput('invalid-mime', 0),
      mimeType: 'text/plain',
    })).toEqual({ ok: false, reason: 'invalidMimeType' });

    let quotaWrites = 0;
    const quotaLimited = createToolOutputImageAdmission(async () => {
      quotaWrites += 1;
      throw new ThreadResourceQuotaError();
    });
    expect(await quotaLimited(imageInput('quota', 0))).toEqual({ ok: false, reason: 'quotaExceeded' });
    expect(await quotaLimited(imageInput('quota', 0))).toEqual({ ok: false, reason: 'quotaExceeded' });
    expect(quotaWrites).toBe(1);
  });

  test('does not classify unrelated error text as a Thread quota refusal', async () => {
    const admitted = createToolOutputImageAdmission(async () => {
      throw new Error('The provider quota record could not be decoded.');
    });
    await expect(admitted(imageInput('unrelated-quota-text', 0)))
      .rejects.toThrow('could not be decoded');
  });

  test('releases per-call memo state after normalization completes', async () => {
    let writes = 0;
    const admit = createToolOutputImageAdmission(async (dataBase64, mimeType) => {
      writes += 1;
      return imageRef(dataBase64, mimeType);
    });

    expect(await admit(imageInput('released-call', 0))).toMatchObject({ ok: true });
    admit.release?.('released-call');
    expect(await admit(imageInput('released-call', 0))).toMatchObject({ ok: true });
    expect(writes).toBe(2);
  });
});

function imageInput(
  toolCallId: string,
  imageIndex: number,
  role: 'producer' | 'normalizer' = 'normalizer',
) {
  return {
    toolCallId,
    imageIndex,
    role,
    dataBase64: SMALL_IMAGE_BASE64,
    mimeType: 'image/png',
  };
}

function imageRef(dataBase64: string, mimeType: string) {
  return {
    id: 'a'.repeat(64),
    mimeType,
    byteLength: Buffer.from(dataBase64, 'base64').byteLength,
    fileName: 'tool-output.png',
  };
}
