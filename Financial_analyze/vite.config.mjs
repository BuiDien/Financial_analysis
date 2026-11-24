import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));

// The app lives in src/ (index.html + modules). Using src/ as the Vite root, and
// limiting /@fs to src/ + node_modules/, keeps the dev server from serving anything
// else in this folder (backend/, helix.db, uploads/, .env).
// Port 5500 matches the backend's ALLOWED_ORIGINS (scripts/run.sh).
export default defineConfig({
  root: 'src',
  base: './',
  publicDir: 'public',
  plugins: [react()],
  // One local chunk is fine for a loopback app; silence the 500 kB advisory.
  build: { outDir: '../dist', emptyOutDir: true, chunkSizeWarningLimit: 1500 },
  server: {
    host: '127.0.0.1', port: 5500, strictPort: true,
    fs: { strict: true, allow: [here('./src'), here('./node_modules')] },
  },
  preview: { host: '127.0.0.1', port: 5500, strictPort: true },
});
