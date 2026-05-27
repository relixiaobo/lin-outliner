/// <reference types="vite/client" />
// Brand logos for the provider settings, vendored under
// `src/renderer/assets/provider-icons/<providerId>.svg` (see the README there
// for provenance). Vite resolves each SVG to an emitted asset URL at build
// time; providers without a vendored logo fall back to a monogram avatar.
const ICON_URLS = import.meta.glob('../../assets/provider-icons/*.svg', {
  eager: true,
  query: '?url',
  import: 'default',
}) as Record<string, string>;

const URL_BY_ID = new Map<string, string>();
for (const [path, url] of Object.entries(ICON_URLS)) {
  const file = path.slice(path.lastIndexOf('/') + 1);
  URL_BY_ID.set(file.replace(/\.svg$/, ''), url);
}

/** Resolve a provider's brand-logo URL, or `undefined` if none is vendored. */
export function providerIconUrl(providerId: string): string | undefined {
  return URL_BY_ID.get(providerId);
}
