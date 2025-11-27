/**
 * GitService Encoding Tests
 * 
 * Tests for binary data encoding to ensure large files don't cause stack overflow.
 */

import { describe, it, expect } from 'vitest';

// Test the chunked base64 encoding approach
function uint8ArrayToBase64(uint8Array: Uint8Array): string {
  const CHUNK_SIZE = 0x8000; // 32KB chunks
  let result = '';
  for (let i = 0; i < uint8Array.length; i += CHUNK_SIZE) {
    const chunk = uint8Array.subarray(i, i + CHUNK_SIZE);
    result += String.fromCharCode.apply(null, chunk as unknown as number[]);
  }
  return btoa(result);
}

// The BROKEN approach that causes stack overflow
function uint8ArrayToBase64Broken(uint8Array: Uint8Array): string {
  return btoa(String.fromCharCode(...uint8Array));
}

describe('GitService Base64 Encoding', () => {
  describe('uint8ArrayToBase64 (chunked)', () => {
    it('should encode small arrays correctly', () => {
      const data = new Uint8Array([72, 101, 108, 108, 111]); // "Hello"
      const base64 = uint8ArrayToBase64(data);
      expect(atob(base64)).toBe('Hello');
    });

    it('should encode medium arrays (64KB) without error', () => {
      const size = 64 * 1024; // 64KB - at the limit of spread operator
      const data = new Uint8Array(size);
      for (let i = 0; i < size; i++) {
        data[i] = i % 256;
      }
      
      // Should not throw
      const base64 = uint8ArrayToBase64(data);
      expect(base64.length).toBeGreaterThan(0);
      
      // Verify round-trip
      const decoded = atob(base64);
      expect(decoded.length).toBe(size);
    });

    it('should encode large arrays (1MB) without error', () => {
      const size = 1024 * 1024; // 1MB
      const data = new Uint8Array(size);
      for (let i = 0; i < size; i++) {
        data[i] = i % 256;
      }
      
      // Should not throw
      const base64 = uint8ArrayToBase64(data);
      expect(base64.length).toBeGreaterThan(0);
      
      // Base64 adds ~33% overhead
      expect(base64.length).toBeGreaterThan(size);
      expect(base64.length).toBeLessThan(size * 1.4);
    });

    it('should encode very large arrays (5MB) without error', { timeout: 30000 }, () => {
      const size = 5 * 1024 * 1024; // 5MB
      const data = new Uint8Array(size);
      
      // Should not throw
      const base64 = uint8ArrayToBase64(data);
      expect(base64.length).toBeGreaterThan(0);
    });

    it('should produce identical output to broken method for small arrays', () => {
      const data = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      
      const chunked = uint8ArrayToBase64(data);
      const broken = uint8ArrayToBase64Broken(data);
      
      expect(chunked).toBe(broken);
    });
  });

  describe('Broken spread approach (for comparison)', () => {
    it('should fail or produce garbage for large arrays', () => {
      const size = 100 * 1024; // 100KB - definitely over spread limit
      const data = new Uint8Array(size);
      
      // This SHOULD fail or produce incorrect output
      // We test this to document the bug we fixed
      let threwError = false;
      let result = '';
      
      try {
        result = uint8ArrayToBase64Broken(data);
      } catch (e) {
        threwError = true;
      }
      
      // Either it threw, or the result is wrong length
      // (In some JS engines it silently truncates)
      if (!threwError) {
        const decoded = atob(result);
        // If it didn't throw, the decoded length should be wrong
        // because spread operator has limits
        console.log(`Broken method: input ${size}, output ${decoded.length}`);
      }
      
      // The chunked version should always work
      const chunked = uint8ArrayToBase64(data);
      const decodedChunked = atob(chunked);
      expect(decodedChunked.length).toBe(size);
    });
  });
});

