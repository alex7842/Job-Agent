import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';

const API_PORT = 3000;

export default defineConfig(({ mode }) => {
  // VITE_* is inlined into the bundle, so it is client-visible by definition.
  // Put secrets in the root .env for the API only — never prefix them with VITE_.
  const rootEnv = loadEnv(mode, fileURLToPath(new URL('../..', import.meta.url)), '');
  const apiTarget = process.env.API_URL ?? rootEnv.API_URL ?? `http://localhost:${API_PORT}`;

  // The web app only ever talks to /api, so every server that serves it proxies
  // through to NestJS and the browser never deals with CORS or a second origin.
  // `dev` uses it, and so does `vite preview`, which is what the deploy target
  // runs — so a deployed build behaves identically to local development.
  const apiProxy = {
    '/api': {
      target: apiTarget,
      changeOrigin: true,
      rewrite: (path: string) => path.replace(/^\/api/, ''),
    },
  };

  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
      },
    },
    server: {
      port: 5173,
      proxy: apiProxy,
    },
    preview: {
      host: true,
      port: 5173,
      proxy: apiProxy,
    },
    build: {
      outDir: 'dist',
      sourcemap: true,
    },
  };
});
