import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

// Settings live in the project's .env, one folder up, shared with the server.
// A variable set in the shell wins over the file.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, fileURLToPath(new URL('..', import.meta.url)), '');
  // PORT is the API server's port (same variable the server reads).
  const server = `http://127.0.0.1:${env.PORT || 8787}`;

  return {
    plugins: [react()],
    // Pre-bundle up front so the first page load never races the optimizer.
    optimizeDeps: {
      include: ['react', 'react/jsx-dev-runtime', 'react-dom/client', 'react-router-dom'],
    },
    server: {
      // Local only: the app has no login.
      host: '127.0.0.1',
      port: Number(env.WEB_PORT) || 5173,
      proxy: {
        '/api': server,
        '/ws': { target: server, ws: true },
      },
    },
  };
});
