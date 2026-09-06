/**
 * Build config for the bridge's standalone office page.
 *
 * Separate from the app's build on purpose. The product is an RSC app that needs its own
 * server; the bridge needs one static page it can serve itself from a plain Node process,
 * on its own origin. That origin is the whole point — no CORS, no mixed content, and the
 * session data never leaves the machine.
 *
 * Output lands in `bridge/public/`, which `bridge/server.mjs` serves.
 */

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  root: fileURLToPath(new URL('./bridge/client', import.meta.url)),
  plugins: [react()],
  build: {
    outDir: fileURLToPath(new URL('./bridge/public', import.meta.url)),
    emptyOutDir: true,
    // A local tool served over loopback: readable output is worth more than the last
    // few kilobytes, and it makes the bundle auditable by whoever runs it.
    minify: false,
    sourcemap: true,
  },
  // No base path juggling: the bridge serves this at its root.
  base: '/',
});
