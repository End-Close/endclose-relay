import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Admin status UI. Builds into dist/admin-ui, served by the admin server (:8081) —
// fully self-contained, no CDN assets (customer egress allowlists stay tight).
// Dev: `pnpm dev:ui` on :5173 proxies API calls to the running relay.
export default defineConfig({
  root: 'ui',
  plugins: [react(), tailwindcss()],
  build: {
    outDir: '../dist/admin-ui',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: Object.fromEntries(
      ['/status', '/events', '/audit', '/config', '/killswitch', '/routes'].map((p) => [
        p,
        { target: 'http://127.0.0.1:8081', changeOrigin: true },
      ]),
    ),
  },
})
