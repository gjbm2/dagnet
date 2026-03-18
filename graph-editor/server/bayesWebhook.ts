/**
 * Bayes Webhook — Vite dev server middleware.
 *
 * Delegates to the canonical Vercel handler (api/bayes-webhook.ts).
 * This adapter converts Node IncomingMessage/ServerResponse to the
 * VercelRequest/VercelResponse shape the handler expects.
 *
 * ONE code path for both local and production.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import handler from '../api/bayes-webhook';

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 5_000_000) { reject(new Error('payload too large')); req.destroy(); }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

export async function handleBayesWebhook(
  req: IncomingMessage,
  res: ServerResponse,
  env: Record<string, string>,
): Promise<void> {
  // Inject env vars the handler reads via process.env
  for (const [k, v] of Object.entries(env)) {
    if (!process.env[k]) process.env[k] = v;
  }

  // Read body once (Vercel handler reads req.body which is pre-parsed)
  const rawBody = await readBody(req);
  const body = JSON.parse(rawBody);

  // Adapt to VercelRequest shape (minimal shim)
  const vercelReq = Object.assign(req, { body }) as any;

  // Adapt to VercelResponse shape — capture originals BEFORE overwriting
  const origEnd = res.end.bind(res);
  const vercelRes = Object.assign(res, {
    status(code: number) { res.statusCode = code; return vercelRes; },
    json(data: any) {
      res.setHeader('Content-Type', 'application/json');
      origEnd(JSON.stringify(data));
      return vercelRes;
    },
  }) as any;

  await handler(vercelReq, vercelRes);
}
