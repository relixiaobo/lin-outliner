import { beforeEach, describe, expect, test } from 'bun:test';
import type { AuthInteraction } from '@earendil-works/pi-ai';
import type { AgentProviderSettingsView, OAuthLoginEventEnvelope } from '../../src/core/types';
import {
  createOAuthLoginManager,
  type OAuthLoginManager,
} from '../../src/main/agent/capabilities/agentOAuth';

// A marker settings view so tests can assert the manager returns getSettings().
const SETTINGS = { providers: [], availableProviders: [], agent: {} } as unknown as AgentProviderSettingsView;

let loginImpl: (providerId: string, interaction: AuthInteraction) => Promise<void>;
let ensured: string[];
let refreshed: string[];
let removed: string[];
let manager: OAuthLoginManager;

beforeEach(() => {
  ensured = [];
  refreshed = [];
  removed = [];
  loginImpl = async (providerId, interaction) => {
    if (providerId !== 'github-copilot') throw new Error(`Unknown OAuth provider: ${providerId}`);
    interaction.notify({ type: 'auth_url', url: 'https://example.test/auth' });
    interaction.notify({
      type: 'device_code',
      userCode: 'WXYZ-1234',
      verificationUri: 'https://example.test/device',
      expiresInSeconds: 900,
    });
    await interaction.prompt({
      type: 'select',
      message: 'Pick an org',
      options: [{ id: 'org-a', label: 'Org A' }],
    });
    await interaction.prompt({ type: 'text', message: 'Paste code' });
  };
  manager = createOAuthLoginManager({
    login: (providerId, interaction) => loginImpl(providerId, interaction),
    ensureProviderConfig: async (id) => {
      ensured.push(id);
    },
    refreshProviderModels: async (id) => {
      refreshed.push(id);
    },
    logout: async (id) => {
      removed.push(id);
    },
    getSettings: async () => SETTINGS,
  });
});

describe('oauth login manager', () => {
  test('bridges provider-owned interaction events and returns refreshed settings', async () => {
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
    expect(ensured).toEqual(['github-copilot']);
    expect(refreshed).toEqual(['github-copilot']);
    expect(events.map((e) => e.event.kind)).toEqual(['auth', 'device-code', 'select', 'prompt']);

    const deviceCode = events.find((e) => e.event.kind === 'device-code');
    expect(deviceCode?.event).toMatchObject({ userCode: 'WXYZ-1234', verificationUri: 'https://example.test/device' });
    // Every reply-needed event carries a requestId; passive ones don't.
    const select = events.find((e) => e.event.kind === 'select');
    expect(typeof (select?.event as { requestId?: string }).requestId).toBe('string');
  });

  test('unknown provider rejects', async () => {
    await expect(manager.startLogin('not-a-provider', () => {})).rejects.toThrow(/unknown oauth provider/i);
    expect(ensured).toHaveLength(0);
  });

  test('flow cancellation unwinds an awaiting provider prompt', async () => {
    const emit = (envelope: OAuthLoginEventEnvelope) => {
      // Cancel instead of answering the selection.
      if (envelope.event.kind === 'select') {
        queueMicrotask(() => manager.cancel('github-copilot'));
      }
    };
    await expect(manager.startLogin('github-copilot', emit)).rejects.toThrow(/cancelled/);
    expect(ensured).toHaveLength(0);
  });

  test('prompt-level abort unwinds a callback race and removes the pending reply', async () => {
    const promptAbort = new AbortController();
    loginImpl = async (_providerId, interaction) => {
      const reply = interaction.prompt({
        type: 'manual_code',
        message: 'Paste the callback code',
        signal: promptAbort.signal,
      });
      queueMicrotask(() => promptAbort.abort());
      await reply;
    };
    let requestId = '';

    await expect(manager.startLogin('github-copilot', (envelope) => {
      if (envelope.event.kind === 'manual-code') requestId = envelope.event.requestId;
    })).rejects.toThrow(/cancelled/);

    expect(requestId).toStartWith('oauth:github-copilot:');
    expect(() => manager.respond(requestId, 'late-code')).not.toThrow();
    expect(ensured).toHaveLength(0);
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
