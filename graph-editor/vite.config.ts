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

  // Share-mode credentials env (optional, used by ?secret= flows in embeds)
  // Note: These are intentionally NOT the generic VITE_CREDENTIALS_* names to reduce accidental coupling.
  const shareSecret = env.SHARE_SECRET || '';
  const shareJson = env.SHARE_JSON || '';
  
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
      // Dev-only: browser console log sink for Cursor/agent debugging.
      // Opt-in via localStorage flag in the browser (see consoleMirrorService) and/or env var.
      // Writes JSONL to repo root by default so Cursor can read it.
      ...(mode !== 'production'
        ? [
            {
              name: 'dagnet-console-log-sink',
              configureServer(server) {
                const endpoint = '/__dagnet/console-log';
                const repoConsoleDefault = path.resolve(__dirname, '..', 'debug', 'tmp.browser-console.jsonl');
                const repoSessionDefault = path.resolve(__dirname, '..', 'debug', 'tmp.session-log.jsonl');
                const consoleOutPath = process.env.DAGNET_CONSOLE_LOG_PATH
                  ? path.resolve(process.env.DAGNET_CONSOLE_LOG_PATH)
                  : repoConsoleDefault;
                const sessionOutPath = process.env.DAGNET_SESSION_LOG_PATH
                  ? path.resolve(process.env.DAGNET_SESSION_LOG_PATH)
                  : repoSessionDefault;
                const snapshotEndpoint = '/__dagnet/graph-snapshot';
                const repoSnapshotDirDefault = path.resolve(__dirname, '..', 'debug', 'graph-snapshots');
                const snapshotDir = process.env.DAGNET_GRAPH_SNAPSHOT_DIR
                  ? path.resolve(process.env.DAGNET_GRAPH_SNAPSHOT_DIR)
                  : repoSnapshotDirDefault;

                server.middlewares.use(async (req, res, next) => {
                  try {
                    if (req.method !== 'POST') return next();

                    // Graph snapshots (one JSON file per mark)
                    if (req.url === snapshotEndpoint) {
                      let body = '';
                      req.setEncoding('utf8');
                      req.on('data', (chunk) => {
                        body += chunk;
                        if (body.length > 20_000_000) {
                          res.statusCode = 413;
                          res.end('payload too large');
                          req.destroy();
                        }
                      });
                      req.on('end', () => {
                        try {
                          const parsed = JSON.parse(body || '{}');
                          const ts = typeof parsed?.ts_ms === 'number' ? parsed.ts_ms : Date.now();
                          const labelRaw = typeof parsed?.label === 'string' ? parsed.label : 'mark';
                          const fileIdRaw = typeof parsed?.fileId === 'string' ? parsed.fileId : 'no-file';

                          const sanitise = (s: string) =>
                            s
                              .toLowerCase()
                              .replace(/[^a-z0-9]+/g, '-')
                              .replace(/^-+|-+$/g, '')
                              .slice(0, 80) || 'x';

                          const label = sanitise(labelRaw);
                          const fileId = sanitise(fileIdRaw);

                          fs.mkdirSync(snapshotDir, { recursive: true });
                          const outPath = path.join(snapshotDir, `${ts}_${label}_${fileId}.json`);

                          fs.writeFileSync(outPath, JSON.stringify(parsed, null, 2), 'utf8');
                          res.statusCode = 200;
                          res.setHeader('content-type', 'application/json');
                          res.end(JSON.stringify({ ok: true, path: outPath }));
                        } catch (err: any) {
                          res.statusCode = 400;
                          res.end(`bad request: ${err?.message || String(err)}`);
                        }
                      });
                      return;
                    }

                    // Console/session streams (JSONL)
                    if (req.url !== endpoint) return next();

                    let body = '';
                    req.setEncoding('utf8');
                    req.on('data', (chunk) => {
                      body += chunk;
                      // Hard cap to avoid runaway memory usage
                      if (body.length > 2_000_000) {
                        res.statusCode = 413;
                        res.end('payload too large');
                        req.destroy();
                      }
                    });
                    req.on('end', () => {
                      try {
                        const parsed = JSON.parse(body || '{}');
                        const stream = parsed?.stream === 'session' ? 'session' : 'console';
                        const entries = Array.isArray(parsed?.entries) ? parsed.entries : [];

                        const outPath = stream === 'session' ? sessionOutPath : consoleOutPath;
                        fs.mkdirSync(path.dirname(outPath), { recursive: true });
                        const fd = fs.openSync(outPath, 'a');
                        try {
                          for (const e of entries) {
                            if (!e || typeof e !== 'object') continue;
                            // Avoid ISO timestamps in persisted logs; use ms epoch.
                            if (typeof e.ts_ms !== 'number') (e as any).ts_ms = Date.now();
                            fs.writeSync(fd, `${JSON.stringify(e)}\n`, undefined, 'utf8');
                          }
                        } finally {
                          fs.closeSync(fd);
                        }

                        res.statusCode = 200;
                        res.setHeader('content-type', 'application/json');
                        res.end(JSON.stringify({ ok: true, stream, written: entries.length, path: outPath }));
                      } catch (err: any) {
                        res.statusCode = 400;
                        res.end(`bad request: ${err?.message || String(err)}`);
                      }
                    });
                  } catch {
                    // Best-effort; never break dev server
                    next();
                  }
                });
              },
            },
          ]
        : []),
    ],
    define: {
      'import.meta.env.VITE_APP_VERSION': JSON.stringify(versionShort),
      'import.meta.env.VITE_APP_VERSION_FULL': JSON.stringify(version),
      'import.meta.env.VITE_BUILD_TIMESTAMP': JSON.stringify(buildTimestamp),
      'import.meta.env.VITE_GIT_COMMIT': JSON.stringify(gitCommit),
      'import.meta.env.VITE_INIT_CREDENTIALS_SECRET': JSON.stringify(initSecret),
      'import.meta.env.VITE_INIT_CREDENTIALS_JSON': JSON.stringify(initCredentialsJson),
      'import.meta.env.SHARE_SECRET': JSON.stringify(shareSecret),
      'import.meta.env.SHARE_JSON': JSON.stringify(shareJson),
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
    },
    optimizeDeps: {
      include: ['jose'], // Pre-bundle jose for dynamic imports
    }
  };
});
