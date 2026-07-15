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

const TRANSLATION_GUEST_SRC = readFileSync(
  join(import.meta.dir, '../../src/renderer/ui/preview/urlPageTranslationGuest.ts'),
  'utf8',
);

const PAGE_TRANSLATION_SRC = readFileSync(
  join(import.meta.dir, '../../src/main/pageTranslation.ts'),
  'utf8',
);

const TRANSLATION_GUEST_HOST_SRC = readFileSync(
  join(import.meta.dir, '../../src/main/urlPageTranslationGuest.ts'),
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

  test('translation keeps the guest unprivileged and inserts only inert text', () => {
    expect(TRANSLATION_GUEST_SRC).toContain("'input', 'textarea', 'select', 'option', 'button', 'form', 'nav'");
    expect(TRANSLATION_GUEST_SRC).toContain("'[contenteditable]'");
    expect(TRANSLATION_GUEST_SRC).toContain('translation.textContent = item.translation');
    expect(TRANSLATION_GUEST_SRC).not.toContain('translation.innerHTML');
    expect(TRANSLATION_GUEST_SRC).not.toContain('ipcRenderer');
    expect(TRANSLATION_GUEST_SRC).not.toContain('preload');
    expect(TRANSLATION_GUEST_SRC).not.toContain('webview.executeJavaScript(');
    expect(TRANSLATION_GUEST_HOST_SRC).toContain('executeJavaScriptInIsolatedWorld');
    expect(TRANSLATION_GUEST_HOST_SRC).toContain("guest.hostWebContents !== sender");
    expect(TRANSLATION_GUEST_HOST_SRC).toContain("guest.getType() !== 'webview'");
  });

  test('the scoped translation shortcut is intercepted by the hardened guest host', () => {
    expect(MAIN_SRC).toContain("webContents.on('before-input-event'");
    expect(MAIN_SRC).toContain("input.code === 'KeyA'");
    expect(MAIN_SRC).toContain('LIN_URL_PAGE_TRANSLATION_SHORTCUT_CHANNEL');
    expect(MAIN_SRC).toContain('contents.send(LIN_URL_PAGE_TRANSLATION_SHORTCUT_CHANNEL, webContents.id)');
  });

  test('translation validates bounded blocks and exact response ids in main', () => {
    expect(PAGE_TRANSLATION_SRC).toContain('URL_PAGE_TRANSLATION_MAX_BLOCKS');
    expect(PAGE_TRANSLATION_SRC).toContain('URL_PAGE_TRANSLATION_MAX_BATCH_CHARS');
    expect(PAGE_TRANSLATION_SRC).toContain('requestedIds.has(id)');
    expect(PAGE_TRANSLATION_SRC).toContain('translations.has(id)');
    expect(MAIN_SRC).toContain("event.sender !== mainWindow.webContents");
  });
});
