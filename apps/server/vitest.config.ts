import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Resetting files share one launcher-owned test session store and run serially.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    setupFiles: ['test/setup-identity.ts'],
    include: ['test/**/*.test.ts'],
  },
});
