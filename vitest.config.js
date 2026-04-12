import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['achievement_hunter/src/pipeline/__tests__/**/*.test.js'],
  },
});
