import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Builds into `web/chart/`, which `app_server.py` serves at `/chart`.
 *
 * 默认改为**同源** `/chart/`：jsDelivr 的 `@main` 是按分支解析的，有新版本时
 * CDN 可能还指着旧提交——新构建出的 `layouts-*.js` 之类懒加载分块会 404，
 * 而且浏览器缓存了旧 HTML 时更容易踩到。同源资源由 app_server 直接发，
 * 文件名带内容哈希 + `Cache-Control: immutable`，既不会 404 也不会重复下载。
 *
 * 需要 CDN 时可以显式指定：
 *   CHART_BASE='https://cdn.jsdelivr.net/gh/26055423/SyncNote@<固定提交>/web/chart/' npm run build
 * （务必钉到具体提交，不要用 @main）
 */
const CHART_BASE = process.env.CHART_BASE ?? '/chart/';

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
