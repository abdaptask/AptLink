import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(here, 'package.json'), 'utf-8')) as {
  version: string;
};

export default defineConfig({
  // Use relative asset paths in the production build so the bundle works
  // when loaded via file:// inside Electron. Without this, index.html
  // references /assets/... which resolves to filesystem root and 404s.
  base: './',
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
