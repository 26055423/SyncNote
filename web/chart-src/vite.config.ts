import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Builds into `web/chart/`, which `app_server.py` serves at `/chart`.
 *
 * 静态资源走 jsDelivr（仓库是公开的）：从国内到新加坡的链路实测只有 20 KB/s，
 * 而同一个文件走 CDN 是 300 KB/s 以上。HTML 仍由自己的服务器返回，接口照旧同源。
 *
 * 想在完全自托管的机器上用本地资源，把 CHART_BASE 设成 '/chart/' 再构建即可。
 */
const CHART_BASE = process.env.CHART_BASE ?? 'https://cdn.jsdelivr.net/gh/26055423/SyncNote@main/web/chart/';

export default defineConfig({
  base: CHART_BASE,
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
