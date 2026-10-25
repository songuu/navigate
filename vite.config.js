import { defineConfig } from 'vite';
export default defineConfig({
  server: { proxy: { '/api/content': { target: process.env.CONTENT_PREVIEW_TARGET || 'http://127.0.0.1:5198', changeOrigin: false, configure(proxy){proxy.on('proxyReq',request=>request.setHeader('Host','songuu.top'));} } } },
  build: { target: 'es2022' }
});
