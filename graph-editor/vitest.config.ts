import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

// Plugin to intercept whatwg-url and webidl-conversions imports and replace with mocks
const whatwgUrlPlugin = () => ({
  name: 'whatwg-url-mock',
  resolveId(id: string) {
    if (id === 'whatwg-url' || id.includes('whatwg-url')) {
      return path.resolve(__dirname, './src/test/mocks/whatwg-url.ts');
    }
    if (id === 'webidl-conversions' || id.includes('webidl-conversions')) {
      return path.resolve(__dirname, './src/test/mocks/webidl-conversions.ts');
    }
    return null;
  },
});

export default defineConfig({
  plugins: [react() as any, whatwgUrlPlugin()],  // Type assertion to resolve Vite version mismatch
  test: {
    globals: true,
    environment: 'happy-dom', // Using happy-dom instead of jsdom to avoid whatwg-url dependency conflicts
    
    // MERGED: Support both old and new test locations
    setupFiles: [
      './src/test/setup.ts',  // Original location
      './tests/setup.ts'       // New comprehensive test suite
    ],
    
    // MERGED: Include both old and new test patterns
    include: [
      '**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}',  // Original pattern (src/test/)
      'tests/**/*.{test,spec}.{ts,tsx}'                     // New pattern (tests/)
    ],
    
    exclude: ['node_modules', 'dist', '.next', '.vercel', '**/api/**'],
    
    // Ignore unhandled errors from webidl-conversions (all tests pass, this is a dependency issue)
    onConsoleLog: (log, type) => {
      if (log.includes('webidl-conversions')) return false;
      return true;
    },
    
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html', 'lcov'],
      exclude: [
        'node_modules/',
        'src/test/',          // Original
        'tests/',             // New
        '**/*.d.ts',
        '**/*.config.*',
        '**/mockData',
        '**/*.test.ts',       // New
        '**/*.test.tsx',      // New
        'dist/',
        '.next/',
        'vite.config.ts',
        'vitest.config.ts'
      ],
      // Coverage thresholds - starting low, increase as test coverage improves
      // Current actual: ~12% lines, ~13% functions, ~8% branches
      thresholds: {
        lines: 10,
        functions: 10,
        branches: 5,
        statements: 10
      }
    },
    
    // Separate unit and integration tests
    typecheck: {
      enabled: false, // Run separately with tsc
    },
    
    // Configure pool to handle unhandled errors gracefully
    pool: 'threads',
    poolOptions: {
      threads: {
        singleThread: false,
        isolate: true,  // NEW: Better isolation for new tests
        minThreads: 1,
        maxThreads: 4
      },
    },
    
    // Don't bail on unhandled errors - all tests pass, webidl-conversions error is a dependency issue
    bail: process.env.CI ? 1 : 0,  // UPDATED: Bail on CI for faster feedback
    
    // Force exit after tests complete to prevent hanging on unhandled errors
    teardownTimeout: 5000,
    
    // Configure test timeout to prevent hanging
    testTimeout: 10000,
    hookTimeout: 10000,
    
    // Force exit after tests complete (prevents hanging in CI/non-interactive mode)
    forceRerunTriggers: [],
    
    // NEW: Better reporters for new test suite
    reporters: ['dot'],
    
    // Ensure tests exit properly (not in watch mode)
    watch: false,
  },
  
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@tests': path.resolve(__dirname, './tests'),  // NEW: Alias for new test suite
      // Replace whatwg-url with Node.js built-in URL to avoid webidl-conversions errors
      'whatwg-url': path.resolve(__dirname, './src/test/mocks/whatwg-url.ts'),
      'webidl-conversions': path.resolve(__dirname, './src/test/mocks/webidl-conversions.ts'),
    },
  },
  
  // Prevent @vercel/node from loading its dependencies during tests
  server: {
    fs: {
      allow: ['..'],
    },
  },
  
  optimizeDeps: {
    exclude: ['@vercel/node', 'webidl-conversions', 'whatwg-url'],
  },
});
