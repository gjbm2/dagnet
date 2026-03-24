import { VercelRequest, VercelResponse } from '@vercel/node';

/**
 * GET /api/bayes/config
 *
 * Returns the config values the FE needs to commission a Bayes fit.
 * Modal endpoint URLs are derived from a single base URL env var.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const modal_base_url = process.env.BAYES_MODAL_BASE_URL?.trim();
  const webhook_url = process.env.BAYES_WEBHOOK_URL?.trim();
  const webhook_secret = process.env.BAYES_WEBHOOK_SECRET?.trim();
  const db_connection = process.env.DB_CONNECTION?.trim();

  if (!modal_base_url || !webhook_url || !webhook_secret || !db_connection) {
    return res.status(500).json({
      error: 'Bayes config not fully configured',
      missing: [
        !modal_base_url && 'BAYES_MODAL_BASE_URL',
        !webhook_url && 'BAYES_WEBHOOK_URL',
        !webhook_secret && 'BAYES_WEBHOOK_SECRET',
        !db_connection && 'DB_CONNECTION',
      ].filter(Boolean),
    });
  }

  return res.status(200).json({
    modal_submit_url: `${modal_base_url}submit.modal.run`,
    modal_status_url: `${modal_base_url}status.modal.run`,
    modal_cancel_url: `${modal_base_url}cancel.modal.run`,
    webhook_url,
    webhook_secret,
    db_connection,
  });
}
