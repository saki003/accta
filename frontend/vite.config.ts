import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],

  worker: {
    format: 'es',
  },

  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:8001',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
      '/volumes': {
        target: 'http://localhost:8001',
        changeOrigin: true,
      },
      '/studies': {
        target: 'http://localhost:8001',
        changeOrigin: true,
      },
      '/mpr': {
        target: 'http://localhost:8001',
        changeOrigin: true,
      },
      '/algorithms': {
        target: 'http://localhost:8001',
        changeOrigin: true,
      },
      '/browse': {
        target: 'http://localhost:8001',
        changeOrigin: true,
      },
    },
  },

  optimizeDeps: {
    include: ['globalthis', 'fast-deep-equal'],
  },

  resolve: {
    alias: {
      // @icr/polyseg-wasm is an optional dep of @cornerstonejs/tools for
      // advanced segmentation — stub it out since we don't use it.
      '@icr/polyseg-wasm': '/src/lib/polyseg-stub.ts',
    },
  },

  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          vtk: ['@kitware/vtk.js'],
          cornerstone: [
            '@cornerstonejs/core',
            '@cornerstonejs/tools',
            '@cornerstonejs/dicom-image-loader',
          ],
        },
      },
    },
  },
});
