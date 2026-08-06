// OAuth providers whose provider-owned auth also accepts a normal pasted API
// key. GitHub Copilot is intentionally absent: its alternate token is an ambient
// integration token, not a user-facing API key.
export const OAUTH_API_KEY_FALLBACK = new Set<string>([
  'anthropic',
  'kimi-coding',
  'openrouter',
  'radius',
  'xai',
]);
