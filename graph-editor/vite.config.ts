import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { handleProxyRequest } from './server/proxy';
import { execSync } from 'child_process';
import fs from 'fs';

export default defineConfig(({ mode }) => {
  // Check if we're in production (Vercel sets VERCEL_ENV=production)
  const isProduction = mode === 'production' || process.env.VERCEL_ENV === 'production' || process.env.NODE_ENV === 'production';

  // Load .env / .env.local variables for this mode
  const env = loadEnv(mode, process.cwd(), '');
  // Read version from package.json
  const packageJson = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'package.json'), 'utf-8'));
  const version = packageJson.version;
  
  // Get git commit hash (if available)
  let gitCommit = 'unknown';
  try {
    gitCommit = execSync('git rev-parse --short HEAD').toString().trim();
  } catch (e) {
    console.warn('Could not get git commit hash');
  }
  
  // Build timestamp
  const buildTimestamp = new Date().toISOString();
  
  // Format version for display (0.91.8-beta → 0.91.8b)
  const versionShort = version.replace(/^v/, '').replace(/-beta$/, 'b').replace(/-alpha$/, 'a');

  // Credentials init env (optional, used by welcome-screen init)
  const initSecret = env.INIT_CREDENTIALS_SECRET || '';
  const initCredentialsJson = env.INIT_CREDENTIALS_JSON || '';
  
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
    define: {
      'import.meta.env.VITE_APP_VERSION': JSON.stringify(versionShort),
      'import.meta.env.VITE_APP_VERSION_FULL': JSON.stringify(version),
      'import.meta.env.VITE_BUILD_TIMESTAMP': JSON.stringify(buildTimestamp),
      'import.meta.env.VITE_GIT_COMMIT': JSON.stringify(gitCommit),
      'import.meta.env.VITE_INIT_CREDENTIALS_SECRET': JSON.stringify(initSecret),
      'import.meta.env.VITE_INIT_CREDENTIALS_JSON': JSON.stringify(initCredentialsJson),
    },
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
