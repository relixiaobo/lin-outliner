import { beforeEach, describe, expect, test } from 'bun:test';
import type { OAuthCredentials, OAuthLoginCallbacks, OAuthProviderInterface } from '@earendil-works/pi-ai';
import type { AgentProviderSettingsView, OAuthLoginEventEnvelope } from '../../src/core/types';
import { createOAuthLoginManager, type OAuthLoginManager } from '../../src/main/agentOAuth';

// A marker settings view so tests can assert the manager returns getSettings().
const SETTINGS = { providers: [], availableProviders: [], agent: {} } as unknown as AgentProviderSettingsView;

// A fake pi-ai OAuth provider whose login() drives the callbacks: opens an auth
// URL, shows a device code, asks the user to select, then prompts for a code.
// `onSelect` returning undefined (cancel) makes login() reject.
function fakeProvider(): OAuthProviderInterface {
  return {
    id: 'github-copilot',
    name: 'Fake',
    refreshToken: async (creds: OAuthCredentials) => creds,
    getApiKey: (creds: OAuthCredentials) => creds.access,
    login: async (cb: OAuthLoginCallbacks): Promise<OAuthCredentials> => {
      cb.onAuth({ url: 'https://example.test/auth' });
      cb.onDeviceCode({ userCode: 'WXYZ-1234', verificationUri: 'https://example.test/device', expiresInSeconds: 900 });
      const choice = await cb.onSelect({ message: 'Pick an org', options: [{ id: 'org-a', label: 'Org A' }] });
      if (choice === undefined) throw new Error('cancelled');
      const code = await cb.onPrompt({ message: 'Paste code' });
      return { refresh: 'refresh-token', access: `access:${choice}:${code}`, expires: 4242 };
    },
  };
}

let persisted: Array<[string, OAuthCredentials]>;
let removed: string[];
let provider: OAuthProviderInterface | undefined;
let manager: OAuthLoginManager;

beforeEach(() => {
  persisted = [];
  removed = [];
  provider = fakeProvider();
  manager = createOAuthLoginManager({
    getProvider: (id) => (id === provider?.id ? provider : undefined),
    persist: async (id, creds) => {
      persisted.push([id, creds]);
    },
    removeCredential: async (id) => {
      removed.push(id);
    },
    getSettings: async () => SETTINGS,
  });
});

describe('oauth login manager', () => {
  test('bridges callbacks to events, persists credentials, returns settings', async () => {
    const events: OAuthLoginEventEnvelope[] = [];
    const emit = (envelope: OAuthLoginEventEnvelope) => {
      events.push(envelope);
      // Auto-answer the reply-needed events as the renderer would.
      if (envelope.event.kind === 'select') {
        queueMicrotask(() => manager.respond(envelope.event.requestId as string, 'org-a'));
      }
      if (envelope.event.kind === 'prompt') {
        queueMicrotask(() => manager.respond(envelope.event.requestId as string, '5678'));
      }
    };

    const result = await manager.startLogin('github-copilot', emit);

    expect(result).toBe(SETTINGS);
    expect(persisted).toEqual([
      ['github-copilot', { refresh: 'refresh-token', access: 'access:org-a:5678', expires: 4242 }],
    ]);
    expect(events.map((e) => e.event.kind)).toEqual(['auth', 'device-code', 'select', 'prompt']);

    const deviceCode = events.find((e) => e.event.kind === 'device-code');
    expect(deviceCode?.event).toMatchObject({ userCode: 'WXYZ-1234', verificationUri: 'https://example.test/device' });
    // Every reply-needed event carries a requestId; passive ones don't.
    const select = events.find((e) => e.event.kind === 'select');
    expect(typeof (select?.event as { requestId?: string }).requestId).toBe('string');
  });

  test('unknown provider rejects', async () => {
    await expect(manager.startLogin('not-a-provider', () => {})).rejects.toThrow(/unknown oauth provider/);
    expect(persisted).toHaveLength(0);
  });

  test('cancel during a prompt unwinds the login without persisting', async () => {
    const emit = (envelope: OAuthLoginEventEnvelope) => {
      // Cancel instead of answering the selection.
      if (envelope.event.kind === 'select') {
        queueMicrotask(() => manager.cancel('github-copilot'));
      }
    };
    await expect(manager.startLogin('github-copilot', emit)).rejects.toThrow(/cancelled/);
    expect(persisted).toHaveLength(0);
  });

  test('respond after completion is a no-op (no stuck sessions)', async () => {
    const emit = (envelope: OAuthLoginEventEnvelope) => {
      if (envelope.event.kind === 'select') queueMicrotask(() => manager.respond(envelope.event.requestId as string, 'org-a'));
      if (envelope.event.kind === 'prompt') queueMicrotask(() => manager.respond(envelope.event.requestId as string, '0'));
    };
    await manager.startLogin('github-copilot', emit);
    // No active session remains; a stray respond must not throw.
    expect(() => manager.respond('oauth:github-copilot:1', 'late')).not.toThrow();
  });

  test('logout removes the credential and returns settings', async () => {
    const result = await manager.logout('github-copilot');
    expect(result).toBe(SETTINGS);
    expect(removed).toEqual(['github-copilot']);
  });
});
