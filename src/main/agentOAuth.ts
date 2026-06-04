import type {
  OAuthCredentials,
  OAuthLoginCallbacks,
  OAuthProviderInterface,
} from '@earendil-works/pi-ai';
import type { AgentProviderSettingsView, OAuthLoginEvent, OAuthLoginEventEnvelope } from '../core/types';

// Pure orchestration: callback bridging, response correlation, cancellation. It
// imports nothing from Electron, the secret store, or pi-ai's runtime — only
// types (erased at build). The production composition root that injects the real
// provider/persist/settings lives in `agentOAuthManager.ts`, so loading this
// module (e.g. from a unit test) drags in no native dependency.

export type OAuthEventSink = (envelope: OAuthLoginEventEnvelope) => void;

export interface OAuthDeviceCodeInfo {
  userCode: string;
  verificationUri: string;
  expiresInSeconds?: number;
}

export type DeviceCodeOAuthLoginCallbacks = OAuthLoginCallbacks & {
  onDeviceCode?: (info: OAuthDeviceCodeInfo) => void;
};

/** Raised when a sign-in is cancelled (flow-level cancel or a per-step undefined answer). */
class OAuthCancelledError extends Error {
  constructor() {
    super('OAuth sign-in cancelled');
    this.name = 'OAuthCancelledError';
  }
}

/**
 * Dependencies are injected so the orchestration (callback bridging, response
 * correlation, cancellation) is unit-testable without Electron, the secret
 * store, or a real pi-ai provider. Production wires the real implementations
 * in `oauthLoginManager` below.
 */
export interface OAuthLoginDeps {
  getProvider: (providerId: string) => OAuthProviderInterface | undefined;
  persist: (providerId: string, credentials: OAuthCredentials) => Promise<void>;
  /** Create the provider's config row if missing, so a fresh login is selectable. */
  ensureProviderConfig: (providerId: string) => Promise<void>;
  removeCredential: (providerId: string) => Promise<void>;
  getSettings: () => Promise<AgentProviderSettingsView>;
}

export interface OAuthLoginManager {
  /** Run a provider sign-in; resolves with the updated settings, rejects on failure/cancel. */
  startLogin(providerId: string, emit: OAuthEventSink): Promise<AgentProviderSettingsView>;
  /** Answer a `prompt` / `select` / `manual-code` event (undefined = the user cancelled that step). */
  respond(requestId: string, value: string | undefined): void;
  /** Abort an in-flight sign-in for a provider. */
  cancel(providerId: string): void;
  /** Abort every in-flight sign-in (e.g. the config window closed or re-targeted). */
  cancelAll(): void;
  /** Sign out: drop the stored credential, return the updated settings. */
  logout(providerId: string): Promise<AgentProviderSettingsView>;
}

interface PendingReply {
  resolve: (value: string) => void;
  reject: (error: Error) => void;
}

interface ActiveSession {
  abort: AbortController;
  pending: Map<string, PendingReply>;
}

export function createOAuthLoginManager(deps: OAuthLoginDeps): OAuthLoginManager {
  const sessions = new Map<string, ActiveSession>();
  let requestCounter = 0;

  function buildCallbacks(providerId: string, session: ActiveSession, emit: OAuthEventSink): DeviceCodeOAuthLoginCallbacks {
    // Emit a reply-needed event and await the renderer's answer. Rejects (not an
    // empty string) on cancellation, so login() unwinds cleanly instead of being
    // fed a blank code that some provider loops surface as "missing code".
    const ask = (build: (requestId: string) => OAuthLoginEvent): Promise<string> => {
      const requestId = `oauth:${providerId}:${++requestCounter}`;
      return new Promise<string>((resolve, reject) => {
        session.pending.set(requestId, { resolve, reject });
        emit({ providerId, event: build(requestId) });
      });
    };
    return {
      onAuth: (info) => emit({ providerId, event: { kind: 'auth', url: info.url, instructions: info.instructions } }),
      onDeviceCode: (info: OAuthDeviceCodeInfo) =>
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
      onPrompt: (prompt) =>
        ask((requestId) => ({ kind: 'prompt', requestId, message: prompt.message, placeholder: prompt.placeholder })),
      onManualCodeInput: () => ask((requestId) => ({ kind: 'manual-code', requestId })),
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
      // A login with no config row would be orphaned (credential on disk but no
      // selectable provider). The api-key path upserts a row; the oauth path must
      // too — do it before getSettings so the returned view shows the connection.
      await deps.ensureProviderConfig(providerId);
      return await deps.getSettings();
    } finally {
      if (sessions.get(providerId) === session) sessions.delete(providerId);
    }
  }

  function respond(requestId: string, value: string | undefined): void {
    for (const session of sessions.values()) {
      const pending = session.pending.get(requestId);
      if (pending) {
        session.pending.delete(requestId);
        // The renderer only ever answers with a value; undefined means it cancelled
        // that step, which unwinds the login the same way a flow-level cancel does.
        if (value === undefined) pending.reject(new OAuthCancelledError());
        else pending.resolve(value);
        return;
      }
    }
  }

  function cancel(providerId: string): void {
    const session = sessions.get(providerId);
    if (!session) return;
    session.abort.abort();
    // Reject any awaiting prompt so login() rejects (a clean abort, not a blank answer).
    for (const [requestId, pending] of session.pending) {
      session.pending.delete(requestId);
      pending.reject(new OAuthCancelledError());
    }
  }

  function cancelAll(): void {
    for (const providerId of [...sessions.keys()]) cancel(providerId);
  }

  async function logout(providerId: string): Promise<AgentProviderSettingsView> {
    cancel(providerId);
    await deps.removeCredential(providerId);
    return deps.getSettings();
  }

  return { startLogin, respond, cancel, cancelAll, logout };
}
