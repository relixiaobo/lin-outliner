import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const MAIN_SRC = readFileSync(
  join(import.meta.dir, '../../src/main/main.ts'),
  'utf8',
);

const PREVIEW_RENDERERS_SRC = readFileSync(
  join(import.meta.dir, '../../src/renderer/ui/preview/previewRenderers.tsx'),
  'utf8',
);

describe('URL preview webview security posture', () => {
  test('the main window enables webview only behind attach-time hardening', () => {
    expect(MAIN_SRC).toContain('webviewTag: true');
    expect(MAIN_SRC).toContain("contents.on('will-attach-webview'");
    expect(MAIN_SRC).toContain("contents.on('did-attach-webview'");
  });

  test('webview attach strips preload and keeps remote content sandboxed', () => {
    expect(MAIN_SRC).toContain('delete webPreferences.preload');
    expect(MAIN_SRC).toContain('webPreferences.contextIsolation = true');
    expect(MAIN_SRC).toContain('webPreferences.nodeIntegration = false');
    expect(MAIN_SRC).toContain('webPreferences.nodeIntegrationInSubFrames = false');
    expect(MAIN_SRC).toContain('webPreferences.nodeIntegrationInWorker = false');
    expect(MAIN_SRC).toContain('webPreferences.partition = URL_PREVIEW_WEBVIEW_PARTITION');
    expect(MAIN_SRC).toContain('webPreferences.sandbox = true');
    expect(MAIN_SRC).toContain('webPreferences.webSecurity = true');
    expect(MAIN_SRC).toContain('webPreferences.allowRunningInsecureContent = false');
    expect(MAIN_SRC).toContain('webPreferences.disableDialogs = true');
    expect(MAIN_SRC).toContain('webPreferences.navigateOnDragDrop = false');
    expect(MAIN_SRC).toContain('delete params.preload');
    expect(MAIN_SRC).toContain('delete params.webpreferences');
    expect(MAIN_SRC).toContain('normalizePreviewHttpUrl(src)');
    expect(MAIN_SRC).toContain('normalizePreviewHttpUrl(url)');
    expect(MAIN_SRC).toContain('params.partition = URL_PREVIEW_WEBVIEW_PARTITION');
    expect(MAIN_SRC).not.toContain('params.partition !== URL_PREVIEW_WEBVIEW_PARTITION');
    expect(MAIN_SRC).toContain('webContents.session.setPermissionRequestHandler');
    expect(MAIN_SRC).toContain('webContents.session.setPermissionCheckHandler');
  });

  test('the renderer URL preview does not request privileged webview features', () => {
    const webview = PREVIEW_RENDERERS_SRC.match(/<webview[\s\S]*?\/>/)?.[0] ?? '';
    expect(webview).toContain('<webview');
    expect(webview).toContain('partition="url-preview"');
    expect(PREVIEW_RENDERERS_SRC).not.toContain("addEventListener('did-stop-loading'");
    expect(PREVIEW_RENDERERS_SRC).not.toContain('file-preview-url-loading');
    expect(webview).not.toContain('preload=');
    expect(webview).not.toContain('nodeintegration');
    expect(webview).not.toContain('disablewebsecurity');
    expect(webview).not.toContain('allowpopups');
  });
});
