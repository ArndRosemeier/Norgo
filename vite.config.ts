import { defineConfig } from 'vite';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  worker: { format: 'es' },
  // host: true listens on all interfaces so a tablet on the same network can open the dev
  // server (http://<this-pc-LAN-IP>:5173). Plain http on a LAN IP is not a secure context —
  // see README "Playing on an iPad / tablet".
  server: { port: 5173, open: false, host: true },
  preview: { host: true },
  build: { target: 'es2022', chunkSizeWarningLimit: 4000, sourcemap: true },
});
