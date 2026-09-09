import type { AgentProviderStoredApiKey } from './types';

/** Display-only metadata. The concealed characters never cross into the renderer. */
export interface ProviderApiKeyPreview {
  prefix: string;
  mask: string;
  suffix: string;
  length: number;
}

export type ProviderApiKeyReadMode = 'preview' | 'reveal';
export type ProviderApiKeyReadResult<Mode extends ProviderApiKeyReadMode> = Mode extends 'preview'
  ? { providerId: string; preview?: ProviderApiKeyPreview }
  : AgentProviderStoredApiKey;

export function previewProviderApiKey(key: string): ProviderApiKeyPreview {
  const characters = Array.from(key);
  // At most four characters at either end; short keys keep at least half hidden.
  const visible = Math.min(4, Math.floor(characters.length / 4));
  return {
    prefix: characters.slice(0, visible).join(''),
    mask: '•'.repeat(characters.length - visible * 2),
    suffix: visible ? characters.slice(-visible).join('') : '',
    length: characters.length,
  };
}
