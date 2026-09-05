export const STARTUP_STATE_CHANNEL = 'lin:startup-state';
export const STARTUP_GET_CHANNEL = 'lin:startup-get';
export const STARTUP_RETRY_CHANNEL = 'lin:startup-retry';
export const STARTUP_QUIT_CHANNEL = 'lin:startup-quit';

export type StartupState =
  | { readonly status: 'starting' }
  | { readonly status: 'ready' }
  | { readonly status: 'failed'; readonly step: string; readonly message: string };
