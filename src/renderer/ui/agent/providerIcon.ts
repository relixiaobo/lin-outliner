/// <reference types="vite/client" />
// Brand logos for the provider settings, vendored under
// `src/renderer/assets/provider-icons/<providerId>.svg` (see the README there
// for provenance). They are imported as RAW markup (not asset URLs) so they can
// be inlined into the DOM — an inline `<svg>` inherits the page's CSS `color`, so
// monochrome marks that use `fill="currentColor"` (OpenAI, OpenRouter, Groq, …)
// follow the light/dark theme instead of rendering as a fixed black inside an
// `<img>`. Multicolour brand logos carry their own fills and are unaffected.
// Providers without a vendored logo fall back to a monogram avatar.
const ICON_SVGS = import.meta.glob('../../assets/provider-icons/*.svg', {
  eager: true,
  query: '?raw',
  import: 'default',
}) as Record<string, string>;

const SVG_BY_ID = new Map<string, string>();
for (const [path, raw] of Object.entries(ICON_SVGS)) {
  const file = path.slice(path.lastIndexOf('/') + 1);
  SVG_BY_ID.set(file.replace(/\.svg$/, ''), raw);
}

// Regional / plan variants of one brand that reuse its vendored mark rather than
// carry a near-identical copy per id (e.g. Xiaomi's token-plan endpoints all show
// the Xiaomi MiMo logo). Keyed variant id -> the id whose SVG file to reuse.
const ICON_ALIASES: Record<string, string> = {
  'xiaomi-token-plan-cn': 'xiaomi',
  'xiaomi-token-plan-ams': 'xiaomi',
  'xiaomi-token-plan-sgp': 'xiaomi',
};

/** Resolve a provider's brand-logo SVG markup, or `undefined` if none is vendored. */
export function providerIconSvg(providerId: string): string | undefined {
  return SVG_BY_ID.get(providerId) ?? SVG_BY_ID.get(ICON_ALIASES[providerId]);
}
