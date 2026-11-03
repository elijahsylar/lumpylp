/// <reference types="vite/client" />

// Pulls in Vite's ambient types, notably `import.meta.env` (PROD, DEV, MODE).
// main.tsx uses import.meta.env.PROD to keep the service worker out of dev,
// where it caches the app shell and then serves stale module URLs after a
// dependency re-optimization.
