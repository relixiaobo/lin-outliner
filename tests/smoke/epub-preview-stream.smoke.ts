import { expect, test } from '@playwright/test';
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
    const result = await smoke.window.evaluate(async () => {
      const lin = window.lin;
      if (!lin) throw new Error('Missing preload API');
      const asset = await lin.invoke<{ id: string }>('ingest_asset', {
        kind: 'buffer',
        data: new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4]),
        mimeType: 'application/epub+zip',
        originalFilename: 'stream-smoke.epub',
      });
      try {
        const resolved = await lin.invoke<{
          source: { streamUrl?: string } | null;
        }>('preview_resolve_source', {
          target: { kind: 'asset', assetId: asset.id },
        });
        const streamUrl = resolved.source?.streamUrl;
        if (!streamUrl) throw new Error('Missing EPUB stream URL');

        const response = await fetch(streamUrl, {
          headers: { Range: 'bytes=0-3' },
        });
        const stableAssetFetchBlocked = await fetch(`asset://${asset.id}`)
          .then(() => false, () => true);
        return {
          bytes: Array.from(new Uint8Array(await response.arrayBuffer())),
          contentRange: response.headers.get('content-range'),
          stableAssetFetchBlocked,
          status: response.status,
        };
      } finally {
        await lin.invoke('delete_asset', { id: asset.id });
      }
    });

    expect(result).toEqual({
      bytes: [0x50, 0x4b, 0x03, 0x04],
      contentRange: 'bytes 0-3/8',
      stableAssetFetchBlocked: true,
      status: 206,
    });
  });
});
