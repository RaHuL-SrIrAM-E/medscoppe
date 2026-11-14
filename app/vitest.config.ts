import { defineConfig } from 'vitest/config';

// Separate from vite.config.ts on purpose: that file loads the IWSDK dev plugin,
// which starts (or conflicts with) a dev runtime. Unit tests are pure Node.
export default defineConfig({
  test: { include: ['src/**/*.test.ts'], environment: 'node' },
});
