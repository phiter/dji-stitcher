import path from 'node:path';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  worker: { format: 'es' },
  build: { target: 'es2022' },
  resolve: {
    alias: process.env.VITEST ? { '@techstark/opencv-js': path.resolve(import.meta.dirname, 'tests/opencv-shim.ts') } : {},
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 300_000,
  },
});
