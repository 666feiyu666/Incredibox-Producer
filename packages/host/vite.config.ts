import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const BRIDGE = process.env.IC_BRIDGE_URL ?? 'http://127.0.0.1:9451';

/**
 * 开发模式下 Vite 跑在 5173，把 /host（WebSocket）与 /health 代理到 Bridge，
 * 这样 Host UI 里永远只用同源地址，生产模式（Bridge 直接托管 dist）无需改配置。
 */
export default defineConfig({
  // 相对资源路径：Bridge 挂在 / 上托管、或以后挂到子路径都不用改配置
  // （注意 file:// 直接打开 dist/index.html 会被 Chrome 的模块 CORS 拦住，请用 http 访问）
  base: './',
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    strictPort: false,
    proxy: {
      '/host': { target: BRIDGE, ws: true, changeOrigin: true },
      '/health': { target: BRIDGE, changeOrigin: true },
      '/state': { target: BRIDGE, changeOrigin: true },
      '/eval': { target: BRIDGE, changeOrigin: true },
      '/sim': { target: BRIDGE, changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
  },
});
