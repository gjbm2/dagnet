/**
 * Test setup file
 * Configures global test environment
 */

import 'fake-indexeddb/auto';
import '@testing-library/jest-dom';
import { beforeAll, afterEach, vi } from 'vitest';

// Mock console methods to reduce noise in tests.
// NOTE: For debugging, set DAGNET_TEST_DEBUG_LOGS=1 to keep real console output.
beforeAll(() => {
  const debugLogsEnabled = process.env.DAGNET_TEST_DEBUG_LOGS === '1';
  if (debugLogsEnabled) {
    // Leave console intact so production-code logging is visible during tests.
    return;
  }

  global.console = {
    ...console,
    // Keep error and warn for debugging
    error: console.error,
    warn: console.warn,
    // Suppress info and log in tests
    info: vi.fn(),
    log: vi.fn(),
    debug: vi.fn(),
  };
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

// Clean up after each test
afterEach(() => {
  vi.clearAllMocks();
  
  // Clean up any leaked window event listeners
  if (originalRemoveEventListener) {
    for (const { type, listener } of [...testEventListeners]) {
      originalRemoveEventListener(type, listener);
    }
    testEventListeners.length = 0;
  }
});
