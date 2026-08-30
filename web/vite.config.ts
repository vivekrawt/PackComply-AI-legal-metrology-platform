import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:4000',
        changeOrigin: false,
        // Without this, a stopped backend surfaces as an opaque 500 in the UI.
        configure: (proxy) => {
          proxy.on('error', (_err, _req, res: any) => {
            if (res && !res.headersSent && typeof res.writeHead === 'function') {
              res.writeHead(502, { 'Content-Type': 'application/json' });
            }
            res?.end?.(JSON.stringify({
              error: {
                code: 'BACKEND_UNREACHABLE',
                message: 'API server (http://localhost:4000) is not running. Start it with: cd server && npm run dev — or run "npm run dev" from the repo root to start both.',
              },
            }));
          });
        },
      },
    },
  },
  build: { outDir: 'dist', sourcemap: false },
});
