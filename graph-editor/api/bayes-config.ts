import { VercelRequest, VercelResponse } from '@vercel/node';

/**
 * GET /api/bayes/config
 *
 * Returns the config values the FE needs to commission a Bayes fit:
 *   - modal_submit_url: Modal /submit web endpoint
 *   - modal_status_url: Modal /status web endpoint
 *   - webhook_url:      where the Modal worker should POST results
 *   - webhook_secret:   symmetric key for AES-GCM callback token encryption
 *   - db_connection:    Neon PostgreSQL connection string (passed through to Modal)
 *
 * All values come from Vercel env vars. This route does no computation.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const modal_submit_url = process.env.BAYES_MODAL_SUBMIT_URL;
  const modal_status_url = process.env.BAYES_MODAL_STATUS_URL;
  const modal_cancel_url = process.env.BAYES_MODAL_CANCEL_URL;
  const webhook_url = process.env.BAYES_WEBHOOK_URL;
  const webhook_secret = process.env.BAYES_WEBHOOK_SECRET;
  const db_connection = process.env.DB_CONNECTION;

  if (!modal_submit_url || !modal_status_url || !webhook_url || !webhook_secret || !db_connection) {
    return res.status(500).json({
      error: 'Bayes config not fully configured',
      missing: [
        !modal_submit_url && 'BAYES_MODAL_SUBMIT_URL',
        !modal_status_url && 'BAYES_MODAL_STATUS_URL',
        !webhook_url && 'BAYES_WEBHOOK_URL',
        !webhook_secret && 'BAYES_WEBHOOK_SECRET',
        !db_connection && 'DB_CONNECTION',
      ].filter(Boolean),
    });
  }

  return res.status(200).json({ modal_submit_url, modal_status_url, modal_cancel_url, webhook_url, webhook_secret, db_connection });
}
