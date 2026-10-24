import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: here,
  plugins: [react(), tailwindcss()],
  build: { outDir: path.join(here, 'dist'), emptyOutDir: true },
  server: {
    port: 5173,
    proxy: { '/api': 'http://127.0.0.1:18082' },
  },
});
