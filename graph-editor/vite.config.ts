import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { handleProxyRequest } from './server/proxy';

export default defineConfig(({ mode }) => {
  // Check if we're in production (Vercel sets VERCEL_ENV=production)
  const isProduction = mode === 'production' || process.env.VERCEL_ENV === 'production' || process.env.NODE_ENV === 'production';
  
  return {
    plugins: [
      react(),
      // DAS Proxy plugin
      {
        name: 'das-proxy',
        configureServer(server) {
          server.middlewares.use(async (req, res, next) => {
            if (req.url?.startsWith('/api/das-proxy')) {
              await handleProxyRequest(req, res);
            } else {
              next();
            }
          });
        },
      },
    ],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
    publicDir: 'public',
    server: {
      port: parseInt(process.env.VITE_PORT || '5173'),
      hmr: true,
      watch: {
        include: ['src/**/*']
      },
      // Allow serving files from parent directory
      fs: {
        allow: ['..', '../..']
      }
    },
    build: {
      outDir: 'dist',
      emptyOutDir: true,
      minify: isProduction ? 'terser' : false,
      terserOptions: isProduction ? {
        compress: {
          drop_console: true,
          drop_debugger: true,
        },
      } : undefined,
    }
  };
});
