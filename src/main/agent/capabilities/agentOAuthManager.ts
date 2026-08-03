import { piModels } from '../../piModels';
import { createOAuthLoginManager } from './agentOAuth';
import {
  ensureProviderConfig,
  getProviderSettings,
  refreshProviderModels,
} from './agentSettings';

// Composition root for the OAuth sign-in manager: it injects the real pi-ai
// Models login/logout operations and the provider-config writes into the pure
// orchestration in `agentOAuth.ts`. Keeping this wiring out of that module means a
// unit test can import the orchestration without pulling in Electron / the secret
// store / pi-ai's runtime. main.ts imports the singleton from here.
export const oauthLoginManager = createOAuthLoginManager({
  login: async (providerId, interaction) => {
    await piModels().login(providerId, 'oauth', interaction);
  },
  ensureProviderConfig,
  refreshProviderModels: async (providerId) => {
    await refreshProviderModels(providerId);
  },
  logout: (providerId) => piModels().logout(providerId),
  getSettings: getProviderSettings,
});
