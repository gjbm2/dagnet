import { describe, it, expect, vi, beforeEach } from 'vitest';

// We test the client behaviour (payload + error handling) by stubbing fetch.
import { listSignatures } from '../signatureLinksApi';

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

  it('listSignatures list_params mode sends correct payload', async () => {
    const fetchMock = vi.fn(async (_url: any, init: any) => {
      const body = JSON.parse(init.body);
      expect(body.list_params).toBe(true);
      expect(body.param_id_prefix).toBe('repo-main-');
      expect(body.graph_name).toBe('my-graph');
      // param_id should NOT be present when list_params is used without it
      expect(body.param_id).toBeUndefined();

      return new Response(
        JSON.stringify({
          success: true,
          params: [
            { param_id: 'repo-main-param-alpha', signature_count: 3, latest_created_at: '2026-02-04T00:00:00Z', earliest_created_at: '2026-01-01T00:00:00Z' },
          ],
          count: 1,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    });
    vi.stubGlobal('fetch', fetchMock as any);

    const res = await listSignatures({ list_params: true, param_id_prefix: 'repo-main-', graph_name: 'my-graph' });
    expect(res.success).toBe(true);
    expect(res.params).toHaveLength(1);
    expect(res.params![0].param_id).toBe('repo-main-param-alpha');
    expect(res.params![0].signature_count).toBe(3);
  });

  // NOTE: Tests for createEquivalenceLink, deactivateEquivalenceLink, resolveEquivalentHashes
  // were removed — those functions no longer exist. Equivalence is now FE-owned via hash-mappings.json.
});
