import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Native Windows protection calls the inbox PowerShell/.NET helper. Allow
    // startup overhead without changing command expiry or crash-worker deadlines.
    ...(process.platform === 'win32'
      ? { testTimeout: 60_000, hookTimeout: 60_000 }
      : {}),
  },
});
