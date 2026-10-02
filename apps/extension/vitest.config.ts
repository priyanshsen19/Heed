import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['test/**/*.test.{ts,tsx}'],
    exclude: ['test/e2e/**'],
    env: {
      VITE_API_BASE_URL: 'http://localhost:8787',
      VITE_ENV: 'test',
    },
  },
  define: { __HEED_VERSION__: JSON.stringify('0.0.1') },
});
