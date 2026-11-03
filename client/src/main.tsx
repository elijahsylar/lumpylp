import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import './index.css';

// Production only. In dev the worker caches the app shell (lumpylp-shell-v1)
// and then serves stale module URLs after Vite re-optimizes dependencies —
// which surfaces as two copies of React and a blank screen that survives
// restarting the dev server. Registering an existing install also has to be
// torn down, so unregister any worker left over from a previous dev session.
if ('serviceWorker' in navigator) {
  if (import.meta.env.PROD) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    });
  } else {
    navigator.serviceWorker.getRegistrations()
      .then((rs) => rs.forEach((r) => r.unregister()))
      .catch(() => {});
  }
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {/* Opt in to the v7 behaviours now: silences the two future-flag
        warnings React Router logs on every page load, and means the
        eventual v7 upgrade is not also a behaviour change. */}
    <BrowserRouter
      future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
    >
      <App />
    </BrowserRouter>
  </React.StrictMode>
);
