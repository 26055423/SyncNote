import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Builds into `web/chart/`, which `app_server.py` serves at `/chart`.
 *
 * Everything stays same-origin: the page calls `/api/chart/...` on the same host, so
 * the production bundle needs no proxy and no token in the build.
 *
 * `base: '/chart/'` keeps the hashed asset URLs under the same prefix the server maps.
 */
export default defineConfig({
  base: '/chart/',
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5180,
    strictPort: true,
    proxy: {
      '/api': { target: 'http://127.0.0.1:18886', changeOrigin: false },
    },
  },
  build: {
    outDir: '../chart',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 1600,
  },
});
