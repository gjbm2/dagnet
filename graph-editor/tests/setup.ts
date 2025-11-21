/**
 * Global Test Setup
 * 
 * Runs before all tests. Sets up:
 * - Global mocks
 * - Test utilities
 * - Cleanup handlers
 */

import { expect, afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

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
});

// Mock console methods in tests (reduce noise)
global.console = {
  ...console,
  // Keep error and warn for debugging
  error: vi.fn(console.error),
  warn: vi.fn(console.warn),
  // Suppress log, info, debug in tests
  log: vi.fn(),
  info: vi.fn(),
  debug: vi.fn()
};

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

// Global test timeout warning
const originalTimeout = setTimeout;
(global as any).setTimeout = function (callback: any, delay: number, ...args: any[]) {
  if (delay > 5000) {
    console.warn(`Long timeout detected: ${delay}ms. Consider reducing for faster tests.`);
  }
  return originalTimeout(callback, delay, ...args);
};

console.log('✅ Test environment initialized');

