// SPDX-License-Identifier: GPL-3.0-or-later
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['*/test/**/*.test.ts'],
    testTimeout: 30_000,
    pool: 'forks',
    globalSetup: ['./vitest.global-setup.ts'],
  },
});
