/**
 * Global Test Setup
 * 
 * Runs before all tests. Sets up:
 * - Global mocks
 * - Test utilities
 * - Cleanup handlers
 * 
 * Note: Requires Node.js 20+ (dependencies require it)
 */

import { expect, afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

// Extend Vitest matchers
expect.extend({
  /**
   * Check if value is close to expected (within tolerance)
   */
  toBeCloseTo(received: number, expected: number, precision = 2) {
    const tolerance = Math.pow(10, -precision) / 2;
    const pass = Math.abs(received - expected) < tolerance;

    return {
      pass,
      message: () =>
        pass
          ? `Expected ${received} not to be close to ${expected}`
          : `Expected ${received} to be close to ${expected} (within ${tolerance})`
    };
  },

  /**
   * Check if object has all required fields
   */
  toHaveRequiredFields(received: any, fields: string[]) {
    const missing = fields.filter(field => !(field in received));
    const pass = missing.length === 0;

    return {
      pass,
      message: () =>
        pass
          ? `Expected object not to have all fields ${fields.join(', ')}`
          : `Expected object to have fields ${missing.join(', ')} but they were missing`
    };
  }
});

// Auto-cleanup after each test
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers(); // Reset any fake timers
});

// Mock console methods in tests (suppress all noise by default).
// NOTE: For debugging, set DAGNET_TEST_DEBUG_LOGS=1 to keep real console output.
if (process.env.DAGNET_TEST_DEBUG_LOGS !== '1') {
  global.console = {
    ...console,
    // Suppress ALL console output in tests for clean output
    error: vi.fn(),
    warn: vi.fn(),
    log: vi.fn(),
    info: vi.fn(),
    debug: vi.fn()
  };
}

// Mock window.crypto for UUIDs
if (typeof window !== 'undefined' && !window.crypto) {
  Object.defineProperty(window, 'crypto', {
    value: {
      randomUUID: () => {
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
          const r = Math.random() * 16 | 0;
          const v = c === 'x' ? r : (r & 0x3 | 0x8);
          return v.toString(16);
        });
      },
      getRandomValues: (arr: any) => {
        for (let i = 0; i < arr.length; i++) {
          arr[i] = Math.floor(Math.random() * 256);
        }
        return arr;
      }
    }
  });
}

// Mock IndexedDB (used by fileRegistry)
if (typeof window !== 'undefined' && !window.indexedDB) {
  const { IDBFactory } = require('fake-indexeddb');
  Object.defineProperty(window, 'indexedDB', {
    value: new IDBFactory()
  });
}

// Mock fetch to serve files from public/ folder in tests
// This prevents ECONNREFUSED errors when tests try to load schemas
const originalFetch = globalThis.fetch;
globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input.toString();
  
  // Handle relative URLs that would resolve to public/ folder
  if (url.startsWith('/param-schemas/') || url.startsWith('/ui-schemas/') || url.startsWith('/schemas/')) {
    const filePath = join(__dirname, '..', 'public', url);
    
    if (existsSync(filePath)) {
      const content = readFileSync(filePath, 'utf-8');
      const contentType = url.endsWith('.yaml') || url.endsWith('.yml') 
        ? 'text/yaml' 
        : 'application/json';
      
      return new Response(content, {
        status: 200,
        headers: { 'Content-Type': contentType }
      });
    } else {
      return new Response('Not found', { status: 404 });
    }
  }
  
  // Handle localhost URLs - fail fast instead of hanging
  if (url.includes('localhost') || url.includes('127.0.0.1')) {
    return new Response('Network error', { status: 500 });
  }
  
  // Pass through to original fetch for other URLs
  return originalFetch(input, init);
}) as typeof fetch;
