import { LOCAL_GATEWAY_PROVIDER_REGISTRY } from '../../../core/localGatewayProviders';

// Provider display names, split out of `providerCatalog` because that module
// inlines brand SVGs through `import.meta.glob`, which only exists under Vite.
// Naming a provider is needed on surfaces that must also load in a plain
// `bun test` (the model picker, its unit tests), so the pure string half lives
// here and `providerCatalog` re-exports it for its existing importers.

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
  baseten: 'Baseten',
  huggingface: 'Hugging Face',
  'kimi-coding': 'Kimi Coding',
  'qwen-token-plan': 'Qwen Token Plan',
  'qwen-token-plan-cn': 'Qwen Token Plan (CN)',
  'qwen-token-plan-individual': 'Qwen Token Plan Individual',
  radius: 'Radius',
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
  qwen: 'Qwen',
};

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
