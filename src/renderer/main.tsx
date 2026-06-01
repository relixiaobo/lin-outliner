import React from 'react';
import ReactDOM from 'react-dom/client';
import {
  MAC_TRAFFIC_LIGHT_POSITION,
  MAC_TRAFFIC_LIGHT_SIZE,
  MAC_WINDOW_CORNER_RADIUS,
} from '../core/chromeGeometry';
import { windowSurfaceFromSearch } from '../core/settingsWindow';
import { App } from './ui/App';
import { SettingsWindow } from './ui/SettingsWindow';
import './styles/index.css';
import './styles/outliner.css';

// The same bundle serves the main window and the dedicated settings window; the
// surface is selected by a ?surface= query param the main process sets.
const surface = windowSurfaceFromSearch(window.location.search);

// Dark/light follows the OS automatically via @media (prefers-color-scheme) in
// tokens.css / theme-dark.css — no renderer theme bridge needed.

// Mark the document with the active OS window material so chrome surfaces turn
// translucent in the first painted frame (no opaque -> frosted flash). Only the
// main window carries a material; the settings window is an opaque Preferences
// surface, and the browser/dev preview has no material to show through.
const windowMaterial = window.lin?.windowMaterial ?? null;
if (windowMaterial && surface === 'main') {
  document.documentElement.dataset.windowMaterial = windowMaterial;
}

// Mirror the OS-window geometry (owned by core/chromeGeometry.ts, which the main
// process reads to build the native window) onto :root, so the renderer's layout
// — chrome strip height, the rail-toggle centreline, and the concentric rail
// radius (rail = --radius-window − gap) — derives from the SAME constants instead
// of a hand-kept CSS duplicate that can drift. Main surface only: that is where
// the custom native window (traffic lights + corner) actually exists; the dev /
// browser / settings surfaces fall back to the literals in tokens.css.
if (surface === 'main') {
  const root = document.documentElement.style;
  root.setProperty('--traffic-light-x', `${MAC_TRAFFIC_LIGHT_POSITION.x}px`);
  root.setProperty('--traffic-light-y', `${MAC_TRAFFIC_LIGHT_POSITION.y}px`);
  root.setProperty('--traffic-light-size', `${MAC_TRAFFIC_LIGHT_SIZE}px`);
  root.setProperty('--radius-window', `${MAC_WINDOW_CORNER_RADIUS}px`);
}

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    {surface === 'settings' ? <SettingsWindow /> : <App />}
  </React.StrictMode>,
);
