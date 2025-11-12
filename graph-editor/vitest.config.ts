import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()] as any,  // Type assertion to resolve Vite version mismatch
  test: {
    globals: true,
    environment: 'happy-dom', // Using happy-dom instead of jsdom to avoid whatwg-url dependency conflicts
    setupFiles: ['./src/test/setup.ts'],
    include: ['**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
    exclude: ['node_modules', 'dist', '.next', '.vercel', '**/api/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html', 'lcov'],
      exclude: [
        'node_modules/',
        'src/test/',
        '**/*.d.ts',
        '**/*.config.*',
        '**/mockData',
        'dist/',
      ],
    },
    // Separate unit and integration tests
    typecheck: {
      enabled: false, // Run separately with tsc
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  // Prevent @vercel/node from loading its dependencies during tests
  server: {
    fs: {
      allow: ['..'],
    },
  },
  optimizeDeps: {
    exclude: ['@vercel/node'],
  },
});

