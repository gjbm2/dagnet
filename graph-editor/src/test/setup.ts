/**
 * Vitest Setup File
 * 
 * Global test configuration and mocks
 */

import { expect, afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';
import '@testing-library/jest-dom';

// Cleanup after each test
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// Mock window.matchMedia (used by many UI components)
// Only in jsdom environment
if (typeof window !== 'undefined') {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

// Mock ResizeObserver (used by ReactFlow and other UI libs)
if (typeof global.ResizeObserver === 'undefined') {
  global.ResizeObserver = vi.fn().mockImplementation(() => ({
    observe: vi.fn(),
    unobserve: vi.fn(),
    disconnect: vi.fn(),
  }));
}

// Mock IntersectionObserver
if (typeof global.IntersectionObserver === 'undefined') {
  global.IntersectionObserver = vi.fn().mockImplementation(() => ({
    observe: vi.fn(),
    unobserve: vi.fn(),
    disconnect: vi.fn(),
  }));
}

// Mock IndexedDB for happy-dom environment
if (typeof global.indexedDB === 'undefined') {
  // Create a minimal IndexedDB mock
  const mockIDBFactory = {
    open: vi.fn(() => {
      const mockDB = {
        objectStoreNames: { contains: vi.fn(() => false), length: 0 },
        transaction: vi.fn(() => ({
          objectStore: vi.fn(() => ({
            get: vi.fn(() => Promise.resolve(undefined)),
            put: vi.fn(() => Promise.resolve(undefined)),
            add: vi.fn(() => Promise.resolve(undefined)),
            delete: vi.fn(() => Promise.resolve(undefined)),
            getAll: vi.fn(() => Promise.resolve([])),
            count: vi.fn(() => Promise.resolve(0)),
          })),
          oncomplete: null,
          onerror: null,
        })),
        createObjectStore: vi.fn(),
        deleteObjectStore: vi.fn(),
        close: vi.fn(),
        onversionchange: null,
      };
      const request = {
        result: mockDB,
        error: null,
        onsuccess: null,
        onerror: null,
        onblocked: null,
        onupgradeneeded: null,
      };
      // Simulate async success
      setTimeout(() => {
        if (request.onsuccess) request.onsuccess({ target: request } as any);
      }, 0);
      return request as any;
    }),
    deleteDatabase: vi.fn(() => {
      const request = {
        result: undefined,
        error: null,
        onsuccess: null,
        onerror: null,
        onblocked: null,
      };
      setTimeout(() => {
        if (request.onsuccess) request.onsuccess({ target: request } as any);
      }, 0);
      return request as any;
    }),
    databases: vi.fn(() => Promise.resolve([])),
    cmp: vi.fn(() => 0),
  };

  (global as any).indexedDB = mockIDBFactory;
  (global as any).IDBKeyRange = {
    bound: vi.fn(),
    lowerBound: vi.fn(),
    upperBound: vi.fn(),
    only: vi.fn(),
  };
}

// Mock Monaco Editor (used by QueryExpressionEditor)
vi.mock('@monaco-editor/react', () => ({
  __esModule: true,
  default: ({ value, onChange }: any) => null, // Minimal mock - component doesn't render Monaco in tests
  Editor: vi.fn(),
  DiffEditor: vi.fn(),
  useMonaco: vi.fn(() => null),
}));

// Note: whatwg-url dependency conflict exists between jsdom@27 and @vercel/node
// This may cause issues with integration tests. If tests fail with webidl-conversions errors,
// try: npm install --save-dev whatwg-url@latest
// Or use a different test environment like happy-dom

// Suppress console errors in tests (optional - comment out if debugging)
// vi.spyOn(console, 'error').mockImplementation(() => {});
// vi.spyOn(console, 'warn').mockImplementation(() => {});

