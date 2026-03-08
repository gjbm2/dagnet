/**
 * Deep-redaction utility for credential-bearing objects.
 *
 * Any object key whose lowercase form contains one of the sensitive substrings
 * is replaced with '[REDACTED]'.  Arrays are traversed recursively.
 */

const SENSITIVE_KEY_SUBSTRINGS = [
  'api_key',
  'secret_key',
  'password',
  'token',
  'access_token',
  'refresh_token',
  'authorization',
  'basic_auth',
  'client_secret',
  'service_account',
  'private_key',
] as const;

export function redactDeep(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(redactDeep);

  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    const lower = k.toLowerCase();
    const isSensitive = SENSITIVE_KEY_SUBSTRINGS.some((s) => lower.includes(s));
    out[k] = isSensitive ? '[REDACTED]' : redactDeep(v);
  }
  return out;
}
