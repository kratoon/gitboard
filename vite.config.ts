import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'src/web',
  plugins: [react()],
  build: {
    outDir: '../../dist/web',
    emptyOutDir: true,
  },
  server: {
    host: '127.0.0.1',
    proxy: {
      // Dev only: the server accepts requests that look like they come from its own origin (ADR-0005).
      '/api': {
        target: 'http://127.0.0.1:4317',
        changeOrigin: true,
        headers: { origin: 'http://127.0.0.1:4317' },
      },
    },
  },
});
