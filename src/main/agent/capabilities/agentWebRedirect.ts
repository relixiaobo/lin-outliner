import type {
  Event as ElectronEvent,
  WebContents,
  WebContentsWillNavigateEventParams,
  WebContentsWillRedirectEventParams,
} from 'electron';

export type RedirectTargetAdmission = (sourceUrl: string, targetUrl: string) => string | null;

// Resolve only the first main-frame redirect. preventDefault() runs inside the
// redirect event before the admitted target is returned to the caller.
export function interceptFirstMainFrameRedirect(
  webContents: WebContents,
  sourceUrl: string,
  timeoutMs: number,
  admitTarget: RedirectTargetAdmission,
  signal?: AbortSignal,
): Promise<string | null> {
  if (signal?.aborted) return Promise.resolve(null);

  return new Promise((resolve) => {
    let settled = false;
    const finish = (target: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      webContents.off('will-redirect', onRedirect);
      webContents.off('will-navigate', onNavigate);
      resolve(target);
    };
    const stop = () => {
      try {
        webContents.stop();
      } catch {
        // no-op
      }
    };
    const onRedirect = (
      event: ElectronEvent<WebContentsWillRedirectEventParams>,
      redirectUrl: string,
      _isInPlace: boolean,
      isMainFrame: boolean,
    ) => {
      if (!isMainFrame) return;
      event.preventDefault();
      stop();
      finish(admitTarget(sourceUrl, event.url || redirectUrl));
    };
    const onNavigate = (
      event: ElectronEvent<WebContentsWillNavigateEventParams>,
      _navigateUrl: string,
      _isInPlace: boolean,
      isMainFrame: boolean,
    ) => {
      if (!isMainFrame) return;
      event.preventDefault();
      stop();
      finish(null);
    };
    const onAbort = () => {
      stop();
      finish(null);
    };
    const timer = setTimeout(() => {
      stop();
      finish(null);
    }, timeoutMs);

    signal?.addEventListener('abort', onAbort, { once: true });
    webContents.on('will-redirect', onRedirect);
    webContents.on('will-navigate', onNavigate);
    void webContents.loadURL(sourceUrl).then(
      () => finish(null),
      () => finish(null),
    );
  });
}
