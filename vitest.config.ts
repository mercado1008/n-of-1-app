import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      // Match Next.js tsconfig.json "@/*": ["./*"]
      '@': resolve(__dirname, '.'),
    },
  },
  test: {
    environment: 'node',
  },
});
