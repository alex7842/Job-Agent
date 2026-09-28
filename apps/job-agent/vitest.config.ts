import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    root: './',
    include: ['**/*.spec.ts'],
    // There are no unit specs yet; the suite should not fail the `turbo run test`
    // task just because the glob is empty.
    passWithNoTests: true,
  },
});
