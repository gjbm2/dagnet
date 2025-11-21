/**
 * Test setup file
 * Configures global test environment
 */

import 'fake-indexeddb/auto';
import '@testing-library/jest-dom';
import { beforeAll, afterEach, vi } from 'vitest';

// Mock console methods to reduce noise in tests
beforeAll(() => {
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
