import { describe, expect, mock, test } from 'bun:test';
import type { BrowserWindow, MessageBoxOptions, WebContents } from 'electron';
import { clearPreviewTranslationCacheFromSettings } from '../../src/main/previewTranslationCacheClear';

const labels = {
  translationDataClearConfirmAction: 'Clear Saved Translations',
  translationDataClearConfirmDetail: 'Visible translations remain.',
  translationDataClearConfirmMessage: 'Clear all saved translations?',
  translationDataClearConfirmTitle: 'Clear saved translations',
  translationDataCancelAction: 'Cancel',
};

function windowFixture(): { sender: WebContents; window: BrowserWindow } {
  const sender = {} as WebContents;
  return { sender, window: { webContents: sender } as BrowserWindow };
}

describe('preview translation cache settings clear', () => {
  test('rejects callers outside the live settings window', async () => {
    const fixture = windowFixture();
    const clear = mock(async () => undefined);
    const showMessageBox = mock(async () => ({ response: 0 }));

    const result = await clearPreviewTranslationCacheFromSettings(
      { sender: {} as WebContents },
      {
        cache: { clear },
        getSettingsWindow: () => fixture.window,
        labels: () => labels,
        showMessageBox,
      },
    );

    expect(result).toEqual({ status: 'failed', error: 'unavailable' });
    expect(showMessageBox).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();
  });

  test('uses a cancel-safe native confirmation before clearing', async () => {
    const fixture = windowFixture();
    const clear = mock(async () => undefined);
    let options: MessageBoxOptions | null = null;

    const result = await clearPreviewTranslationCacheFromSettings(
      { sender: fixture.sender },
      {
        cache: { clear },
        getSettingsWindow: () => fixture.window,
        labels: () => labels,
        showMessageBox: async (_window, nextOptions) => {
          options = nextOptions;
          return { response: 1 };
        },
      },
    );

    expect(result).toEqual({ status: 'canceled' });
    expect(clear).not.toHaveBeenCalled();
    expect(options).toMatchObject({
      buttons: ['Clear Saved Translations', 'Cancel'],
      cancelId: 1,
      defaultId: 1,
      message: 'Clear all saved translations?',
      noLink: true,
      type: 'warning',
    });
  });

  test('clears only after explicit confirmation', async () => {
    const fixture = windowFixture();
    const clear = mock(async () => undefined);

    const result = await clearPreviewTranslationCacheFromSettings(
      { sender: fixture.sender },
      {
        cache: { clear },
        getSettingsWindow: () => fixture.window,
        labels: () => labels,
        showMessageBox: async () => ({ response: 0 }),
      },
    );

    expect(result).toEqual({ status: 'cleared' });
    expect(clear).toHaveBeenCalledTimes(1);
  });

  test('maps a clear failure to bounded settings state', async () => {
    const fixture = windowFixture();
    const result = await clearPreviewTranslationCacheFromSettings(
      { sender: fixture.sender },
      {
        cache: { clear: async () => { throw new Error('private path'); } },
        getSettingsWindow: () => fixture.window,
        labels: () => labels,
        showMessageBox: async () => ({ response: 0 }),
      },
    );

    expect(result).toEqual({ status: 'failed', error: 'clear-failed' });
  });
});
