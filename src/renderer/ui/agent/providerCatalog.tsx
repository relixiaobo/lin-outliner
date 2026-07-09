import type {
  AgentProviderConfigView,
  AgentProviderOption,
  AgentProviderSettingsView,
} from '../../api/types';
import type { Messages } from '../../../core/i18n';
import { providerIconSvg } from './providerIcon';
import {
  LOCAL_GATEWAY_PROVIDER_REGISTRY,
  localGatewayProviderDefinition,
} from '../../../core/localGatewayProviders';

// Pure provider-catalog helpers shared by the settings list (AgentSettingsView)
// and the standalone per-provider config window (ProviderConfigWindow): display
// names, brand avatar, credential/active derivation, auth notes, and docs links.
// Keeping them here (not on a component) lets the config window derive its own
// context from a fresh settings fetch without importing the whole settings view.

export const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  ...Object.fromEntries(LOCAL_GATEWAY_PROVIDER_REGISTRY.map((provider) => [provider.providerId, provider.name])),
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
  'minimax-cn': 'MiniMax (CN)',
  huggingface: 'Hugging Face',
  'kimi-coding': 'Kimi Coding',
  'github-copilot': 'GitHub Copilot',
  'amazon-bedrock': 'Amazon Bedrock',
  'vercel-ai-gateway': 'Vercel AI Gateway',
  'cloudflare-workers-ai': 'Cloudflare Workers AI',
  'cloudflare-ai-gateway': 'Cloudflare AI Gateway',
  opencode: 'OpenCode',
  'opencode-go': 'OpenCode Go',
  xiaomi: 'Xiaomi MiMo',
  'xiaomi-token-plan-cn': 'Xiaomi Token Plan (CN)',
  'xiaomi-token-plan-ams': 'Xiaomi Token Plan (AMS)',
  'xiaomi-token-plan-sgp': 'Xiaomi Token Plan (SGP)',
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
// CLASS now comes from main (`authKind`); the visible note + docs LABEL are i18n
// (t.providerCatalog.auth.*), keyed by provider id; the docsURL stays here (not
// localizable). These providers show the note in place of a key field; oauth
// providers use the sign-in flow (ProviderOAuthForm).
export interface ProviderAuthInfo {
  note: string;
  docsUrl?: string;
  docsLabel?: string;
}

// docsUrl per managed-credential provider (the localizable copy is in i18n).
const PROVIDER_AUTH_DOCS_URL: Record<string, string> = {
  'amazon-bedrock': 'https://docs.aws.amazon.com/bedrock/latest/userguide/getting-started.html',
  'google-vertex': 'https://cloud.google.com/docs/authentication/provide-credentials-adc',
};

// Resolve the managed-credential note + docs link for a provider, or undefined if
// it takes a normal API key. `t` supplies the localized note + docs label.
export function providerAuthInfo(providerId: string, t: Messages): ProviderAuthInfo | undefined {
  // Dynamic index: the cast asserts the key is present, so the runtime `if (!copy)`
  // guard below is the real safety (the typed-dictionary compile-time guarantee only
  // covers static `t.a.b` paths). Keep the guard if this is ever refactored.
  const copy = t.providerCatalog.auth[providerId as keyof typeof t.providerCatalog.auth];
  if (!copy) return undefined;
  const docsLabel = 'docsLabel' in copy ? copy.docsLabel : undefined;
  return { note: copy.note, docsUrl: PROVIDER_AUTH_DOCS_URL[providerId], docsLabel };
}

// docsUrl per oauth provider (the localizable hint + docs label live in i18n).
const OAUTH_SIGN_IN_DOCS_URL: Record<string, string> = {
  'github-copilot': 'https://github.com/features/copilot',
};

export interface OAuthSignInInfo {
  hint: string;
  docsUrl?: string;
  docsLabel?: string;
}

// Brand sign-in hint + docs link for an oauth provider, or undefined for a provider
// with no sign-in copy. The oauth CLASS is main's `authKind`; `t` supplies the copy.
// pi-ai exposes no separate "Claude Code" provider — the Anthropic OAuth flow IS the
// Claude subscription login (scopes include `user:sessions:claude_code`); the copy
// names it so it reads as that login, closing the "where's Claude Code?" gap.
export function oauthSignInInfo(providerId: string, t: Messages): OAuthSignInInfo | undefined {
  const copy = t.providerCatalog.oauth[providerId as keyof typeof t.providerCatalog.oauth];
  if (!copy) return undefined;
  // Only some providers carry a docs link (and thus a docsLabel); narrow safely so
  // the heterogeneous message union still type-checks.
  const docsLabel = 'docsLabel' in copy ? copy.docsLabel : undefined;
  return { hint: copy.hint, docsUrl: OAUTH_SIGN_IN_DOCS_URL[providerId], docsLabel };
}

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

export function providerDescription(catalog: AgentProviderOption | undefined, t: Messages): string {
  const localGatewayProvider = catalog ? localGatewayProviderDefinition(catalog.providerId) : undefined;
  if (localGatewayProvider?.descriptionKey) return t.providerCatalog[localGatewayProvider.descriptionKey];
  if (!catalog || catalog.models.length === 0) return t.providerCatalog.openAiCompatible;
  const names = catalog.models.slice(0, 3).map((model) => model.name.replace(/\s*\(latest\)/i, ''));
  const hasMore = catalog.models.length > names.length;
  return t.providerCatalog.includesModels({ models: names.join(', '), more: hasMore });
}

// The provider-usability predicates live in a glob-free module (no icon imports)
// so lightweight consumers and unit tests can use them without pulling in the
// asset glob; re-exported here for the existing catalog import sites.
export { providerHasCredential, isProviderUsable, resolveUsableActiveProvider } from './providerUsability';
