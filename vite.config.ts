import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const API_PORT = Number(process.env.PORT || 8787);
const target = `http://127.0.0.1:${API_PORT}`;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: Number(process.env.VITE_PORT || 5173),
    strictPort: false,
    proxy: {
      '/api': { target, changeOrigin: false },
      '/media': { target, changeOrigin: false },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    chunkSizeWarningLimit: 1200,
  },
});
