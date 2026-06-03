import type {
  OAuthCredentials,
  OAuthLoginCallbacks,
  OAuthProviderId,
  OAuthProviderInterface,
} from '@earendil-works/pi-ai';
import { getOAuthProvider } from '@earendil-works/pi-ai/oauth';
import type { AgentProviderSettingsView, OAuthLoginEvent, OAuthLoginEventEnvelope } from '../core/types';
import { deleteProviderCredential, getProviderSettings, persistOAuthCredential } from './agentSettings';

export type OAuthEventSink = (envelope: OAuthLoginEventEnvelope) => void;

/**
 * Dependencies are injected so the orchestration (callback bridging, response
 * correlation, cancellation) is unit-testable without Electron, the secret
 * store, or a real pi-ai provider. Production wires the real implementations
 * in `oauthLoginManager` below.
 */
export interface OAuthLoginDeps {
  getProvider: (providerId: string) => OAuthProviderInterface | undefined;
  persist: (providerId: string, credentials: OAuthCredentials) => Promise<void>;
  removeCredential: (providerId: string) => Promise<void>;
  getSettings: () => Promise<AgentProviderSettingsView>;
}

export interface OAuthLoginManager {
  /** Run a provider sign-in; resolves with the updated settings, rejects on failure/cancel. */
  startLogin(providerId: string, emit: OAuthEventSink): Promise<AgentProviderSettingsView>;
  /** Answer a `prompt` / `select` / `manual-code` event (undefined = the user cancelled). */
  respond(requestId: string, value: string | undefined): void;
  /** Abort an in-flight sign-in for a provider. */
  cancel(providerId: string): void;
  /** Sign out: drop the stored credential, return the updated settings. */
  logout(providerId: string): Promise<AgentProviderSettingsView>;
}

interface ActiveSession {
  abort: AbortController;
  pending: Map<string, (value: string | undefined) => void>;
}

export function createOAuthLoginManager(deps: OAuthLoginDeps): OAuthLoginManager {
  const sessions = new Map<string, ActiveSession>();
  let requestCounter = 0;

  function buildCallbacks(providerId: string, session: ActiveSession, emit: OAuthEventSink): OAuthLoginCallbacks {
    // Emit a reply-needed event and await the renderer's answer (or cancellation).
    const ask = (build: (requestId: string) => OAuthLoginEvent): Promise<string | undefined> => {
      const requestId = `oauth:${providerId}:${++requestCounter}`;
      return new Promise<string | undefined>((resolve) => {
        session.pending.set(requestId, resolve);
        emit({ providerId, event: build(requestId) });
      });
    };
    return {
      onAuth: (info) => emit({ providerId, event: { kind: 'auth', url: info.url, instructions: info.instructions } }),
      onDeviceCode: (info) =>
        emit({
          providerId,
          event: {
            kind: 'device-code',
            userCode: info.userCode,
            verificationUri: info.verificationUri,
            expiresInSeconds: info.expiresInSeconds,
          },
        }),
      onProgress: (message) => emit({ providerId, event: { kind: 'progress', message } }),
      onPrompt: async (prompt) =>
        (await ask((requestId) => ({ kind: 'prompt', requestId, message: prompt.message, placeholder: prompt.placeholder }))) ?? '',
      onManualCodeInput: async () => (await ask((requestId) => ({ kind: 'manual-code', requestId }))) ?? '',
      onSelect: (prompt) =>
        ask((requestId) => ({
          kind: 'select',
          requestId,
          message: prompt.message,
          options: prompt.options.map((option) => ({ id: option.id, label: option.label })),
        })),
      signal: session.abort.signal,
    };
  }

  async function startLogin(providerId: string, emit: OAuthEventSink): Promise<AgentProviderSettingsView> {
    const provider = deps.getProvider(providerId);
    if (!provider) throw new Error(`unknown oauth provider: ${providerId}`);
    cancel(providerId); // a second sign-in attempt replaces any in-flight one
    const session: ActiveSession = { abort: new AbortController(), pending: new Map() };
    sessions.set(providerId, session);
    try {
      const credentials = await provider.login(buildCallbacks(providerId, session, emit));
      await deps.persist(providerId, credentials);
      return await deps.getSettings();
    } finally {
      if (sessions.get(providerId) === session) sessions.delete(providerId);
    }
  }

  function respond(requestId: string, value: string | undefined): void {
    for (const session of sessions.values()) {
      const resolve = session.pending.get(requestId);
      if (resolve) {
        session.pending.delete(requestId);
        resolve(value);
        return;
      }
    }
  }

  function cancel(providerId: string): void {
    const session = sessions.get(providerId);
    if (!session) return;
    session.abort.abort();
    // Unblock any awaiting prompt so login() can unwind (undefined = cancelled).
    for (const [requestId, resolve] of session.pending) {
      session.pending.delete(requestId);
      resolve(undefined);
    }
  }

  async function logout(providerId: string): Promise<AgentProviderSettingsView> {
    cancel(providerId);
    await deps.removeCredential(providerId);
    return deps.getSettings();
  }

  return { startLogin, respond, cancel, logout };
}

export const oauthLoginManager = createOAuthLoginManager({
  getProvider: (providerId) => getOAuthProvider(providerId as OAuthProviderId),
  persist: persistOAuthCredential,
  removeCredential: deleteProviderCredential,
  getSettings: getProviderSettings,
});
