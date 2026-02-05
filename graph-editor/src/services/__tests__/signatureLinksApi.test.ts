import { describe, it, expect, vi, beforeEach } from 'vitest';

// We test the client behaviour (payload + error handling) by stubbing fetch.
import { listSignatures, resolveEquivalentHashes } from '../signatureLinksApi';

describe('signatureLinksApi', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('listSignatures posts expected payload and returns parsed rows', async () => {
    const fetchMock = vi.fn(async (_url: any, init: any) => {
      expect(init.method).toBe('POST');
      const body = JSON.parse(init.body);
      expect(body.param_id).toBe('r-b-param-x');
      expect(body.include_inputs).toBe(true);
      expect(body.limit).toBe(123);

      return new Response(
        JSON.stringify({
          success: true,
          rows: [
            {
              param_id: 'r-b-param-x',
              core_hash: 'abc',
              created_at: '2026-02-04T00:00:00Z',
              canonical_signature: '{"c":"x","x":{}}',
              canonical_sig_hash_full: 'deadbeef',
              sig_algo: 'sig_v1_sha256_trunc128_b64url',
              inputs_json: { schema: 'sig_inputs_v1' },
            },
          ],
          count: 1,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    });

    vi.stubGlobal('fetch', fetchMock as any);

    const res = await listSignatures({ param_id: 'r-b-param-x', include_inputs: true, limit: 123 });
    expect(res.success).toBe(true);
    expect(res.count).toBe(1);
    expect(res.rows[0].core_hash).toBe('abc');
  });

  it('resolveEquivalentHashes returns a typed error result on non-2xx', async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(JSON.stringify({ detail: 'boom' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock as any);

    const res = await resolveEquivalentHashes({ param_id: 'r-b-param-x', core_hash: 'abc', include_equivalents: true });
    expect(res.success).toBe(false);
    expect(res.core_hashes).toEqual(['abc']);
    expect(res.count).toBe(1);
    expect(res.error).toContain('boom');
  });
});

