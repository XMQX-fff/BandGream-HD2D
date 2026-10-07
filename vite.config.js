import { defineConfig } from 'vite';

export default defineConfig({
  // host 必须绑 0.0.0.0；allowedHosts 允许部署域名反代，
  // 否则 Vite 会以 "Blocked request. This host is not allowed." 拒绝请求。
  server: { host: '0.0.0.0', port: 5173, allowedHosts: true },
  preview: { host: '0.0.0.0', port: 4173, allowedHosts: true },
  build: { target: 'es2022', chunkSizeWarningLimit: 2000 }
});