import { expect, test } from '@playwright/test';
import { assetUrl } from '../../src/core/assets';
import { closeSmokeApp, launchSmokeApp, type SmokeApp } from './electronApp';

test.describe('EPUB preview stream', () => {
  let smoke: SmokeApp;

  test.beforeAll(async () => {
    smoke = await launchSmokeApp();
    await smoke.window.locator('#root').waitFor();
  });

  test.afterAll(async () => {
    await closeSmokeApp(smoke);
  });

  test('the packaged renderer can range-fetch a resolved asset stream', async () => {
    const assetId = await smoke.window.evaluate(async () => {
      const lin = window.lin;
      if (!lin) throw new Error('Missing preload API');
      const response = await lin.outline.request({
        requestId: `smoke:${Date.now()}`,
        command: 'asset ingest',
        input: {
          source: 'bytes',
          data: 'UEsDBAECAwQ=',
          mimeType: 'application/epub+zip',
          originalFilename: 'stream-smoke.epub',
        },
      });
      if (!response.ok) throw new Error(response.error.message);
      return (response.data as { assetId: string }).assetId;
    });
    const result = await smoke.window.evaluate(async ({ assetId: id, stableAssetUrl }) => {
      const lin = window.lin;
      if (!lin) throw new Error('Missing preload API');
      const resolved = await lin.invoke<{
        source: { streamUrl?: string } | null;
      }>('preview_resolve_source', {
        target: { kind: 'asset', assetId: id },
      });
      const streamUrl = resolved.source?.streamUrl;
      if (!streamUrl) throw new Error('Missing EPUB stream URL');

      const streamResponse = await fetch(streamUrl, {
        headers: { Range: 'bytes=0-3' },
      });
      const stableAssetFetchBlocked = await fetch(stableAssetUrl)
        .then(() => false, () => true);
      return {
        bytes: Array.from(new Uint8Array(await streamResponse.arrayBuffer())),
        contentRange: streamResponse.headers.get('content-range'),
        stableAssetFetchBlocked,
        status: streamResponse.status,
      };
    }, { assetId, stableAssetUrl: assetUrl(assetId) });

    expect(result).toEqual({
      bytes: [0x50, 0x4b, 0x03, 0x04],
      contentRange: 'bytes 0-3/8',
      stableAssetFetchBlocked: true,
      status: 206,
    });
  });
});
