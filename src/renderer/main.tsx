import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './ui/App';
import './styles.css';
import './styles/outliner.css';

// Mark the document with the active OS window material so chrome surfaces turn
// translucent in the first painted frame (no opaque -> frosted flash). Absent in
// the browser/dev preview, where there is no material to show through.
const windowMaterial = window.lin?.windowMaterial ?? null;
if (windowMaterial) document.documentElement.dataset.windowMaterial = windowMaterial;

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
