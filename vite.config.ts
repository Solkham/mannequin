import { defineConfig } from 'vite';

// base: './' — сайт открывается из любой папки (GitHub Pages, локальный файл-сервер).
export default defineConfig({
  base: './',
  // Three.js сам по себе ~600 КБ, делить его на куски для демо незачем.
  build: { chunkSizeWarningLimit: 800 },
});
