import { defineConfig } from 'vite';

export default defineConfig({
  // 相对路径打包，dist/ 丢到任何静态托管（Cloudflare Pages / 子目录）都能直接跑
  base: './',
  build: {
    target: 'es2020',
    assetsInlineLimit: 4096,
  },
  server: {
    host: true,
    port: Number(process.env.PORT) || 5173,
  },
});
