import React from 'react';
import ReactDOM from 'react-dom/client';
import { windowSurfaceFromSearch } from '../core/settingsWindow';
import { App } from './ui/App';
import { SettingsWindow } from './ui/SettingsWindow';
import { initTheme } from './theme';
import './styles/index.css';
import './styles/outliner.css';

// The same bundle serves the main window and the dedicated settings window; the
// surface is selected by a ?surface= query param the main process sets.
const surface = windowSurfaceFromSearch(window.location.search);

// Follow the OS colour scheme (dark/light) on both surfaces.
initTheme();

// Mark the document with the active OS window material so chrome surfaces turn
// translucent in the first painted frame (no opaque -> frosted flash). Only the
// main window carries a material; the settings window is an opaque Preferences
// surface, and the browser/dev preview has no material to show through.
const windowMaterial = window.lin?.windowMaterial ?? null;
if (windowMaterial && surface === 'main') {
  document.documentElement.dataset.windowMaterial = windowMaterial;
}

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    {surface === 'settings' ? <SettingsWindow /> : <App />}
  </React.StrictMode>,
);
