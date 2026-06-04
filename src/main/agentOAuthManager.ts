import type { OAuthProviderId } from '@earendil-works/pi-ai';
import { getOAuthProvider } from '@earendil-works/pi-ai/oauth';
import { createOAuthLoginManager } from './agentOAuth';
import {
  deleteProviderCredential,
  ensureProviderConfig,
  getProviderSettings,
  persistOAuthCredential,
} from './agentSettings';

// Composition root for the OAuth sign-in manager: it injects the real pi-ai
// provider lookup and the secret-store / provider-config writes into the pure
// orchestration in `agentOAuth.ts`. Keeping this wiring out of that module means a
// unit test can import the orchestration without pulling in Electron / the secret
// store / pi-ai's runtime. main.ts imports the singleton from here.
export const oauthLoginManager = createOAuthLoginManager({
  getProvider: (providerId) => getOAuthProvider(providerId as OAuthProviderId),
  persist: persistOAuthCredential,
  ensureProviderConfig,
  removeCredential: deleteProviderCredential,
  getSettings: getProviderSettings,
});
