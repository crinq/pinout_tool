import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  publicDir: 'public',
  worker: {
    format: 'es',
  },
  server: {
    headers: {
      // The remote-data-source feature lets the user point at any
      // HTTP(S) endpoint (GitHub raw, GitHub Pages, jsDelivr, a local
      // static server, etc.), so connect-src has to allow arbitrary
      // origins. Image/font/media sources stay locked to 'self'.
      'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; connect-src 'self' https: http://localhost:* http://127.0.0.1:* file:;",
    },
  },
});
