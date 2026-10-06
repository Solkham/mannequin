import { defineConfig } from 'vite';

// Виджет для маркетплейсов: один файл dist/widget.js (с Three.js внутри), без сайта вокруг.
export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    chunkSizeWarningLimit: 900,
    lib: { entry: 'src/tryon/embed.ts', formats: ['iife'], name: 'MannequinTryOn', fileName: () => 'widget.js' },
  },
});
