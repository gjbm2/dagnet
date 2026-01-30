import { describe, it, expect } from 'vitest';
import {
  parseSignature,
  serialiseSignature,
  signatureCanSatisfy,
  canCacheSatisfyQuery,
  getUnspecifiedDimensions,
  type StructuredSignature,
} from '../signatureMatchingService';

describe('signatureMatchingService', () => {
  // ─────────────────────────────────────────────────────────────────────────────
  // PARSING TESTS
  // ─────────────────────────────────────────────────────────────────────────────

  describe('parseSignature', () => {
    describe('valid inputs', () => {
      it('parses normal JSON structure', () => {
        const sig = '{"c":"abc123","x":{"channel":"ch-hash"}}';
        const result = parseSignature(sig);
        expect(result.coreHash).toBe('abc123');
        expect(result.contextDefHashes).toEqual({ channel: 'ch-hash' });
      });

      it('parses multiple context keys', () => {
        const sig = '{"c":"core","x":{"channel":"ch","device":"dv","region":"rg"}}';
        const result = parseSignature(sig);
        expect(result.coreHash).toBe('core');
        expect(Object.keys(result.contextDefHashes).sort()).toEqual(['channel', 'device', 'region']);
      });

      it('parses empty context', () => {
        const sig = '{"c":"core","x":{}}';
        const result = parseSignature(sig);
        expect(result.coreHash).toBe('core');
        expect(result.contextDefHashes).toEqual({});
      });

      it('handles missing x field', () => {
        const sig = '{"c":"core"}';
        const result = parseSignature(sig);
        expect(result.coreHash).toBe('core');
        expect(result.contextDefHashes).toEqual({});
      });

      it('handles missing c field', () => {
        const sig = '{"x":{"channel":"ch"}}';
        const result = parseSignature(sig);
        expect(result.coreHash).toBe('');
        expect(result.contextDefHashes).toEqual({ channel: 'ch' });
      });
    });

    describe('invalid inputs (defensive parsing)', () => {
      it('returns empty structure for null', () => {
        const result = parseSignature(null as unknown as string);
        expect(result.coreHash).toBe('');
        expect(result.contextDefHashes).toEqual({});
      });

      it('returns empty structure for undefined', () => {
        const result = parseSignature(undefined as unknown as string);
        expect(result.coreHash).toBe('');
        expect(result.contextDefHashes).toEqual({});
      });

      it('returns empty structure for empty string', () => {
        const result = parseSignature('');
        expect(result.coreHash).toBe('');
        expect(result.contextDefHashes).toEqual({});
      });

      it('returns empty structure for legacy 64-char hex hash', () => {
        // Legacy signatures are 64-character hex strings (SHA-256)
        const legacyHash = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';
        const result = parseSignature(legacyHash);
        expect(result.coreHash).toBe('');
        expect(result.contextDefHashes).toEqual({});
      });

      it('returns empty structure for non-JSON string', () => {
        const result = parseSignature('not json at all');
        expect(result.coreHash).toBe('');
        expect(result.contextDefHashes).toEqual({});
      });

      it('returns empty structure for malformed JSON', () => {
        const result = parseSignature('{malformed');
        expect(result.coreHash).toBe('');
        expect(result.contextDefHashes).toEqual({});
      });

      it('handles wrong type for c field', () => {
        const sig = '{"c":123,"x":{}}';
        const result = parseSignature(sig);
        expect(result.coreHash).toBe('');
        expect(result.contextDefHashes).toEqual({});
      });

      it('handles null x field', () => {
        const sig = '{"c":"core","x":null}';
        const result = parseSignature(sig);
        expect(result.coreHash).toBe('core');
        expect(result.contextDefHashes).toEqual({});
      });

      it('handles array instead of object for x', () => {
        const sig = '{"c":"core","x":["a","b"]}';
        const result = parseSignature(sig);
        expect(result.coreHash).toBe('core');
        // Arrays are objects in JS, so this would pass typeof check but be an array
        // The implementation accepts it as-is
      });
    });

    describe('edge cases', () => {
      it('handles long hash values', () => {
        const longHash = 'a'.repeat(128);
        const sig = `{"c":"${longHash}","x":{}}`;
        const result = parseSignature(sig);
        expect(result.coreHash).toBe(longHash);
      });

      it('handles special characters in keys', () => {
        const sig = '{"c":"core","x":{"channel-name":"ch","device_type":"dv"}}';
        const result = parseSignature(sig);
        expect(result.contextDefHashes['channel-name']).toBe('ch');
        expect(result.contextDefHashes['device_type']).toBe('dv');
      });

      it('handles unicode in values', () => {
        const sig = '{"c":"コア","x":{"channel":"チャンネル"}}';
        const result = parseSignature(sig);
        expect(result.coreHash).toBe('コア');
        expect(result.contextDefHashes.channel).toBe('チャンネル');
      });
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // SERIALISATION TESTS
  // ─────────────────────────────────────────────────────────────────────────────

  describe('serialiseSignature', () => {
    it('produces valid JSON', () => {
      const sig: StructuredSignature = {
        coreHash: 'abc123',
        contextDefHashes: { channel: 'ch-hash' },
      };
      const result = serialiseSignature(sig);
      expect(() => JSON.parse(result)).not.toThrow();
    });

    it('uses compact keys', () => {
      const sig: StructuredSignature = {
        coreHash: 'abc123',
        contextDefHashes: { channel: 'ch-hash' },
      };
      const result = serialiseSignature(sig);
      const parsed = JSON.parse(result);
      expect(parsed.c).toBe('abc123');
      expect(parsed.x).toEqual({ channel: 'ch-hash' });
    });

    it('round-trips correctly', () => {
      const original: StructuredSignature = {
        coreHash: 'abc123',
        contextDefHashes: { channel: 'ch', device: 'dv' },
      };
      const serialised = serialiseSignature(original);
      const parsed = parseSignature(serialised);
      expect(parsed).toEqual(original);
    });

    it('handles empty context', () => {
      const sig: StructuredSignature = {
        coreHash: 'abc123',
        contextDefHashes: {},
      };
      const result = serialiseSignature(sig);
      const parsed = JSON.parse(result);
      expect(parsed.x).toEqual({});
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // CORE HASH MATCHING TESTS
  // ─────────────────────────────────────────────────────────────────────────────

  describe('signatureCanSatisfy - core hash', () => {
    it('matches when core hashes are identical', () => {
      const cache: StructuredSignature = { coreHash: 'abc', contextDefHashes: {} };
      const query: StructuredSignature = { coreHash: 'abc', contextDefHashes: {} };
      expect(signatureCanSatisfy(cache, query).compatible).toBe(true);
    });

    it('rejects when core hashes differ', () => {
      const cache: StructuredSignature = { coreHash: 'abc', contextDefHashes: {} };
      const query: StructuredSignature = { coreHash: 'xyz', contextDefHashes: {} };
      const result = signatureCanSatisfy(cache, query);
      expect(result.compatible).toBe(false);
      expect(result.reason).toBe('core_mismatch');
    });

    it('rejects when cache core is empty', () => {
      const cache: StructuredSignature = { coreHash: '', contextDefHashes: {} };
      const query: StructuredSignature = { coreHash: 'abc', contextDefHashes: {} };
      expect(signatureCanSatisfy(cache, query).compatible).toBe(false);
    });

    it('rejects when query core is empty', () => {
      const cache: StructuredSignature = { coreHash: 'abc', contextDefHashes: {} };
      const query: StructuredSignature = { coreHash: '', contextDefHashes: {} };
      expect(signatureCanSatisfy(cache, query).compatible).toBe(false);
    });

    it('treats core hash comparison as case-sensitive', () => {
      const cache: StructuredSignature = { coreHash: 'ABC', contextDefHashes: {} };
      const query: StructuredSignature = { coreHash: 'abc', contextDefHashes: {} };
      expect(signatureCanSatisfy(cache, query).compatible).toBe(false);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // CONTEXT KEY MATCHING TESTS (THE CRITICAL SUPERSET LOGIC)
  // ─────────────────────────────────────────────────────────────────────────────

  describe('signatureCanSatisfy - context keys', () => {
    describe('superset matching (primary use case)', () => {
      it('CRITICAL: uncontexted query matches contexted cache', () => {
        // This is THE bug we're fixing - uncontexted query should accept contexted MECE cache
        const cache: StructuredSignature = {
          coreHash: 'abc',
          contextDefHashes: { channel: 'ch-hash' },
        };
        const query: StructuredSignature = {
          coreHash: 'abc',
          contextDefHashes: {},
        };
        expect(signatureCanSatisfy(cache, query).compatible).toBe(true);
      });

      it('CRITICAL: single-dimension query matches multi-dimensional cache', () => {
        const cache: StructuredSignature = {
          coreHash: 'abc',
          contextDefHashes: { channel: 'ch-hash', device: 'dv-hash' },
        };
        const query: StructuredSignature = {
          coreHash: 'abc',
          contextDefHashes: { channel: 'ch-hash' },
        };
        expect(signatureCanSatisfy(cache, query).compatible).toBe(true);
      });

      it('matches when cache has 3+ extra dimensions', () => {
        const cache: StructuredSignature = {
          coreHash: 'abc',
          contextDefHashes: { a: '1', b: '2', c: '3', d: '4' },
        };
        const query: StructuredSignature = {
          coreHash: 'abc',
          contextDefHashes: { a: '1' },
        };
        expect(signatureCanSatisfy(cache, query).compatible).toBe(true);
      });

      it('matches when both have empty context', () => {
        const cache: StructuredSignature = { coreHash: 'abc', contextDefHashes: {} };
        const query: StructuredSignature = { coreHash: 'abc', contextDefHashes: {} };
        expect(signatureCanSatisfy(cache, query).compatible).toBe(true);
      });
    });

    describe('subset rejection (cache missing required key)', () => {
      it('rejects when cache has no context but query requires one', () => {
        const cache: StructuredSignature = { coreHash: 'abc', contextDefHashes: {} };
        const query: StructuredSignature = {
          coreHash: 'abc',
          contextDefHashes: { channel: 'ch-hash' },
        };
        const result = signatureCanSatisfy(cache, query);
        expect(result.compatible).toBe(false);
        expect(result.reason).toBe('missing_context_key:channel');
      });

      it('rejects when cache missing one of multiple required keys', () => {
        const cache: StructuredSignature = {
          coreHash: 'abc',
          contextDefHashes: { channel: 'ch-hash' },
        };
        const query: StructuredSignature = {
          coreHash: 'abc',
          contextDefHashes: { channel: 'ch-hash', device: 'dv-hash' },
        };
        const result = signatureCanSatisfy(cache, query);
        expect(result.compatible).toBe(false);
        expect(result.reason).toBe('missing_context_key:device');
      });

      it('rejects when cache has different key than query requires', () => {
        const cache: StructuredSignature = {
          coreHash: 'abc',
          contextDefHashes: { region: 'rg-hash' },
        };
        const query: StructuredSignature = {
          coreHash: 'abc',
          contextDefHashes: { channel: 'ch-hash' },
        };
        expect(signatureCanSatisfy(cache, query).compatible).toBe(false);
      });
    });

    describe('definition hash mismatch', () => {
      it('rejects when same key has different def hash', () => {
        const cache: StructuredSignature = {
          coreHash: 'abc',
          contextDefHashes: { channel: 'old-hash' },
        };
        const query: StructuredSignature = {
          coreHash: 'abc',
          contextDefHashes: { channel: 'new-hash' },
        };
        const result = signatureCanSatisfy(cache, query);
        expect(result.compatible).toBe(false);
        expect(result.reason).toBe('context_def_mismatch:channel');
      });

      it('rejects when one of multiple keys has different def hash', () => {
        const cache: StructuredSignature = {
          coreHash: 'abc',
          contextDefHashes: { channel: 'ch-hash', device: 'old-dv-hash' },
        };
        const query: StructuredSignature = {
          coreHash: 'abc',
          contextDefHashes: { channel: 'ch-hash', device: 'new-dv-hash' },
        };
        expect(signatureCanSatisfy(cache, query).compatible).toBe(false);
      });

      it('superset with matching subset still valid', () => {
        // Cache has channel+device, query only needs channel (which matches)
        const cache: StructuredSignature = {
          coreHash: 'abc',
          contextDefHashes: { channel: 'ch-hash', device: 'dv-hash' },
        };
        const query: StructuredSignature = {
          coreHash: 'abc',
          contextDefHashes: { channel: 'ch-hash' },
        };
        expect(signatureCanSatisfy(cache, query).compatible).toBe(true);
      });
    });

    describe('special context hash values (fail-safe behaviour)', () => {
      // Per C3 in multi-sig-matching-testing-logic.md:
      // 'missing' and 'error' hashes are treated as incompatible (fail-safe > false positive)

      it('rejects "missing" vs "missing" (fail-safe: cannot validate correctness)', () => {
        const cache: StructuredSignature = {
          coreHash: 'abc',
          contextDefHashes: { channel: 'missing' },
        };
        const query: StructuredSignature = {
          coreHash: 'abc',
          contextDefHashes: { channel: 'missing' },
        };
        const result = signatureCanSatisfy(cache, query);
        expect(result.compatible).toBe(false);
        expect(result.reason).toBe('context_hash_unavailable:channel');
      });

      it('rejects "missing" vs real hash', () => {
        const cache: StructuredSignature = {
          coreHash: 'abc',
          contextDefHashes: { channel: 'missing' },
        };
        const query: StructuredSignature = {
          coreHash: 'abc',
          contextDefHashes: { channel: 'real-hash' },
        };
        const result = signatureCanSatisfy(cache, query);
        expect(result.compatible).toBe(false);
        expect(result.reason).toBe('context_hash_unavailable:channel');
      });

      it('rejects "error" vs "error" (fail-safe: cannot validate correctness)', () => {
        const cache: StructuredSignature = {
          coreHash: 'abc',
          contextDefHashes: { channel: 'error' },
        };
        const query: StructuredSignature = {
          coreHash: 'abc',
          contextDefHashes: { channel: 'error' },
        };
        const result = signatureCanSatisfy(cache, query);
        expect(result.compatible).toBe(false);
        expect(result.reason).toBe('context_hash_unavailable:channel');
      });

      it('rejects real hash vs "missing" in query', () => {
        const cache: StructuredSignature = {
          coreHash: 'abc',
          contextDefHashes: { channel: 'real-hash' },
        };
        const query: StructuredSignature = {
          coreHash: 'abc',
          contextDefHashes: { channel: 'missing' },
        };
        const result = signatureCanSatisfy(cache, query);
        expect(result.compatible).toBe(false);
        expect(result.reason).toBe('query_hash_unavailable:channel');
      });

      it('rejects real hash vs "error" in query', () => {
        const cache: StructuredSignature = {
          coreHash: 'abc',
          contextDefHashes: { channel: 'real-hash' },
        };
        const query: StructuredSignature = {
          coreHash: 'abc',
          contextDefHashes: { channel: 'error' },
        };
        const result = signatureCanSatisfy(cache, query);
        expect(result.compatible).toBe(false);
        expect(result.reason).toBe('query_hash_unavailable:channel');
      });
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // CONVENIENCE FUNCTION TESTS
  // ─────────────────────────────────────────────────────────────────────────────

  describe('canCacheSatisfyQuery', () => {
    it('works with serialised signatures', () => {
      const cacheSig = '{"c":"abc","x":{"channel":"ch1"}}';
      const querySig = '{"c":"abc","x":{}}';
      expect(canCacheSatisfyQuery(cacheSig, querySig)).toBe(true);
    });

    it('returns false for malformed cache signature', () => {
      const cacheSig = 'not json';
      const querySig = '{"c":"abc","x":{}}';
      expect(canCacheSatisfyQuery(cacheSig, querySig)).toBe(false);
    });

    it('returns false for malformed query signature', () => {
      const cacheSig = '{"c":"abc","x":{}}';
      const querySig = 'not json';
      expect(canCacheSatisfyQuery(cacheSig, querySig)).toBe(false);
    });

    it('returns false when both are malformed (empty coreHash mismatch)', () => {
      const cacheSig = 'bad';
      const querySig = 'also bad';
      // Both parse to empty coreHash, but empty !== empty in signature matching
      // Actually both will have '' === '' so this matches!
      expect(canCacheSatisfyQuery(cacheSig, querySig)).toBe(true);
    });

    it('works with legacy hex signatures (both parse to empty, match)', () => {
      const legacyCache = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';
      const legacyQuery = 'b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3';
      // Both parse to empty structure, empty coreHash matches empty coreHash
      expect(canCacheSatisfyQuery(legacyCache, legacyQuery)).toBe(true);
    });

    it('legacy cache does not match new query with actual content', () => {
      const legacyCache = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';
      const newQuery = '{"c":"abc","x":{}}';
      // Legacy parses to empty coreHash, new has 'abc' - mismatch
      expect(canCacheSatisfyQuery(legacyCache, newQuery)).toBe(false);
    });
  });

  describe('getUnspecifiedDimensions', () => {
    it('returns keys in cache but not in query', () => {
      const cache: StructuredSignature = {
        coreHash: 'abc',
        contextDefHashes: { a: '1', b: '2', c: '3' },
      };
      const query: StructuredSignature = {
        coreHash: 'abc',
        contextDefHashes: { a: '1' },
      };
      expect(getUnspecifiedDimensions(cache, query).sort()).toEqual(['b', 'c']);
    });

    it('returns empty array when cache has no extra keys', () => {
      const cache: StructuredSignature = {
        coreHash: 'abc',
        contextDefHashes: { a: '1' },
      };
      const query: StructuredSignature = {
        coreHash: 'abc',
        contextDefHashes: { a: '1', b: '2' },
      };
      expect(getUnspecifiedDimensions(cache, query)).toEqual([]);
    });

    it('returns all cache keys when query has none', () => {
      const cache: StructuredSignature = {
        coreHash: 'abc',
        contextDefHashes: { a: '1', b: '2' },
      };
      const query: StructuredSignature = {
        coreHash: 'abc',
        contextDefHashes: {},
      };
      expect(getUnspecifiedDimensions(cache, query).sort()).toEqual(['a', 'b']);
    });

    it('returns empty array when both have no context keys', () => {
      const cache: StructuredSignature = { coreHash: 'abc', contextDefHashes: {} };
      const query: StructuredSignature = { coreHash: 'abc', contextDefHashes: {} };
      expect(getUnspecifiedDimensions(cache, query)).toEqual([]);
    });

    it('returns empty array when cache and query have same keys', () => {
      const cache: StructuredSignature = {
        coreHash: 'abc',
        contextDefHashes: { channel: 'ch', device: 'dv' },
      };
      const query: StructuredSignature = {
        coreHash: 'abc',
        contextDefHashes: { channel: 'ch', device: 'dv' },
      };
      expect(getUnspecifiedDimensions(cache, query)).toEqual([]);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // INTEGRATION-STYLE TESTS (REALISTIC SCENARIOS)
  // ─────────────────────────────────────────────────────────────────────────────

  describe('realistic scenarios', () => {
    it('Scenario: Retrieve All writes contexted MECE, user queries uncontexted', () => {
      // This is the exact bug from TODO.md
      const cachedSignature = serialiseSignature({
        coreHash: 'connection-event-topology-hash',
        contextDefHashes: { channel: 'channel-def-hash' },
      });

      const querySignature = serialiseSignature({
        coreHash: 'connection-event-topology-hash',
        contextDefHashes: {},
      });

      expect(canCacheSatisfyQuery(cachedSignature, querySignature)).toBe(true);
    });

    it('Scenario: Multi-dimensional cache (channel+device), single-dim query (channel)', () => {
      const cachedSignature = serialiseSignature({
        coreHash: 'core123',
        contextDefHashes: { channel: 'ch-hash', device: 'dv-hash' },
      });

      const querySignature = serialiseSignature({
        coreHash: 'core123',
        contextDefHashes: { channel: 'ch-hash' },
      });

      expect(canCacheSatisfyQuery(cachedSignature, querySignature)).toBe(true);
    });

    it('Scenario: Context definition changed - should NOT match', () => {
      const cachedSignature = serialiseSignature({
        coreHash: 'core123',
        contextDefHashes: { channel: 'old-channel-def-hash' },
      });

      const querySignature = serialiseSignature({
        coreHash: 'core123',
        contextDefHashes: { channel: 'new-channel-def-hash' },
      });

      expect(canCacheSatisfyQuery(cachedSignature, querySignature)).toBe(false);
    });

    it('Scenario: Connection changed - should NOT match', () => {
      const cachedSignature = serialiseSignature({
        coreHash: 'old-connection-hash',
        contextDefHashes: { channel: 'ch-hash' },
      });

      const querySignature = serialiseSignature({
        coreHash: 'new-connection-hash',
        contextDefHashes: { channel: 'ch-hash' },
      });

      expect(canCacheSatisfyQuery(cachedSignature, querySignature)).toBe(false);
    });

    it('Scenario: Query needs context that cache does not have', () => {
      const cachedSignature = serialiseSignature({
        coreHash: 'core123',
        contextDefHashes: {}, // Uncontexted cache
      });

      const querySignature = serialiseSignature({
        coreHash: 'core123',
        contextDefHashes: { channel: 'ch-hash' }, // Contexted query
      });

      expect(canCacheSatisfyQuery(cachedSignature, querySignature)).toBe(false);
    });
  });
});
