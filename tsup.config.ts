import { defineConfig } from 'tsup';

// Builds the Node side (CLI + server + core) into dist/. The web bundle is built separately by Vite
// into dist/web. Dependencies stay external and are installed from package.json.
export default defineConfig({
  entry: { cli: 'src/cli/bin.ts' },
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  clean: true,
  splitting: true,
  sourcemap: false,
});
