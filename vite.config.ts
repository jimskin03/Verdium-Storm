import { defineConfig } from 'vite';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  base: './',
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: { host: '0.0.0.0', port: 5173, strictPort: true },
  preview: { host: '0.0.0.0', port: 4173, strictPort: true },
  build: {
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 4096,
    rollupOptions: { output: { manualChunks: { three: ['three'] } } },
  },
});
