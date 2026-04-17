import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { handleProxyRequest } from './server/proxy';
import { handleGithubProxyRequest } from './server/githubProxy';
import { handleAuthCallback, configureAuthCallback } from './server/authCallback';
import { handleBayesWebhook } from './server/bayesWebhook';
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

  // Configure auth callback middleware with env vars (dev only)
  configureAuthCallback(
    env.VITE_GITHUB_OAUTH_CLIENT_ID || '',
    env.GITHUB_OAUTH_CLIENT_SECRET || '',
  );

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
      // Server freshness endpoint — agents use this to verify code is live.
      {
        name: 'dagnet-server-info',
        configureServer(server) {
          const bootEpoch = Date.now() / 1000;
          server.middlewares.use((req, res, next) => {
            if (req.url === '/__dagnet/server-info') {
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({
                boot_epoch: bootEpoch,
                pid: process.pid,
                server: 'vite',
              }));
              return;
            }
            next();
          });
        },
      },
      // DAS Proxy plugin
      {
        name: 'das-proxy',
        configureServer(server) {
          server.middlewares.use(async (req, res, next) => {
            if (req.url?.startsWith('/api/das-proxy')) {
              await handleProxyRequest(req, res);
            } else if (req.url?.startsWith('/api/github-proxy')) {
              await handleGithubProxyRequest(req, res);
            } else if (req.url?.startsWith('/api/auth-callback')) {
              await handleAuthCallback(req, res);
            } else if (req.url?.startsWith('/api/bayes-webhook')) {
              await handleBayesWebhook(req, res, env);
            } else if (req.url?.startsWith('/api/bayes/config') || req.url?.startsWith('/api/bayes-config')) {
              // Dev-only: serve Bayes config from .env.local (mirrors api/bayes-config.ts)
              const modal_base_url = (env.BAYES_MODAL_BASE_URL || '').trim();
              const webhook_url = env.BAYES_WEBHOOK_URL || '';
              const webhook_secret = env.BAYES_WEBHOOK_SECRET || '';
              const db_connection = env.DB_CONNECTION || '';
              const missing = [
                !modal_base_url && 'BAYES_MODAL_BASE_URL',
                !webhook_url && 'BAYES_WEBHOOK_URL',
                !webhook_secret && 'BAYES_WEBHOOK_SECRET',
                !db_connection && 'DB_CONNECTION',
              ].filter(Boolean);
              res.setHeader('Content-Type', 'application/json');
              if (missing.length) {
                res.statusCode = 500;
                res.end(JSON.stringify({ error: 'Bayes config not fully configured', missing }));
              } else {
                res.statusCode = 200;
                res.end(JSON.stringify({
                  modal_submit_url: `${modal_base_url}submit.modal.run`,
                  modal_status_url: `${modal_base_url}status.modal.run`,
                  modal_cancel_url: `${modal_base_url}cancel.modal.run`,
                  webhook_url, webhook_secret, db_connection,
                }));
              }
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
                // Python server log — marks are propagated here so
                // extract-mark-logs.sh can window the Python stream too.
                const pythonLogDefault = path.resolve(__dirname, '..', 'debug', 'tmp.python-server.jsonl');
                const pythonLogPath = process.env.DAGNET_PYTHON_LOG_PATH
                  ? path.resolve(process.env.DAGNET_PYTHON_LOG_PATH)
                  : pythonLogDefault;

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

                    // Dev diagnostic state dump (FileRegistry + IDB + planner)
                    // Triggered on mark or via window.dagnetDump() → devDiagnosticService
                    if (req.url === '/__dagnet/diag-dump' || req.url === '/__dagnet/registry-dump') {
                      let body = '';
                      req.setEncoding('utf8');
                      req.on('data', (chunk: string) => { body += chunk; if (body.length > 10_000_000) { res.statusCode = 413; res.end('too large'); req.destroy(); } });
                      req.on('end', () => {
                        try {
                          const debugDir = path.resolve(__dirname, '..', 'debug');
                          fs.mkdirSync(debugDir, { recursive: true });
                          const outPath = path.join(debugDir, 'tmp.diag-state.json');
                          fs.writeFileSync(outPath, body, 'utf8');
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

                    // Analysis compute roundtrip dumps (one JSON per compute)
                    if (req.url === '/__dagnet/analysis-dump') {
                      let body = '';
                      req.setEncoding('utf8');
                      req.on('data', (chunk: string) => { body += chunk; if (body.length > 20_000_000) { res.statusCode = 413; res.end('too large'); req.destroy(); } });
                      req.on('end', () => {
                        try {
                          const parsed = JSON.parse(body || '{}');
                          const dumpDir = path.resolve(__dirname, '..', 'debug', 'analysis-dumps');
                          fs.mkdirSync(dumpDir, { recursive: true });
                          const ts = Date.now();
                          const atype = typeof parsed?.analysisType === 'string'
                            ? parsed.analysisType.replace(/[^a-z0-9_-]/gi, '').slice(0, 30) : 'unknown';
                          const dsl = typeof parsed?.analyticsDsl === 'string'
                            ? parsed.analyticsDsl.replace(/[^a-zA-Z0-9()-]/g, '_').slice(0, 50) : '';
                          const outPath = path.join(dumpDir, `${ts}_${atype}_${dsl}.json`);
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

                        // Propagate marks to Python server log so
                        // extract-mark-logs.sh can window it by mark.
                        const marks = entries.filter(
                          (e: any) => e?.kind === 'mark' || e?.operation === 'DEV_MARK'
                        );
                        if (marks.length > 0) {
                          try {
                            fs.mkdirSync(path.dirname(pythonLogPath), { recursive: true });
                            const pyFd = fs.openSync(pythonLogPath, 'a');
                            try {
                              for (const m of marks) {
                                const markEntry = {
                                  kind: 'mark' as const,
                                  ts_ms: m.ts_ms ?? Date.now(),
                                  label: m.label ?? m.message ?? 'mark',
                                };
                                fs.writeSync(pyFd, `${JSON.stringify(markEntry)}\n`, undefined, 'utf8');
                              }
                            } finally {
                              fs.closeSync(pyFd);
                            }
                          } catch {
                            // best-effort
                          }
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
      host: true,
      port: parseInt(process.env.VITE_PORT || '5173'),
      hmr: true,
      watch: {
        // Include shipped docs so dev server reliably picks up new/renamed workshop markdown files
        // under public/docs without requiring manual restarts.
        include: ['src/**/*', 'public/docs/**/*']
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
