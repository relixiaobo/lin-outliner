import React from 'react';
import ReactDOM from 'react-dom/client';
import { LauncherApp } from './LauncherApp';
import { I18nProvider } from '../i18n/I18nProvider';
import { installInputModalityTracking } from '../ui/focus/inputModality';
// Design tokens first (defines :root), then the dark media override, then the
// launcher's own rules that consume them. These are pure CSS custom-property
// sheets — no JS, no editor graph — so the launcher inherits the app's color /
// type / spacing / elevation system (design-system.md) while staying light.
import '../styles/tokens.css';
import '../styles/icons.css';
import '../styles/theme-dark.css';
// a11y.css MUST follow theme-dark.css (shared :root specificity, source order
// wins): it honors prefers-contrast / reduced-transparency / reduced-motion by
// re-pointing tokens, so the launcher gets B8 compliance for free.
import '../styles/a11y.css';
// The shared primitives the launcher actually renders (Button, Input) carry their
// styles in these sheets. Without them the classes resolve to nothing and the
// browser's DEFAULT control chrome shows through — which is why the footer's
// action hint rendered as a bordered UA button (a grey box in dark, an outlined
// box in light) no matter what launcher.css said about it. ~4KB of pure CSS: the
// "stay light" rule for this bundle is about the editor graph (ProseMirror /
// Shiki / markdown), not about the design system its own controls need.
import '../styles/button.css';
import '../styles/input.css';
import '../styles/launcher.css';

// Dedicated launcher renderer entry. Kept deliberately separate from the main
// app bundle (src/renderer/main.tsx) so the launcher window loads instantly and
// never pulls in ProseMirror / Shiki / markdown / the document projection.
// See docs/plans/lazy-like-global-launcher.md (bundle-bloat mitigation).

installInputModalityTracking();

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <I18nProvider>
      <LauncherApp />
    </I18nProvider>
  </React.StrictMode>,
);
