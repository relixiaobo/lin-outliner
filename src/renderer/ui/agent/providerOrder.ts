import { LOCAL_GATEWAY_PROVIDER_REGISTRY } from '../../../core/localGatewayProviders';

// Which provider leads when nothing else separates two of them. Its own module
// because both consumers — the settings provider list and the model picker —
// would otherwise have to import it through the other, and because it must stay
// free of asset imports (`providerCatalog` inlines brand SVGs via
// `import.meta.glob`, which only exists under Vite).
//
// Ordering only. It must never decide which model a Thread executes: a
// hand-maintained table picking someone's provider at runtime is how an unpinned
// Thread would silently migrate between connections.

export const PREFERRED_PROVIDER_ORDER = [
  'anthropic',
  'openai',
  ...LOCAL_GATEWAY_PROVIDER_REGISTRY.map((provider) => provider.providerId),
  'google',
  'openrouter',
];

export function preferredProviderIndex(providerId: string): number {
  const index = PREFERRED_PROVIDER_ORDER.indexOf(providerId);
  return index >= 0 ? index : PREFERRED_PROVIDER_ORDER.length;
}
