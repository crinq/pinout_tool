import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  publicDir: 'public',
  worker: {
    format: 'es',
  },
});
