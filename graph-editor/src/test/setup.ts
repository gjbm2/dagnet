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

// Clean up after each test
afterEach(() => {
  vi.clearAllMocks();
});
