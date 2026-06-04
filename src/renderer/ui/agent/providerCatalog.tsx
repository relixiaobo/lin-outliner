import type {
  AgentProviderConfigView,
  AgentProviderOption,
  AgentProviderSettingsView,
} from '../../api/types';
import { providerIconSvg } from './providerIcon';

// Pure provider-catalog helpers shared by the settings list (AgentSettingsView)
// and the standalone per-provider config window (ProviderConfigWindow): display
// names, brand avatar, credential/active derivation, auth notes, and docs links.
// Keeping them here (not on a component) lets the config window derive its own
// context from a fresh settings fetch without importing the whole settings view.

export const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  'openai-codex': 'OpenAI Codex',
  'azure-openai-responses': 'Azure OpenAI',
  google: 'Google Gemini',
  'google-vertex': 'Google Vertex AI',
  openrouter: 'OpenRouter',
  deepseek: 'DeepSeek',
  xai: 'xAI',
  groq: 'Groq',
  mistral: 'Mistral',
  moonshotai: 'Moonshot AI',
  'moonshotai-cn': 'Moonshot AI (CN)',
  zai: 'Z.AI',
  together: 'Together AI',
  fireworks: 'Fireworks AI',
  cerebras: 'Cerebras',
  minimax: 'MiniMax',
  huggingface: 'Hugging Face',
  'kimi-coding': 'Kimi Coding',
  'github-copilot': 'GitHub Copilot',
};

// Tokens that should keep a specific casing when a provider id falls through to
// the generic title-case path (e.g. `cloudflare-ai-gateway` -> Cloudflare AI Gateway).
const NAME_TOKEN_OVERRIDES: Record<string, string> = {
  ai: 'AI',
  openai: 'OpenAI',
  api: 'API',
  cn: 'CN',
  ams: 'AMS',
  sgp: 'SGP',
  gpt: 'GPT',
  github: 'GitHub',
};

// Where to mint an API key, for the providers we can link directly. Omitted
// providers simply drop the helper link.
export const PROVIDER_DOCS_URL: Record<string, string> = {
  anthropic: 'https://console.anthropic.com/settings/keys',
  openai: 'https://platform.openai.com/api-keys',
  google: 'https://aistudio.google.com/app/apikey',
  openrouter: 'https://openrouter.ai/keys',
  deepseek: 'https://platform.deepseek.com/api_keys',
  xai: 'https://console.x.ai',
  groq: 'https://console.groq.com/keys',
  mistral: 'https://console.mistral.ai/api-keys',
};

// Presentation copy for providers that don't take a pasteable API key. The auth
// CLASS now comes from main (`authKind`); this table is copy-only (note + docs),
// keyed by provider id. Managed providers show the note in place of a key field;
// oauth providers use the sign-in flow (ProviderOAuthForm).
export interface ProviderAuthInfo {
  note: string;
  docsUrl?: string;
  docsLabel?: string;
}

export const PROVIDER_AUTH: Record<string, ProviderAuthInfo> = {
  'amazon-bedrock': {
    note: 'Bedrock uses your AWS credentials (a named profile, IAM role, or AWS_* environment variables) — there is no API key to paste here.',
    docsUrl: 'https://docs.aws.amazon.com/bedrock/latest/userguide/getting-started.html',
    docsLabel: 'AWS credential setup',
  },
  'google-vertex': {
    note: 'Vertex AI uses Google Cloud Application Default Credentials (run `gcloud auth application-default login`) — there is no API key to paste here.',
    docsUrl: 'https://cloud.google.com/docs/authentication/provide-credentials-adc',
    docsLabel: 'Set up ADC',
  },
};

// Brand sign-in label + a docs link for the oauth providers, used by the
// sign-in flow. Copy-only — the oauth CLASS is main's `authKind`.
export const OAUTH_SIGN_IN: Record<string, { hint: string; docsUrl?: string; docsLabel?: string }> = {
  anthropic: { hint: 'Sign in with your Claude Pro or Max subscription.' },
  'github-copilot': {
    hint: 'Sign in with your GitHub account — no API key to paste.',
    docsUrl: 'https://github.com/features/copilot',
    docsLabel: 'About GitHub Copilot',
  },
  'openai-codex': { hint: 'Sign in with your ChatGPT Plus or Pro subscription.' },
};

// OAuth providers that ALSO accept a pasted API key (Anthropic console keys). For
// these the sign-in form offers an "Use an API key instead" escape hatch back to
// the standard key form; the others are sign-in only.
export const OAUTH_API_KEY_FALLBACK = new Set<string>(['anthropic']);

export function formatProviderName(providerId: string): string {
  const known = PROVIDER_DISPLAY_NAMES[providerId];
  if (known) return known;
  return providerId
    .split(/[-_]/g)
    .filter(Boolean)
    .map((part) => NAME_TOKEN_OVERRIDES[part] ?? part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ') || providerId;
}

export function providerInitial(providerId: string): string {
  return (formatProviderName(providerId).trim()[0] ?? '?').toUpperCase();
}

// Brand avatar. The monogram fallback (no vendored logo) keeps a neutral fill so
// the letter reads; a vendored logo shows bare (no box). The SVG is INLINED so
// monochrome `fill="currentColor"` marks follow the theme via the avatar's color.
export function ProviderAvatar({ providerId, large }: { providerId: string; large?: boolean }) {
  const svg = providerIconSvg(providerId);
  const className = `settings-provider-avatar${large ? ' is-large' : ''}${svg ? ' has-logo' : ''}`;
  return (
    <span className={className} aria-hidden="true">
      {svg ? (
        // Trusted, build-time vendored brand SVGs (no remote/user input) — inlined
        // so `currentColor` marks follow the theme.
        <span className="settings-provider-logo" dangerouslySetInnerHTML={{ __html: svg }} />
      ) : providerInitial(providerId)}
    </span>
  );
}

export function providerDescription(catalog: AgentProviderOption | undefined): string {
  if (!catalog || catalog.models.length === 0) return 'Connect any OpenAI-compatible endpoint.';
  const names = catalog.models.slice(0, 3).map((model) => model.name.replace(/\s*\(latest\)/i, ''));
  const suffix = catalog.models.length > names.length ? ', and more' : '';
  return `Includes ${names.join(', ')}${suffix}.`;
}

export function getFallbackModelId(providerId: string): string {
  const lower = providerId.toLowerCase();
  if (lower.includes('anthropic') || lower.includes('claude')) {
    return 'claude-3-5-sonnet-latest';
  }
  if (lower.includes('google') || lower.includes('gemini')) {
    return 'gemini-2.5-flash';
  }
  return 'gpt-4o';
}

export function providerHasCredential(
  provider: AgentProviderConfigView | undefined,
  catalog: AgentProviderOption | undefined,
): boolean {
  // `auth.credentialed` is main's authoritative signal (stored key, oauth login,
  // env key, or managed ambient). Fall back to the catalog env flag for a
  // provider that has no view row yet (not configured).
  return Boolean(provider?.auth?.credentialed) || Boolean(catalog?.hasEnvApiKey);
}

export function resolveUsableActiveProvider(
  settings: AgentProviderSettingsView,
): AgentProviderConfigView | undefined {
  const isUsable = (provider: AgentProviderConfigView) => {
    const catalog = settings.availableProviders.find((candidate) => candidate.providerId === provider.providerId);
    return provider.enabled && providerHasCredential(provider, catalog);
  };
  return settings.activeProviderId
    ? settings.providers.find((provider) => provider.providerId === settings.activeProviderId && isUsable(provider))
      ?? settings.providers.find(isUsable)
    : settings.providers.find(isUsable);
}
