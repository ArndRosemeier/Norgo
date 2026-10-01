import { defineConfig } from 'vite';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  worker: { format: 'es' },
  server: { port: 5173, open: false },
  build: { target: 'es2022', chunkSizeWarningLimit: 4000, sourcemap: true },
});
