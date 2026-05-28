import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(here, 'package.json'), 'utf-8')) as {
  version: string;
};

// v0.10.5 — base path resolution.
//
// Electron loads the bundle via file:// (mainWindow.loadFile), so the
// HTML's asset references MUST be relative (`./assets/...`) — absolute
// `/assets/...` would resolve to the filesystem root and 404.
//
// Vercel loads the bundle via https:// at deeper URLs like
// /auth/microsoft/callback or /voicemail/123/play. Relative asset
// references resolve against the current URL path, so /assets/...
// becomes /auth/microsoft/assets/... which doesn't exist → 404, blank
// page, React never mounts. Vercel needs absolute paths.
//
// Toggle via the VERCEL env var (Vercel sets it automatically during
// builds; absent locally so Electron builds get relative paths). If
// someone ever needs to build for absolute paths locally for some
// other host, set VITE_FORCE_ABSOLUTE_BASE=1.
const useAbsoluteBase = Boolean(process.env.VERCEL) || process.env.VITE_FORCE_ABSOLUTE_BASE === '1';
// eslint-disable-next-line no-console
console.log(`[vite] base = ${useAbsoluteBase ? '/' : './'} (VERCEL=${process.env.VERCEL ?? 'unset'})`);

export default defineConfig({
  base: useAbsoluteBase ? '/' : './',
  plugins: [react()],
  define: {
    // Bake the package version into the bundle so the UI can display it.
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  server: {
    port: 5173,
    strictPort: true, // fail loudly if 5173 is busy instead of silently switching to 5174
  },
});
