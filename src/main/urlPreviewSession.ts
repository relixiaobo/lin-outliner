import type {
  HandlerDetails,
  Session,
  WebContents,
  WindowOpenHandlerResponse,
} from 'electron';
import { normalizePreviewHttpUrl } from '../core/preview';
import { isRendererPermissionAllowed } from './rendererPermissions';

type PreviewSession = Pick<
  Session,
  | 'clearAuthCache'
  | 'clearCache'
  | 'clearStorageData'
  | 'closeAllConnections'
  | 'cookies'
  | 'flushStorageData'
  | 'setPermissionCheckHandler'
  | 'setPermissionRequestHandler'
>;

type PreviewGuest = Pick<WebContents, 'isDestroyed' | 'loadURL'>;

const configuredSessions = new WeakSet<object>();

export function configureUrlPreviewSession(previewSession: PreviewSession): void {
  if (configuredSessions.has(previewSession)) return;
  configuredSessions.add(previewSession);

  previewSession.setPermissionRequestHandler((_contents, permission, callback) => {
    callback(isRendererPermissionAllowed(permission));
  });
  previewSession.setPermissionCheckHandler((_contents, permission) => (
    isRendererPermissionAllowed(permission)
  ));
}

export function createUrlPreviewWindowOpenHandler(
  guest: PreviewGuest,
  onNavigationError: (error: unknown) => void = () => undefined,
): (details: HandlerDetails) => WindowOpenHandlerResponse {
  return (details) => {
    const url = normalizePreviewHttpUrl(details.url);
    if (!url || details.postBody) return { action: 'deny' };

    queueMicrotask(() => {
      if (guest.isDestroyed()) return;
      const options = details.referrer.url ? { httpReferrer: details.referrer } : undefined;
      void guest.loadURL(url, options).catch(onNavigationError);
    });
    return { action: 'deny' };
  };
}

export async function clearUrlPreviewSessionData(previewSession: PreviewSession): Promise<void> {
  await previewSession.closeAllConnections();
  await Promise.all([
    previewSession.clearAuthCache(),
    previewSession.clearCache(),
    previewSession.clearStorageData(),
  ]);
  await previewSession.cookies.flushStore();
}

export async function flushUrlPreviewSession(previewSession: PreviewSession | null): Promise<void> {
  if (!previewSession) return;
  previewSession.flushStorageData();
  await previewSession.cookies.flushStore();
}
