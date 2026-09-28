import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    root: './',
    include: ['**/*.spec.ts'],
    // There are no unit specs yet; an empty glob should not fail `turbo run test`.
    passWithNoTests: true,
  },
});
