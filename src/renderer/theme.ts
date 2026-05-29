// Bridges the OS colour scheme to the [data-theme] CSS gate that tokens.css /
// theme-dark.css key off. The whole component + shell layer is now alpha-on-ink
// token-based (design-system rollout Phase 2), so dark is safe to follow the OS.
//
// Track B (#45) extends this to honour a persisted light / dark / system
// preference via nativeTheme.themeSource in the main process; today it simply
// mirrors the OS appearance. Setting data-theme explicitly (rather than relying
// on @media) keeps a single activation path that the in-app toggle can override.
export function initTheme(): void {
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  const apply = (dark: boolean): void => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  };
  apply(mq.matches);
  mq.addEventListener('change', (event) => apply(event.matches));
}
