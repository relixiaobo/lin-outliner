import React from 'react';
import ReactDOM from 'react-dom/client';
import { LauncherApp } from './LauncherApp';
// Design tokens first (defines :root), then the dark media override, then the
// launcher's own rules that consume them. These are pure CSS custom-property
// sheets — no JS, no editor graph — so the launcher inherits the app's color /
// type / spacing / elevation system (design-system.md) while staying light.
import '../styles/tokens.css';
import '../styles/theme-dark.css';
// a11y.css MUST follow theme-dark.css (shared :root specificity, source order
// wins): it honors prefers-contrast / reduced-transparency / reduced-motion by
// re-pointing tokens, so the launcher gets B8 compliance for free.
import '../styles/a11y.css';
import '../styles/launcher.css';

// Dedicated launcher renderer entry. Kept deliberately separate from the main
// app bundle (src/renderer/main.tsx) so the launcher window loads instantly and
// never pulls in ProseMirror / Shiki / markdown / the document projection.
// See docs/plans/lazy-like-global-launcher.md (bundle-bloat mitigation).

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <LauncherApp />
  </React.StrictMode>,
);
