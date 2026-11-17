import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    env: {
      AB_DB_PATH: ':memory:',
      OWNER_NAME: 'Sam Rivera',
    },
  },
});
