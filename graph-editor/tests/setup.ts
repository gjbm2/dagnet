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

// Track window event listeners added during tests for cleanup
const originalAddEventListener = typeof window !== 'undefined' ? window.addEventListener.bind(window) : null;
const originalRemoveEventListener = typeof window !== 'undefined' ? window.removeEventListener.bind(window) : null;
const testEventListeners: Array<{ type: string; listener: EventListenerOrEventListenerObject }> = [];

if (typeof window !== 'undefined' && originalAddEventListener && originalRemoveEventListener) {
  window.addEventListener = (type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => {
    // Track dagnet: custom events for cleanup
    if (type.startsWith('dagnet:')) {
      testEventListeners.push({ type, listener });
    }
    return originalAddEventListener(type, listener, options);
  };
  
  window.removeEventListener = (type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions) => {
    // Remove from tracking
    const idx = testEventListeners.findIndex(e => e.type === type && e.listener === listener);
    if (idx >= 0) testEventListeners.splice(idx, 1);
    return originalRemoveEventListener(type, listener, options);
  };
}

// Auto-cleanup after each test
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers(); // Reset any fake timers
  
  // Clean up any leaked window event listeners
  if (originalRemoveEventListener) {
    for (const { type, listener } of [...testEventListeners]) {
      originalRemoveEventListener(type, listener);
    }
    testEventListeners.length = 0;
  }
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
// For real HTTP calls (Python API), use undici which works in Node.js
const { fetch: undiciFetch } = require('undici');

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
  
  // Allow real HTTP calls to Python API (snapshot writes, etc.)
  // These need undici because happy-dom's fetch doesn't make real network calls
  const isPythonApi = url.includes('/api/snapshots/') || 
    url.includes(':9000/') || url.includes(':8000/');
  if ((url.includes('localhost') || url.includes('127.0.0.1')) && isPythonApi) {
    // Use undici for real HTTP calls
    return undiciFetch(input, init);
  }
  
  // Block other localhost URLs to fail fast instead of hanging
  if (url.includes('localhost') || url.includes('127.0.0.1')) {
    return new Response('Network error', { status: 500 });
  }
  
  // Pass through to undici for external URLs
  return undiciFetch(input, init);
}) as typeof fetch;
